import sqlite3
import uuid
import time
from contextlib import contextmanager
from .config import Config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    display_name TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    is_agent INTEGER DEFAULT 0,
    agent_token TEXT UNIQUE,
    last_active_at REAL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at REAL NOT NULL,
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS direct_chats (
    id TEXT PRIMARY KEY,
    user1_id TEXT NOT NULL REFERENCES users(id),
    user2_id TEXT NOT NULL REFERENCES users(id),
    created_at REAL NOT NULL,
    UNIQUE(user1_id, user2_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_type TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL REFERENCES users(id),
    content TEXT DEFAULT '',
    content_type TEXT DEFAULT 'text',
    file_url TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    mentions TEXT DEFAULT '[]',
    created_at REAL NOT NULL
);

-- Per-user, per-chat "read cursor". `last_read_at` is a unix timestamp; any
-- message in the chat with `created_at > last_read_at` and `sender_id !=
-- user_id` is considered unread. A user's first-time baseline for a chat is
-- either the chat creation time (direct) or the group membership join time
-- (group), so joining a chat does not retroactively flag history as unread.
CREATE TABLE IF NOT EXISTS read_cursors (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_type TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    last_read_at REAL NOT NULL,
    PRIMARY KEY (user_id, chat_type, chat_id)
);

-- Legacy table from the per-message unread model; kept as a no-op drop so
-- upgrading instances don't leave orphan data around.
DROP TABLE IF EXISTS unread_messages;

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_type, chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_read_cursors_user ON read_cursors(user_id);
CREATE INDEX IF NOT EXISTS idx_users_agent_token ON users(agent_token);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_DEFAULT_SETTINGS = {}


def _is_active(last_active_at):
    """Decide whether a `last_active_at` timestamp is recent enough to
    treat the user as online. Used as the single source of truth everywhere
    the code previously looked at a persisted `is_online` flag."""
    if not last_active_at:
        return False
    return last_active_at >= (time.time() - Config.ACTIVE_TIMEOUT)


def _apply_online(user_dict):
    """Decorate a user row with a derived `is_online` field based on
    `last_active_at`. The DB no longer stores an `is_online` column — any
    client activity (heartbeat, send_message, mark_read) bumps
    `last_active_at`, and `ACTIVE_TIMEOUT` turns that into a boolean. Safe
    on None / rows missing the column (returned as-is)."""
    if not user_dict:
        return user_dict
    user_dict["is_online"] = 1 if _is_active(user_dict.get("last_active_at")) else 0
    return user_dict


def _apply_peer_online(row_dict):
    """Same as `_apply_online` but for the aliased `peer_last_active_at`
    column produced by the direct-chat query."""
    if not row_dict or "peer_last_active_at" not in row_dict:
        return row_dict
    row_dict["peer_online"] = 1 if _is_active(row_dict.get("peer_last_active_at")) else 0
    return row_dict


def get_db():
    db = sqlite3.connect(Config.DATABASE)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


@contextmanager
def get_db_ctx():
    db = get_db()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    with get_db_ctx() as db:
        db.executescript(SCHEMA)
        _migrate_presence_columns(db)


def _migrate_presence_columns(db):
    """Upgrade legacy `users` tables to the simplified presence model.

    Old schema had `is_online INTEGER` + `last_seen REAL` and relied on a
    sweeper to keep them consistent. New schema is a single
    `last_active_at REAL`; online-ness is derived at read time from
    `ACTIVE_TIMEOUT`. Migration rules for an existing DB:
      - If `last_active_at` is missing but `last_seen` exists → rename.
      - If `is_online` still exists → drop it (SQLite ≥ 3.35).
      - Fresh install: SCHEMA already has `last_active_at`, nothing to do.
    All ALTERs are idempotent and safe to run on every startup.
    """
    cols = {r["name"] for r in db.execute("PRAGMA table_info(users)").fetchall()}
    if "last_active_at" not in cols:
        if "last_seen" in cols:
            db.execute("ALTER TABLE users RENAME COLUMN last_seen TO last_active_at")
        else:
            db.execute("ALTER TABLE users ADD COLUMN last_active_at REAL")
    elif "last_seen" in cols:
        # Both columns present (shouldn't happen but be defensive): copy
        # any fresher `last_seen` forward, then drop the legacy column.
        db.execute(
            "UPDATE users SET last_active_at = MAX(COALESCE(last_active_at, 0), "
            "COALESCE(last_seen, 0)) WHERE last_seen IS NOT NULL"
        )
        db.execute("ALTER TABLE users DROP COLUMN last_seen")
    if "is_online" in cols:
        db.execute("ALTER TABLE users DROP COLUMN is_online")


def now():
    return time.time()


def new_id():
    return uuid.uuid4().hex


# ── User operations ──

def create_user(username, password_hash, display_name, role="user", avatar=""):
    uid = new_id()
    with get_db_ctx() as db:
        db.execute(
            "INSERT INTO users (id, username, password_hash, display_name, avatar, role, is_agent, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
            (uid, username, password_hash, display_name, avatar, role, now()),
        )
    return uid


def create_agent(username, display_name, token, avatar=""):
    uid = new_id()
    with get_db_ctx() as db:
        db.execute(
            "INSERT INTO users (id, username, password_hash, display_name, avatar, role, is_agent, agent_token, created_at) "
            "VALUES (?, ?, NULL, ?, ?, 'agent', 1, ?, ?)",
            (uid, username, display_name, avatar, token, now()),
        )
    return uid


def get_user_by_username(username):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    db.close()
    return _apply_online(dict(row)) if row else None


def get_user_by_id(user_id):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    db.close()
    return _apply_online(dict(row)) if row else None


def get_user_by_agent_token(token):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE agent_token = ? AND is_agent = 1", (token,)).fetchone()
    db.close()
    return _apply_online(dict(row)) if row else None


def touch_active(user_id):
    """Refresh a user's `last_active_at` to now.

    Called on every inbound signal that proves the client is alive and
    kicking: heartbeat, send_message, mark_read, etc. Cheap enough to run
    per-event (single indexed UPDATE). Derived `is_online` follows
    automatically — no separate flag to keep in sync."""
    if not user_id:
        return
    with get_db_ctx() as db:
        db.execute("UPDATE users SET last_active_at = ? WHERE id = ?", (now(), user_id))


def list_users():
    db = get_db()
    rows = db.execute(
        "SELECT id, username, display_name, avatar, role, is_agent, last_active_at "
        "FROM users ORDER BY created_at"
    ).fetchall()
    db.close()
    return [_apply_online(dict(r)) for r in rows]


def list_agents():
    db = get_db()
    rows = db.execute(
        "SELECT id, username, display_name, avatar, agent_token, last_active_at "
        "FROM users WHERE is_agent = 1 ORDER BY created_at"
    ).fetchall()
    db.close()
    return [_apply_online(dict(r)) for r in rows]


def delete_user(user_id):
    with get_db_ctx() as db:
        db.execute("DELETE FROM group_members WHERE user_id = ?", (user_id,))
        # read_cursors cascades via FK
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))


