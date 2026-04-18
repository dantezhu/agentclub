import logging
import os
import json
from flask import Blueprint, request, session, jsonify, send_from_directory
from werkzeug.utils import secure_filename
from .config import Config
from .auth import hash_password, verify_password, generate_agent_token, login_required, admin_required
from . import models

api = Blueprint("api", __name__)
log = logging.getLogger(__name__)


def _get_ext(filename):
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def _allowed_file(filename):
    ext = _get_ext(filename)
    all_exts = set()
    for exts in Config.ALLOWED_EXTENSIONS.values():
        all_exts.update(exts)
    return ext in all_exts


def _detect_content_type(filename):
    ext = _get_ext(filename)
    for ctype, exts in Config.ALLOWED_EXTENSIONS.items():
        if ext in exts:
            return ctype
    return "file"


def _safe_filename(filename):
    """secure_filename that preserves the extension even for non-ASCII names."""
    ext = _get_ext(filename)
    base = secure_filename(filename.rsplit(".", 1)[0]) if "." in filename else secure_filename(filename)
    if not base:
        base = "file"
    return f"{base}.{ext}" if ext else base


# ── Auth routes ──

@api.route("/api/register", methods=["POST"])
def register():
    users = models.list_users()
    if users and not Config.ALLOW_REGISTRATION:
        return jsonify({"error": "注册功能已关闭"}), 403

    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "")
    display_name = data.get("display_name", "").strip() or username

    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400
    if len(username) < 2 or len(username) > 32:
        return jsonify({"error": "用户名长度 2-32 字符"}), 400
    if len(password) < 6:
        return jsonify({"error": "密码至少 6 个字符"}), 400

    if models.get_user_by_username(username):
        return jsonify({"error": "用户名已存在"}), 409

    role = "admin" if not users else "user"

    uid = models.create_user(username, hash_password(password), display_name, role=role)
    session["user_id"] = uid
    user = models.get_user_by_id(uid)
    return jsonify(_safe_user(user)), 201


@api.route("/api/registration-status")
def registration_status():
    users = models.list_users()
    allow = not users or Config.ALLOW_REGISTRATION
    return jsonify({"allow_registration": allow})


@api.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "")

    user = models.get_user_by_username(username)
    if not user or user["is_agent"] or not verify_password(password, user["password_hash"]):
        # Brute-force / typo investigation needs to know the attempted
        # username and the source IP, but never the password (don't even
        # log its length — gives attackers a sidechannel).
        log.warning("login failed: username=%r ip=%s", username, request.remote_addr)
        return jsonify({"error": "用户名或密码错误"}), 401

    session["user_id"] = user["id"]
    log.info("login ok: user=%s (%s) ip=%s", user["username"], user["id"], request.remote_addr)
    return jsonify(_safe_user(user))


@api.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@api.route("/api/me")
@login_required
def me():
    return jsonify(_safe_user(request.current_user))


@api.route("/api/me", methods=["PUT"])
@login_required
def update_me():
    data = request.get_json()
    updates = {}
    if "display_name" in data and data["display_name"].strip():
        updates["display_name"] = data["display_name"].strip()
    if "avatar" in data:
        updates["avatar"] = data["avatar"]
    if updates:
        models.update_user(request.current_user["id"], **updates)
    user = models.get_user_by_id(request.current_user["id"])
    return jsonify(_safe_user(user))


@api.route("/api/agents/<agent_id>", methods=["PUT"])
@admin_required
def update_agent(agent_id):
    agent = models.get_user_by_id(agent_id)
    if not agent or not agent["is_agent"]:
        return jsonify({"error": "Agent 不存在"}), 404
    data = request.get_json()
    updates = {}
    if "display_name" in data and data["display_name"].strip():
        updates["display_name"] = data["display_name"].strip()
    if "avatar" in data:
        updates["avatar"] = data["avatar"]
    if updates:
        models.update_user(agent_id, **updates)
    return jsonify({"ok": True})


@api.route("/api/agents/<agent_id>", methods=["DELETE"])
@admin_required
def delete_agent(agent_id):
    agent = models.get_user_by_id(agent_id)
    if not agent or not agent["is_agent"]:
        return jsonify({"error": "Agent 不存在"}), 404
    models.delete_user(agent_id)
    return jsonify({"ok": True})


