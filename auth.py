import hashlib
import hmac
import secrets
from functools import wraps
from flask import session, request, jsonify
import models


def hash_password(password):
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return f"{salt}${h.hex()}"


def verify_password(password, password_hash):
    if not password_hash:
        return False
    salt, h = password_hash.split("$", 1)
    computed = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return hmac.compare_digest(computed.hex(), h)


def generate_agent_token():
    return secrets.token_urlsafe(32)


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = session.get("user_id")
        if not user_id:
            return jsonify({"error": "未登录"}), 401
        user = models.get_user_by_id(user_id)
        if not user:
            session.clear()
            return jsonify({"error": "用户不存在"}), 401
        request.current_user = user
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = session.get("user_id")
        if not user_id:
            return jsonify({"error": "未登录"}), 401
        user = models.get_user_by_id(user_id)
        if not user or user["role"] != "admin":
            return jsonify({"error": "需要管理员权限"}), 403
        request.current_user = user
        return f(*args, **kwargs)
    return decorated
