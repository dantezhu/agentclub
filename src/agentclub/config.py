"""Server configuration.

All knobs are read from environment variables so that the CLI can drive
them from three layers, in increasing priority:

    1. built-in defaults (this file)
    2. ``${AGENTCLUB_HOME}/config.json``  (loaded by the CLI into env)
    3. ``--foo`` CLI flags / shell env

The CLI is responsible for translating JSON config files and CLI flags
into ``os.environ`` BEFORE this module gets imported; here we simply
read env and expose a ``Config`` class that the Flask app mounts via
``app.config.from_object(Config)``.

JSON config file rule: keys are **UPPERCASE** and match the attributes
below (e.g. ``HOST``, ``PORT``, ``SECRET_KEY``). Unknown keys are
silently ignored so forward-compatible deploys don't break on extra
fields.

``refresh_config()`` re-reads every env-backed attribute back onto the
``Config`` class. This is necessary because CLI subcommands set env
vars AFTER importing this module (via ``apply_env`` in the common
bootstrap), and class attributes otherwise stay frozen to the value at
first import.
"""
import os
import secrets


def _default_home():
    """Runtime data directory. CLI sets ``AGENTCLUB_HOME`` explicitly;
    importing this module standalone (tests, ``python -m agentclub.app``)
    falls back to ``~/.agentclub`` (Unix-style per-user config dir)."""
    return os.environ.get("AGENTCLUB_HOME") or os.path.expanduser("~/.agentclub")


def _bool(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# Module-level BASE_DIR is kept in sync by refresh_config().
BASE_DIR = _default_home()


class Config:
    # Fixed constants (not env-tunable).
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50MB
    ALLOWED_EXTENSIONS = {
        "image": {"png", "jpg", "jpeg", "gif", "webp", "svg"},
        "audio": {"mp3", "wav", "ogg", "m4a"},
        "video": {"mp4", "webm", "mov"},
        "file": {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "zip", "tar", "gz"},
    }
    MESSAGE_PAGE_SIZE = 50

    # Env-tunable fields are populated by refresh_config() at import
    # time and any time CLI ``apply_env`` runs. Keeping them declared
    # here (as None) makes IDE autocomplete happy and signals intent.
    HOST = None
    PORT = None
    DEBUG = None
    SECRET_KEY = None
    DATABASE = None
    UPLOAD_FOLDER = None
    ALLOW_REGISTRATION = None
    MESSAGE_RETENTION_DAYS = None
    HEARTBEAT_INTERVAL = None
    ACTIVE_TIMEOUT = None
    PRESENCE_POLL_INTERVAL = None


def refresh_config():
    """Re-read every env-backed Config attribute from ``os.environ``.

    Called automatically once at module import, and again by the CLI's
    ``apply_env`` so that config.json / --flag overrides take effect
    even when ``agentclub.config`` was imported earlier in the process
    (which always happens when tests + CLI share a process)."""
    global BASE_DIR
    BASE_DIR = _default_home()

    # Network
    Config.HOST = os.environ.get("HOST", "0.0.0.0")
    Config.PORT = int(os.environ.get("PORT", "5555"))
    Config.DEBUG = _bool("DEBUG", False)

    # Security — dev-only fallback lets ``python -m agentclub.app`` boot
    # without CLI orchestration; ``agentclub onboard`` always mints a
    # real random key.
    Config.SECRET_KEY = os.environ.get(
        "SECRET_KEY", "agentclub-dev-key-do-not-use-in-prod"
    )

    # Storage (derived from BASE_DIR unless explicitly overridden)
    Config.DATABASE = os.environ.get("DATABASE") or os.path.join(BASE_DIR, "agentclub.db")
    Config.UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER") or os.path.join(BASE_DIR, "media", "uploads")

    # Retention + feature flags
    Config.ALLOW_REGISTRATION = _bool("ALLOW_REGISTRATION", True)
    Config.MESSAGE_RETENTION_DAYS = int(os.environ.get("MESSAGE_RETENTION_DAYS", "30"))

    # Presence cadences (see README § online status)
    Config.HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL", "30"))
    Config.ACTIVE_TIMEOUT = int(os.environ.get("ACTIVE_TIMEOUT", "90"))
    Config.PRESENCE_POLL_INTERVAL = int(os.environ.get("PRESENCE_POLL_INTERVAL", "30"))


# Populate on import so existing ``from .config import Config`` code
# sees fully-initialized attributes.
refresh_config()


def generate_secret_key():
    """Used by ``agentclub onboard`` to mint a fresh SECRET_KEY."""
    return secrets.token_hex(32)