@api.route("/api/groups/<group_id>", methods=["PUT"])
@login_required
def update_group(group_id):
    group = models.get_group(group_id)
    if not group:
        return jsonify({"error": "群组不存在"}), 404
    if group["created_by"] != request.current_user["id"]:
        return jsonify({"error": "只有创建者可以修改群组"}), 403
    data = request.get_json()
    updates = {}
    if "name" in data and data["name"].strip():
        updates["name"] = data["name"].strip()
    if "avatar" in data:
        updates["avatar"] = data["avatar"]
    if updates:
        models.update_group(group_id, **updates)
    return jsonify(models.get_group(group_id))


# ── Agent management (admin only) ──

@api.route("/api/agents", methods=["POST"])
@admin_required
def create_agent():
    data = request.get_json()
    username = data.get("username", "").strip()
    display_name = data.get("display_name", "").strip() or username
    avatar = data.get("avatar", "")

    if not username:
        return jsonify({"error": "用户名不能为空"}), 400
    if models.get_user_by_username(username):
        return jsonify({"error": "用户名已存在"}), 409

    token = generate_agent_token()
    uid = models.create_agent(username, display_name, token, avatar)
    agent = models.get_user_by_id(uid)
    return jsonify({**_safe_user(agent), "agent_token": token}), 201


@api.route("/api/agents")
@admin_required
def list_agents():
    return jsonify(models.list_agents())


@api.route("/api/users")
@login_required
def list_users():
    return jsonify(models.list_users())


# ── Group management ──

@api.route("/api/groups", methods=["POST"])
@login_required
def create_group():
    data = request.get_json()
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "群组名不能为空"}), 400

    gid = models.create_group(name, request.current_user["id"], data.get("avatar", ""))
    group = models.get_group(gid)
    return jsonify(group), 201


@api.route("/api/groups")
@login_required
def list_groups():
    return jsonify(models.get_user_groups(request.current_user["id"]))


@api.route("/api/groups/<group_id>")
@login_required
def get_group(group_id):
    group = models.get_group(group_id)
    if not group:
        return jsonify({"error": "群组不存在"}), 404
    return jsonify(group)


@api.route("/api/groups/<group_id>/members")
@login_required
def group_members(group_id):
    if not models.is_group_member(group_id, request.current_user["id"]):
        return jsonify({"error": "你不在这个群组中"}), 403
    return jsonify(models.get_group_members(group_id))


@api.route("/api/groups/<group_id>/members", methods=["POST"])
@login_required
def add_member(group_id):
    group = models.get_group(group_id)
    if not group:
        return jsonify({"error": "群组不存在"}), 404
    cur = request.current_user
    if cur["role"] != "admin" and group["created_by"] != cur["id"]:
        return jsonify({"error": "只有管理员或群创建者可以添加成员"}), 403
    data = request.get_json()
    user_id = data.get("user_id")
    if not user_id or not models.get_user_by_id(user_id):
        return jsonify({"error": "用户不存在"}), 404
    models.add_group_member(group_id, user_id)

    # Push the new membership to any open tabs the user has. Two subtleties:
    #   1. We cannot use `flask_socketio.join_room(...)` here because it tries
    #      to read `flask.request.namespace`, which only exists inside a
    #      Socket.IO event handler — HTTP routes don't have it.
    #   2. `user_sids` can contain stale sids (between a reload's connect and
    #      the old socket's disconnect, or after an engineio ping timeout).
    #      `server.enter_room` raises `ValueError: sid is not connected to
    #      requested namespace` for those, so we guard and skip.
    from .socket_events import user_sids
    from .app import socketio
    _room_transition(socketio, user_sids.get(user_id, set()), f"group_{group_id}", join=True)

    return jsonify({"ok": True})


def _room_transition(socketio, sids, room, *, join):
    """Best-effort add/remove sids to a Socket.IO room from an HTTP context.
    Stale sids are silently skipped; a sidebar-refresh nudge is emitted to
    every sid we tried, regardless of outcome."""
    for sid in list(sids):
        try:
            if join:
                socketio.server.enter_room(sid, room, namespace="/")
            else:
                socketio.server.leave_room(sid, room, namespace="/")
        except (KeyError, ValueError):
            # sid has already disconnected — nothing to do.
            pass
        try:
            socketio.emit("chat_list_updated", to=sid)
        except Exception:
            pass


