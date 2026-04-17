import json
from flask import session, request
from flask_socketio import emit, join_room, leave_room
import models

# sid → user_id mapping
connected_users = {}
# user_id → set of sids (one user can have multiple tabs)
user_sids = {}
# sid → "chat_type_chat_id" currently viewing
active_chat = {}


def register_events(socketio):

    @socketio.on("connect")
    def on_connect(auth_data=None):
        auth_data = auth_data or {}

        # Agent token auth
        agent_token = auth_data.get("agent_token")
        if agent_token:
            user = models.get_user_by_agent_token(agent_token)
            if not user:
                return False  # reject connection
            _register_connection(user, request.sid)
            return

        # Web user session auth
        user_id = session.get("user_id")
        if not user_id:
            return False
        user = models.get_user_by_id(user_id)
        if not user:
            return False
        _register_connection(user, request.sid)

    @socketio.on("disconnect")
    def on_disconnect():
        active_chat.pop(request.sid, None)
        user_id = connected_users.pop(request.sid, None)
        if user_id:
            sids = user_sids.get(user_id, set())
            sids.discard(request.sid)
            if not sids:
                user_sids.pop(user_id, None)
                models.set_user_online(user_id, False)
                user = models.get_user_by_id(user_id)
                if user:
                    _broadcast_presence(user, False)

    @socketio.on("send_message")
    def on_send_message(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return

        chat_type = data.get("chat_type", "group")
        chat_id = data.get("chat_id")
        content = data.get("content", "")
        content_type = data.get("content_type", "text")
        file_url = data.get("file_url", "")
        file_name = data.get("file_name", "")
        mentions = json.dumps(data.get("mentions", []))

        if not chat_id:
            return

        # Permission check
        if chat_type == "group" and not models.is_group_member(chat_id, user_id):
            emit("error", {"message": "你不在这个群组中"})
            return

        result = models.save_message(
            chat_type, chat_id, user_id, content, content_type,
            file_url, file_name, mentions
        )
        sender = models.get_user_by_id(user_id)
        msg = {
            "id": result["id"],
            "chat_type": chat_type,
            "chat_id": chat_id,
            "sender_id": user_id,
            "sender_name": sender["display_name"],
            "sender_avatar": sender["avatar"],
            "sender_is_agent": sender["is_agent"],
            "content": content,
            "content_type": content_type,
            "file_url": file_url,
            "file_name": file_name,
            "mentions": data.get("mentions", []),
            "created_at": result["created_at"],
        }

        chat_key = f"{chat_type}_{chat_id}"

        # Unread tracking uses a per-(user,chat) read cursor; we don't
        # insert a row per recipient on send. Just notify recipients whose
        # counts may have changed (they might be viewing another chat and
        # want to see the badge update).
        if chat_type == "group":
            socketio.emit("new_message", msg, room=f"group_{chat_id}")
            members = models.get_group_members(chat_id)
            for m in members:
                if m["id"] == user_id:
                    continue
                viewing = any(
                    active_chat.get(sid) == chat_key
                    for sid in user_sids.get(m["id"], set())
                )
                if viewing:
                    # Recipient is actively looking at the chat → advance
                    # their cursor so the message doesn't linger as unread.
                    models.mark_read(m["id"], chat_type, chat_id, result["created_at"])
                else:
                    _notify_unread(socketio, m["id"])

        elif chat_type == "direct":
            db = models.get_db()
            chat = db.execute("SELECT * FROM direct_chats WHERE id = ?", (chat_id,)).fetchone()
            db.close()
            if chat:
                peer_id = chat["user2_id"] if chat["user1_id"] == user_id else chat["user1_id"]
                if peer_id in user_sids:
                    for sid in user_sids[peer_id]:
                        join_room(f"direct_{chat_id}", sid=sid)
                        socketio.emit("chat_list_updated", to=sid)
                viewing = any(
                    active_chat.get(sid) == chat_key
                    for sid in user_sids.get(peer_id, set())
                )
                if viewing:
                    models.mark_read(peer_id, chat_type, chat_id, result["created_at"])
                else:
                    _notify_unread(socketio, peer_id)
            socketio.emit("new_message", msg, room=f"direct_{chat_id}")

    @socketio.on("join_chat")
    def on_join_chat(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        chat_type = data.get("chat_type", "group")
        chat_id = data.get("chat_id")
        if not chat_id:
            return

        room = f"{chat_type}_{chat_id}"
        join_room(room)
        active_chat[request.sid] = f"{chat_type}_{chat_id}"
        models.clear_unread(user_id, chat_type, chat_id)

    @socketio.on("leave_chat")
    def on_leave_chat(data):
        chat_type = data.get("chat_type", "group")
        chat_id = data.get("chat_id")
        if chat_id:
            leave_room(f"{chat_type}_{chat_id}")
        active_chat.pop(request.sid, None)

    @socketio.on("typing")
    def on_typing(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        user = models.get_user_by_id(user_id)
        chat_type = data.get("chat_type", "group")
        chat_id = data.get("chat_id")
        if chat_id and user:
            room = f"{chat_type}_{chat_id}"
            emit("typing", {
                "user_id": user_id,
                "display_name": user["display_name"],
                "chat_type": chat_type,
                "chat_id": chat_id,
            }, room=room, include_self=False)

    @socketio.on("mark_read")
    def on_mark_read(data):
        """Advance the user's read cursor for a chat.

        Accepts either:
          {chat_type, chat_id}              → advance to now (bulk)
          {chat_type, chat_id, message_id}  → advance to that message's ts
          {message_id}                      → advance cursor inferred from
                                              the message's (chat_type, chat_id)
          {message_ids: [...]}              → batch form of the above

        Humans open a chat to emit the bulk form; agents emit the per-message
        form after processing each inbound message.
        """
        user_id = connected_users.get(request.sid)
        if not user_id:
            return

        ids = data.get("message_ids")
        if not ids and data.get("message_id"):
            ids = [data["message_id"]]

        if ids:
            models.mark_read_up_to_messages(user_id, ids)
            return

        chat_type = data.get("chat_type")
        chat_id = data.get("chat_id")
        if chat_type and chat_id:
            models.mark_read(user_id, chat_type, chat_id)


def _register_connection(user, sid):
    user_id = user["id"]
    connected_users[sid] = user_id
    if user_id not in user_sids:
        user_sids[user_id] = set()
    user_sids[user_id].add(sid)

    models.set_user_online(user_id, True)

    # Join all group rooms
    groups = models.get_user_groups(user_id)
    for g in groups:
        join_room(f"group_{g['id']}")

    # Join direct chat rooms
    dchats = models.get_user_direct_chats(user_id)
    for dc in dchats:
        join_room(f"direct_{dc['id']}")

    # Send any still-unread messages so the recipient can catch up. We do NOT
    # auto-clear here; the recipient must ACK explicitly (humans ACK by opening
    # a chat via `join_chat`/`mark_read`, agents ACK per-message via
    # `ack_message`). This prevents both (a) lost badges on page refresh and
    # (b) reply storms when an agent's socket reconnects and would otherwise
    # re-process already-handled messages.
    unread = models.get_unread_messages(user_id)
    if unread:
        for msg in unread:
            msg["mentions"] = json.loads(msg.get("mentions", "[]"))
        emit("offline_messages", unread)

    # Broadcast online status
    _broadcast_presence(user, True)

    emit("auth_ok", {
        "user_id": user_id,
        "display_name": user["display_name"],
        "role": user["role"],
        "is_agent": user["is_agent"],
    })


def _notify_unread(socketio, target_user_id):
    for sid in user_sids.get(target_user_id, set()):
        socketio.emit("unread_updated", to=sid)


def _broadcast_presence(user, online):
    from app import socketio
    socketio.emit("presence", {
        "user_id": user["id"],
        "display_name": user["display_name"],
        "is_online": online,
        "is_agent": user["is_agent"],
    })
