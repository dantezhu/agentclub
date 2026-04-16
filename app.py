import os
from flask import Flask, send_from_directory
from flask_socketio import SocketIO
from config import Config
import models

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config.from_object(Config)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading", max_http_buffer_size=50 * 1024 * 1024)

# Register HTTP routes
from routes import api
app.register_blueprint(api)

# Register Socket.IO events
from socket_events import register_events
register_events(socketio)


@app.route("/")
def index():
    return send_from_directory("templates", "login.html")


@app.route("/chat")
def chat_page():
    return send_from_directory("templates", "chat.html")


@app.before_request
def ensure_db():
    if not hasattr(app, "_db_initialized"):
        models.init_db()
        os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
        app._db_initialized = True


if __name__ == "__main__":
    models.init_db()
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
    socketio.run(app, host="0.0.0.0", port=5555, debug=True)
