"""Process-wide logging setup for the AgentClub server.

The CLI (`agentclub serve`) calls :func:`setup_logging` once during
bootstrap, after configuration has been resolved. After that, any module
can do::

    import logging
    logger = logging.getLogger(__name__)
    logger.info("hello")

and the message ends up in two places:

1. ``stdout`` — visible from ``journalctl -u agentclub`` / ``docker logs``,
   and convenient when running in the foreground.
2. ``${LOG_DIR}/agentclub.log`` — size-rotated. When the file reaches
   ``LOG_MAX_SIZE_MB`` MB (default 100) it rolls to ``agentclub.log.1``
   and shifts older numbered files down; ``LOG_BACKUP_COUNT`` (default 5)
   historical files are kept, so the on-disk total caps at roughly
   ``(1 + backup_count) * max_size_mb`` MB (default ≈ 600MB).

Werkzeug / Flask / Socket.IO access logs are NOT redirected here on
purpose; nginx is the canonical access-log source in production, and
keeping the per-request chatter out of ``agentclub.log`` keeps it
readable for the things that matter (auth, errors, business events).
"""
from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler

from .config import Config


_FORMAT = "%(asctime)s.%(msecs)03d %(levelname)s [%(name)s] %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

_LOGGER_NAMESPACE = __name__.partition(".")[0]
_LOG_FILENAME = f"{_LOGGER_NAMESPACE}.log"

# Module-level guard so multiple imports / repeated CLI invocations
# in the same process (notably tests) don't stack handlers and
# multiply each log line.
_configured = False


def setup_logging() -> str:
    """Configure the package logger tree. Returns the log file path.

    Idempotent: a second call with the same Config is a no-op. If the
    log directory cannot be created we fall back to stdout-only and
    surface a single warning rather than crashing the boot — losing
    file logs is bad, but losing the server is worse.
    """
    global _configured
    if _configured:
        return os.path.join(Config.LOG_DIR, _LOG_FILENAME)

    level = getattr(logging, Config.LOG_LEVEL, logging.INFO)
    formatter = logging.Formatter(_FORMAT, datefmt=_DATEFMT)

    # We attach handlers to the package namespace logger rather
    # than the root logger, so noisy third-party libraries (werkzeug,
    # engineio, socketio) keep their default behaviour and don't pollute
    # our file. Application code should always log via
    # ``logging.getLogger(__name__)`` from inside the package to participate.
    namespace_logger = logging.getLogger(_LOGGER_NAMESPACE)
    namespace_logger.setLevel(level)
    namespace_logger.propagate = False

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(formatter)
    namespace_logger.addHandler(stream)

    log_path = os.path.join(Config.LOG_DIR, _LOG_FILENAME)
    try:
        os.makedirs(Config.LOG_DIR, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_path,
            maxBytes=Config.LOG_MAX_SIZE_MB * 1024 * 1024,
            backupCount=Config.LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        # Rotated files are named ``agentclub.log.1`` (most recent),
        # ``agentclub.log.2``, ... up to .{LOG_BACKUP_COUNT}.
        file_handler.setFormatter(formatter)
        namespace_logger.addHandler(file_handler)
    except OSError as e:
        # File handler couldn't open. Stay alive on stdout only.
        namespace_logger.warning(
            "logging_setup: cannot write to %s (%s); stdout-only mode",
            log_path, e,
        )

    _configured = True
    namespace_logger.info(
        "logging ready: level=%s file=%s rotation=%dMB×%d",
        Config.LOG_LEVEL, log_path,
        Config.LOG_MAX_SIZE_MB, Config.LOG_BACKUP_COUNT,
    )
    return log_path
