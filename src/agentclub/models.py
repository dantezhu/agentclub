import time
import uuid
from contextlib import contextmanager

from peewee import (
    Case,
    CharField,
    CompositeKey,
    DatabaseProxy,
    FloatField,
    ForeignKeyField,
    IntegrityError,
    IntegerField,
    Model,
    TextField,
    fn,
)
from playhouse.db_url import connect as connect_database_url

from .config import Config


db_proxy = DatabaseProxy()
_database = None
_database_url = None

DatabaseIntegrityError = IntegrityError


def _connect_database(url):
    kwargs = {}
    if url.startswith("sqlite:"):
        kwargs["pragmas"] = {
            "foreign_keys": 1,
            "journal_mode": "wal",
        }
    return connect_database_url(url, **kwargs)


def configure_database():
    global _database, _database_url
    url = Config.DATABASE_URL
    if _database is not None and _database_url == url:
        return _database
    if _database is not None and not _database.is_closed():
        _database.close()
    _database = _connect_database(url)
    _database_url = url
    db_proxy.initialize(_database)
    return _database


@contextmanager
def _connection():
    db = configure_database()
    should_close = db.is_closed()
    if should_close:
        db.connect(reuse_if_open=True)
    try:
        yield db
    finally:
        if should_close and not db.is_closed():
            db.close()


@contextmanager
def _transaction():
    with _connection() as db:
        with db.atomic():
            yield db


class BaseModel(Model):
    class Meta:
        database = db_proxy


class User(BaseModel):
    id = CharField(primary_key=True, max_length=64)
    username = CharField(unique=True, max_length=255)
    password_hash = CharField(null=True, max_length=255)
    display_name = CharField(max_length=255)
    avatar = CharField(default="", max_length=1024)
    description = TextField()
    role = CharField(default="user", max_length=32)
    is_agent = IntegerField(default=0)
    agent_token = CharField(unique=True, null=True, max_length=255)
    last_active_at = FloatField(null=True)
    created_at = FloatField()

    class Meta:
        table_name = "users"
        indexes = ((("created_at",), False),)


class Group(BaseModel):
    id = CharField(primary_key=True, max_length=64)
    name = CharField(max_length=255)
    avatar = CharField(default="", max_length=1024)
    description = TextField()
    created_by = ForeignKeyField(
        User,
        backref="created_groups",
        column_name="created_by",
        on_delete="RESTRICT",
    )
    created_at = FloatField()

    class Meta:
        table_name = "groups"
        indexes = ((("created_at",), False),)


class GroupMember(BaseModel):
    group = ForeignKeyField(
        Group,
        backref="memberships",
        column_name="group_id",
        on_delete="CASCADE",
        index=False,
    )
    user = ForeignKeyField(
        User,
        backref="group_memberships",
        column_name="user_id",
        on_delete="CASCADE",
    )
    joined_at = FloatField()

    class Meta:
        table_name = "group_members"
        primary_key = CompositeKey("group", "user")


class DirectChat(BaseModel):
    id = CharField(primary_key=True, max_length=64)
    user1 = ForeignKeyField(
        User,
        backref="direct_chats_as_user1",
        column_name="user1_id",
        on_delete="RESTRICT",
    )
    user2 = ForeignKeyField(
        User,
        backref="direct_chats_as_user2",
        column_name="user2_id",
        on_delete="RESTRICT",
    )
    created_at = FloatField()

    class Meta:
        table_name = "direct_chats"
        indexes = ((("user1", "user2"), True),)


class Message(BaseModel):
    id = CharField(primary_key=True, max_length=64)
    chat_type = CharField(max_length=16)
    chat_id = CharField(max_length=64)
    sender = ForeignKeyField(
        User,
        backref="messages",
        column_name="sender_id",
        on_delete="RESTRICT",
    )
    content = TextField()
    content_type = CharField(default="text", max_length=64)
    file_url = CharField(default="", max_length=2048)
    file_name = CharField(default="", max_length=1024)
    mentions = TextField()
    created_at = FloatField()

    class Meta:
        table_name = "messages"
        indexes = (
            (("chat_type", "chat_id", "created_at"), False),
            (("created_at",), False),
        )


