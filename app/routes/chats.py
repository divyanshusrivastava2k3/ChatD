import os
import uuid
from flask import Blueprint, render_template, request, redirect, url_for, session, jsonify, current_app
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from app.database import query_db, insert_db, execute_db

chats_bp = Blueprint('chats', __name__)

# Helper to check file extensions
def allowed_file(filename, file_type='file'):
    if '.' not in filename:
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    if file_type == 'image':
        return ext in {'png', 'jpg', 'jpeg', 'gif', 'webp'}
    elif file_type == 'video':
        return ext in {'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'}
    else:  # file (pdf, zip, docs, video, images)
        return ext in {
            'png', 'jpg', 'jpeg', 'gif', 'webp', 
            'pdf', 'zip', 'txt', 'doc', 'docx',
            'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'
        }

@chats_bp.route('/')
def index():
    if 'user_id' not in session:
        return redirect(url_for('auth.login'))
    
    user_id = session['user_id']
    
    # Fetch user details
    user = query_db("SELECT * FROM users WHERE id = ?", (user_id,), one=True)
    if not user:
        session.clear()
        return redirect(url_for('auth.login'))
    
    # Fetch user settings
    settings = query_db("SELECT * FROM settings WHERE user_id = ?", (user_id,), one=True)
    if not settings:
        # Emergency backup create settings
        insert_db(
            "INSERT INTO settings (user_id, theme, wallpaper, last_seen_visibility, read_receipts, sound_enabled) VALUES (?, 'light', 'none', 1, 1, 1)",
            (user_id,)
        )
        settings = query_db("SELECT * FROM settings WHERE user_id = ?", (user_id,), one=True)
    
    # Mark user online
    execute_db("UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?", (user_id,))

    return render_template('chat.html', user=user, settings=settings)

@chats_bp.route('/api/search-users')
def search_users():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    current_user_id = session['user_id']
    query = request.args.get('q', '').strip()
    only_chatted = request.args.get('only_chatted', 'false').lower() == 'true'
    
    if only_chatted:
        if not query:
            users = query_db(
                """
                SELECT DISTINCT u.id, COALESCE(u.display_name || ' (' || u.username || ')', u.username) AS username, u.mobile, u.profile_picture, u.bio, u.is_online, u.last_seen 
                FROM users u 
                JOIN chats c ON (
                    (c.user1_id = ? AND c.user2_id = u.id) OR (c.user2_id = ? AND c.user1_id = u.id)
                ) 
                WHERE (c.is_group = 0 OR c.is_group IS NULL) AND u.id != ? 
                ORDER BY u.username ASC
                """,
                (current_user_id, current_user_id, current_user_id)
            )
        else:
            users = query_db(
                """
                SELECT DISTINCT u.id, COALESCE(u.display_name || ' (' || u.username || ')', u.username) AS username, u.mobile, u.profile_picture, u.bio, u.is_online, u.last_seen 
                FROM users u 
                JOIN chats c ON (
                    (c.user1_id = ? AND c.user2_id = u.id) OR (c.user2_id = ? AND c.user1_id = u.id)
                ) 
                WHERE (c.is_group = 0 OR c.is_group IS NULL) AND u.id != ? AND (u.username LIKE ? OR u.display_name LIKE ? OR u.mobile LIKE ?) 
                ORDER BY u.username ASC
                """,
                (current_user_id, current_user_id, current_user_id, f"%{query}%", f"%{query}%", f"%{query}%")
            )
    else:
        if not query:
            # Return all other users if empty query (helpful for group population)
            users = query_db(
                "SELECT id, COALESCE(display_name || ' (' || username || ')', username) AS username, mobile, profile_picture, bio, is_online, last_seen FROM users WHERE id != ? ORDER BY username ASC",
                (current_user_id,)
            )
        else:
            # Search by username or mobile number (excluding current user)
            users = query_db(
                "SELECT id, COALESCE(display_name || ' (' || username || ')', username) AS username, mobile, profile_picture, bio, is_online, last_seen FROM users WHERE (username LIKE ? OR display_name LIKE ? OR mobile LIKE ?) AND id != ?",
                (f"%{query}%", f"%{query}%", f"%{query}%", current_user_id)
            )
    
    return jsonify([dict(u) for u in users])

