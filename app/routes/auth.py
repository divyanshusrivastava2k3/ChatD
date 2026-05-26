from flask import Blueprint, render_template, request, redirect, url_for, session, flash, current_app
from werkzeug.security import generate_password_hash, check_password_hash
from app.database import query_db, insert_db, execute_db
import re
import datetime

auth_bp = Blueprint('auth', __name__)

def log_to_file(message):
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{timestamp}] {message}"
    print(formatted, flush=True)
    try:
        with open("/auth_debug.txt", "a") as f:
            f.write(formatted + "\n")
    except Exception as e:
        print(f"Error writing to auth_debug.txt: {str(e)}", flush=True)

@auth_bp.route('/signup', methods=['GET', 'POST'])
def signup():
    if 'user_id' in session:
        return redirect(url_for('chats.index'))

    if request.method == 'POST':
        mobile = request.form.get('mobile', '').strip()
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        confirm_password = request.form.get('confirm_password', '')

        log_to_file(f"[SIGNUP] Received signup attempt for username='{username}', mobile='{mobile}'")

        # Validations
        if not mobile or not username or not password or not confirm_password:
            log_to_file("[SIGNUP] Validation status: missing fields")
            flash('All fields are required.', 'error')
            return render_template('login.html', active_tab='signup')

        # Clean mobile number of common formatting characters
        cleaned_mobile = mobile.replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
        
        # Validation pattern: starts with +, has a 1-4 digit country code, and exactly 10 digits
        if not re.match(r'^\+[1-9]\d{0,3}\d{10}$', cleaned_mobile):
            log_to_file(f"[SIGNUP] Validation status: invalid mobile format for '{cleaned_mobile}'")
            flash('Mobile number must include a country code starting with + followed by exactly a 10-digit phone number (e.g., +919876543210).', 'error')
            return render_template('login.html', active_tab='signup')
            
        mobile = cleaned_mobile
        log_to_file(f"[SIGNUP] Mobile number cleaned to: '{mobile}'")

        if len(password) < 6:
            log_to_file("[SIGNUP] Validation status: password too short")
            flash('Password must be at least 6 characters long.', 'error')
            return render_template('login.html', active_tab='signup')

        if password != confirm_password:
            log_to_file("[SIGNUP] Validation status: passwords do not match")
            flash('Passwords do not match.', 'error')
            return render_template('login.html', active_tab='signup')

        # Check unique username
        existing_user = query_db("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", (username,), one=True)
        if existing_user:
            log_to_file(f"[SIGNUP] Username already taken: {username}")
            flash('Username is already taken.', 'error')
            return render_template('login.html', active_tab='signup')

        # Check unique mobile number
        existing_mobile = query_db("SELECT * FROM users WHERE mobile = ?", (mobile,), one=True)
        if existing_mobile:
            log_to_file(f"[SIGNUP] Mobile already registered: {mobile}")
            flash('Mobile number is already registered with another account.', 'error')
            return render_template('login.html', active_tab='signup')

        try:
            # Hash password and insert user
            password_hash = generate_password_hash(password)
            user_id = insert_db(
                "INSERT INTO users (username, display_name, mobile, password_hash) VALUES (?, ?, ?, ?)",
                (username, username, mobile, password_hash)
            )
            log_to_file(f"[SIGNUP] User inserted successfully with ID: {user_id}")
            
            # Create default settings for this user
            insert_db(
                "INSERT INTO settings (user_id, theme, wallpaper, last_seen_visibility, read_receipts, sound_enabled) VALUES (?, 'light', 'none', 1, 1, 1)",
                (user_id,)
            )
            log_to_file(f"[SIGNUP] Settings created for user ID: {user_id}")
            
            flash('Account created successfully! Please sign in.', 'success')
            return redirect(url_for('auth.login'))
        except Exception as e:
            log_to_file(f"[SIGNUP] Exception occurred during insert: {str(e)}")
            flash(f'An error occurred: {str(e)}', 'error')
            return render_template('login.html', active_tab='signup')

    return render_template('login.html', active_tab='signup')