class ReadCursor(BaseModel):
    user = ForeignKeyField(
        User,
        backref="read_cursors",
        column_name="user_id",
        on_delete="CASCADE",
        index=False,
    )
    chat_type = CharField(max_length=16)
    chat_id = CharField(max_length=64)
    last_read_at = FloatField()

    class Meta:
        table_name = "read_cursors"
        primary_key = CompositeKey("user", "chat_type", "chat_id")


class Setting(BaseModel):
    key = CharField(primary_key=True, max_length=255)
    value = TextField()

    class Meta:
        table_name = "settings"


_MODELS = [User, Group, GroupMember, DirectChat, Message, ReadCursor, Setting]


def _is_active(last_active_at):
    if not last_active_at:
        return False
    return last_active_at >= (time.time() - Config.ACTIVE_TIMEOUT)


def _apply_online(user_dict):
    if not user_dict:
        return user_dict
    user_dict["is_online"] = 1 if _is_active(user_dict.get("last_active_at")) else 0
    return user_dict


def _apply_peer_online(row_dict):
    if not row_dict or "peer_last_active_at" not in row_dict:
        return row_dict
    row_dict["peer_online"] = 1 if _is_active(row_dict.get("peer_last_active_at")) else 0
    row_dict["peer_description"] = row_dict.get("peer_description") or ""
    row_dict["peer_avatar"] = row_dict.get("peer_avatar") or ""
    row_dict["peer_is_agent"] = int(row_dict.get("peer_is_agent") or 0)
    return row_dict


def _user_dict(user, *, include_password_hash=True, include_agent_token=True):
    if not user:
        return None
    data = {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "avatar": user.avatar or "",
        "description": user.description or "",
        "role": user.role,
        "is_agent": int(user.is_agent or 0),
        "last_active_at": user.last_active_at,
        "created_at": user.created_at,
    }
    if include_password_hash:
        data["password_hash"] = user.password_hash
    if include_agent_token:
        data["agent_token"] = user.agent_token
    return _apply_online(data)


def _group_dict(group):
    if not group:
        return None
    return {
        "id": group.id,
        "name": group.name,
        "avatar": group.avatar or "",
        "description": group.description or "",
        "created_by": group.created_by_id,
        "created_at": group.created_at,
    }


def _direct_chat_dict(chat):
    if not chat:
        return None
    return {
        "id": chat.id,
        "user1_id": chat.user1_id,
        "user2_id": chat.user2_id,
        "created_at": chat.created_at,
    }


def _message_dict(row):
    return {
        "id": row["id"],
        "chat_type": row["chat_type"],
        "chat_id": row["chat_id"],
        "sender_id": row["sender_id"],
        "content": row.get("content") or "",
        "content_type": row.get("content_type") or "text",
        "file_url": row.get("file_url") or "",
        "file_name": row.get("file_name") or "",
        "mentions": row.get("mentions") or "[]",
        "created_at": row["created_at"],
        "sender_name": row.get("sender_name"),
        "sender_avatar": row.get("sender_avatar") or "",
        "sender_is_agent": int(row.get("sender_is_agent") or 0),
    }


def init_db():
    with _connection() as db:
        existing_tables = set(db.get_tables())
        missing_models = [
            model
            for model in _MODELS
            if model._meta.table_name not in existing_tables
        ]
        if missing_models:
            db.create_tables(missing_models, safe=True)


def now():
    return time.time()


KIND_USER = "user"
KIND_GROUP = "group"
KIND_DIRECT = "direct"
KIND_MESSAGE = "message"

_ID_PREFIX = {
    KIND_USER: "u_",
    KIND_GROUP: "gc_",
    KIND_DIRECT: "dc_",
    KIND_MESSAGE: "msg_",
}


