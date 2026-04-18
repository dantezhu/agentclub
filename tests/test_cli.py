"""CLI integration tests.

Each test spins up an isolated data directory via ``tmp_path`` and
drives the Click commands end-to-end with ``CliRunner``. The goal
isn't to re-test server behaviour (``test_app.py`` does that) but to
pin the command surface: arguments, idempotency, expected side effects
on disk + DB.
"""
import json
import os
import sqlite3
from pathlib import Path

import pytest
from click.testing import CliRunner

from agentclub.cli import main
from agentclub.cli.onboard import onboard
from agentclub.cli.admin import admin_group
from agentclub.cli.agent import agent_group
from agentclub.cli.config_cmd import config_group


@pytest.fixture
def runner():
    return CliRunner()


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "ac-data"


def _onboard(runner, data_dir, **extra):
    args = ["--data-dir", str(data_dir), "--admin-password", "testpass123"]
    for k, v in extra.items():
        args += [f"--{k.replace('_', '-')}", str(v)]
    return runner.invoke(onboard, args)


# ── Onboard ──

class TestOnboard:
    def test_creates_data_dir_and_config(self, runner, data_dir):
        res = _onboard(runner, data_dir)
        assert res.exit_code == 0, res.output
        assert data_dir.exists()
        assert (data_dir / "config.json").exists()
        assert (data_dir / "uploads").exists()
        assert (data_dir / "agentclub.db").exists()

        cfg = json.loads((data_dir / "config.json").read_text())
        assert cfg["HOST"] == "0.0.0.0"
        assert cfg["PORT"] == 5555
        # SECRET_KEY must be a real key, not the dev fallback.
        assert len(cfg["SECRET_KEY"]) >= 32
        assert "dev-key" not in cfg["SECRET_KEY"]

    def test_admin_account_is_created(self, runner, data_dir):
        res = _onboard(runner, data_dir)
        assert res.exit_code == 0
        conn = sqlite3.connect(data_dir / "agentclub.db")
        row = conn.execute(
            "SELECT username, role FROM users WHERE username = 'admin'"
        ).fetchone()
        conn.close()
        assert row == ("admin", "admin")

    def test_random_password_is_generated_and_printed(self, runner, data_dir):
        # Drop the inline password → onboard should mint one and print it.
        res = runner.invoke(onboard, ["--data-dir", str(data_dir)])
        assert res.exit_code == 0
        # Password line is rendered with click.style; strip to plain text
        # for assertions.
        assert "password" in res.output
        # At minimum, there must be a 20-char alphanumeric token echoed.
        import re
        assert re.search(r"[A-Za-z0-9_\-]{16,}", res.output)

    def test_refuses_to_overwrite_without_force(self, runner, data_dir):
        r1 = _onboard(runner, data_dir)
        assert r1.exit_code == 0
        r2 = _onboard(runner, data_dir)
        assert r2.exit_code != 0
        assert "--force" in r2.output

    def test_force_overwrites_and_resets_admin_password(self, runner, data_dir):
        r1 = _onboard(runner, data_dir, admin_password="first1234")
        assert r1.exit_code == 0
        r2 = runner.invoke(onboard, [
            "--data-dir", str(data_dir),
            "--admin-password", "second4567",
            "--force",
        ])
        assert r2.exit_code == 0, r2.output
        # New password works; old one doesn't.
        from agentclub import models
        from agentclub.auth import verify_password
        # Be mindful: test_app.py may have pinned Config.DATABASE. Use a
        # direct connection instead of models.* to avoid that coupling.
        conn = sqlite3.connect(data_dir / "agentclub.db")
        row = conn.execute(
            "SELECT password_hash FROM users WHERE username = 'admin'"
        ).fetchone()
        conn.close()
        assert verify_password("second4567", row[0])
        assert not verify_password("first1234", row[0])


# ── Admin ──

class TestAdmin:
    def test_create_admin(self, runner, data_dir):
        _onboard(runner, data_dir)
        res = runner.invoke(admin_group, [
            "create", "alice",
            "--data-dir", str(data_dir),
            "--password", "alicepass",
        ])
        assert res.exit_code == 0, res.output
        conn = sqlite3.connect(data_dir / "agentclub.db")
        row = conn.execute(
            "SELECT role FROM users WHERE username = 'alice'"
        ).fetchone()
        conn.close()
        assert row == ("admin",)

    def test_create_admin_rejects_duplicate(self, runner, data_dir):
        _onboard(runner, data_dir)
        # `admin` was already created by onboard.
        res = runner.invoke(admin_group, [
            "create", "admin",
            "--data-dir", str(data_dir),
            "--password", "x",
        ])
        assert res.exit_code != 0
        assert "already exists" in res.output

    def test_passwd_changes_password(self, runner, data_dir):
        _onboard(runner, data_dir, admin_password="orig1234")
        res = runner.invoke(admin_group, [
            "passwd", "admin",
            "--data-dir", str(data_dir),
            "--password", "new5678",
        ])
        assert res.exit_code == 0, res.output

        from agentclub.auth import verify_password
        conn = sqlite3.connect(data_dir / "agentclub.db")
        row = conn.execute(
            "SELECT password_hash FROM users WHERE username = 'admin'"
        ).fetchone()
        conn.close()
        assert verify_password("new5678", row[0])
        assert not verify_password("orig1234", row[0])

    def test_passwd_rejects_non_admin(self, runner, data_dir):
        _onboard(runner, data_dir)
        # Insert a plain user directly.
        conn = sqlite3.connect(data_dir / "agentclub.db")
        conn.execute(
            "INSERT INTO users (id, username, password_hash, display_name, "
            "role, is_agent, created_at) VALUES ('u1', 'bob', 'x', 'Bob', "
            "'user', 0, 1)"
        )
        conn.commit()
        conn.close()

        res = runner.invoke(admin_group, [
            "passwd", "bob",
            "--data-dir", str(data_dir),
            "--password", "y",
        ])
        assert res.exit_code != 0
        assert "not an admin" in res.output


