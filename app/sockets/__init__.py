from flask import session
from flask_socketio import emit, join_room, leave_room
from app import socketio
from app.database import execute_db, query_db, insert_db

@socketio.on('connect')
def handle_connect():
    user_id = session.get('user_id')
    if user_id:
        # Mark user as online
        execute_db("UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?", (user_id,))
        join_room(f"user_{user_id}")
        # Broadcast status update
        emit('user_status_change', {'user_id': user_id, 'is_online': 1}, broadcast=True)
        
        try:
            # Mark all undelivered messages sent to this newly connected user as delivered (is_delivered = 2)
            undelivered = query_db("""
                SELECT m.id, m.chat_id, m.sender_id
                FROM messages m
                JOIN chats c ON m.chat_id = c.id
                WHERE m.is_delivered = 1 AND m.is_seen = 0 AND m.sender_id != ?
                  AND (c.user1_id = ? OR c.user2_id = ?)
            """, (user_id, user_id, user_id))
            
            if undelivered:
                for item in undelivered:
                    execute_db("UPDATE messages SET is_delivered = 2 WHERE id = ?", (item['id'],))
                
                # Notify the chats that their undelivered messages are now delivered
                chats_affected = list(set(item['chat_id'] for item in undelivered))
                for cid in chats_affected:
                    emit('messages_delivered', {'chat_id': cid}, room=f"chat_{cid}")
        except Exception as e:
            print("Delivery status check on connect error:", e)

@socketio.on('disconnect')
def handle_disconnect():
    user_id = session.get('user_id')
    if user_id:
        # Mark user as offline
        execute_db("UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?", (user_id,))
        # Broadcast status update
        emit('user_status_change', {'user_id': user_id, 'is_online': 0}, broadcast=True)

@socketio.on('join_chat')
def handle_join_chat(data):
    chat_id = data.get('chat_id')
    if chat_id:
        join_room(f"chat_{chat_id}")

@socketio.on('leave_chat')
def handle_leave_chat(data):
    chat_id = data.get('chat_id')
    if chat_id:
        leave_room(f"chat_{chat_id}")

@socketio.on('send_message')
def handle_send_message(data):
    sender_id = session.get('user_id')
    if not sender_id:
        return
    
    chat_id = data.get('chat_id')
    text = data.get('text', '').strip()
    msg_type = data.get('type', 'text')
    file_path = data.get('file_path')
    file_name = data.get('file_name')
    reply_to_id = data.get('reply_to_id')
    
    if not chat_id or (not text and not file_path):
        return
        
    # Process replying
    reply_to_text = None
    reply_to_sender = None
    if reply_to_id:
        parent_msg = query_db("SELECT text, sender_id, is_deleted FROM messages WHERE id = ?", (reply_to_id,), one=True)
        if parent_msg:
            reply_to_text = parent_msg['text'] if parent_msg['is_deleted'] == 0 else "This message was deleted"
            sender_info = query_db("SELECT username FROM users WHERE id = ?", (parent_msg['sender_id'],), one=True)
            if sender_info:
                reply_to_sender = sender_info['username']

    try:
        # Determine initial deliver state and chat metadata
        is_delivered = 1
        chat_info = query_db("SELECT user1_id, user2_id, is_group, group_send_permission FROM chats WHERE id = ?", (chat_id,), one=True)
        if chat_info:
            if chat_info['is_group'] == 1:
                is_delivered = 2 # Groups are immediately delivered
                
                # Check if group messaging is restricted to only admins
                if chat_info['group_send_permission'] == 'admins':
                    # Retrieve the sender's role
                    membership = query_db("SELECT role FROM group_members WHERE chat_id = ? AND user_id = ?", (chat_id, sender_id), one=True)
                    if not membership or membership['role'] not in ('owner', 'admin'):
                        # Message is blocked
                        return
            else:
                recipient_id = chat_info['user2_id'] if chat_info['user1_id'] == sender_id else chat_info['user1_id']
                rec_user = query_db("SELECT is_online FROM users WHERE id = ?", (recipient_id,), one=True)
                if rec_user and rec_user['is_online'] == 1:
                    is_delivered = 2

        # Save message
        msg_id = insert_db(
            "INSERT INTO messages (chat_id, sender_id, text, type, file_path, file_name, is_delivered, is_seen, reply_to_id, reply_to_text, reply_to_sender) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
            (chat_id, sender_id, text, msg_type, file_path, file_name, is_delivered, reply_to_id, reply_to_text, reply_to_sender)
        )
        
        # If it's a file, insert files table row for gallery sync too
        if file_path:
            # We can calculate size as 0 if not accessible, or fallback
            insert_db(
                "INSERT INTO files (message_id, file_path, file_name, file_size, file_type) VALUES (?, ?, ?, 0, ?)",
                (msg_id, file_path, file_name or "forwarded_file", msg_type)
            )
        
        msg = query_db("SELECT * FROM messages WHERE id = ?", (msg_id,), one=True)
        msg_dict = dict(msg)
        msg_dict['reactions'] = []
        
        # Add sender username and profile picture as group messages need to display them!
        sender_info = query_db("SELECT username, profile_picture FROM users WHERE id = ?", (sender_id,), one=True)
        msg_dict['sender_username'] = sender_info['username'] if sender_info else 'User'
        msg_dict['sender_profile_picture'] = sender_info['profile_picture'] if sender_info else '/static/images/default_avatar.svg'
        
        # Emit to chat room
        emit('receive_message', msg_dict, room=f"chat_{chat_id}")
        
        # Notify recipient room of chat update and emit message
        if chat_info:
            if chat_info['is_group'] == 1:
                group_members_list = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
                for gm in group_members_list:
                    # Emit receive message for background update trigger
                    if gm['user_id'] != sender_id:
                        emit('receive_message', msg_dict, room=f"user_{gm['user_id']}")
                    emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{gm['user_id']}")
            else:
                recipient_id = chat_info['user2_id'] if chat_info['user1_id'] == sender_id else chat_info['user1_id']
                # Emit to recipient's personal room as well to handle background alerts / counts
                emit('receive_message', msg_dict, room=f"user_{recipient_id}")
                emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{recipient_id}")
                emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{sender_id}")
    except Exception as e:
        print("Socket send_message error:", e)