def new_id(kind):
    try:
        prefix = _ID_PREFIX[kind]
    except KeyError as e:
        raise ValueError(
            f"unknown id kind {kind!r}; expected one of {sorted(_ID_PREFIX)}"
        ) from e
    return prefix + uuid.uuid4().hex


def assert_kind(value, kind):
    prefix = _ID_PREFIX.get(kind)
    if prefix is None:
        raise ValueError(f"unknown id kind {kind!r}")
    if not isinstance(value, str) or not value.startswith(prefix):
        raise ValueError(f"expected {kind} id (prefix {prefix!r}), got {value!r}")


def create_user(username, password_hash, display_name, role="user", avatar=""):
    uid = new_id(KIND_USER)
    with _transaction():
        User.create(
            id=uid,
            username=username,
            password_hash=password_hash,
            display_name=display_name,
            avatar=avatar or "",
            description="",
            role=role,
            is_agent=0,
            created_at=now(),
        )
    return uid


def create_agent(username, display_name, token, avatar="", description=""):
    uid = new_id(KIND_USER)
    with _transaction():
        User.create(
            id=uid,
            username=username,
            password_hash=None,
            display_name=display_name,
            avatar=avatar or "",
            description=description or "",
            role="agent",
            is_agent=1,
            agent_token=token,
            created_at=now(),
        )
    return uid


def get_user_by_username(username):
    with _connection():
        return _user_dict(User.get_or_none(User.username == username))


def get_user_by_id(user_id):
    with _connection():
        return _user_dict(User.get_or_none(User.id == user_id))


def get_user_by_agent_token(token):
    with _connection():
        user = User.get_or_none((User.agent_token == token) & (User.is_agent == 1))
        return _user_dict(user)


def touch_active(user_id):
    if not user_id:
        return
    with _transaction():
        User.update(last_active_at=now()).where(User.id == user_id).execute()


def list_users():
    with _connection():
        users = list(User.select().order_by(User.created_at))
    return [
        _user_dict(user, include_password_hash=False, include_agent_token=False)
        for user in users
    ]


def list_agents():
    with _connection():
        users = list(User.select().where(User.is_agent == 1).order_by(User.created_at))
    return [
        _user_dict(user, include_password_hash=False, include_agent_token=True)
        for user in users
    ]


def get_user_footprint(user_id):
    with _connection():
        direct_chat_ids = [
            row.id for row in DirectChat
            .select(DirectChat.id)
            .where((DirectChat.user1 == user_id) | (DirectChat.user2 == user_id))
        ]
        owned_group_ids = [
            row.id for row in Group
            .select(Group.id)
            .where(Group.created_by == user_id)
        ]
        direct_msg_count = (
            Message
            .select()
            .where((Message.chat_type == "direct") & (Message.chat_id.in_(direct_chat_ids)))
            .count()
            if direct_chat_ids else 0
        )
        owned_group_msg_count = (
            Message
            .select()
            .where((Message.chat_type == "group") & (Message.chat_id.in_(owned_group_ids)))
            .count()
            if owned_group_ids else 0
        )
        own_messages = Message.select().where(Message.sender == user_id).count()
        joined_groups = GroupMember.select().where(GroupMember.user == user_id).count()
    return {
        "direct_chats": len(direct_chat_ids),
        "direct_messages": direct_msg_count,
        "owned_groups": len(owned_group_ids),
        "owned_group_messages": owned_group_msg_count,
        "joined_groups": joined_groups,
        "own_messages": own_messages,
    }


