import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "agentclub-dev-secret-key-change-me")
    DATABASE = os.path.join(BASE_DIR, "agentclub.db")
    UPLOAD_FOLDER = os.path.join(BASE_DIR, "static", "uploads")
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50MB
    ALLOWED_EXTENSIONS = {
        "image": {"png", "jpg", "jpeg", "gif", "webp", "svg"},
        "audio": {"mp3", "wav", "ogg", "m4a"},
        "video": {"mp4", "webm", "mov"},
        "file": {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "zip", "tar", "gz"},
    }
    MESSAGE_RETENTION_DAYS = int(os.environ.get("MESSAGE_RETENTION_DAYS", "30"))
    ALLOW_REGISTRATION = os.environ.get("ALLOW_REGISTRATION", "true").lower() == "true"
    # How many history messages to load per page
    MESSAGE_PAGE_SIZE = 50
    # How often (in seconds) connected clients (web + agent) should emit a
    # `heartbeat` event. The server advertises this value in the `auth_ok`
    # payload so all three clients (web, nanobot, openclaw) stay in sync
    # with a single server-side source of truth.
    HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL", "30"))
    # How long a user's last heartbeat can be stale before they count as
    # offline, regardless of the `is_online` flag in the DB. The flag alone
    # is unreliable when a socket dies silently without firing `disconnect`,
    # so we combine it with `last_seen` freshness. Should be a few multiples
    # of HEARTBEAT_INTERVAL to tolerate transient network blips.
    HEARTBEAT_TIMEOUT = int(os.environ.get("HEARTBEAT_TIMEOUT", "300"))
