import os

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'chatd_super_secret_key_129381')
    
    # Session Cookie configuration for embedded iframe inside AI Studio preview
    SESSION_COOKIE_SAMESITE = 'None'
    SESSION_COOKIE_SECURE = True
    
    # Database
    BASE_DIR = os.path.abspath(os.path.dirname(__file__))
    DATABASE = os.path.join(BASE_DIR, 'chatd.db')
    
    # Uploads
    UPLOAD_FOLDER = os.path.join(BASE_DIR, 'app', 'static', 'uploads')
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB limit
    
    # Allowed file extensions
    ALLOWED_EXTENSIONS_IMAGE = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
    ALLOWED_EXTENSIONS_DOC = {'pdf', 'zip', 'txt', 'doc', 'docx'}

