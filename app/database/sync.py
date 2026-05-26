import os
import json
import sqlite3
import threading
import time
import hashlib
from google.cloud import firestore

# Lock to control single-threaded writes to Firestore
_sync_lock = threading.Lock()

# Lock to control debouncing timers
_timer_lock = threading.Lock()
_sync_timer = None

# Global cache of the MD5 hash of the last successfully synced database
_last_saved_hash = None

def get_config():
    """Retrieve database & project config from firebase-applet-config.json."""
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    config_path = os.path.join(base_dir, 'firebase-applet-config.json')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"[FIREBASE SYNC] Error reading firebase config file: {str(e)}", flush=True)
    return None

def get_firestore_client():
    """Initialize & return Google Cloud Firestore client."""
    config = get_config() or {}
        
    project_id = os.environ.get('FIREBASE_PROJECT_ID') or config.get('projectId')
    database_id = os.environ.get('FIREBASE_DATABASE_ID') or config.get('firestoreDatabaseId')
    
    # Check if SERVICE ACCOUNT key is provided via environment variables (for Render)
    service_account_json = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON')
    if service_account_json:
        # On Render / external servers, if the database ID points to the sandbox "ai-studio-...",
        # override it to "(default)" so it correctly uses their standard production default database.
        if database_id and database_id.startswith("ai-studio-"):
            database_id = "(default)"
            
        try:
            from google.oauth2 import service_account as google_service_account
            info = json.loads(service_account_json)
            # Make sure we use the project ID from the service account key if not explicitly set
            p_id = project_id or info.get('project_id')
            credentials = google_service_account.Credentials.from_service_account_info(info)
            return firestore.Client(project=p_id, database=database_id, credentials=credentials)
        except Exception as e:
            print(f"[FIREBASE SYNC] Failed to initialize Firestore using FIREBASE_SERVICE_ACCOUNT_JSON: {str(e)}", flush=True)

    # Default fallback (works automatically inside AI Studio Cloud Run sandbox)
    try:
        return firestore.Client(project=project_id, database=database_id)
    except Exception as e:
        print(f"[FIREBASE SYNC] Failed to initialize default Firestore Client: {str(e)}", flush=True)
    return None

def get_db_path():
    """Return the absolute path to the SQLite chatd.db file."""
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    return os.path.join(base_dir, 'chatd.db')

def restore_db():
    """
    Downloads database chunks from Firestore and reconstructs chatd.db locally.
    Called once during Flask application startup before any routing is initialized.
    """
    db_path = get_db_path()
    print(f"[FIREBASE RESTORE] Starting check for database from Firestore to: {db_path}", flush=True)
    try:
        client = get_firestore_client()
        if not client:
            print("[FIREBASE RESTORE] Error: Could not load Firestore configuration. Skipping restore.", flush=True)
            return False

        meta_ref = client.collection('sqlite_backups').document('meta')
        meta_doc = meta_ref.get()
        if not meta_doc.exists:
            print("[FIREBASE RESTORE] No previous cloud backup found. App will start with a brand new, clean database.", flush=True)
            return False

        meta_data = meta_doc.to_dict()
        chunk_count = meta_data.get('chunk_count', 0)
        total_size = meta_data.get('total_size', 0)
        last_updated = meta_data.get('last_updated', 'unknown')
        print(f"[FIREBASE RESTORE] Cloud backup found! {chunk_count} chunks, {total_size} bytes (last synced: {last_updated}). Downloading...", flush=True)

        full_data = bytearray()
        for i in range(chunk_count):
            print(f"[FIREBASE RESTORE] Downloading chunk {i+1}/{chunk_count}...", flush=True)
            chunk_ref = client.collection('sqlite_backups').document(f'chunk_{i}')
            chunk_doc = chunk_ref.get()
            if chunk_doc.exists:
                chunk_dict = chunk_doc.to_dict()
                chunk_data = chunk_dict.get('data')
                if chunk_data:
                    full_data.extend(chunk_data)
                else:
                    print(f"[FIREBASE RESTORE] Warning: Chunk {i} contains empty data!", flush=True)
            else:
                print(f"[FIREBASE RESTORE] Error: Chunk {i} is missing from Firestore!", flush=True)
                return False

        if len(full_data) == 0:
            print("[FIREBASE RESTORE] Error: Reconstruction resulted in an empty byte array.", flush=True)
            return False

        # Build directories if missing
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        with open(db_path, 'wb') as f:
            f.write(full_data)

        # Update cache of the last saved hash to match the restored state
        global _last_saved_hash
        _last_saved_hash = hashlib.md5(full_data).hexdigest()

        print(f"[FIREBASE RESTORE] SUCCESS! Reconstructed local database file ({len(full_data)} bytes) with md5 hash {_last_saved_hash}. Ready to start!", flush=True)
        return True
    except Exception as e:
        print(f"[FIREBASE RESTORE] Exception encountered during RESTORE: {str(e)}", flush=True)
        return False

