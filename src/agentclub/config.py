"""Server configuration.

Agent Club materializes runtime config from three layers, in increasing
priority:

    1. built-in defaults
    2. ``data-dir/config.json``
    3. explicit CLI flags

The CLI loads ``config.json``, merges any command-line overrides, and
calls ``apply_config()`` before importing the server.

JSON config file rule: keys are **UPPERCASE** and match the attributes
below (e.g. ``HOST``, ``PORT``, ``SECRET_KEY``). Unknown keys are
ignored.
"""
import os
import secrets


DEFAULT_DATA_DIR = os.path.expanduser("~/.agentclub")
DATA_DIR = os.path.abspath(DEFAULT_DATA_DIR)


def _normalize_data_dir(data_dir):
    if data_dir is None:
        data_dir = DEFAULT_DATA_DIR
    return os.path.abspath(os.path.expanduser(os.fspath(data_dir)))


def _bool(values, name, default):
    raw = values.get(name, default)
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _int(values, name, default):
    return int(values.get(name, default))


def _string(values, name, default):
    raw = values.get(name, default)
    if raw is None:
        return default
    return str(raw)


def _nonempty_string(values, name, default):
    raw = values.get(name)
    if raw is None:
        return default
    text = str(raw)
    return text or default


class Config:
    # Fixed constants. ALLOWED_EXTENSIONS is a nested set/dict that does
    # not belong in JSON config.
    ALLOWED_EXTENSIONS = {
        "image": {"png", "jpg", "jpeg", "gif", "webp"},
        "audio": {"mp3", "wav", "ogg", "m4a"},
        "video": {"mp4", "webm", "mov"},
        "file": {
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "txt", "md", "markdown", "log",
            "json", "yaml", "yml", "toml", "ini", "xml", "csv",
            "zip", "tar", "gz",
        },
    }

    HOST = None
    PORT = None
    DEBUG = None
    SECRET_KEY = None
    DATABASE_URL = None
    UPLOAD_FOLDER = None
    MEDIA_FOLDER = None
    MAX_CONTENT_LENGTH = None
    MESSAGE_PAGE_SIZE = None
    ALLOW_REGISTRATION = None
    MESSAGE_RETENTION_DAYS = None
    MESSAGE_CLEANUP_INTERVAL_SECONDS = None
    HEARTBEAT_INTERVAL = None
    ACTIVE_TIMEOUT = None
    PRESENCE_POLL_INTERVAL = None
    LOG_DIR = None
    LOG_LEVEL = None
    LOG_MAX_SIZE_MB = None
    LOG_BACKUP_COUNT = None
    SITE_NAME = None
    SITE_LOGO = None
    SITE_LOGO_TEXT = None


def _derive_logo_text(site_name):
    """Build a short 1-2 char wordmark from the site name.

    Heuristic:
      - "Agent Club" -> "AC"   (multiple ASCII words -> take initials)
      - "AgentClub"  -> "AG"   (single ASCII word -> take first 2 letters)
      - "我的团队"    -> "我的"  (CJK -> take first 2 chars)
      - empty/junk   -> "AC"   (safe fallback)

    Capped at 2 visible chars so the round mark stays legible at 24-40px.
    """
    name = (site_name or "").strip()
    if not name:
        return "AC"
    words = name.split()
    if len(words) >= 2:
        # Multiple whitespace-separated words: take leading char of each.
        # Works for both "Agent Club" -> AC and "我 的 团队" -> 我的.
        return "".join(w[0] for w in words[:2]).upper()
    # Single word -- take the first two characters as-is. Upper-casing
    # only matters for ASCII; CJK is unaffected.
    return name[:2].upper()


def _sqlite_url_from_path(path):
    if path == ":memory:":
        return "sqlite:///:memory:"
    return "sqlite:///" + os.path.abspath(os.path.expanduser(os.fspath(path)))


def apply_config(data_dir=None, values=None):
    """Apply runtime config from explicit values.

    ``values`` is normally the merged ``config.json`` + CLI override dict.
    Unknown keys are ignored by construction because only known fields
    are read below.
    """
    global DATA_DIR
    DATA_DIR = _normalize_data_dir(data_dir)
    values = values or {}

    # Network
    # Default to loopback only. To expose on LAN/public IPs, opt in with
    # ``--host 0.0.0.0`` or set HOST in config.json.
    Config.HOST = _string(values, "HOST", "127.0.0.1")
    Config.PORT = _int(values, "PORT", 5555)
    Config.DEBUG = _bool(values, "DEBUG", False)

    # Security. ``agentclub onboard`` always writes a real random key;
    # this fallback only lets ``python -m agentclub.app`` boot locally.
    Config.SECRET_KEY = _string(
        values, "SECRET_KEY", "agentclub-dev-key-do-not-use-in-prod"
    )

    # Storage
    default_database = _sqlite_url_from_path(os.path.join(DATA_DIR, "agentclub.db"))
    Config.DATABASE_URL = _nonempty_string(values, "DATABASE_URL", default_database)
    Config.MEDIA_FOLDER = _nonempty_string(
        values, "MEDIA_FOLDER", os.path.join(DATA_DIR, "media")
    )
    Config.UPLOAD_FOLDER = os.path.join(Config.MEDIA_FOLDER, "uploads")
    Config.MAX_CONTENT_LENGTH = _int(values, "MAX_CONTENT_LENGTH", 50 * 1024 * 1024)

    # Retention + feature flags + paging
    Config.ALLOW_REGISTRATION = _bool(values, "ALLOW_REGISTRATION", False)
    Config.MESSAGE_RETENTION_DAYS = _int(values, "MESSAGE_RETENTION_DAYS", 30)
    Config.MESSAGE_CLEANUP_INTERVAL_SECONDS = _int(
        values, "MESSAGE_CLEANUP_INTERVAL_SECONDS", 3600
    )
    Config.MESSAGE_PAGE_SIZE = _int(values, "MESSAGE_PAGE_SIZE", 50)

    # Presence cadences
    Config.HEARTBEAT_INTERVAL = _int(values, "HEARTBEAT_INTERVAL", 30)
    Config.ACTIVE_TIMEOUT = _int(values, "ACTIVE_TIMEOUT", 90)
    Config.PRESENCE_POLL_INTERVAL = _int(values, "PRESENCE_POLL_INTERVAL", 30)

    # Logging
    Config.LOG_DIR = _nonempty_string(values, "LOG_DIR", os.path.join(DATA_DIR, "logs"))
    Config.LOG_LEVEL = _nonempty_string(values, "LOG_LEVEL", "INFO").upper()
    Config.LOG_MAX_SIZE_MB = _int(values, "LOG_MAX_SIZE_MB", 100)
    Config.LOG_BACKUP_COUNT = _int(values, "LOG_BACKUP_COUNT", 5)

    # Branding
    Config.SITE_NAME = (_nonempty_string(values, "SITE_NAME", "Agent Club")).strip()
    Config.SITE_LOGO = (_string(values, "SITE_LOGO", "")).strip()
    explicit_text = (_string(values, "SITE_LOGO_TEXT", "")).strip()
    Config.SITE_LOGO_TEXT = explicit_text or _derive_logo_text(Config.SITE_NAME)


# Populate defaults on import so existing ``from .config import Config``
# code sees fully initialized attributes.
apply_config()


def generate_secret_key():
    """Used by ``agentclub onboard`` to mint a fresh SECRET_KEY."""
    return secrets.token_hex(32)