@socketio.on('typing')
def handle_typing(data):
    user_id = session.get('user_id')
    if not user_id:
        return
    chat_id = data.get('chat_id')
    is_typing = data.get('is_typing', False)
    emit('typing_status', {'chat_id': chat_id, 'user_id': user_id, 'is_typing': is_typing}, room=f"chat_{chat_id}", include_self=False)

@socketio.on('message_seen')
def handle_message_seen(data):
    user_id = session.get('user_id')
    if not user_id:
        return
    chat_id = data.get('chat_id')
    if chat_id:
        user_settings = query_db("SELECT read_receipts FROM settings WHERE user_id = ?", (user_id,), one=True)
        read_receipts_enabled = True
        if user_settings and user_settings['read_receipts'] == 0:
            read_receipts_enabled = False

        if read_receipts_enabled:
            execute_db("UPDATE messages SET is_seen = 1 WHERE chat_id = ? AND sender_id != ?", (chat_id, user_id))
            emit('messages_seen', {'chat_id': chat_id, 'seen_by': user_id}, room=f"chat_{chat_id}", include_self=False)
        else:
            execute_db("UPDATE messages SET is_delivered = 2 WHERE chat_id = ? AND sender_id != ?", (chat_id, user_id))
        
        # Update both chat list statuses
        chat_info = query_db("SELECT is_group, user1_id, user2_id FROM chats WHERE id = ?", (chat_id,), one=True)
        if chat_info:
            if chat_info['is_group'] == 1:
                group_members_list = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
                for gm in group_members_list:
                    emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{gm['user_id']}")
            else:
                recipient_id = chat_info['user2_id'] if chat_info['user1_id'] == user_id else chat_info['user1_id']
                emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{recipient_id}")