@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('chats.index'))

    if request.method == 'POST':
        login_id = request.form.get('login_id', '').strip() # Can be username or mobile
        password = request.form.get('password', '')

        log_to_file(f"[LOGIN] Received login attempt for login_id='{login_id}'")

        if not login_id or not password:
            log_to_file("[LOGIN] Missing credentials")
            flash('Please fill in all fields.', 'error')
            return render_template('login.html', active_tab='login')

        # Clean login option if it represents/contains a mobile number
        cleaned_login_id = login_id
        is_phone_like = False
        if login_id.startswith('+') or any(char.isdigit() for char in login_id):
            # Strip standard formatting, spaces, brackets, and leading '+'
            cleaned_digits = login_id.replace(" ", "").replace("-", "").replace("(", "").replace(")", "").replace("+", "")
            is_phone_like = cleaned_digits.isdigit()
            if is_phone_like:
                cleaned_login_id = cleaned_digits

        log_to_file(f"[LOGIN] Parsed: is_phone_like={is_phone_like}, cleaned_login_id='{cleaned_login_id}'")

        # Find potential matched user records
        matched_users = []
        if is_phone_like:
            # Try with prepended '+'
            with_plus = "+" + cleaned_login_id
            # Try last 10 digits exact match
            last_10 = cleaned_login_id[-10:] if len(cleaned_login_id) >= 10 else None
            
            if last_10 and len(last_10) == 10:
                log_to_file(f"[LOGIN] Searching phone-like targets with last_10='{last_10}'")
                matched_users = query_db(
                    "SELECT * FROM users WHERE mobile = ? OR mobile = ? OR (length(mobile) >= 10 AND SUBSTR(mobile, -10) = ?)",
                    (login_id, with_plus, last_10)
                )
            else:
                log_to_file("[LOGIN] Searching phone-like target matches")
                matched_users = query_db(
                    "SELECT * FROM users WHERE mobile = ? OR mobile = ?",
                    (login_id, with_plus)
                )

        # If matching using phone yielded nothing, or if login_id is not phone-like, search by username (case-insensitive)
        if not matched_users:
            log_to_file("[LOGIN] Searching by username case-insensitive")
            user_by_name = query_db("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", (login_id,), one=True)
            if user_by_name:
                matched_users = [user_by_name]

        if not matched_users:
            log_to_file(f"[LOGIN] No user accounts found for ID '{login_id}'")
            flash('Invalid username/mobile or password.', 'error')
            return render_template('login.html', active_tab='login')

        log_to_file(f"[LOGIN] Found {len(matched_users)} candidate account(s) for login_id '{login_id}'")

        # Iterate through candidate accounts to find one with matching password
        user = None
        for candidate in matched_users:
            candidate_dict = dict(candidate)
            try:
                is_correct_pw = check_password_hash(candidate_dict['password_hash'], password)
                if is_correct_pw:
                    user = candidate
                    break
            except Exception as check_err:
                log_to_file(f"[LOGIN] Unable to verify hash for user ID {candidate_dict.get('id')}: {str(check_err)}")

        if not user:
            log_to_file("[LOGIN] auth_status: password mismatch for candidates")
            flash('Invalid username/mobile or password.', 'error')
            return render_template('login.html', active_tab='login')

        # Login successful, create session
        session['user_id'] = user['id']
        session['username'] = user['username']
        log_to_file(f"[LOGIN] Session created for ID: {user['id']}")
        
        # Mark online
        execute_db("UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?", (user['id'],))
        log_to_file("[LOGIN] Marked online successfully. Redirecting to chats...")
        
        return redirect(url_for('chats.index'))

    return render_template('login.html', active_tab='login')

@auth_bp.route('/logout')
def logout():
    user_id = session.get('user_id')
    if user_id:
        # Mark offline
        execute_db("UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?", (user_id,))
    
    session.clear()
    flash('You have been logged out.', 'success')
    return redirect(url_for('auth.login'))