@chats_bp.route('/api/chats', methods=['GET'])
def get_user_chats():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    current_user_id = session['user_id']
    
    # Fetch all chats where the user is a participant:
    # 1) Direct DMs where user1_id or user2_id is current_user_id
    # 2) Groups where user is a member of group_members mapping
    chats_query = """
    SELECT 
        c.id as chat_id,
        c.is_group,
        c.group_name,
        c.group_avatar,
        c.group_description,
        c.owner_id,
        c.group_edit_permission,
        c.group_send_permission,
        u.id as recipient_id,
        COALESCE(u.display_name || ' (' || u.username || ')', u.username) AS username,
        u.mobile,
        u.profile_picture,
        u.bio,
        u.is_online,
        u.last_seen,
        s.last_seen_visibility,
        (
            SELECT json_object(
                'id', m.id, 
                'text', m.text, 
                'sender_id', m.sender_id, 
                'sender_username', (SELECT username FROM users WHERE id = m.sender_id),
                'type', m.type, 
                'timestamp', m.timestamp,
                'is_deleted', m.is_deleted,
                'is_seen', m.is_seen
            )
            FROM messages m
            WHERE m.chat_id = c.id
            ORDER BY m.timestamp DESC, m.id DESC
            LIMIT 1
        ) as last_message,
        (
            SELECT COUNT(*) 
            FROM messages m 
            WHERE m.chat_id = c.id AND m.sender_id != ? AND m.is_seen = 0
        ) as unread_count
    FROM chats c
    LEFT JOIN users u ON (c.is_group = 0 AND (c.user1_id = u.id OR c.user2_id = u.id) AND u.id != ?)
    LEFT JOIN settings s ON u.id = s.user_id
    WHERE (c.is_group = 0 AND (c.user1_id = ? OR c.user2_id = ?))
       OR (c.is_group = 1 AND c.id IN (SELECT chat_id FROM group_members WHERE user_id = ?))
    ORDER BY COALESCE(
        (SELECT m.timestamp FROM messages m WHERE m.chat_id = c.id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1),
        c.created_at
    ) DESC
    """
    
    user_chats = query_db(chats_query, (current_user_id, current_user_id, current_user_id, current_user_id, current_user_id))
    
    results = []
    for chat in user_chats:
        chat_dict = dict(chat)
        if chat_dict['last_message']:
            import json
            try:
                chat_dict['last_message'] = json.loads(chat_dict['last_message'])
            except:
                chat_dict['last_message'] = None
        results.append(chat_dict)
        
    return jsonify(results)

