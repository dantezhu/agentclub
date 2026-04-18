import json
import logging
from flask import session, request
from flask_socketio import emit, join_room, leave_room
from .config import Config
from . import models

log = logging.getLogger(__name__)

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
                log.warning("socket connect rejected: invalid agent_token sid=%s", request.sid)
                return False  # reject connection
            _register_connection(user, request.sid)
            log.info("socket connect: agent=%s (%s) sid=%s", user["username"], user["id"], request.sid)
            return

        # Web user session auth
        user_id = session.get("user_id")
        if not user_id:
            log.debug("socket connect rejected: no session sid=%s", request.sid)
            return False
        user = models.get_user_by_id(user_id)
        if not user:
            log.warning("socket connect rejected: stale session user_id=%s sid=%s", user_id, request.sid)
            return False
        _register_connection(user, request.sid)
        log.info("socket connect: user=%s (%s) sid=%s", user["username"], user["id"], request.sid)

    @socketio.on("disconnect")
    def on_disconnect():
        """Release the in-memory sid → user mapping.

        Presence is NOT flipped here. It's a pure function of
        `last_active_at` + ACTIVE_TIMEOUT, so a disconnected client will
        naturally age out of "online" once their heartbeat stops bumping
        the timestamp. This avoids the historical footgun where a
        silent-disconnect (browser crash, lid close, network drop) would
        keep the user stuck showing online until the sweeper ran."""
        active_chat.pop(request.sid, None)
        user_id = connected_users.pop(request.sid, None)
        if user_id:
            sids = user_sids.get(user_id, set())
            sids.discard(request.sid)
            if not sids:
                user_sids.pop(user_id, None)
            log.info("socket disconnect: user=%s sid=%s remaining_sids=%d",
                     user_id, request.sid, len(sids))

    @socketio.on("send_message")
    def on_send_message(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        models.touch_active(user_id)

        chat_type = data.get("chat_type", "group")
        chat_id = data.get("chat_id")
        content = data.get("content", "")
        content_type = data.get("content_type", "text")
        file_url = data.get("file_url", "")
        file_name = data.get("file_name", "")

        # `mentions` travels the wire as an array of user_ids (uuid strings)
        # plus the special literal "all" for @everyone. We normalize here so
        # downstream (DB, channel plugins) can trust the shape.
        raw_mentions = data.get("mentions", [])
        if not isinstance(raw_mentions, list):
            raw_mentions = []
        mentions_list = []
        seen = set()
        for item in raw_mentions:
            if not isinstance(item, str):
                continue
            item = item.strip()
            if not item or item in seen:
                continue
            seen.add(item)
            mentions_list.append(item)
            if len(mentions_list) >= 100:
                break
        mentions = json.dumps(mentions_list)

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
            "mentions": mentions_list,
            "created_at": result["created_at"],
        }

        chat_key = f"{chat_type}_{chat_id}"

        # Unread tracking uses a per-(user,chat) read cursor; we don't
        # insert a row per recipient on send. Just notify recipients whose
        # counts may have changed (they might be viewing another chat and
        # want to see the badge update).
        if chat_type == "group":
            # Broadcast directly to each member's sids rather than via the
            # ``group_{id}`` Socket.IO room. The room is populated by
            # ``_register_connection`` at connect time and best-effort
            # ``enter_room`` calls from ``routes.add_member``; the latter
            # has proven unreliable for already-connected agent sockets
            # (sid staleness / namespace timing), so members added after
            # the bot connected wouldn't receive messages until the bot
            # reconnected. Driving the fan-out off the ``group_members``
            # table makes the source of truth the DB, not the in-memory
            # room registry — agents and humans alike now always receive
            # every message they're entitled to.
            members = models.get_group_members(chat_id)
            for m in members:
                # Sender's own tabs are included here so the web UI's
                # optimistic-less render pipeline (which draws every
                # message, including one's own, off the server echo)
                # keeps working.
                for sid in user_sids.get(m["id"], set()):
                    socketio.emit("new_message", msg, to=sid)
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

    @socketio.on("heartbeat")
    def on_heartbeat():
        """Application-level ping/pong.

        Clients (web + agent) emit this every ~HEARTBEAT_INTERVAL seconds
        over the existing socket. We bump the user's `last_active_at` so
        `_is_active()` can distinguish a live session from a zombie one
        (TCP path dead without firing `disconnect`). The `heartbeat_ack`
        echo lets the client verify the round trip and optionally react
        (we don't currently, but it keeps the door open for client-side
        liveness checks)."""
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        models.touch_active(user_id)
        emit("heartbeat_ack")

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
        models.touch_active(user_id)

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

    # Mark the user active immediately so polling peers see the online
    # flip on their next `/api/presence` tick without waiting for the
    # first heartbeat.
    models.touch_active(user_id)

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

    emit("auth_ok", {
        "user_id": user_id,
        "display_name": user["display_name"],
        "role": user["role"],
        "is_agent": user["is_agent"],
        # Server-preferred cadences so every client (web, nanobot,
        # openclaw) uses one source of truth and a deploy-time config
        # change takes effect everywhere on the next reconnect.
        "heartbeat_interval": Config.HEARTBEAT_INTERVAL,
        "presence_poll_interval": Config.PRESENCE_POLL_INTERVAL,
    })


def _notify_unread(socketio, target_user_id):
    for sid in user_sids.get(target_user_id, set()):
        socketio.emit("unread_updated", to=sid)