@api.route("/api/groups/<group_id>/members/<user_id>", methods=["DELETE"])
@login_required
def remove_member(group_id, user_id):
    group = models.get_group(group_id)
    if not group:
        return jsonify({"error": "群组不存在"}), 404
    cur = request.current_user
    if cur["role"] != "admin" and group["created_by"] != cur["id"]:
        return jsonify({"error": "只有管理员或群创建者可以移除成员"}), 403
    if user_id == group["created_by"]:
        return jsonify({"error": "不能移除群创建者"}), 400
    models.remove_group_member(group_id, user_id)

    # Kick the removed user out of the Socket.IO room so they stop seeing
    # new messages immediately, and push a sidebar refresh.
    from .socket_events import user_sids
    from .app import socketio
    _room_transition(socketio, user_sids.get(user_id, set()), f"group_{group_id}", join=False)

    return jsonify({"ok": True})


@api.route("/api/groups/<group_id>", methods=["DELETE"])
@login_required
def delete_group(group_id):
    group = models.get_group(group_id)
    if not group:
        return jsonify({"error": "群组不存在"}), 404
    if group["created_by"] != request.current_user["id"]:
        return jsonify({"error": "只有创建者可以解散群组"}), 403
    # Notify all online members
    from .socket_events import user_sids
    from .app import socketio
    members = models.get_group_members(group_id)
    for m in members:
        if m["id"] in user_sids:
            for sid in user_sids[m["id"]]:
                socketio.emit("chat_list_updated", to=sid)
    models.delete_group(group_id)
    return jsonify({"ok": True})


@api.route("/api/groups/<group_id>/leave", methods=["POST"])
@login_required
def leave_group(group_id):
    group = models.get_group(group_id)
    if not group:
        return jsonify({"error": "群组不存在"}), 404
    if group["created_by"] == request.current_user["id"]:
        return jsonify({"error": "创建者不能退出群组，请使用解散功能"}), 400
    models.remove_group_member(group_id, request.current_user["id"])
    return jsonify({"ok": True})


@api.route("/api/direct-chats/<chat_id>", methods=["DELETE"])
@login_required
def delete_direct_chat(chat_id):
    models.delete_direct_chat(chat_id, request.current_user["id"])
    return jsonify({"ok": True})


# ── Direct chats ──

@api.route("/api/direct-chats")
@login_required
def list_direct_chats():
    return jsonify(models.get_user_direct_chats(request.current_user["id"]))


@api.route("/api/direct-chats", methods=["POST"])
@login_required
def create_direct_chat():
    data = request.get_json()
    peer_id = data.get("user_id")
    if not peer_id or not models.get_user_by_id(peer_id):
        return jsonify({"error": "用户不存在"}), 404
    chat = models.get_or_create_direct_chat(request.current_user["id"], peer_id)
    return jsonify(chat)


# ── Messages ──

@api.route("/api/unread-counts")
@login_required
def unread_counts():
    return jsonify(models.get_unread_counts(request.current_user["id"]))


@api.route("/api/presence")
@login_required
def presence_snapshot():
    """Return the current online state of a batch of users.

    Default scope (no `user_ids` param): every peer the current user has
    a direct chat with. Groups are intentionally excluded because the
    Web UI doesn't display real-time presence for group members — opening
    the members panel fetches a one-shot snapshot via `/api/groups/.../members`.

    With `?user_ids=a,b,c`: restricted to the given ids that the user can
    legitimately see. Right now "can see" just means they exist; tighten
    if we ever add privacy controls.

    Response shape:
      [{ "user_id": "...", "is_online": 0|1, "last_active_at": 123.4 }]
    """
    raw = request.args.get("user_ids", "").strip()
    if raw:
        ids = [x for x in (s.strip() for s in raw.split(",")) if x]
    else:
        ids = models.get_direct_chat_peers(request.current_user["id"])
    return jsonify(models.get_presence_snapshot(ids))


@api.route("/api/last-messages")
@login_required
def last_messages():
    uid = request.current_user["id"]
    groups = models.get_user_groups(uid)
    directs = models.get_user_direct_chats(uid)
    chat_keys = [(("group", g["id"])) for g in groups] + [("direct", d["id"]) for d in directs]
    return jsonify(models.get_last_messages(chat_keys))