@chats_bp.route('/api/chats/create', methods=['POST'])
def create_chat():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    current_user_id = session['user_id']
    recipient_id = request.json.get('recipient_id')
    
    if not recipient_id:
        return jsonify({'error': 'Recipient ID is required'}), 400
    
    # Force order user1_id < user2_id to prevent duplicates
    u1, u2 = min(int(current_user_id), int(recipient_id)), max(int(current_user_id), int(recipient_id))
    
    # Check if chat exists
    existing_chat = query_db("SELECT id FROM chats WHERE user1_id = ? AND user2_id = ?", (u1, u2), one=True)
    if existing_chat:
        return jsonify({'chat_id': existing_chat['id']})
    
    try:
        chat_id = insert_db("INSERT INTO chats (user1_id, user2_id) VALUES (?, ?)", (u1, u2))
        return jsonify({'chat_id': chat_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@chats_bp.route('/api/chats/<int:chat_id>/messages', methods=['GET'])
def get_messages(chat_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    # Verify user is part of the chat (either direct DM or Group)
    current_user_id = session['user_id']
    chat = query_db("""
        SELECT * FROM chats 
        WHERE id = ? AND (
            (is_group = 0 AND (user1_id = ? OR user2_id = ?)) OR 
            (is_group = 1 AND id IN (SELECT chat_id FROM group_members WHERE user_id = ?))
        )
    """, (chat_id, current_user_id, current_user_id, current_user_id), one=True)
    if not chat:
        return jsonify({'error': 'Chat not found or unauthorized access'}), 404
    
    messages = query_db(
        """
        SELECT m.id, m.chat_id, m.sender_id, m.text, m.type, m.file_path, m.file_name, m.timestamp, m.is_deleted, 
               m.reply_to_id, m.reply_to_text, m.reply_to_sender, m.is_delivered, m.is_seen,
               COALESCE(u.display_name || ' (' || u.username || ')', u.username) AS sender_username, u.profile_picture AS sender_profile_picture
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.id
        WHERE m.chat_id = ? AND (m.deleted_by IS NULL OR m.deleted_by = '' OR ',' || m.deleted_by || ',' NOT LIKE '%,' || ? || ',%')
        ORDER BY m.timestamp ASC, m.id ASC
        """,
        (chat_id, str(current_user_id))
    )
    
    # Fetch reactions for all messages in this chat
    reactions = query_db("""
        SELECT r.message_id, r.user_id, r.emoji, COALESCE(u.display_name || ' (' || u.username || ')', u.username) AS username
        FROM reactions r
        JOIN users u ON r.user_id = u.id
        WHERE r.message_id IN (SELECT id FROM messages WHERE chat_id = ?)
    """, (chat_id,))
    
    reactions_map = {}
    for r in reactions:
        msg_id_key = r['message_id']
        if msg_id_key not in reactions_map:
            reactions_map[msg_id_key] = []
        reactions_map[msg_id_key].append({
            'user_id': r['user_id'],
            'emoji': r['emoji'],
            'username': r['username']
        })
    
    # Check if the current user has read receipts enabled
    user_settings = query_db("SELECT read_receipts FROM settings WHERE user_id = ?", (current_user_id,), one=True)
    read_receipts_enabled = True
    if user_settings and user_settings['read_receipts'] == 0:
        read_receipts_enabled = False

    # Mark messages from other user as read & delivered
    if read_receipts_enabled:
        execute_db("UPDATE messages SET is_delivered = 2, is_seen = 1 WHERE chat_id = ? AND sender_id != ?", (chat_id, current_user_id))
    else:
        execute_db("UPDATE messages SET is_delivered = 2 WHERE chat_id = ? AND sender_id != ?", (chat_id, current_user_id))
    
    results = []
    for m in messages:
        m_dict = dict(m)
        m_dict['reactions'] = reactions_map.get(m['id'], [])
        results.append(m_dict)
        
    return jsonify(results)

@chats_bp.route('/api/chats/clear', methods=['POST'])
def clear_chat():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    chat_id = request.json.get('chat_id')
    if not chat_id:
        return jsonify({'error': 'Chat ID is required'}), 400
    
    current_user_id = session['user_id']
    
    # Verify user is in chat
    chat = query_db("SELECT * FROM chats WHERE id = ? AND (user1_id = ? OR user2_id = ?)", (chat_id, current_user_id, current_user_id), one=True)
    if not chat:
        return jsonify({'error': 'Unauthorized or Chat not found'}), 403
    
    try:
        # Note: Clean delete from messages and linked files
        execute_db("DELETE FROM files WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)", (chat_id,))
        execute_db("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        return jsonify({'success': True, 'message': 'Chat history cleared successfully.'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@chats_bp.route('/api/chats/delete', methods=['POST'])
def delete_chat():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    chat_id = request.json.get('chat_id')
    if not chat_id:
        return jsonify({'error': 'Chat ID is required'}), 400
    
    current_user_id = session['user_id']
    
    # Verify user is part of layout
    chat = query_db("""
        SELECT * FROM chats 
        WHERE id = ? AND (
            (is_group = 0 AND (user1_id = ? OR user2_id = ?)) OR 
            (is_group = 1 AND id IN (SELECT chat_id FROM group_members WHERE user_id = ?))
        )
    """, (chat_id, current_user_id, current_user_id, current_user_id), one=True)
    
    if not chat:
        return jsonify({'error': 'Chat not found or unauthorized access'}), 404
    
    try:
        # Delete related reactions of messages
        execute_db("DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)", (chat_id,))
        # Delete related files
        execute_db("DELETE FROM files WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)", (chat_id,))
        # Delete related messages
        execute_db("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        # Delete group members if any
        execute_db("DELETE FROM group_members WHERE chat_id = ?", (chat_id,))
        # Delete the chat itself
        execute_db("DELETE FROM chats WHERE id = ?", (chat_id,))
        
        return jsonify({'success': True, 'message': 'Chat deleted successfully.'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@chats_bp.route('/api/profile/update', methods=['POST'])
def update_profile():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    user_id = session['user_id']
    username = request.form.get('username', '').strip()
    bio = request.form.get('bio', '').strip()
    
    if not username:
        return jsonify({'error': 'Username cannot be empty'}), 400
        
    # Check username uniqueness if altered
    existing = query_db("SELECT id FROM users WHERE username = ? AND id != ?", (username, user_id), one=True)
    if existing:
        return jsonify({'error': 'Username is already taken'}), 400
        
    profile_p = None
    if 'profile_picture' in request.files:
        file = request.files['profile_picture']
        if file and file.filename != '' and allowed_file(file.filename, 'image'):
            # Generate a unique secure filename
            filename = secure_filename(file.filename)
            unique_filename = f"avatar_{uuid.uuid4().hex}_{filename}"
            filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], unique_filename)
            file.save(filepath)
            profile_p = f"/static/uploads/{unique_filename}"
            
    if profile_p:
        execute_db(
            "UPDATE users SET username = ?, bio = ?, profile_picture = ? WHERE id = ?",
            (username, bio, profile_p, user_id)
        )
        session['username'] = username
        return jsonify({'success': True, 'username': username, 'bio': bio, 'profile_picture': profile_p})
    else:
        execute_db(
            "UPDATE users SET username = ?, bio = ? WHERE id = ?",
            (username, bio, user_id)
        )
        session['username'] = username
        return jsonify({'success': True, 'username': username, 'bio': bio})

@chats_bp.route('/api/settings/update', methods=['POST'])
def update_settings():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    user_id = session['user_id']
    theme = request.json.get('theme')
    wallpaper = request.json.get('wallpaper')
    last_seen_visibility = request.json.get('last_seen_visibility')
    read_receipts = request.json.get('read_receipts')
    sound_enabled = request.json.get('sound_enabled')
    
    # Build query dynamically depending on payload
    fields = []
    params = []
    
    if theme is not None:
        fields.append("theme = ?")
        params.append(theme)
    if wallpaper is not None:
        fields.append("wallpaper = ?")
        params.append(wallpaper)
    if last_seen_visibility is not None:
        fields.append("last_seen_visibility = ?")
        params.append(1 if last_seen_visibility else 0)
    if read_receipts is not None:
        fields.append("read_receipts = ?")
        params.append(1 if read_receipts else 0)
    if sound_enabled is not None:
        fields.append("sound_enabled = ?")
        params.append(1 if sound_enabled else 0)
        
    if not fields:
        return jsonify({'error': 'No fields to update'}), 400
        
    params.append(user_id)
    query = f"UPDATE settings SET {', '.join(fields)} WHERE user_id = ?"
    
    try:
        execute_db(query, tuple(params))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@chats_bp.route('/api/account/password', methods=['POST'])
def change_password():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    user_id = session['user_id']
    old_pw = request.json.get('old_password')
    new_pw = request.json.get('new_password')
    
    if not old_pw or not new_pw:
        return jsonify({'error': 'Both old and new passwords are required'}), 400
        
    user = query_db("SELECT password_hash FROM users WHERE id = ?", (user_id,), one=True)
    if not user or not check_password_hash(user['password_hash'], old_pw):
        return jsonify({'error': 'Incorrect current password. Please fill correct current password.'}), 400
        
    if len(new_pw) < 6:
        return jsonify({'error': 'New password must be at least 6 characters long'}), 400
        
    try:
        new_hash = generate_password_hash(new_pw)
        execute_db("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user_id))
        return jsonify({'success': True, 'message': 'Password updated successfully.'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@chats_bp.route('/api/upload-file', methods=['POST'])
def upload_file():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    chat_id = request.form.get('chat_id')
    reply_to_id = request.form.get('reply_to_id')
    
    if not chat_id:
        return jsonify({'error': 'Chat ID is required'}), 400
        
    if 'file' not in request.files:
        return jsonify({'error': 'No file segment found'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
        
    if not allowed_file(file.filename):
        return jsonify({'error': 'File type not allowed'}), 400
        
    try:
        sender_id = session['user_id']
        filename = secure_filename(file.filename)
        unique_name = f"file_{uuid.uuid4().hex}_{filename}"
        filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], unique_name)
        
        file.save(filepath)
        web_path = f"/static/uploads/{unique_name}"
        
        # Determine files type
        ext = filename.rsplit('.', 1)[1].lower() if '.' in filename else ''
        file_category = 'file'
        if ext in {'png', 'jpg', 'jpeg', 'gif', 'webp'}:
            file_category = 'image'
        elif ext in {'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'}:
            file_category = 'video'
            
        file_size = os.path.getsize(filepath)
        
        # Handle optional replying caching
        reply_to_text = None
        reply_to_sender = None
        if reply_to_id:
            parent_msg = query_db("SELECT text, sender_id FROM messages WHERE id = ?", (reply_to_id,), one=True)
            if parent_msg:
                reply_to_text = parent_msg['text']
                sender_info = query_db("SELECT username FROM users WHERE id = ?", (parent_msg['sender_id'],), one=True)
                if sender_info:
                    reply_to_sender = sender_info['username']
        
        # Determine initial deliver state (single tick = 1, double tick = 2) for uploads
        is_delivered = 1
        chat_info = query_db("SELECT user1_id, user2_id, is_group FROM chats WHERE id = ?", (chat_id,), one=True)
        if chat_info and chat_info['is_group'] == 0:
            recipient_id = chat_info['user2_id'] if chat_info['user1_id'] == sender_id else chat_info['user1_id']
            rec_user = query_db("SELECT is_online FROM users WHERE id = ?", (recipient_id,), one=True)
            if rec_user and rec_user['is_online'] == 1:
                is_delivered = 2
        elif chat_info and chat_info['is_group'] == 1:
            is_delivered = 2 # Groups default to double ticks since multiple people could receive

        # Insert message
        msg_id = insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, file_path, file_name, is_delivered, is_seen, reply_to_id, reply_to_text, reply_to_sender) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
            (chat_id, sender_id, filename, file_category, web_path, filename, is_delivered, reply_to_id, reply_to_text, reply_to_sender)
        )
        
        # Insert files table entry
        insert_db(
            "INSERT INTO files (message_id, file_path, file_name, file_size, file_type) VALUES (?, ?, ?, ?, ?)",
            (msg_id, web_path, filename, file_size, file_category)
        )
        
        inserted_message = query_db("SELECT * FROM messages WHERE id = ?", (msg_id,), one=True)
        inserted_msg_dict = dict(inserted_message)
        inserted_msg_dict['reactions'] = []
        
        sender_info = query_db("SELECT username, profile_picture FROM users WHERE id = ?", (sender_id,), one=True)
        inserted_msg_dict['sender_username'] = sender_info['username'] if sender_info else 'User'
        inserted_msg_dict['sender_profile_picture'] = sender_info['profile_picture'] if sender_info else '/static/images/default_avatar.svg'
        
        # Broadcast immediately over sockets
        from app import socketio
        socketio.emit('receive_message', inserted_msg_dict, room=f"chat_{chat_id}")
        
        # Trigger chat list refresh
        if chat_info:
            if chat_info['is_group'] == 1:
                group_members_list = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
                for gm in group_members_list:
                    socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{gm['user_id']}")
            else:
                recipient_id = chat_info['user2_id'] if chat_info['user1_id'] == sender_id else chat_info['user1_id']
                socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{recipient_id}")
                socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{sender_id}")
            
        return jsonify(inserted_msg_dict)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Create Group Chat
@chats_bp.route('/api/groups/create', methods=['POST'])
def create_group():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    current_user_id = session['user_id']
    group_name = request.json.get('group_name', '').strip()
    group_description = request.json.get('group_description', '').strip()
    recipient_ids = request.json.get('recipient_ids', []) # Array of user IDs to add initially
    
    if not group_name:
        return jsonify({'error': 'Group Name is required'}), 400
        
    try:
        # Insert a new record in chats
        # is_group = 1, owner_id = current_user_id
        chat_id = insert_db(
            "INSERT INTO chats (is_group, group_name, group_description, owner_id) VALUES (1, ?, ?, ?)",
            (group_name, group_description, current_user_id)
        )
        
        # Add owner to group_members
        insert_db(
            "INSERT INTO group_members (chat_id, user_id, role) VALUES (?, ?, 'owner')",
            (chat_id, current_user_id)
        )
        
        # Add initial members
        for u_id in recipient_ids:
            try:
                # Exclude owner if they are already in list
                if int(u_id) != int(current_user_id):
                    insert_db(
                        "INSERT INTO group_members (chat_id, user_id, role) VALUES (?, ?, 'member')",
                        (chat_id, int(u_id))
                    )
            except Exception:
                pass
                
        # Send a system notification message inside the group!
        sys_text = "Group created successfully"
        insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, is_delivered) VALUES (?, NULL, ?, 'text', 2)",
            (chat_id, sys_text)
        )
        
        # Trigger sockets for list updates for everyone added
        from app import socketio
        all_included = [current_user_id] + [int(uid) for uid in recipient_ids]
        for user_item in set(all_included):
            socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{user_item}")
            
        return jsonify({'success': True, 'chat_id': chat_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Fetch Group Members
@chats_bp.route('/api/groups/<int:chat_id>/members', methods=['GET'])
def get_group_members(chat_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    
    # Check if user is a member of the group
    is_member = query_db("SELECT id FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, current_user_id), one=True)
    if not is_member:
        return jsonify({'error': 'Unauthorized. You are not a member of this group.'}), 403
        
    members = query_db("""
        SELECT u.id, COALESCE(u.display_name || ' (' || u.username || ')', u.username) AS username, u.profile_picture, u.bio, u.is_online, u.last_seen, gm.role 
        FROM group_members gm
        JOIN users u ON gm.user_id = u.id
        WHERE gm.chat_id = ?
        ORDER BY CASE gm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, u.username ASC
    """, (chat_id,))
    
    return jsonify([dict(m) for m in members])


# Add New Members to Group
@chats_bp.route('/api/groups/<int:chat_id>/members/add', methods=['POST'])
def add_group_members(chat_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    user_ids = request.json.get('user_ids', [])
    
    # Check if current user is owner or admin in group
    role_row = query_db("SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, current_user_id), one=True)
    if not role_row or role_row['role'] not in ('owner', 'admin'):
        return jsonify({'error': 'Only Group Owners or Admins can add members.'}), 403
        
    added_names = []
    for u_id in user_ids:
        try:
            user_info = query_db("SELECT username FROM users WHERE id = ?", (int(u_id),), one=True)
            if user_info:
                insert_db("INSERT INTO group_members (chat_id, user_id, role) VALUES (?, ?, 'member')", (chat_id, int(u_id)))
                added_names.append(user_info['username'])
        except Exception:
            pass
            
    if added_names:
        # Save a system notification message
        updater = query_db("SELECT username FROM users WHERE id = ?", (current_user_id,), one=True)
        updater_name = updater['username'] if updater else 'Admin'
        sys_text = f"{updater_name} added {', '.join(added_names)}"
        insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, is_delivered) VALUES (?, NULL, ?, 'text', 2)",
            (chat_id, sys_text)
        )
        
        # Trigger sockets room alert
        from app import socketio
        # Alert all new/existing members
        all_members = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
        for m in all_members:
            socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{m['user_id']}")
            
        # Emit system message immediately to live chat
        sys_msg = query_db("SELECT * FROM messages WHERE chat_id = ? AND sender_id IS NULL ORDER BY id DESC LIMIT 1", (chat_id,), one=True)
        if sys_msg:
            sys_msg_dict = dict(sys_msg)
            sys_msg_dict['reactions'] = []
            socketio.emit('receive_message', sys_msg_dict, room=f"chat_{chat_id}")
            
    return jsonify({'success': True})


# Remove Member from Group
@chats_bp.route('/api/groups/<int:chat_id>/members/remove', methods=['POST'])
def remove_group_member(chat_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    target_user_id = request.json.get('user_id')
    
    if not target_user_id:
        return jsonify({'error': 'Target User ID is required.'}), 400
        
    # Check if current user is admin/owner
    my_role_row = query_db("SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, current_user_id), one=True)
    chat_meta = query_db("SELECT owner_id FROM chats WHERE id = ?", (chat_id,), one=True)
    
    is_authorized = False
    my_role = my_role_row['role'] if my_role_row else 'member'
    if my_role in ('owner', 'admin'):
        is_authorized = True
    if chat_meta and chat_meta['owner_id'] == current_user_id:
        is_authorized = True
        my_role = 'owner'
        
    if not is_authorized:
        return jsonify({'error': 'Only Group Owners or Admins can remove members.'}), 403
        
    # Check target role (cannot remove owners, and admins can't remove other admins or owners)
    target_role_row = query_db("SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, target_user_id), one=True)
    if not target_role_row:
        return jsonify({'error': 'Target user is not a member of this group.'}), 404
        
    target_role = target_role_row['role']
    if chat_meta and chat_meta['owner_id'] == target_user_id:
        target_role = 'owner'
        
    if target_role == 'owner':
        return jsonify({'error': 'Cannot remove the group owner.'}), 400
        
    if my_role == 'admin' and target_role == 'admin':
        return jsonify({'error': 'Admins cannot remove other admins. Only owners can.'}), 403
        
    try:
        user_info = query_db("SELECT username FROM users WHERE id = ?", (target_user_id,), one=True)
        execute_db("DELETE FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, target_user_id))
        
        # Save system message
        updater = query_db("SELECT username FROM users WHERE id = ?", (current_user_id,), one=True)
        updater_name = updater['username'] if updater else 'Admin'
        sys_text = f"{updater_name} removed {user_info['username'] if user_info else 'User'}"
        insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, is_delivered) VALUES (?, NULL, ?, 'text', 2)",
            (chat_id, sys_text)
        )
        
        # Sockets notification
        from app import socketio
        # Alert remaining members & the removed user so their chat list updates/clears
        socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{target_user_id}")
        socketio.emit('group_removed', {'chat_id': chat_id}, room=f"user_{target_user_id}")
        
        all_members = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
        for m in all_members:
            socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{m['user_id']}")
            
        sys_msg = query_db("SELECT * FROM messages WHERE chat_id = ? AND sender_id IS NULL ORDER BY id DESC LIMIT 1", (chat_id,), one=True)
        if sys_msg:
            sys_msg_dict = dict(sys_msg)
            sys_msg_dict['reactions'] = []
            socketio.emit('receive_message', sys_msg_dict, room=f"chat_{chat_id}")
            
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Promote Member to Admin
@chats_bp.route('/api/groups/<int:chat_id>/members/promote', methods=['POST'])
def promote_group_member(chat_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    target_user_id = request.json.get('user_id')
    
    if not target_user_id:
        return jsonify({'error': 'Target User ID is required.'}), 400
        
    # Check if current user is owner (only owner can promote admins)
    my_role_row = query_db("SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, current_user_id), one=True)
    chat_meta = query_db("SELECT owner_id FROM chats WHERE id = ?", (chat_id,), one=True)
    
    is_owner = False
    if my_role_row and my_role_row['role'] == 'owner':
        is_owner = True
    if chat_meta and chat_meta['owner_id'] == current_user_id:
        is_owner = True
        
    if not is_owner:
        return jsonify({'error': 'Only the Group Owner (creator) can promote members.'}), 403
        
    try:
        execute_db("UPDATE group_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?", (chat_id, target_user_id))
        
        user_info = query_db("SELECT username FROM users WHERE id = ?", (target_user_id,), one=True)
        updater = query_db("SELECT username FROM users WHERE id = ?", (current_user_id,), one=True)
        updater_name = updater['username'] if updater else 'Admin'
        sys_text = f"{updater_name} promoted {user_info['username'] if user_info else 'User'} to Admin"
        insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, is_delivered) VALUES (?, NULL, ?, 'text', 2)",
            (chat_id, sys_text)
        )
        
        from app import socketio
        all_members = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
        for m in all_members:
            socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{m['user_id']}")
            
        sys_msg = query_db("SELECT * FROM messages WHERE chat_id = ? AND sender_id IS NULL ORDER BY id DESC LIMIT 1", (chat_id,), one=True)
        if sys_msg:
            sys_msg_dict = dict(sys_msg)
            sys_msg_dict['reactions'] = []
            socketio.emit('receive_message', sys_msg_dict, room=f"chat_{chat_id}")
            
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Demote Admin to Member
@chats_bp.route('/api/groups/<int:chat_id>/members/demote', methods=['POST'])
def demote_group_member(chat_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    target_user_id = request.json.get('user_id')
    
    if not target_user_id:
        return jsonify({'error': 'Target User ID is required.'}), 400
        
    # Check if current user is owner (only owner can demote admins)
    my_role_row = query_db("SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, current_user_id), one=True)
    chat_meta = query_db("SELECT owner_id FROM chats WHERE id = ?", (chat_id,), one=True)
    
    is_owner = False
    if my_role_row and my_role_row['role'] == 'owner':
        is_owner = True
    if chat_meta and chat_meta['owner_id'] == current_user_id:
        is_owner = True
        
    if not is_owner:
        return jsonify({'error': 'Only the Group Owner can demote admins.'}), 403
        
    try:
        execute_db("UPDATE group_members SET role = 'member' WHERE chat_id = ? AND user_id = ?", (chat_id, target_user_id))
        
        user_info = query_db("SELECT username FROM users WHERE id = ?", (target_user_id,), one=True)
        updater = query_db("SELECT username FROM users WHERE id = ?", (current_user_id,), one=True)
        updater_name = updater['username'] if updater else 'Admin'
        sys_text = f"{updater_name} demoted {user_info['username'] if user_info else 'User'} to Member"
        insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, is_delivered) VALUES (?, NULL, ?, 'text', 2)",
            (chat_id, sys_text)
        )
        
        from app import socketio
        all_members = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
        for m in all_members:
            socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{m['user_id']}")
            
        sys_msg = query_db("SELECT * FROM messages WHERE chat_id = ? AND sender_id IS NULL ORDER BY id DESC LIMIT 1", (chat_id,), one=True)
        if sys_msg:
            sys_msg_dict = dict(sys_msg)
            sys_msg_dict['reactions'] = []
            socketio.emit('receive_message', sys_msg_dict, room=f"chat_{chat_id}")
            
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Leave Group
@chats_bp.route('/api/groups/<int:chat_id>/leave', methods=['POST'])
def leave_group(chat_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    
    # Check if target user is owner
    my_role_row = query_db("SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, current_user_id), one=True)
    chat_meta = query_db("SELECT owner_id FROM chats WHERE id = ?", (chat_id,), one=True)
    
    if not my_role_row:
        if chat_meta and chat_meta['owner_id'] == current_user_id:
            execute_db("INSERT OR IGNORE INTO group_members (chat_id, user_id, role) VALUES (?, ?, 'owner')", (chat_id, current_user_id))
            my_role_row = {'role': 'owner'}
        else:
            return jsonify({'error': 'You are not a member of this group.'}), 400
            
    my_role = my_role_row['role'] if my_role_row else 'member'
    if chat_meta and chat_meta['owner_id'] == current_user_id:
        my_role = 'owner'
        
    if my_role == 'owner':
        # Owner leaving: promote first admin to owner, or if no admin/members, delete the chat
        admins = query_db("SELECT user_id FROM group_members WHERE chat_id = ? AND role = 'admin' LIMIT 1", (chat_id,))
        if admins:
            new_owner = admins[0]['user_id']
            execute_db("UPDATE group_members SET role = 'owner' WHERE chat_id = ? AND user_id = ?", (chat_id, new_owner))
            execute_db("UPDATE chats SET owner_id = ? WHERE id = ?", (new_owner, chat_id))
        else:
            members = query_db("SELECT user_id FROM group_members WHERE chat_id = ? AND user_id != ? LIMIT 1", (chat_id, current_user_id))
            if members:
                new_owner = members[0]['user_id']
                execute_db("UPDATE group_members SET role = 'owner' WHERE chat_id = ? AND user_id = ?", (chat_id, new_owner))
                execute_db("UPDATE chats SET owner_id = ? WHERE id = ?", (new_owner, chat_id))
                
    try:
        user_info = query_db("SELECT username FROM users WHERE id = ?", (current_user_id,), one=True)
        execute_db("DELETE FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, current_user_id))
        
        # Check if group is empty now
        rem = query_db("SELECT COUNT(*) as count FROM group_members WHERE chat_id = ?", (chat_id,), one=True)
        if rem and rem['count'] == 0:
            # Delete group indices entirely
            execute_db("DELETE FROM files WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)", (chat_id,))
            execute_db("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
            execute_db("DELETE FROM chats WHERE id = ?", (chat_id,))
            return jsonify({'success': True, 'cleared': True})
            
        # Send system message
        sys_text = f"{user_info['username'] if user_info else 'User'} left the group"
        insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, is_delivered) VALUES (?, NULL, ?, 'text', 2)",
            (chat_id, sys_text)
        )
        
        from app import socketio
        socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{current_user_id}")
        socketio.emit('group_removed', {'chat_id': chat_id}, room=f"user_{current_user_id}")
        
        all_members = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
        for m in all_members:
            socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{m['user_id']}")
            
        sys_msg = query_db("SELECT * FROM messages WHERE chat_id = ? AND sender_id IS NULL ORDER BY id DESC LIMIT 1", (chat_id,), one=True)
        if sys_msg:
            sys_msg_dict = dict(sys_msg)
            sys_msg_dict['reactions'] = []
            socketio.emit('receive_message', sys_msg_dict, room=f"chat_{chat_id}")
            
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Edit Group Meta Settings
@chats_bp.route('/api/groups/<int:chat_id>/settings', methods=['POST'])
def update_group_settings(chat_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
        
    current_user_id = session['user_id']
    
    # Verify current user role
    my_role_row = query_db("SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, current_user_id), one=True)
    chat_meta = query_db("SELECT group_name, group_description, group_avatar, group_edit_permission, group_send_permission, owner_id FROM chats WHERE id = ?", (chat_id,), one=True)
    if not chat_meta:
        return jsonify({'error': 'Group not found.'}), 404
        
    # Standard fallback
    is_owner = (chat_meta['owner_id'] == current_user_id)
    user_role = my_role_row['role'] if my_role_row else ('owner' if is_owner else 'member')
    
    # Enforce only owner/admin can update group settings
    if user_role not in ('owner', 'admin'):
        return jsonify({'error': 'Only Group Owners or Admins are allowed to edit details.'}), 403
        
    group_name = request.form.get('group_name', '').strip()
    group_description = request.form.get('group_description', '').strip()
    
    # Read permission inputs (Only Group Creator/Owner is allowed to modify permission settings)
    group_edit_permission = request.form.get('group_edit_permission', chat_meta['group_edit_permission'])
    group_send_permission = request.form.get('group_send_permission', chat_meta['group_send_permission'])
    
    if not group_name:
        return jsonify({'error': 'Group Name cannot be empty.'}), 400
        
    # Standard admin or user trying to alter settings they shouldn't be allowed to change:
    if user_role != 'owner':
        # Enforce keeping existing permissions
        group_edit_permission = chat_meta['group_edit_permission']
        group_send_permission = chat_meta['group_send_permission']
        
    group_p = None
    if 'group_avatar' in request.files:
        file = request.files['group_avatar']
        if file and file.filename != '' and allowed_file(file.filename, 'image'):
            filename = secure_filename(file.filename)
            unique_filename = f"group_{uuid.uuid4().hex}_{filename}"
            filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], unique_filename)
            file.save(filepath)
            group_p = f"/static/uploads/{unique_filename}"
            
    try:
        if group_p:
            execute_db(
                "UPDATE chats SET group_name = ?, group_description = ?, group_avatar = ?, group_edit_permission = ?, group_send_permission = ? WHERE id = ?",
                (group_name, group_description, group_p, group_edit_permission, group_send_permission, chat_id)
            )
        else:
            execute_db(
                "UPDATE chats SET group_name = ?, group_description = ?, group_edit_permission = ?, group_send_permission = ? WHERE id = ?",
                (group_name, group_description, group_edit_permission, group_send_permission, chat_id)
            )
            
        # Send system message notify change
        user_row = query_db("SELECT username FROM users WHERE id = ?", (current_user_id,), one=True)
        updater_name = user_row['username'] if user_row else 'Member'
        
        changes = []
        if chat_meta['group_name'] != group_name:
            changes.append(f"name to \"{group_name}\"")
        if group_p:
            changes.append("profile picture")
        if chat_meta['group_description'] != group_description:
            changes.append("description")
        if chat_meta['group_edit_permission'] != group_edit_permission or chat_meta['group_send_permission'] != group_send_permission:
            changes.append("permissions")
            
        if not changes:
            sys_text = f"{updater_name} updated group details"
        else:
            if len(changes) == 1:
                sys_text = f"{updater_name} updated group {changes[0]}"
            elif len(changes) == 2:
                sys_text = f"{updater_name} updated group {changes[0]} and {changes[1]}"
            else:
                sys_text = f"{updater_name} updated group " + ", ".join(changes[:-1]) + f", and {changes[-1]}"

        insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, is_delivered) VALUES (?, NULL, ?, 'text', 2)",
            (chat_id, sys_text)
        )
        
        # Notify sockets
        from app import socketio
        all_members = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
        for m in all_members:
            socketio.emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{m['user_id']}")
            
        # Trigger live metadata update details room
        socketio.emit('group_meta_updated', {
            'chat_id': chat_id,
            'group_name': group_name,
            'group_description': group_description,
            'group_avatar': group_p or chat_meta['group_avatar'],
            'group_edit_permission': group_edit_permission,
            'group_send_permission': group_send_permission
        }, room=f"chat_{chat_id}")
        
        sys_msg = query_db("SELECT * FROM messages WHERE chat_id = ? AND sender_id IS NULL ORDER BY id DESC LIMIT 1", (chat_id,), one=True)
        if sys_msg:
            sys_msg_dict = dict(sys_msg)
            sys_msg_dict['reactions'] = []
            socketio.emit('receive_message', sys_msg_dict, room=f"chat_{chat_id}")
            
        return jsonify({
            'success': True,
            'group_name': group_name,
            'group_description': group_description,
            'group_avatar': group_p or chat_meta['group_avatar'],
            'group_edit_permission': group_edit_permission,
            'group_send_permission': group_send_permission
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

