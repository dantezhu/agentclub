"""CLI integration tests.

Each test spins up an isolated data directory via ``tmp_path`` and
drives the Click commands end-to-end with ``CliRunner``. The goal
isn't to re-test server behaviour (``test_app.py`` does that) but to
pin the command surface: arguments, idempotency, expected side effects
on disk + DB.
"""
import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from agentclub.cli import main
from agentclub.cli.onboard import onboard
from agentclub.cli.agent import agent_group
from agentclub.cli.config_cmd import config_group
from agentclub.cli._common import DEFAULT_DATA_DIR, resolve_data_dir


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


def _models_for_data_dir(data_dir):
    db_path = data_dir / "agentclub.db"
    return _models_for_url(f"sqlite:///{db_path}")


def _models_for_url(database_url):
    from agentclub import config, models

    config.Config.DATABASE_URL = database_url
    models.init_db()
    return models


# ── Onboard ──

class TestOnboard:
    def test_creates_data_dir_and_config(self, runner, data_dir):
        res = _onboard(runner, data_dir)
        assert res.exit_code == 0, res.output
        assert data_dir.exists()
        assert (data_dir / "config.json").exists()
        assert (data_dir / "media" / "uploads").exists()
        assert (data_dir / "agentclub.db").exists()

        cfg = json.loads((data_dir / "config.json").read_text())
        assert cfg["HOST"] == "127.0.0.1"
        assert cfg["PORT"] == 5555
        assert cfg["DATABASE_URL"] == f"sqlite:///{data_dir / 'agentclub.db'}"
        # SECRET_KEY must be a real key, not the dev fallback.
        assert len(cfg["SECRET_KEY"]) >= 32
        assert "dev-key" not in cfg["SECRET_KEY"]

    def test_admin_account_is_created(self, runner, data_dir):
        res = _onboard(runner, data_dir)
        assert res.exit_code == 0
        models = _models_for_data_dir(data_dir)
        user = models.get_user_by_username("admin")
        assert user["username"] == "admin"
        assert user["role"] == "admin"

    def test_database_url_option_is_written_and_initialized(self, runner, data_dir, tmp_path):
        custom_db = tmp_path / "custom-agentclub.db"
        database_url = f"sqlite:///{custom_db}"

        res = _onboard(runner, data_dir, database_url=database_url)

        assert res.exit_code == 0, res.output
        cfg = json.loads((data_dir / "config.json").read_text())
        assert cfg["DATABASE_URL"] == database_url
        assert database_url in res.output
        assert custom_db.exists()
        assert not (data_dir / "agentclub.db").exists()

        models = _models_for_url(database_url)
        user = models.get_user_by_username("admin")
        assert user["username"] == "admin"
        assert user["role"] == "admin"

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
        from agentclub.auth import verify_password
        models = _models_for_data_dir(data_dir)
        user = models.get_user_by_username("admin")
        assert verify_password("second4567", user["password_hash"])
        assert not verify_password("first1234", user["password_hash"])


# Admin-specific CLI tests used to live here under ``TestAdmin``;
# they were removed when ``cli/admin.py`` was folded into the unified
# ``cli/user.py`` (admin is just ``role=admin`` on a regular user
# account, so create/edit/delete share the same surface). Coverage for
# those operations now lives implicitly in ``test_app.py`` (role
# semantics) and would belong in a future ``TestUser`` class here if
# the CLI surface needs end-to-end pinning again.


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
        models = _models_for_data_dir(data_dir)
        agent = models.get_user_by_username("bot1")
        assert agent["is_agent"] == 1
        assert agent["display_name"] == "Bot One"
        assert agent["agent_token"] in res.output

    def test_list_agents_never_shows_token(self, runner, data_dir):
        _onboard(runner, data_dir)
        runner.invoke(agent_group, [
            "create", "bot1",
            "--data-dir", str(data_dir),
        ])
        # Remember the token, then ensure list doesn't leak it.
        models = _models_for_data_dir(data_dir)
        token = models.get_user_by_username("bot1")["agent_token"]

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
        models = _models_for_data_dir(data_dir)
        old_token = models.get_user_by_username("bot1")["agent_token"]

        res = runner.invoke(agent_group, [
            "reset-token", "bot1",
            "--data-dir", str(data_dir),
        ])
        assert res.exit_code == 0, res.output

        models = _models_for_data_dir(data_dir)
        new_token = models.get_user_by_username("bot1")["agent_token"]
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
        assert "DATABASE_URL" in res.output
        assert "DATABASE " not in res.output
        assert "redacted" in res.output
        assert "SESSION_LIFETIME_DAYS" in res.output

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
    def test_default_ignores_agentclub_home_env(self, monkeypatch, tmp_path):
        monkeypatch.setenv("AGENTCLUB_HOME", str(tmp_path / "ignored"))

        assert resolve_data_dir(None) == DEFAULT_DATA_DIR.resolve()

    def test_requires_onboarded_dir(self, runner, tmp_path):
        res = runner.invoke(config_group, [
            "show", "--data-dir", str(tmp_path / "nope"),
        ])
        assert res.exit_code != 0
        assert "does not exist" in res.output or "onboard" in res.output