@api.route("/api/messages/<chat_type>/<chat_id>")
@login_required
def get_messages(chat_type, chat_id):
    before = request.args.get("before", type=float)
    limit = min(request.args.get("limit", Config.MESSAGE_PAGE_SIZE, type=int), 100)
    messages = models.get_messages(chat_type, chat_id, before=before, limit=limit)
    models.clear_unread(request.current_user["id"], chat_type, chat_id)
    return jsonify(messages)


# ── File upload ──

@api.route("/api/upload", methods=["POST"])
@login_required
def upload_file():
    if "file" not in request.files:
        return jsonify({"error": "没有文件"}), 400
    f = request.files["file"]
    if not f.filename or not _allowed_file(f.filename):
        return jsonify({"error": "不支持的文件类型"}), 400

    filename = _safe_filename(f.filename)
    unique_name = f"{models.new_id()}_{filename}"
    filepath = os.path.join(Config.UPLOAD_FOLDER, unique_name)
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
    f.save(filepath)

    url = f"/media/uploads/{unique_name}"
    content_type = _detect_content_type(filename)
    return jsonify({"url": url, "filename": filename, "content_type": content_type})


# ── File upload for agents (token auth) ──

@api.route("/api/agent/upload", methods=["POST"])
def agent_upload_file():
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        return jsonify({"error": "缺少认证"}), 401
    user = models.get_user_by_agent_token(token)
    if not user:
        return jsonify({"error": "无效的 Token"}), 401

    if "file" not in request.files:
        return jsonify({"error": "没有文件"}), 400
    f = request.files["file"]
    if not f.filename or not _allowed_file(f.filename):
        return jsonify({"error": "不支持的文件类型"}), 400

    filename = _safe_filename(f.filename)
    unique_name = f"{models.new_id()}_{filename}"
    filepath = os.path.join(Config.UPLOAD_FOLDER, unique_name)
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
    f.save(filepath)

    url = f"/media/uploads/{unique_name}"
    content_type = _detect_content_type(filename)
    return jsonify({"url": url, "filename": filename, "content_type": content_type})


# ── Agent message history (token auth) ──

@api.route("/api/agent/messages/<chat_type>/<chat_id>")
def agent_get_messages(chat_type, chat_id):
    """Token-authenticated message history for agents."""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        return jsonify({"error": "缺少认证"}), 401
    user = models.get_user_by_agent_token(token)
    if not user:
        return jsonify({"error": "无效的 Token"}), 401

    before = request.args.get("before", type=float)
    limit = min(request.args.get("limit", Config.MESSAGE_PAGE_SIZE, type=int), 100)
    messages = models.get_messages(chat_type, chat_id, before=before, limit=limit)
    return jsonify(messages)


# ── Agent chat list (token auth) ──

@api.route("/api/agent/chats")
def agent_list_chats():
    """Token-authenticated chat list for agents."""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        return jsonify({"error": "缺少认证"}), 401
    user = models.get_user_by_agent_token(token)
    if not user:
        return jsonify({"error": "无效的 Token"}), 401

    groups = models.get_user_groups(user["id"])
    directs = models.get_user_direct_chats(user["id"])
    return jsonify({"groups": groups, "directs": directs})


# Mirror of `/api/groups/<id>/members` but authenticated via agent token so
# channel plugins can resolve display-name ↔ user-id for @mention handling
# without needing a browser session.
@api.route("/api/agent/groups/<group_id>/members")
def agent_group_members(group_id):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        return jsonify({"error": "缺少认证"}), 401
    user = models.get_user_by_agent_token(token)
    if not user:
        return jsonify({"error": "无效的 Token"}), 401
    if not models.is_group_member(group_id, user["id"]):
        return jsonify({"error": "不在该群组中"}), 403
    return jsonify(models.get_group_members(group_id))


@api.route("/media/uploads/<filename>")
def serve_upload(filename):
    return send_from_directory(Config.UPLOAD_FOLDER, filename)


# ── Admin settings ──

@api.route("/api/settings")
@admin_required
def get_settings():
    return jsonify(models.get_all_settings())


@api.route("/api/settings", methods=["PUT"])
@admin_required
def update_settings():
    data = request.get_json()
    for key, value in data.items():
        models.set_setting(key, value)
    return jsonify(models.get_all_settings())


def _safe_user(user):
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "avatar": user["avatar"],
        "role": user["role"],
        "is_agent": user["is_agent"],
        "is_online": user["is_online"],
    }