def update_user(user_id, **kwargs):
    allowed = {"display_name", "avatar", "password_hash", "role"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [user_id]
    with get_db_ctx() as db:
        db.execute(f"UPDATE users SET {set_clause} WHERE id = ?", values)


# ── Group operations ──

def create_group(name, created_by, avatar=""):
    gid = new_id()
    ts = now()
    with get_db_ctx() as db:
        db.execute(
            "INSERT INTO groups (id, name, avatar, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
            (gid, name, avatar, created_by, ts),
        )
        db.execute(
            "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
            (gid, created_by, ts),
        )
    return gid


def get_group(group_id):
    db = get_db()
    row = db.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
    db.close()
    return dict(row) if row else None


def add_group_member(group_id, user_id):
    with get_db_ctx() as db:
        db.execute(
            "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
            (group_id, user_id, now()),
        )


def remove_group_member(group_id, user_id):
    with get_db_ctx() as db:
        db.execute("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", (group_id, user_id))


def update_group(group_id, **kwargs):
    allowed = {"name", "avatar"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [group_id]
    with get_db_ctx() as db:
        db.execute(f"UPDATE groups SET {set_clause} WHERE id = ?", values)


def get_group_members(group_id):
    db = get_db()
    rows = db.execute(
        "SELECT u.id, u.username, u.display_name, u.avatar, u.role, u.is_agent, "
        "       u.last_active_at "
        "FROM users u JOIN group_members gm ON u.id = gm.user_id "
        "WHERE gm.group_id = ? ORDER BY gm.joined_at",
        (group_id,),
    ).fetchall()
    db.close()
    return [_apply_online(dict(r)) for r in rows]


def get_user_groups(user_id):
    db = get_db()
    rows = db.execute(
        "SELECT g.* FROM groups g JOIN group_members gm ON g.id = gm.group_id "
        "WHERE gm.user_id = ? ORDER BY g.created_at",
        (user_id,),
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


def delete_group(group_id):
    with get_db_ctx() as db:
        db.execute(
            "DELETE FROM read_cursors WHERE chat_type = 'group' AND chat_id = ?",
            (group_id,),
        )
        db.execute("DELETE FROM messages WHERE chat_type = 'group' AND chat_id = ?", (group_id,))
        db.execute("DELETE FROM group_members WHERE group_id = ?", (group_id,))
        db.execute("DELETE FROM groups WHERE id = ?", (group_id,))


def is_group_member(group_id, user_id):
    db = get_db()
    row = db.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
        (group_id, user_id),
    ).fetchone()
    db.close()
    return row is not None


# ── Direct chat operations ──

def delete_direct_chat(chat_id, user_id):
    with get_db_ctx() as db:
        chat = db.execute("SELECT * FROM direct_chats WHERE id = ? AND (user1_id = ? OR user2_id = ?)", (chat_id, user_id, user_id)).fetchone()
        if chat:
            db.execute(
                "DELETE FROM read_cursors WHERE chat_type = 'direct' AND chat_id = ?",
                (chat_id,),
            )
            db.execute("DELETE FROM messages WHERE chat_type = 'direct' AND chat_id = ?", (chat_id,))
            db.execute("DELETE FROM direct_chats WHERE id = ?", (chat_id,))


def get_or_create_direct_chat(user1_id, user2_id):
    a, b = sorted([user1_id, user2_id])
    db = get_db()
    row = db.execute(
        "SELECT * FROM direct_chats WHERE user1_id = ? AND user2_id = ?", (a, b)
    ).fetchone()
    db.close()
    if row:
        return dict(row)
    cid = new_id()
    with get_db_ctx() as db:
        db.execute(
            "INSERT OR IGNORE INTO direct_chats (id, user1_id, user2_id, created_at) VALUES (?, ?, ?, ?)",
            (cid, a, b, now()),
        )
    return {"id": cid, "user1_id": a, "user2_id": b}


def get_user_direct_chats(user_id):
    db = get_db()
    rows = db.execute(
        "SELECT dc.*, "
        "CASE WHEN dc.user1_id = ? THEN u2.id ELSE u1.id END AS peer_id, "
        "CASE WHEN dc.user1_id = ? THEN u2.display_name ELSE u1.display_name END AS peer_name, "
        "CASE WHEN dc.user1_id = ? THEN u2.avatar ELSE u1.avatar END AS peer_avatar, "
        "CASE WHEN dc.user1_id = ? THEN u2.last_active_at ELSE u1.last_active_at END AS peer_last_active_at, "
        "CASE WHEN dc.user1_id = ? THEN u2.is_agent ELSE u1.is_agent END AS peer_is_agent "
        "FROM direct_chats dc "
        "JOIN users u1 ON dc.user1_id = u1.id "
        "JOIN users u2 ON dc.user2_id = u2.id "
        "WHERE dc.user1_id = ? OR dc.user2_id = ?",
        (user_id, user_id, user_id, user_id, user_id, user_id, user_id),
    ).fetchall()
    db.close()
    return [_apply_peer_online(dict(r)) for r in rows]


def get_direct_chat_peers(user_id):
    """Return every distinct peer `user_id` (not the chat id) the given
    user has a direct-chat record with. Used as the default scope for the
    presence polling endpoint — groups are intentionally excluded because
    the Web UI doesn't surface real-time presence for group members."""
    db = get_db()
    rows = db.execute(
        "SELECT CASE WHEN user1_id = ? THEN user2_id ELSE user1_id END AS peer_id "
        "FROM direct_chats WHERE user1_id = ? OR user2_id = ?",
        (user_id, user_id, user_id),
    ).fetchall()
    db.close()
    return [r["peer_id"] for r in rows]


def get_presence_snapshot(user_ids):
    """Compute the current online state for a batch of users.

    Returns a list of `{user_id, is_online, last_active_at}`. Users that
    don't exist are silently skipped. Caller is expected to authorize the
    `user_ids` list (e.g. restrict to the requesting user's direct-chat
    peers) — this helper is just the DB + timeout math."""
    ids = [u for u in (user_ids or []) if u]
    if not ids:
        return []
    db = get_db()
    placeholders = ",".join("?" for _ in ids)
    rows = db.execute(
        f"SELECT id, last_active_at FROM users WHERE id IN ({placeholders})",
        ids,
    ).fetchall()
    db.close()
    result = []
    for r in rows:
        result.append({
            "user_id": r["id"],
            "is_online": 1 if _is_active(r["last_active_at"]) else 0,
            "last_active_at": r["last_active_at"],
        })
    return result


# ── Message operations ──

def save_message(chat_type, chat_id, sender_id, content="", content_type="text",
                 file_url="", file_name="", mentions="[]"):
    mid = new_id()
    ts = now()
    with get_db_ctx() as db:
        db.execute(
            "INSERT INTO messages (id, chat_type, chat_id, sender_id, content, content_type, file_url, file_name, mentions, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (mid, chat_type, chat_id, sender_id, content, content_type, file_url, file_name, mentions, ts),
        )
    return {"id": mid, "created_at": ts}


def get_last_messages(chat_keys):
    """Get the last message for each (chat_type, chat_id) pair.
    chat_keys: list of (chat_type, chat_id) tuples
    Returns dict: "type_id" -> {sender_name, content, content_type, created_at}
    """
    if not chat_keys:
        return {}
    db = get_db()
    result = {}
    for chat_type, chat_id in chat_keys:
        row = db.execute(
            "SELECT m.content, m.content_type, m.created_at, u.display_name AS sender_name "
            "FROM messages m JOIN users u ON m.sender_id = u.id "
            "WHERE m.chat_type = ? AND m.chat_id = ? "
            "ORDER BY m.created_at DESC LIMIT 1",
            (chat_type, chat_id),
        ).fetchone()
        if row:
            result[f"{chat_type}_{chat_id}"] = dict(row)
    db.close()
    return result


def get_messages(chat_type, chat_id, before=None, limit=50):
    db = get_db()
    if before:
        rows = db.execute(
            "SELECT m.*, u.display_name AS sender_name, u.avatar AS sender_avatar, u.is_agent AS sender_is_agent "
            "FROM messages m JOIN users u ON m.sender_id = u.id "
            "WHERE m.chat_type = ? AND m.chat_id = ? AND m.created_at < ? "
            "ORDER BY m.created_at DESC LIMIT ?",
            (chat_type, chat_id, before, limit),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT m.*, u.display_name AS sender_name, u.avatar AS sender_avatar, u.is_agent AS sender_is_agent "
            "FROM messages m JOIN users u ON m.sender_id = u.id "
            "WHERE m.chat_type = ? AND m.chat_id = ? "
            "ORDER BY m.created_at DESC LIMIT ?",
            (chat_type, chat_id, limit),
        ).fetchall()
    db.close()
    return [dict(r) for r in reversed(rows)]


# ── Read-cursor based unread tracking ──
#
# Instead of one row per (user, unread-message), we store a single
# `last_read_at` timestamp per (user, chat). Unread messages are those with
# `created_at > last_read_at` authored by someone other than the user.
#
# Baseline for users without a cursor row: the chat's creation time for
# direct chats, or the member's `joined_at` for groups. This way joining a
# chat never retroactively flags the full history as unread, and we don't
# need to eagerly insert cursor rows on chat creation.


def mark_read(user_id, chat_type, chat_id, up_to_ts=None):
    """Advance the user's read cursor for this chat. `up_to_ts` is the
    inclusive ceiling (defaults to now). The cursor only moves forward — a
    smaller `up_to_ts` is ignored."""
    ts = float(up_to_ts) if up_to_ts is not None else now()
    with get_db_ctx() as db:
        db.execute(
            "INSERT INTO read_cursors (user_id, chat_type, chat_id, last_read_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(user_id, chat_type, chat_id) DO UPDATE SET "
            "last_read_at = MAX(last_read_at, excluded.last_read_at)",
            (user_id, chat_type, chat_id, ts),
        )


def mark_read_up_to_message(user_id, message_id):
    """Advance the cursor to include the given message (and everything before
    it in the same chat)."""
    db = get_db()
    row = db.execute(
        "SELECT chat_type, chat_id, created_at FROM messages WHERE id = ?",
        (message_id,),
    ).fetchone()
    db.close()
    if not row:
        return False
    mark_read(user_id, row["chat_type"], row["chat_id"], row["created_at"])
    return True


def mark_read_up_to_messages(user_id, message_ids):
    """Batch variant: resolve each id to its (chat, created_at) and advance
    the per-chat cursor to the MAX created_at. Missing ids are silently
    ignored."""
    ids = [m for m in (message_ids or []) if m]
    if not ids:
        return
    placeholders = ",".join("?" for _ in ids)
    db = get_db()
    rows = db.execute(
        f"SELECT chat_type, chat_id, MAX(created_at) AS ts FROM messages "
        f"WHERE id IN ({placeholders}) GROUP BY chat_type, chat_id",
        ids,
    ).fetchall()
    db.close()
    for r in rows:
        mark_read(user_id, r["chat_type"], r["chat_id"], r["ts"])


# Public alias used by callers that just want to "bulk mark this chat as
# read up to now". Signature mirrors the historical `clear_unread` for
# backward compatibility with call sites.
def clear_unread(user_id, chat_type=None, chat_id=None):
    if chat_type and chat_id:
        mark_read(user_id, chat_type, chat_id)
        return
    # No chat specified → mark every chat the user participates in.
    db = get_db()
    direct = db.execute(
        "SELECT id FROM direct_chats WHERE user1_id = ? OR user2_id = ?",
        (user_id, user_id),
    ).fetchall()
    groups = db.execute(
        "SELECT group_id FROM group_members WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    db.close()
    ts = now()
    for r in direct:
        mark_read(user_id, "direct", r["id"], ts)
    for r in groups:
        mark_read(user_id, "group", r["group_id"], ts)


def _unread_where_clauses():
    """Shared CTE that enumerates each chat the user is in and joins the
    per-chat baseline: either the user's cursor, or the chat-creation /
    group-join timestamp when no cursor has been set yet."""
    return (
        "WITH user_chats AS ( "
        "  SELECT 'direct' AS chat_type, dc.id AS chat_id, dc.created_at AS joined_at "
        "  FROM direct_chats dc WHERE dc.user1_id = :uid OR dc.user2_id = :uid "
        "  UNION ALL "
        "  SELECT 'group', gm.group_id, gm.joined_at "
        "  FROM group_members gm WHERE gm.user_id = :uid "
        "), "
        "chat_since AS ( "
        "  SELECT uc.chat_type, uc.chat_id, "
        "         COALESCE(rc.last_read_at, uc.joined_at) AS since "
        "  FROM user_chats uc "
        "  LEFT JOIN read_cursors rc "
        "         ON rc.user_id = :uid AND rc.chat_type = uc.chat_type AND rc.chat_id = uc.chat_id "
        ") "
    )


def get_unread_counts(user_id):
    db = get_db()
    sql = _unread_where_clauses() + (
        "SELECT cs.chat_type, cs.chat_id, COUNT(m.id) AS count "
        "FROM chat_since cs "
        "LEFT JOIN messages m "
        "       ON m.chat_type = cs.chat_type AND m.chat_id = cs.chat_id "
        "      AND m.sender_id != :uid AND m.created_at > cs.since "
        "GROUP BY cs.chat_type, cs.chat_id "
        "HAVING count > 0"
    )
    rows = db.execute(sql, {"uid": user_id}).fetchall()
    db.close()
    return {f"{r['chat_type']}_{r['chat_id']}": r["count"] for r in rows}


def get_unread_messages(user_id):
    """Return all messages the user has not yet read, across every chat
    they're in, ordered by creation time. Used for offline-catchup delivery
    on (re)connect."""
    db = get_db()
    sql = _unread_where_clauses() + (
        "SELECT m.*, u.display_name AS sender_name, u.avatar AS sender_avatar, "
        "       u.is_agent AS sender_is_agent "
        "FROM chat_since cs "
        "JOIN messages m "
        "  ON m.chat_type = cs.chat_type AND m.chat_id = cs.chat_id "
        " AND m.sender_id != :uid AND m.created_at > cs.since "
        "JOIN users u ON m.sender_id = u.id "
        "ORDER BY m.created_at"
    )
    rows = db.execute(sql, {"uid": user_id}).fetchall()
    db.close()
    return [dict(r) for r in rows]


def cleanup_old_messages(days=None):
    if days is None:
        days = Config.MESSAGE_RETENTION_DAYS
    cutoff = now() - days * 86400
    with get_db_ctx() as db:
        db.execute("DELETE FROM messages WHERE created_at < ?", (cutoff,))


# ── Settings ──

def get_setting(key):
    db = get_db()
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    db.close()
    if row:
        return row["value"]
    return _DEFAULT_SETTINGS.get(key, "")


def set_setting(key, value):
    with get_db_ctx() as db:
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
            (key, value, value),
        )


def get_all_settings():
    db = get_db()
    rows = db.execute("SELECT key, value FROM settings").fetchall()
    db.close()
    result = dict(_DEFAULT_SETTINGS)
    for r in rows:
        result[r["key"]] = r["value"]
    return result
