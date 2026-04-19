"""Flask + Socket.IO application instance.

Importing this module builds the global ``app`` and ``socketio``
objects. Production entry is ``agentclub serve`` (in ``agentclub.cli``)
which sets ``AGENTCLUB_HOME`` and config env vars BEFORE importing
this file, then calls ``socketio.run``. Tests and ``python -m
agentclub.app`` also work for quick local iteration.
"""
import logging
import os
from flask import Flask, render_template, jsonify, request
from werkzeug.exceptions import HTTPException
from flask_socketio import SocketIO
from .config import Config
from . import models

log = logging.getLogger(__name__)


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


@app.context_processor
def _inject_branding():
    """Expose Config.SITE_* to every Jinja render so templates can show
    a deployer-customised name / logomark. Read from Config (not env)
    so refresh_config() takes effect at runtime."""
    return {
        "site_name": Config.SITE_NAME,
        "site_logo": Config.SITE_LOGO,
        "site_logo_text": Config.SITE_LOGO_TEXT,
    }


@app.route("/")
def index():
    return render_template("login.html")


@app.route("/chat")
def chat_page():
    return render_template("chat.html")


@app.route("/admin")
def admin_page():
    return render_template("admin.html")


@app.before_request
def ensure_db():
    """Lazy first-request init. Safe with the CLI too: ``onboard``
    already created the DB, and re-running ``init_db`` is idempotent."""
    if not hasattr(app, "_db_initialized"):
        models.init_db()
        os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
        app._db_initialized = True


@app.errorhandler(Exception)
def _log_unhandled(e):
    """Last-resort logger for anything routes don't catch. HTTPException
    is returned as-is so Flask still serves the intended 4xx page; only
    true 5xx-class bugs hit ``log.exception`` and surface a generic 500.
    """
    if isinstance(e, HTTPException):
        return e
    log.exception("unhandled exception on %s %s", request.method, request.path)
    return jsonify({"error": "服务器内部错误"}), 500


if __name__ == "__main__":
    models.init_db()
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
    socketio.run(app, host=Config.HOST, port=Config.PORT, debug=Config.DEBUG or True)
