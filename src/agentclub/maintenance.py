"""Scheduled maintenance tasks for the AgentClub server."""
from __future__ import annotations

import logging
import os
import time

from . import models
from .config import Config


logger = logging.getLogger(__name__)

_retention_task_started = False


def cleanup_old_uploads(cutoff):
    """Delete uploaded files older than ``cutoff`` based on filesystem mtime."""
    upload_dir = Config.UPLOAD_FOLDER
    deleted = 0
    try:
        entries = os.scandir(upload_dir)
    except FileNotFoundError:
        return 0
    except OSError as exc:
        logger.warning("message retention cleanup could not scan uploads: %s", exc)
        return 0

    with entries:
        for entry in entries:
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
                if entry.stat(follow_symlinks=False).st_mtime >= cutoff:
                    continue
                os.remove(entry.path)
                deleted += 1
            except FileNotFoundError:
                continue
            except OSError as exc:
                logger.warning(
                    "message retention cleanup could not delete upload %s: %s",
                    entry.path,
                    exc,
                )
    return deleted


def run_retention_cleanup(now_ts=None):
    """Apply message and upload-file retention once."""
    days = Config.MESSAGE_RETENTION_DAYS
    if days <= 0:
        return {"messages_deleted": 0, "files_deleted": 0}

    current = time.time() if now_ts is None else now_ts
    cutoff = current - days * 86400
    messages_deleted = models.cleanup_old_messages(days, cutoff=cutoff)
    files_deleted = cleanup_old_uploads(cutoff)
    return {
        "messages_deleted": messages_deleted,
        "files_deleted": files_deleted,
    }


def _retention_cleanup_loop(socketio):
    while True:
        socketio.sleep(Config.MESSAGE_CLEANUP_INTERVAL_SECONDS)
        try:
            logger.info("message retention cleanup started")
            result = run_retention_cleanup()
        except Exception:
            logger.exception("message retention cleanup failed")
            continue
        logger.info(
            "message retention cleanup deleted %s messages and %s upload files",
            result["messages_deleted"],
            result["files_deleted"],
        )


def start_retention_cleanup_task(socketio):
    """Start the retention cleanup loop if retention is enabled."""
    global _retention_task_started
    if _retention_task_started:
        return False
    if Config.MESSAGE_RETENTION_DAYS <= 0:
        return False
    if Config.MESSAGE_CLEANUP_INTERVAL_SECONDS <= 0:
        logger.warning(
            "message retention cleanup disabled: "
            "MESSAGE_CLEANUP_INTERVAL_SECONDS must be positive"
        )
        return False

    _retention_task_started = True
    socketio.start_background_task(_retention_cleanup_loop, socketio)
    logger.info(
        "message retention cleanup scheduled every %s seconds",
        Config.MESSAGE_CLEANUP_INTERVAL_SECONDS,
    )
    return True