# ── Agent ──

class TestAgent:
    def test_create_agent_prints_token_once(self, runner, data_dir):
        _onboard(runner, data_dir)
        res = runner.invoke(agent_group, [
            "create", "bot1",
            "--data-dir", str(data_dir),
            "--display-name", "Bot One",
        ])
        assert res.exit_code == 0, res.output
        assert "token" in res.output
        # The printed token must match what's in the DB.
        conn = sqlite3.connect(data_dir / "agentclub.db")
        row = conn.execute(
            "SELECT agent_token, is_agent, display_name FROM users WHERE username = 'bot1'"
        ).fetchone()
        conn.close()
        assert row[1] == 1
        assert row[2] == "Bot One"
        assert row[0] in res.output

    def test_list_agents_never_shows_token(self, runner, data_dir):
        _onboard(runner, data_dir)
        runner.invoke(agent_group, [
            "create", "bot1",
            "--data-dir", str(data_dir),
        ])
        # Remember the token, then ensure list doesn't leak it.
        conn = sqlite3.connect(data_dir / "agentclub.db")
        token = conn.execute(
            "SELECT agent_token FROM users WHERE username = 'bot1'"
        ).fetchone()[0]
        conn.close()

        res = runner.invoke(agent_group, [
            "list", "--data-dir", str(data_dir),
        ])
        assert res.exit_code == 0, res.output
        assert "bot1" in res.output
        assert "STATUS" in res.output
        assert token not in res.output

    def test_list_empty(self, runner, data_dir):
        _onboard(runner, data_dir)
        res = runner.invoke(agent_group, [
            "list", "--data-dir", str(data_dir),
        ])
        assert res.exit_code == 0
        assert "No agents" in res.output

    def test_reset_token_replaces_old_one(self, runner, data_dir):
        _onboard(runner, data_dir)
        runner.invoke(agent_group, [
            "create", "bot1",
            "--data-dir", str(data_dir),
        ])
        conn = sqlite3.connect(data_dir / "agentclub.db")
        old_token = conn.execute(
            "SELECT agent_token FROM users WHERE username = 'bot1'"
        ).fetchone()[0]
        conn.close()

        res = runner.invoke(agent_group, [
            "reset-token", "bot1",
            "--data-dir", str(data_dir),
        ])
        assert res.exit_code == 0, res.output

        conn = sqlite3.connect(data_dir / "agentclub.db")
        new_token = conn.execute(
            "SELECT agent_token FROM users WHERE username = 'bot1'"
        ).fetchone()[0]
        conn.close()
        assert new_token != old_token
        assert new_token in res.output

    def test_reset_token_unknown_agent(self, runner, data_dir):
        _onboard(runner, data_dir)
        res = runner.invoke(agent_group, [
            "reset-token", "ghost",
            "--data-dir", str(data_dir),
        ])
        assert res.exit_code != 0
        assert "not found" in res.output


# ── Config show ──

class TestConfigShow:
    def test_reports_data_dir_and_redacts_secret(self, runner, data_dir):
        _onboard(runner, data_dir)
        res = runner.invoke(config_group, [
            "show", "--data-dir", str(data_dir),
        ])
        assert res.exit_code == 0, res.output
        assert str(data_dir) in res.output
        assert "SECRET_KEY" in res.output
        assert "redacted" in res.output

    def test_show_secrets_prints_key(self, runner, data_dir):
        _onboard(runner, data_dir)
        cfg = json.loads((data_dir / "config.json").read_text())
        res = runner.invoke(config_group, [
            "show", "--data-dir", str(data_dir), "--show-secrets",
        ])
        assert res.exit_code == 0
        assert cfg["SECRET_KEY"] in res.output


# ── Version ──

class TestVersion:
    def test_version_flag(self, runner):
        res = runner.invoke(main, ["--version"])
        assert res.exit_code == 0
        assert "agentclub" in res.output.lower() or "version" in res.output.lower()


# ── Data dir resolution guardrails ──

class TestDataDirResolution:
    def test_requires_onboarded_dir(self, runner, tmp_path):
        res = runner.invoke(config_group, [
            "show", "--data-dir", str(tmp_path / "nope"),
        ])
        assert res.exit_code != 0
        assert "does not exist" in res.output or "onboard" in res.output
