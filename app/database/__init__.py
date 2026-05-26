import os
import sqlite3
from flask import g, current_app

def get_db():
    db_path = current_app.config['DATABASE']
    if 'db' not in g:
        g.db = sqlite3.connect(db_path)
        g.db.row_factory = sqlite3.Row
        # Enable WAL mode and synchronous=NORMAL to make DB reads/writes blazing fast
        g.db.execute("PRAGMA journal_mode=WAL;")
        g.db.execute("PRAGMA synchronous=NORMAL;")
        g.db.execute("PRAGMA cache_size=-4000;") # Uses ~4MB memory cache
        g.db.execute("PRAGMA foreign_keys=ON;")
    return g.db

def close_db(e=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def query_db(query, args=(), one=False):
    db = get_db()
    cur = db.execute(query, args)
    rv = cur.fetchall()
    cur.close()
    return (rv[0] if rv else None) if one else rv

def insert_db(query, args=()):
    db = get_db()
    cur = db.cursor()
    cur.execute(query, args)
    db.commit()
    last_id = cur.lastrowid
    cur.close()
    
    # Sync SQLite changes back to Firestore
    try:
        from app.database.sync import trigger_save_db_async
        trigger_save_db_async()
    except Exception as e:
        print(f"[FIREBASE SYNC] Trigger save failed: {str(e)}", flush=True)
        
    return last_id

def execute_db(query, args=()):
    db = get_db()
    db.execute(query, args)
    db.commit()
    
    # Sync SQLite changes back to Firestore
    try:
        from app.database.sync import trigger_save_db_async
        trigger_save_db_async()
    except Exception as e:
        print(f"[FIREBASE SYNC] Trigger save failed: {str(e)}", flush=True)

def init_db():
    # RESTORE BEFORE PREPARATION
    try:
        from app.database.sync import restore_db
        restore_db()
    except Exception as e:
        print(f"[FIREBASE RESTORE] Setup trigger error: {str(e)}", flush=True)

    db_path = current_app.config['DATABASE']
    db = sqlite3.connect(db_path)

    
    # Check if we need to migrate (only if tables already exist)
    try:
        cursor = db.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
        users_exists = cursor.fetchone() is not None
    except Exception:
        users_exists = False

    if users_exists:
        # Dynamic database migration: allow multiple accounts with the same mobile number
        try:
            cursor = db.cursor()
            cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
            row = cursor.fetchone()
            if row and "mobile TEXT UNIQUE" in row[0]:
                print("[MIGRATION] Migrating users table to remove UNIQUE constraint from mobile...", flush=True)
                db.execute("PRAGMA foreign_keys=OFF")
                db.execute("""
                CREATE TABLE IF NOT EXISTS users_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    display_name TEXT,
                    mobile TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    profile_picture TEXT DEFAULT '/static/images/default_avatar.svg',
                    bio TEXT DEFAULT 'Hey there! I am using ChatD.',
                    joined_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    is_online INTEGER DEFAULT 0
                );
                """)
                db.execute("""
                INSERT INTO users_new (id, username, mobile, password_hash, profile_picture, bio, joined_date, last_seen, is_online)
                SELECT id, username, mobile, password_hash, profile_picture, bio, joined_date, last_seen, is_online FROM users;
                """)
                db.execute("DROP TABLE users;")
                db.execute("ALTER TABLE users_new RENAME TO users;")
                db.execute("PRAGMA foreign_keys=ON")
                db.commit()
                print("[MIGRATION] Migration completed successfully!", flush=True)
        except Exception as e:
            print(f"[MIGRATION] Error migrating users table: {str(e)}", flush=True)

        # Migrate again to ensure display_name column exists
        try:
            cursor = db.cursor()
            cursor.execute("PRAGMA table_info(users)")
            columns = [row[1] for row in cursor.fetchall()]
            if "display_name" not in columns:
                print("[MIGRATION] Adding display_name column to users...", flush=True)
                db.execute("ALTER TABLE users ADD COLUMN display_name TEXT")
                db.commit()
        except Exception as e:
            print(f"[MIGRATION] Error adding display_name column: {str(e)}", flush=True)
    
    # Create tables
    with db:
        # 1. users table
        db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            display_name TEXT,
            mobile TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            profile_picture TEXT DEFAULT '/static/images/default_avatar.svg',
            bio TEXT DEFAULT 'Hey there! I am using ChatD.',
            joined_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_online INTEGER DEFAULT 0
        );
        """)
        # 2. chats table
        db.execute("""
        CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user1_id INTEGER,
            user2_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_group INTEGER DEFAULT 0,
            group_name TEXT,
            group_avatar TEXT DEFAULT '/static/images/default_group.svg',
            group_description TEXT,
            owner_id INTEGER,
            FOREIGN KEY(user1_id) REFERENCES users(id),
            FOREIGN KEY(user2_id) REFERENCES users(id),
            UNIQUE(user1_id, user2_id)
        );
        """)
        
        # Safe alter commands for backwards compatibility
        try:
            db.execute("ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0")
        except Exception:
            pass
        try:
            db.execute("ALTER TABLE chats ADD COLUMN group_name TEXT")
        except Exception:
            pass
        try:
            db.execute("ALTER TABLE chats ADD COLUMN group_avatar TEXT DEFAULT '/static/images/default_group.svg'")
        except Exception:
            pass
        try:
            db.execute("ALTER TABLE chats ADD COLUMN group_description TEXT")
        except Exception:
            pass
        try:
            db.execute("ALTER TABLE chats ADD COLUMN owner_id INTEGER")
        except Exception:
            pass
        try:
            db.execute("ALTER TABLE chats ADD COLUMN group_edit_permission TEXT DEFAULT 'all'")
        except Exception:
            pass
        try:
            db.execute("ALTER TABLE chats ADD COLUMN group_send_permission TEXT DEFAULT 'all'")
        except Exception:
            pass

        # 2b. group_members table
        db.execute("""
        CREATE TABLE IF NOT EXISTS group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER,
            user_id INTEGER,
            role TEXT DEFAULT 'member', -- 'owner', 'admin', 'member'
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(chat_id) REFERENCES chats(id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            UNIQUE(chat_id, user_id)
        );
        """)
        
        # 3. messages table
        db.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER,
            sender_id INTEGER,
            text TEXT,
            type TEXT DEFAULT 'text',
            file_path TEXT,
            file_name TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER DEFAULT 0,
            deleted_by TEXT DEFAULT '',
            reply_to_id INTEGER,
            reply_to_text TEXT,
            reply_to_sender TEXT,
            is_delivered INTEGER DEFAULT 1,
            is_seen INTEGER DEFAULT 0,
            FOREIGN KEY(chat_id) REFERENCES chats(id),
            FOREIGN KEY(sender_id) REFERENCES users(id)
        );
        """)
        
        # 4. settings table
        db.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER UNIQUE,
            theme TEXT DEFAULT 'light',
            wallpaper TEXT DEFAULT 'none',
            last_seen_visibility INTEGER DEFAULT 1,
            read_receipts INTEGER DEFAULT 1,
            sound_enabled INTEGER DEFAULT 1,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        """)
        
        # 5. files table
        db.execute("""
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER,
            file_path TEXT,
            file_name TEXT,
            file_size INTEGER,
            file_type TEXT,
            FOREIGN KEY(message_id) REFERENCES messages(id)
        );
        """)

        # 6. reactions table
        db.execute("""
        CREATE TABLE IF NOT EXISTS reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER,
            user_id INTEGER,
            emoji TEXT,
            FOREIGN KEY(message_id) REFERENCES messages(id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            UNIQUE(message_id, user_id)
        );
        """)

        # Database performance optimization indices for lightning fast queries:
        db.execute("CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(chat_id, sender_id, is_seen);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC, id DESC);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_group_members_chat_user ON group_members(chat_id, user_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions(message_id);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);")
        
        # Clean up existing demo accounts
        db.execute("DELETE FROM settings WHERE user_id IN (SELECT id FROM users WHERE username IN ('Aman', 'Rahul', 'Sneha', 'Priya', 'Amit', 'Kabir', 'Divya', 'Nehal', 'Rohit', 'Ananya', 'Aman (aman.dev)', 'Aman (aman.test)', 'Rahul (rahul.active)', 'Rahul (rahul.work)', 'Sneha (sneha.personal)', 'Sneha (sneha.backup)', 'Priya (priya.primary)', 'Priya (priya.web)', 'Amit (amit.alpha)', 'Amit (amit.beta)', 'aman.dev', 'aman.test', 'rahul.active', 'rahul.work', 'sneha.personal', 'sneha.backup', 'priya.primary', 'priya.web', 'amit.alpha', 'amit.beta', 'rohit.gamer', 'sneha.art', 'aditya.fitness', 'neha.travels', 'vikram.tech', 'kabir.music'))")
        db.execute("DELETE FROM users WHERE username IN ('Aman', 'Rahul', 'Sneha', 'Priya', 'Amit', 'Kabir', 'Divya', 'Nehal', 'Rohit', 'Ananya', 'Aman (aman.dev)', 'Aman (aman.test)', 'Rahul (rahul.active)', 'Rahul (rahul.work)', 'Sneha (sneha.personal)', 'Sneha (sneha.backup)', 'Priya (priya.primary)', 'Priya (priya.web)', 'Amit (amit.alpha)', 'Amit (amit.beta)', 'aman.dev', 'aman.test', 'rahul.active', 'rahul.work', 'sneha.personal', 'sneha.backup', 'priya.primary', 'priya.web', 'amit.alpha', 'amit.beta', 'rohit.gamer', 'sneha.art', 'aditya.fitness', 'neha.travels', 'vikram.tech', 'kabir.music') OR mobile LIKE '+91987654321%' OR mobile IN ('+919012345678', '+919023456789', '+919034567890', '+919045678901', '+919056789012', '+919067890123')")
        
    db.close()

    # Flush migrated schema synchronously to Firestore
    try:
        from app.database.sync import save_db
        save_db()
    except Exception as e:
        print(f"[FIREBASE INITIAL SAVE] Failed to sync database schema: {str(e)}", flush=True)