def delete_user(user_id):
    with _transaction():
        direct_chat_ids = [
            row.id for row in DirectChat
            .select(DirectChat.id)
            .where((DirectChat.user1 == user_id) | (DirectChat.user2 == user_id))
        ]
        for chat_id in direct_chat_ids:
            ReadCursor.delete().where(
                (ReadCursor.chat_type == "direct") & (ReadCursor.chat_id == chat_id)
            ).execute()
            Message.delete().where(
                (Message.chat_type == "direct") & (Message.chat_id == chat_id)
            ).execute()
            DirectChat.delete().where(DirectChat.id == chat_id).execute()

        owned_group_ids = [
            row.id for row in Group
            .select(Group.id)
            .where(Group.created_by == user_id)
        ]
        for group_id in owned_group_ids:
            ReadCursor.delete().where(
                (ReadCursor.chat_type == "group") & (ReadCursor.chat_id == group_id)
            ).execute()
            Message.delete().where(
                (Message.chat_type == "group") & (Message.chat_id == group_id)
            ).execute()
            GroupMember.delete().where(GroupMember.group == group_id).execute()
            Group.delete().where(Group.id == group_id).execute()

        Message.delete().where(Message.sender == user_id).execute()
        GroupMember.delete().where(GroupMember.user == user_id).execute()
        ReadCursor.delete().where(ReadCursor.user == user_id).execute()
        User.delete().where(User.id == user_id).execute()


