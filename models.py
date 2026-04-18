import sqlite3
import uuid
import time
from contextlib import contextmanager
from config import Config

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
    is_online INTEGER DEFAULT 0,
    last_seen REAL,
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


def _apply_online(user_dict):
    """Reconcile `is_online` with the recorded `last_seen` heartbeat.

    A user only counts as online if BOTH the session flag is set AND a
    heartbeat has arrived within the last `Config.HEARTBEAT_TIMEOUT`
    seconds. This protects against stuck-True states where the ws died
    without cleanly firing `disconnect`. Mutates and returns the dict;
    safe on None.
    """
    if not user_dict or "is_online" not in user_dict:
        return user_dict
    ls = user_dict.get("last_seen") or 0
    fresh = ls >= (time.time() - Config.HEARTBEAT_TIMEOUT)
    user_dict["is_online"] = 1 if (user_dict.get("is_online") and fresh) else 0
    return user_dict


def _apply_peer_online(row_dict):
    """Same as `_apply_online` but for the aliased `peer_online` /
    `peer_last_seen` columns produced by the direct-chat query."""
    if not row_dict or "peer_online" not in row_dict:
        return row_dict
    ls = row_dict.get("peer_last_seen") or 0
    fresh = ls >= (time.time() - Config.HEARTBEAT_TIMEOUT)
    row_dict["peer_online"] = 1 if (row_dict.get("peer_online") and fresh) else 0
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


def set_user_online(user_id, online=True):
    with get_db_ctx() as db:
        db.execute(
            "UPDATE users SET is_online = ?, last_seen = ? WHERE id = ?",
            (1 if online else 0, now(), user_id),
        )


def touch_last_seen(user_id):
    """Update the user's heartbeat timestamp without touching `is_online`.

    Called on every incoming heartbeat / ping frame from a connected
    client. Cheap enough to run per-heartbeat (single indexed UPDATE)."""
    with get_db_ctx() as db:
        db.execute("UPDATE users SET last_seen = ? WHERE id = ?", (now(), user_id))


def sweep_stale_online():
    """Flip `is_online` to 0 for any user whose heartbeat has gone stale.

    Returned list contains the users that were just transitioned so the
    caller can broadcast a presence update. A user appears here at most
    once per staleness episode — we only select rows that still had
    `is_online = 1` at sweep time."""
    threshold = now() - Config.HEARTBEAT_TIMEOUT
    with get_db_ctx() as db:
        rows = db.execute(
            "SELECT id, display_name, is_agent FROM users "
            "WHERE is_online = 1 AND COALESCE(last_seen, 0) < ?",
            (threshold,),
        ).fetchall()
        if not rows:
            return []
        ids = [r["id"] for r in rows]
        placeholders = ",".join("?" for _ in ids)
        db.execute(
            f"UPDATE users SET is_online = 0 WHERE id IN ({placeholders})",
            ids,
        )
    return [dict(r) for r in rows]


def list_users():
    db = get_db()
    rows = db.execute(
        "SELECT id, username, display_name, avatar, role, is_agent, is_online, last_seen "
        "FROM users ORDER BY created_at"
    ).fetchall()
    db.close()
    return [_apply_online(dict(r)) for r in rows]


def list_agents():
    db = get_db()
    rows = db.execute(
        "SELECT id, username, display_name, avatar, agent_token, is_online, last_seen "
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
        "       u.is_online, u.last_seen "
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
        "CASE WHEN dc.user1_id = ? THEN u2.is_online ELSE u1.is_online END AS peer_online, "
        "CASE WHEN dc.user1_id = ? THEN u2.last_seen ELSE u1.last_seen END AS peer_last_seen, "
        "CASE WHEN dc.user1_id = ? THEN u2.is_agent ELSE u1.is_agent END AS peer_is_agent "
        "FROM direct_chats dc "
        "JOIN users u1 ON dc.user1_id = u1.id "
        "JOIN users u2 ON dc.user2_id = u2.id "
        "WHERE dc.user1_id = ? OR dc.user2_id = ?",
        (user_id, user_id, user_id, user_id, user_id, user_id, user_id, user_id),
    ).fetchall()
    db.close()
    return [_apply_peer_online(dict(r)) for r in rows]


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