@socketio.on('delete_message')
def handle_delete_message(data):
    user_id = session.get('user_id')
    if not user_id:
        return
        
    message_id = data.get('message_id')
    delete_type = data.get('delete_type') # 'self' or 'everyone'
    
    if not message_id:
        return
        
    msg = query_db("SELECT * FROM messages WHERE id = ?", (message_id,), one=True)
    if not msg:
        return
        
    chat_id = msg['chat_id']
    
    if delete_type == 'everyone':
        if msg['sender_id'] != user_id:
            # Only sender can delete for everyone
            return
        execute_db("UPDATE messages SET is_deleted = 1, text = 'This message was deleted' WHERE id = ?", (message_id,))
        emit('message_deleted_everyone', {'message_id': message_id, 'chat_id': chat_id}, room=f"chat_{chat_id}")
        
        # trigger update to recipient chat list for last message refresh
        chat_info = query_db("SELECT is_group, user1_id, user2_id FROM chats WHERE id = ?", (chat_id,), one=True)
        if chat_info:
            if chat_info['is_group'] == 1:
                group_members_list = query_db("SELECT user_id FROM group_members WHERE chat_id = ?", (chat_id,))
                for gm in group_members_list:
                    emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{gm['user_id']}")
            else:
                rec_id = chat_info['user2_id'] if chat_info['user1_id'] == user_id else chat_info['user1_id']
                emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{rec_id}")
                emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{user_id}")
            
    elif delete_type == 'self':
        current_deleted_by = msg['deleted_by'] or ""
        deleted_by_list = [x for x in current_deleted_by.split(',') if x]
        if str(user_id) not in deleted_by_list:
            deleted_by_list.append(str(user_id))
        new_deleted_by = ",".join(deleted_by_list)
        
        execute_db("UPDATE messages SET deleted_by = ? WHERE id = ?", (new_deleted_by, message_id))
        emit('message_deleted_self', {'message_id': message_id, 'chat_id': chat_id}, room=f"user_{user_id}")
        
        # trigger update of own chat list in case this was the last message displayed
        emit('chat_list_update', {'chat_id': chat_id}, room=f"user_{user_id}")

@socketio.on('add_reaction')
def handle_add_reaction(data):
    user_id = session.get('user_id')
    if not user_id:
        return
    message_id = data.get('message_id')
    emoji = data.get('emoji', '').strip()
    if not message_id or not emoji:
         return
         
    # Check if chat exists and user is part of it
    msg = query_db("SELECT chat_id FROM messages WHERE id = ?", (message_id,), one=True)
    if not msg:
        return
    chat_id = msg['chat_id']
    
    try:
        # Toggle: check if reaction already contains this exact emoji by this user
        existing = query_db("SELECT id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", (message_id, user_id, emoji), one=True)
        if existing:
            execute_db("DELETE FROM reactions WHERE id = ?", (existing['id'],))
        else:
            # Delete any existing reaction by this user on this message (one reaction limit)
            execute_db("DELETE FROM reactions WHERE message_id = ? AND user_id = ?", (message_id, user_id))
            execute_db("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)", (message_id, user_id, emoji))
            
        # Broadcast updated list
        reactions_query = query_db("""
            SELECT r.user_id, r.emoji, u.username
            FROM reactions r
            JOIN users u ON r.user_id = u.id
            WHERE r.message_id = ?
        """, (message_id,))
        
        reactions_list = [dict(r) for r in reactions_query]
        emit('reaction_update', {
            'message_id': message_id,
            'chat_id': chat_id,
            'reactions': reactions_list
        }, room=f"chat_{chat_id}")
    except Exception as e:
        print("add_reaction socket error:", e)

@socketio.on('remove_reaction')
def handle_remove_reaction(data):
    user_id = session.get('user_id')
    if not user_id:
        return
    message_id = data.get('message_id')
    if not message_id:
        return
        
    msg = query_db("SELECT chat_id FROM messages WHERE id = ?", (message_id,), one=True)
    if not msg:
        return
    chat_id = msg['chat_id']
    
    try:
        execute_db("DELETE FROM reactions WHERE message_id = ? AND user_id = ?", (message_id, user_id))
        
        # Broadcast updated list
        reactions_query = query_db("""
            SELECT r.user_id, r.emoji, u.username
            FROM reactions r
            JOIN users u ON r.user_id = u.id
            WHERE r.message_id = ?
        """, (message_id,))
        
        reactions_list = [dict(r) for r in reactions_query]
        emit('reaction_update', {
            'message_id': message_id,
            'chat_id': chat_id,
            'reactions': reactions_list
        }, room=f"chat_{chat_id}")
    except Exception as e:
        print("remove_reaction socket error:", e)