def update_user(user_id, **kwargs):
    allowed = {"display_name", "avatar", "description", "password_hash", "role"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return
    with _transaction():
        User.update(**fields).where(User.id == user_id).execute()


def reset_agent_token(agent_id, token):
    with _transaction():
        User.update(agent_token=token).where(User.id == agent_id).execute()


def create_group(name, created_by, avatar="", description=""):
    assert_kind(created_by, KIND_USER)
    gid = new_id(KIND_GROUP)
    ts = now()
    with _transaction():
        Group.create(
            id=gid,
            name=name,
            avatar=avatar or "",
            description=description or "",
            created_by=created_by,
            created_at=ts,
        )
        GroupMember.create(group=gid, user=created_by, joined_at=ts)
    return gid


def get_group(group_id):
    with _connection():
        return _group_dict(Group.get_or_none(Group.id == group_id))


def add_group_member(group_id, user_id):
    assert_kind(group_id, KIND_GROUP)
    assert_kind(user_id, KIND_USER)
    condition = (GroupMember.group == group_id) & (GroupMember.user == user_id)
    try:
        with _transaction():
            if GroupMember.select().where(condition).exists():
                return
            GroupMember.create(group=group_id, user=user_id, joined_at=now())
    except IntegrityError:
        with _transaction():
            if GroupMember.select().where(condition).exists():
                return
        raise


def remove_group_member(group_id, user_id):
    with _transaction():
        GroupMember.delete().where(
            (GroupMember.group == group_id) & (GroupMember.user == user_id)
        ).execute()


def update_group(group_id, **kwargs):
    allowed = {"name", "avatar", "description"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return
    with _transaction():
        Group.update(**fields).where(Group.id == group_id).execute()


def get_group_members(group_id):
    query = (
        User
        .select()
        .join(GroupMember, on=(User.id == GroupMember.user))
        .where(GroupMember.group == group_id)
        .order_by(GroupMember.joined_at)
    )
    with _connection():
        users = list(query)
    return [
        _user_dict(user, include_password_hash=False, include_agent_token=False)
        for user in users
    ]


def get_user_groups(user_id):
    query = (
        Group
        .select()
        .join(GroupMember, on=(Group.id == GroupMember.group))
        .where(GroupMember.user == user_id)
        .order_by(Group.created_at)
    )
    with _connection():
        groups = list(query)
    return [_group_dict(group) for group in groups]


def delete_group(group_id):
    with _transaction():
        ReadCursor.delete().where(
            (ReadCursor.chat_type == "group") & (ReadCursor.chat_id == group_id)
        ).execute()
        Message.delete().where(
            (Message.chat_type == "group") & (Message.chat_id == group_id)
        ).execute()
        GroupMember.delete().where(GroupMember.group == group_id).execute()
        Group.delete().where(Group.id == group_id).execute()


def is_group_member(group_id, user_id):
    with _connection():
        return GroupMember.select().where(
            (GroupMember.group == group_id) & (GroupMember.user == user_id)
        ).exists()


def is_direct_chat_participant(chat_id, user_id):
    with _connection():
        return DirectChat.select().where(
            (DirectChat.id == chat_id) &
            ((DirectChat.user1 == user_id) | (DirectChat.user2 == user_id))
        ).exists()


def can_access_chat(chat_type, chat_id, user_id):
    if chat_type == "group":
        return is_group_member(chat_id, user_id)
    if chat_type == "direct":
        return is_direct_chat_participant(chat_id, user_id)
    return False


def delete_direct_chat(chat_id, user_id):
    with _transaction():
        chat = DirectChat.get_or_none(
            (DirectChat.id == chat_id) &
            ((DirectChat.user1 == user_id) | (DirectChat.user2 == user_id))
        )
        if not chat:
            return
        ReadCursor.delete().where(
            (ReadCursor.chat_type == "direct") & (ReadCursor.chat_id == chat_id)
        ).execute()
        Message.delete().where(
            (Message.chat_type == "direct") & (Message.chat_id == chat_id)
        ).execute()
        DirectChat.delete().where(DirectChat.id == chat_id).execute()


def get_direct_chat(chat_id):
    with _connection():
        return _direct_chat_dict(DirectChat.get_or_none(DirectChat.id == chat_id))


def get_or_create_direct_chat(user1_id, user2_id):
    assert_kind(user1_id, KIND_USER)
    assert_kind(user2_id, KIND_USER)
    a, b = sorted([user1_id, user2_id])
    try:
        with _transaction():
            chat = DirectChat.get_or_none((DirectChat.user1 == a) & (DirectChat.user2 == b))
            if chat:
                return _direct_chat_dict(chat)
            chat = DirectChat.create(
                id=new_id(KIND_DIRECT),
                user1=a,
                user2=b,
                created_at=now(),
            )
            return _direct_chat_dict(chat)
    except IntegrityError:
        with _connection():
            chat = DirectChat.get((DirectChat.user1 == a) & (DirectChat.user2 == b))
        return _direct_chat_dict(chat)


def get_user_direct_chats(user_id):
    U1 = User.alias()
    U2 = User.alias()
    peer_is_u2 = DirectChat.user1 == user_id
    query = (
        DirectChat
        .select(
            DirectChat.id.alias("id"),
            DirectChat.user1.alias("user1_id"),
            DirectChat.user2.alias("user2_id"),
            DirectChat.created_at.alias("created_at"),
            Case(None, ((peer_is_u2, U2.id),), U1.id).alias("peer_id"),
            Case(None, ((peer_is_u2, U2.display_name),), U1.display_name).alias("peer_name"),
            Case(None, ((peer_is_u2, U2.avatar),), U1.avatar).alias("peer_avatar"),
            Case(None, ((peer_is_u2, U2.description),), U1.description).alias("peer_description"),
            Case(None, ((peer_is_u2, U2.last_active_at),), U1.last_active_at).alias("peer_last_active_at"),
            Case(None, ((peer_is_u2, U2.is_agent),), U1.is_agent).alias("peer_is_agent"),
        )
        .join(U1, on=(DirectChat.user1 == U1.id))
        .switch(DirectChat)
        .join(U2, on=(DirectChat.user2 == U2.id))
        .where((DirectChat.user1 == user_id) | (DirectChat.user2 == user_id))
    )
    with _connection():
        rows = list(query.dicts())
    return [_apply_peer_online(dict(row)) for row in rows]


def get_direct_chat_peers(user_id):
    with _connection():
        chats = list(DirectChat.select().where(
            (DirectChat.user1 == user_id) | (DirectChat.user2 == user_id)
        ))
    return [chat.user2_id if chat.user1_id == user_id else chat.user1_id for chat in chats]


def get_presence_snapshot(user_ids):
    ids = [user_id for user_id in (user_ids or []) if user_id]
    if not ids:
        return []
    with _connection():
        users = list(User.select(User.id, User.last_active_at).where(User.id.in_(ids)))
    return [
        {
            "user_id": user.id,
            "is_online": 1 if _is_active(user.last_active_at) else 0,
            "last_active_at": user.last_active_at,
        }
        for user in users
    ]


def save_message(chat_type, chat_id, sender_id, content="", content_type="text",
                 file_url="", file_name="", mentions="[]"):
    assert_kind(sender_id, KIND_USER)
    assert_kind(chat_id, KIND_GROUP if chat_type == "group" else KIND_DIRECT)
    mid = new_id(KIND_MESSAGE)
    ts = now()
    with _transaction():
        Message.create(
            id=mid,
            chat_type=chat_type,
            chat_id=chat_id,
            sender=sender_id,
            content=content or "",
            content_type=content_type or "text",
            file_url=file_url or "",
            file_name=file_name or "",
            mentions=mentions or "[]",
            created_at=ts,
        )
    return {"id": mid, "created_at": ts}


def get_last_messages(chat_keys):
    if not chat_keys:
        return {}
    result = {}
    for chat_type, chat_id in chat_keys:
        query = (
            Message
            .select(
                Message.content,
                Message.content_type,
                Message.created_at,
                User.display_name.alias("sender_name"),
            )
            .join(User, on=(Message.sender == User.id))
            .where((Message.chat_type == chat_type) & (Message.chat_id == chat_id))
            .order_by(Message.created_at.desc())
            .limit(1)
        )
        with _connection():
            row = query.dicts().first()
        if row:
            result[f"{chat_type}_{chat_id}"] = dict(row)
    return result


def _messages_query(chat_type, chat_id, before=None, limit=50):
    query = (
        Message
        .select(
            Message.id.alias("id"),
            Message.chat_type.alias("chat_type"),
            Message.chat_id.alias("chat_id"),
            Message.sender.alias("sender_id"),
            Message.content.alias("content"),
            Message.content_type.alias("content_type"),
            Message.file_url.alias("file_url"),
            Message.file_name.alias("file_name"),
            Message.mentions.alias("mentions"),
            Message.created_at.alias("created_at"),
            User.display_name.alias("sender_name"),
            User.avatar.alias("sender_avatar"),
            User.is_agent.alias("sender_is_agent"),
        )
        .join(User, on=(Message.sender == User.id))
        .where((Message.chat_type == chat_type) & (Message.chat_id == chat_id))
    )
    if before:
        query = query.where(Message.created_at < before)
    query = query.order_by(Message.created_at.desc())
    if limit is not None:
        query = query.limit(limit)
    return query


def get_messages(chat_type, chat_id, before=None, limit=50):
    with _connection():
        rows = list(_messages_query(chat_type, chat_id, before=before, limit=limit).dicts())
    return [_message_dict(dict(row)) for row in reversed(rows)]


def mark_read(user_id, chat_type, chat_id, up_to_ts=None):
    ts = float(up_to_ts) if up_to_ts is not None else now()
    condition = (
        (ReadCursor.user == user_id) &
        (ReadCursor.chat_type == chat_type) &
        (ReadCursor.chat_id == chat_id)
    )
    try:
        with _transaction():
            updated = (
                ReadCursor
                .update(last_read_at=ts)
                .where(condition & (ReadCursor.last_read_at < ts))
                .execute()
            )
            if updated or ReadCursor.select().where(condition).exists():
                return
            ReadCursor.create(
                user=user_id,
                chat_type=chat_type,
                chat_id=chat_id,
                last_read_at=ts,
            )
    except IntegrityError:
        with _transaction():
            updated = (
                ReadCursor
                .update(last_read_at=ts)
                .where(condition & (ReadCursor.last_read_at < ts))
                .execute()
            )
            if updated or ReadCursor.select().where(condition).exists():
                return
        raise


def mark_read_up_to_message(user_id, message_id):
    with _connection():
        message = Message.get_or_none(Message.id == message_id)
    if not message:
        return False
    mark_read(user_id, message.chat_type, message.chat_id, message.created_at)
    return True


def mark_read_up_to_messages(user_id, message_ids):
    ids = [message_id for message_id in (message_ids or []) if message_id]
    if not ids:
        return
    query = (
        Message
        .select(
            Message.chat_type.alias("chat_type"),
            Message.chat_id.alias("chat_id"),
            fn.MAX(Message.created_at).alias("ts"),
        )
        .where(Message.id.in_(ids))
        .group_by(Message.chat_type, Message.chat_id)
    )
    with _connection():
        rows = list(query.dicts())
    for row in rows:
        mark_read(user_id, row["chat_type"], row["chat_id"], row["ts"])


def clear_unread(user_id, chat_type=None, chat_id=None):
    if chat_type and chat_id:
        mark_read(user_id, chat_type, chat_id)
        return
    ts = now()
    with _connection():
        direct = list(DirectChat.select(DirectChat.id).where(
            (DirectChat.user1 == user_id) | (DirectChat.user2 == user_id)
        ))
        groups = list(GroupMember.select(GroupMember.group).where(GroupMember.user == user_id))
    for row in direct:
        mark_read(user_id, "direct", row.id, ts)
    for row in groups:
        mark_read(user_id, "group", row.group_id, ts)


def _chat_baselines(user_id):
    baselines = []
    with _connection():
        direct = list(DirectChat.select().where(
            (DirectChat.user1 == user_id) | (DirectChat.user2 == user_id)
        ))
        memberships = list(GroupMember.select().where(GroupMember.user == user_id))
        cursors = {
            (row.chat_type, row.chat_id): row.last_read_at
            for row in ReadCursor.select().where(ReadCursor.user == user_id)
        }
    for chat in direct:
        key = ("direct", chat.id)
        baselines.append((key[0], key[1], cursors.get(key, chat.created_at)))
    for membership in memberships:
        key = ("group", membership.group_id)
        baselines.append((key[0], key[1], cursors.get(key, membership.joined_at)))
    return baselines


def get_unread_counts(user_id):
    result = {}
    for chat_type, chat_id, since in _chat_baselines(user_id):
        with _connection():
            count = Message.select().where(
                (Message.chat_type == chat_type) &
                (Message.chat_id == chat_id) &
                (Message.sender != user_id) &
                (Message.created_at > since)
            ).count()
        if count > 0:
            result[f"{chat_type}_{chat_id}"] = count
    return result


def get_unread_messages(user_id):
    rows = []
    for chat_type, chat_id, since in _chat_baselines(user_id):
        with _connection():
            rows.extend(
                list(
                    _messages_query(chat_type, chat_id, before=None, limit=None)
                    .where((Message.sender != user_id) & (Message.created_at > since))
                    .dicts()
                )
            )
    rows.sort(key=lambda row: row["created_at"])
    return [_message_dict(dict(row)) for row in rows]


def cleanup_old_messages(days=None, *, cutoff=None):
    if days is None:
        days = Config.MESSAGE_RETENTION_DAYS
    if days <= 0:
        return 0
    if cutoff is None:
        cutoff = now() - days * 86400
    with _transaction():
        return Message.delete().where(Message.created_at < cutoff).execute()


def get_setting(key):
    with _connection():
        setting = Setting.get_or_none(Setting.key == key)
    if setting:
        return setting.value
    return ""


def set_setting(key, value):
    try:
        with _transaction():
            updated = Setting.update(value=value).where(Setting.key == key).execute()
            if updated or Setting.select().where(Setting.key == key).exists():
                return
            Setting.create(key=key, value=value)
    except IntegrityError:
        with _transaction():
            updated = Setting.update(value=value).where(Setting.key == key).execute()
            if updated or Setting.select().where(Setting.key == key).exists():
                return
        raise


def get_all_settings():
    with _connection():
        settings = list(Setting.select())
    result = {}
    for setting in settings:
        result[setting.key] = setting.value
    return result
