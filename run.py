import subprocess
import sys
import os
import traceback

log_file_path = os.path.join(os.path.abspath(os.path.dirname(__file__)), "bootstrap_log.txt")

def write_log(message):
    print(message, flush=True)
    with open(log_file_path, "a") as f:
        f.write(message + "\n")

# Initialize and empty the log file
with open(log_file_path, "w") as f:
    f.write("=== Bootstrapper log ===\n")

write_log(f"Current executable: {sys.executable}")
write_log(f"Current sys.path before bootstrap: {sys.path}")

# Self-bootstrap critical python dependencies if missing inside starting containers
try:
    import flask
    import flask_socketio
    write_log("Flask and flask_socketio were successfully imported at startup.")
except ImportError as initial_import_err:
    write_log(f"Initial import of Flask or flask_socketio failed: {str(initial_import_err)}")
    write_log("[ChatD] Critical dependencies missing. Starting self-bootstrapper...")
    
    # 1. Probe or install pip
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "--version"])
        write_log("pip is available.")
    except Exception as pip_check_err:
        write_log(f"[ChatD] pip is missing or check failed: {str(pip_check_err)}. Fetching official get-pip module...")
        try:
            import urllib.request
            urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", "get-pip.py")
            subprocess.check_call([sys.executable, "get-pip.py", "--user"])
            write_log("get-pip.py completed successfully with --user.")
            if os.path.exists("get-pip.py"):
                os.remove("get-pip.py")
        except Exception as e:
            write_log(f"[ChatD] Bootstrapping pip failed: {str(e)}")
            write_log(traceback.format_exc())
            sys.exit(1)
            
    # 2. Install requirements using pip
    try:
        req_file = os.path.join(os.path.abspath(os.path.dirname(__file__)), "requirements.txt")
        write_log(f"[ChatD] Running pip install from {req_file}...")
        
        # Try installing without --user (system environment)
        # We can also add --break-system-packages if it's Debian 12
        try:
            write_log("Attempting pip install to system packages...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", req_file, "--break-system-packages"])
            write_log("Pip install to system packages succeeded!")
        except Exception as system_install_err:
            write_log(f"System install failed ({str(system_install_err)}). Trying install with --user...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "-r", req_file])
            write_log("Pip install with --user site-packages succeeded!")
            
        write_log("[ChatD] Bootstrapper finished successfully. Loading modules...")
    except Exception as e:
        write_log(f"[ChatD] Pip install failed: {str(e)}")
        write_log(traceback.format_exc())
        sys.exit(1)

# Ensure the newly installed paths are registered
try:
    import site
    import importlib
    
    importlib.reload(site)
    
    # Add user site packages if exists
    if hasattr(site, 'getusersitepackages'):
        user_site = site.getusersitepackages()
        write_log(f"User site packages directory: {user_site}")
        if user_site and user_site not in sys.path:
            sys.path.insert(0, user_site)
            write_log("Inserted user site packages directory to sys.path.")
            
    # Add other site-packages directories (e.g. standard user site prefixes)
    if hasattr(site, 'getsitepackages'):
        for site_dir in site.getsitepackages():
            if site_dir not in sys.path:
                sys.path.append(site_dir)
                write_log(f"Added site package directory: {site_dir}")
                
    importlib.invalidate_caches()
    write_log(f"Final sys.path is: {sys.path}")
    
    # Try imports again to confirm success
    import flask
    import flask_socketio
    write_log("Flask and flask_socketio successfully loaded after path registration!")
except Exception as post_bootstrap_err:
    write_log(f"Post bootstrap import verification failed: {str(post_bootstrap_err)}")
    write_log(traceback.format_exc())

# Run the socket application on Port 3000 (Required by Cloud Run routing) or dynamic PORT env var
try:
    from app import create_app, socketio
    application = create_app()
except Exception as e:
    with open("error_debug.txt", "w") as f:
        f.write("Startup Import/Init Error:\n")
        f.write(traceback.format_exc())
    write_log(f"Failed to initialize app: {str(e)}")
    write_log(traceback.format_exc())
    raise e

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    write_log(f"[ChatD] Starting Socket.io server on HTTP://0.0.0.0:{port}...")
    try:
        socketio.run(application, host='0.0.0.0', port=port, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
    except Exception as e:
        with open("error_debug.txt", "w") as f:
            f.write("Runtime Run Error:\n")
            f.write(traceback.format_exc())
        write_log(f"Failed during runtime: {str(e)}")
        raise e
