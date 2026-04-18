"""Flask + Socket.IO application instance.

Importing this module builds the global ``app`` and ``socketio``
objects. Production entry is ``agentclub serve`` (in ``agentclub.cli``)
which sets ``AGENTCLUB_HOME`` and config env vars BEFORE importing
this file, then calls ``socketio.run``. Tests and ``python -m
agentclub.app`` also work for quick local iteration.
"""
import os
from flask import Flask, send_from_directory
from flask_socketio import SocketIO
from .config import Config
from . import models


app = Flask(__name__, static_folder="static", template_folder="templates")
app.config.from_object(Config)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading",
                   max_http_buffer_size=50 * 1024 * 1024)

from .routes import api  # noqa: E402
app.register_blueprint(api)

from .socket_events import register_events  # noqa: E402
register_events(socketio)


@app.route("/")
def index():
    return send_from_directory(app.template_folder, "login.html")


@app.route("/chat")
def chat_page():
    return send_from_directory(app.template_folder, "chat.html")


@app.route("/admin")
def admin_page():
    return send_from_directory(app.template_folder, "admin.html")


@app.before_request
def ensure_db():
    """Lazy first-request init. Safe with the CLI too: ``onboard``
    already created the DB, and re-running ``init_db`` is idempotent."""
    if not hasattr(app, "_db_initialized"):
        models.init_db()
        os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
        app._db_initialized = True


if __name__ == "__main__":
    models.init_db()
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
    socketio.run(app, host=Config.HOST, port=Config.PORT, debug=Config.DEBUG or True)
