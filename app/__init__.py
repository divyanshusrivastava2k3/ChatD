import os
from flask import Flask
from flask_socketio import SocketIO
from config import Config

socketio = SocketIO()

def create_app():
    flask_app = Flask(__name__)
    flask_app.config.from_object(Config)

    # Enable Werkzeug ProxyFix middleware to correctly detect HTTPS behind Cloud Run/Nginx reverse proxy
    from werkzeug.middleware.proxy_fix import ProxyFix
    flask_app.wsgi_app = ProxyFix(flask_app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

    # Ensure upload folders exist
    os.makedirs(flask_app.config['UPLOAD_FOLDER'], exist_ok=True)
    os.makedirs(os.path.join(flask_app.static_folder, 'images'), exist_ok=True)
    os.makedirs(os.path.join(flask_app.static_folder, 'css'), exist_ok=True)
    os.makedirs(os.path.join(flask_app.static_folder, 'js'), exist_ok=True)

    # Initialize database
    from app.database import init_db, close_db
    flask_app.teardown_appcontext(close_db)
    
    with flask_app.app_context():
        init_db()

    # Initialize SocketIO on Flask App
    socketio.init_app(flask_app, async_mode='threading', cors_allowed_origins="*")

    # Register routes
    from app.routes.auth import auth_bp
    from app.routes.chats import chats_bp
    flask_app.register_blueprint(auth_bp)
    flask_app.register_blueprint(chats_bp)

    import app.sockets

    return flask_app