def save_db():
    """
    Saves the entire local chatd.db file into chunked document partitions on Firestore.
    Forces an SQLite WAL checkpoint beforehand to ensure all transactions are fully written inside chatd.db.
    """
    global _last_saved_hash
    db_path = get_db_path()
    if not os.path.exists(db_path):
        print("[FIREBASE SAVE] Skip: SQLite database file chatd.db does not exist yet.", flush=True)
        return False

    with _sync_lock:
        try:
            # 1. Force a full WAL checkpoint to commit WAL journal logs directly into chatd.db
            try:
                conn = sqlite3.connect(db_path)
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
                conn.close()
                print("[FIREBASE SAVE] SQLite forced WAL checkpoint completed successfully.", flush=True)
            except Exception as e:
                print(f"[FIREBASE SAVE] Non-blocking warning: SQLite checkpoint failed: {str(e)}", flush=True)

            # 2. Read full database file
            with open(db_path, 'rb') as f:
                db_bytes = f.read()

            total_size = len(db_bytes)
            if total_size == 0:
                print("[FIREBASE SAVE] Skip: Database file size is 0 bytes.", flush=True)
                return False

            # Calculate hash and skip upload if unchanged
            current_hash = hashlib.md5(db_bytes).hexdigest()
            if _last_saved_hash is not None and current_hash == _last_saved_hash:
                print(f"[FIREBASE SAVE] Skip: Database hash ({current_hash}) has not changed since last sync.", flush=True)
                return True

            print(f"[FIREBASE SAVE] Initiating database sync back to Firestore (size: {total_size} bytes, new hash: {current_hash})...", flush=True)

            client = get_firestore_client()
            if not client:
                print("[FIREBASE SAVE] Error: Firestore client is unavailable. Skip backup.", flush=True)
                return False

            # 3. Split binary data into 500KB partition chunks to safely avoid Firestore 1MB limits
            CHUNK_SIZE = 500 * 1024
            chunks = [db_bytes[i:i + CHUNK_SIZE] for i in range(0, len(db_bytes), CHUNK_SIZE)]
            chunk_count = len(chunks)
            print(f"[FIREBASE SAVE] Divided {total_size} bytes into {chunk_count} chunks for Firestore upload.", flush=True)

            # 4. Set chunk payloads
            for i, chunk in enumerate(chunks):
                chunk_ref = client.collection('sqlite_backups').document(f'chunk_{i}')
                # Write natively as binary bytes BLOB
                chunk_ref.set({'data': bytes(chunk)})
                print(f"[FIREBASE SAVE] Cloud uploaded chunk {i+1}/{chunk_count} ({len(chunk)} bytes).", flush=True)

            # 5. Commit metadata
            meta_ref = client.collection('sqlite_backups').document('meta')
            meta_ref.set({
                'chunk_count': chunk_count,
                'total_size': total_size,
                'last_updated': firestore.SERVER_TIMESTAMP
            })

            # Update cache of the last saved hash
            _last_saved_hash = current_hash
            print(f"[FIREBASE SAVE] SUCCESS! Firestore backup finished. Cloud copy matches current session perfectly.", flush=True)
            return True
        except Exception as e:
            print(f"[FIREBASE SAVE] Exception encountered during SAVE: {str(e)}", flush=True)
            return False

def trigger_save_db_async():
    """
    Triggers an immediate, synchronous upload of the SQLite file to Firestore.
    This guarantees that the data is fully flushed and backed up before the Cloud Run request/CPU-time ends.
    """
    save_db()
