"""Flask + Socket.IO application instance.

Importing this module builds the global ``app`` and ``socketio``
objects. Production entry is ``agentclub serve`` (in ``agentclub.cli``)
which sets ``AGENTCLUB_HOME`` and config env vars BEFORE importing
this file, then calls ``socketio.run``. Tests and ``python -m
agentclub.app`` also work for quick local iteration.
"""
import logging
import os
from datetime import timedelta
from flask import Flask, render_template, jsonify, request, session, redirect, url_for
from werkzeug.exceptions import HTTPException
from flask_socketio import SocketIO
from .config import Config
from . import models

log = logging.getLogger(__name__)


app = Flask(__name__, static_folder="static", template_folder="templates")
app.config.from_object(Config)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# Persistent login: by default Flask's session cookie is "browser session"
# (no Expires/Max-Age) and dies when the user quits the browser. For an IM
# app that's a worse experience than every comparable product (Feishu /
# WeChat Web etc. all keep you logged in for weeks). We mark the session
# permanent in login()/register() and cap it at 90 days here so the cookie
# carries Max-Age=90d. Idle users get re-prompted only after the cap.
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=90)

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


# Page-level auth gating happens here, *before* HTML/CSS hits the browser.
# Without this the previous flow was: server unconditionally returns the
# requested HTML → page renders → JS fetches /api/me → JS redirects. That
# made every reopen of /chat (with cookie) flash login.html for ~200ms,
# and vice versa. By 302-ing on the server we skip the wrong-template
# render entirely. Login.html still keeps a JS fallback fetch('/api/me')
# in case the cookie was forged/empty in some odd state.
@app.route("/")
def index():
    if "user_id" in session:
        return redirect(url_for("chat_page"))
    return render_template("login.html")


@app.route("/chat")
def chat_page():
    if "user_id" not in session:
        return redirect(url_for("index"))
    return render_template("chat.html")


@app.route("/admin")
def admin_page():
    # /admin checks login here but NOT role — admin.html still calls
    # /api/me to surface a friendly "需要管理员权限" message rather than a
    # raw 403, and the actual admin APIs are gated by @admin_required on
    # the server side. So this redirect just shaves the login flash for
    # the common case (admin reopens browser); non-admin users still hit
    # the in-page check.
    if "user_id" not in session:
        return redirect(url_for("index"))
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
