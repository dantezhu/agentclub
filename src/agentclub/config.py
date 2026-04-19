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
    # Fixed constants (not env-tunable). ALLOWED_EXTENSIONS is a nested
    # set/dict that doesn't map cleanly to env vars; keep it source-only.
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

    # Env-tunable fields are populated by refresh_config() at import
    # time and any time CLI ``apply_env`` runs. Keeping them declared
    # here (as None) makes IDE autocomplete happy and signals intent.
    HOST = None
    PORT = None
    DEBUG = None
    SECRET_KEY = None
    DATABASE = None
    UPLOAD_FOLDER = None
    MEDIA_FOLDER = None
    MAX_CONTENT_LENGTH = None
    MESSAGE_PAGE_SIZE = None
    ALLOW_REGISTRATION = None
    MESSAGE_RETENTION_DAYS = None
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
      - "Agent Club" → "AC"   (multiple ASCII words → take initials)
      - "AgentClub"  → "AG"   (single ASCII word → take first 2 letters)
      - "我的团队"    → "我的"  (CJK → take first 2 chars)
      - empty/junk   → "AC"   (safe fallback)

    Capped at 2 visible chars so the round mark stays legible at 24-40px.
    """
    name = (site_name or "").strip()
    if not name:
        return "AC"
    words = name.split()
    if len(words) >= 2:
        # Multiple whitespace-separated words: take leading char of each.
        # Works for both "Agent Club" → AC and "我 的 团队" → 我的.
        return "".join(w[0] for w in words[:2]).upper()
    # Single word — take the first two characters as-is. Upper-casing
    # only matters for ASCII; CJK is unaffected.
    return name[:2].upper()


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
    # Two related dirs:
    #   MEDIA_FOLDER   → data-dir/media           served at /media/<file>
    #   UPLOAD_FOLDER  → MEDIA_FOLDER/uploads     served at /media/uploads/<file>
    # Uploads is *always* a subdir of media — there's no separate env
    # var for it. The previous design exposed ``UPLOAD_FOLDER`` and
    # ``MEDIA_FOLDER`` as independent overrides, which let an operator
    # split them in confusing ways (uploads written to one tree, served
    # from another). Now the relationship is forced.
    Config.MEDIA_FOLDER = os.environ.get("MEDIA_FOLDER") or os.path.join(BASE_DIR, "media")
    Config.UPLOAD_FOLDER = os.path.join(Config.MEDIA_FOLDER, "uploads")

    # Upload size cap. Unit is bytes (Flask convention). Default 50MB =
    # 52428800. Remember to keep nginx ``client_max_body_size`` in sync.
    Config.MAX_CONTENT_LENGTH = int(os.environ.get("MAX_CONTENT_LENGTH", str(50 * 1024 * 1024)))

    # Retention + feature flags + paging
    # Default is False: a fresh deploy ships closed. The very first
    # signup is special-cased in routes.register() — if the users table
    # is empty, registration is allowed regardless of this flag, so the
    # operator can still bootstrap the initial admin from the web. Set
    # this to True only if you actually want open public registration.
    Config.ALLOW_REGISTRATION = _bool("ALLOW_REGISTRATION", False)
    Config.MESSAGE_RETENTION_DAYS = int(os.environ.get("MESSAGE_RETENTION_DAYS", "30"))
    Config.MESSAGE_PAGE_SIZE = int(os.environ.get("MESSAGE_PAGE_SIZE", "50"))

    # Presence cadences (see README § online status)
    Config.HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL", "30"))
    Config.ACTIVE_TIMEOUT = int(os.environ.get("ACTIVE_TIMEOUT", "90"))
    Config.PRESENCE_POLL_INTERVAL = int(os.environ.get("PRESENCE_POLL_INTERVAL", "30"))

    # Logging — file handler writes to LOG_DIR (defaults to data-dir/logs)
    # and rotates by size. Disk usage cap = (1 + LOG_BACKUP_COUNT) *
    # LOG_MAX_SIZE_MB MB. Defaults: 100MB × 5 backups → ~600MB worst case.
    # stdout always gets a copy too. See agentclub/logging_setup.py.
    Config.LOG_DIR = os.environ.get("LOG_DIR") or os.path.join(BASE_DIR, "logs")
    Config.LOG_LEVEL = (os.environ.get("LOG_LEVEL") or "INFO").upper()
    Config.LOG_MAX_SIZE_MB = int(os.environ.get("LOG_MAX_SIZE_MB", "100"))
    Config.LOG_BACKUP_COUNT = int(os.environ.get("LOG_BACKUP_COUNT", "5"))

    # Branding — all three are optional and only affect the title bar /
    # logomark. Empty strings are treated as "use default":
    #   SITE_NAME       → "Agent Club"
    #   SITE_LOGO       → "" (no image, fall back to text wordmark)
    #   SITE_LOGO_TEXT  → derived from SITE_NAME (see _derive_logo_text)
    # Putting these in config.json — not in the DB settings table — is
    # deliberate: the brand is part of the deploy, not a runtime knob
    # that admins can poke from the web UI.
    Config.SITE_NAME = (os.environ.get("SITE_NAME") or "Agent Club").strip()
    Config.SITE_LOGO = (os.environ.get("SITE_LOGO") or "").strip()
    explicit_text = (os.environ.get("SITE_LOGO_TEXT") or "").strip()
    Config.SITE_LOGO_TEXT = explicit_text or _derive_logo_text(Config.SITE_NAME)


# Populate on import so existing ``from .config import Config`` code
# sees fully-initialized attributes.
refresh_config()


def generate_secret_key():
    """Used by ``agentclub onboard`` to mint a fresh SECRET_KEY."""
    return secrets.token_hex(32)
