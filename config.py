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
    # How long a user's `last_active_at` can go stale before we flip them
    # to offline. Any client activity (heartbeat, send_message, mark_read)
    # refreshes it; when nothing arrives for this long we treat the user
    # as offline. Should be a few multiples of HEARTBEAT_INTERVAL to
    # tolerate transient network blips.
    ACTIVE_TIMEOUT = int(os.environ.get("ACTIVE_TIMEOUT", "90"))
    # How often the web UI polls `/api/presence` to refresh the online
    # status of direct-chat peers. Delivered via `auth_ok.presence_poll_interval`
    # so a server-side config change propagates on the next reconnect.
    # Agent clients do not poll — they don't render presence.
    PRESENCE_POLL_INTERVAL = int(os.environ.get("PRESENCE_POLL_INTERVAL", "30"))
