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

CREATE TABLE IF NOT EXISTS unread_messages (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_type, chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_unread_user ON unread_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_users_agent_token ON users(agent_token);
"""


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
    return dict(row) if row else None


def get_user_by_id(user_id):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    db.close()
    return dict(row) if row else None


def get_user_by_agent_token(token):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE agent_token = ? AND is_agent = 1", (token,)).fetchone()
    db.close()
    return dict(row) if row else None


def set_user_online(user_id, online=True):
    with get_db_ctx() as db:
        db.execute(
            "UPDATE users SET is_online = ?, last_seen = ? WHERE id = ?",
            (1 if online else 0, now(), user_id),
        )


def list_users():
    db = get_db()
    rows = db.execute("SELECT id, username, display_name, avatar, role, is_agent, is_online FROM users ORDER BY created_at").fetchall()
    db.close()
    return [dict(r) for r in rows]


def list_agents():
    db = get_db()
    rows = db.execute(
        "SELECT id, username, display_name, avatar, agent_token, is_online FROM users WHERE is_agent = 1 ORDER BY created_at"
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


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
        "SELECT u.id, u.username, u.display_name, u.avatar, u.role, u.is_agent, u.is_online "
        "FROM users u JOIN group_members gm ON u.id = gm.user_id "
        "WHERE gm.group_id = ? ORDER BY gm.joined_at",
        (group_id,),
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


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
        db.execute("DELETE FROM unread_messages WHERE message_id IN (SELECT id FROM messages WHERE chat_type = 'group' AND chat_id = ?)", (group_id,))
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
            db.execute("DELETE FROM unread_messages WHERE message_id IN (SELECT id FROM messages WHERE chat_type = 'direct' AND chat_id = ?)", (chat_id,))
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
        "CASE WHEN dc.user1_id = ? THEN u2.is_online ELSE u1.is_online END AS peer_online "
        "FROM direct_chats dc "
        "JOIN users u1 ON dc.user1_id = u1.id "
        "JOIN users u2 ON dc.user2_id = u2.id "
        "WHERE dc.user1_id = ? OR dc.user2_id = ?",
        (user_id, user_id, user_id, user_id, user_id, user_id),
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


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


def add_unread(user_id, message_id):
    with get_db_ctx() as db:
        db.execute(
            "INSERT OR IGNORE INTO unread_messages (user_id, message_id) VALUES (?, ?)",
            (user_id, message_id),
        )


def get_unread_messages(user_id):
    db = get_db()
    rows = db.execute(
        "SELECT m.*, u.display_name AS sender_name, u.avatar AS sender_avatar, u.is_agent AS sender_is_agent "
        "FROM unread_messages um "
        "JOIN messages m ON um.message_id = m.id "
        "JOIN users u ON m.sender_id = u.id "
        "WHERE um.user_id = ? ORDER BY m.created_at",
        (user_id,),
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


def clear_unread(user_id, chat_type=None, chat_id=None):
    with get_db_ctx() as db:
        if chat_type and chat_id:
            db.execute(
                "DELETE FROM unread_messages WHERE user_id = ? AND message_id IN "
                "(SELECT id FROM messages WHERE chat_type = ? AND chat_id = ?)",
                (user_id, chat_type, chat_id),
            )
        else:
            db.execute("DELETE FROM unread_messages WHERE user_id = ?", (user_id,))


def cleanup_old_messages(days=None):
    if days is None:
        days = Config.MESSAGE_RETENTION_DAYS
    cutoff = now() - days * 86400
    with get_db_ctx() as db:
        db.execute("DELETE FROM unread_messages WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)", (cutoff,))
        db.execute("DELETE FROM messages WHERE created_at < ?", (cutoff,))
