from pathlib import Path

from agentclub import config


def test_database_url_defaults_to_sqlite_file(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTCLUB_HOME", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)

    config.refresh_config()

    assert config.Config.DATABASE_URL.startswith("sqlite:///")
    assert config.Config.DATABASE_URL.endswith("/agentclub.db")


def test_explicit_database_url_is_used(monkeypatch):
    url = "mysql://agent:secret@db.example:3306/agentclub"
    monkeypatch.setenv("DATABASE_URL", url)

    config.refresh_config()

    assert config.Config.DATABASE_URL == url


def test_database_path_config_is_not_exposed():
    assert not hasattr(config.Config, "DATABASE")


def test_server_source_has_no_sqlite3_direct_access():
    src_root = Path(__file__).resolve().parents[1] / "src" / "agentclub"
    offenders = []
    for path in src_root.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if "sqlite3" in text:
            offenders.append(path.relative_to(src_root).as_posix())
    assert offenders == []
