from contextlib import contextmanager
from pathlib import Path

from agentclub import config
from agentclub import models


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


def test_implicit_field_indexes_do_not_have_duplicate_explicit_indexes():
    offenders = []

    for model in models._MODELS:
        implicit_indexes = {
            name
            for name, field in model._meta.fields.items()
            if getattr(field, "index", False) or getattr(field, "unique", False)
        }
        for fields, _unique in model._meta.indexes:
            if len(fields) == 1 and fields[0] in implicit_indexes:
                offenders.append(f"{model.__name__}.{fields[0]}")

    assert offenders == []


def test_composite_primary_key_prefixes_do_not_create_redundant_indexes():
    offenders = []

    for model in models._MODELS:
        primary_key_fields = getattr(model._meta.primary_key, "field_names", ())
        if len(primary_key_fields) < 2:
            continue
        field_name = primary_key_fields[0]
        if getattr(model._meta.fields[field_name], "index", False):
            offenders.append(f"{model.__name__}.{field_name}")

    assert offenders == []


def test_generated_mysql_index_names_are_unique():
    from peewee import MySQLDatabase

    mysql_db = MySQLDatabase("agentclub")
    offenders = []

    with mysql_db.bind_ctx(models._MODELS, bind_refs=False, bind_backrefs=False):
        for model in models._MODELS:
            index_names = []
            for context in model._schema._create_indexes(safe=True):
                sql, _params = context.query()
                marker = " INDEX `"
                if marker in sql:
                    index_names.append(sql.split(marker, 1)[1].split("`", 1)[0])
            duplicates = {
                index_name
                for index_name in index_names
                if index_names.count(index_name) > 1
            }
            offenders.extend(
                f"{model.__name__}.{index_name}" for index_name in sorted(duplicates)
            )

    assert offenders == []


def test_generated_mysql_timestamp_columns_use_double_precision():
    from peewee import MySQLDatabase

    mysql_db = MySQLDatabase("agentclub")
    timestamp_columns = {
        models.User: ["last_active_at", "created_at"],
        models.Group: ["created_at"],
        models.GroupMember: ["joined_at"],
        models.DirectChat: ["created_at"],
        models.Message: ["created_at"],
        models.ReadCursor: ["last_read_at"],
    }
    offenders = []

    with mysql_db.bind_ctx(models._MODELS, bind_refs=False, bind_backrefs=False):
        for model, columns in timestamp_columns.items():
            sql, _params = model._schema._create_table(safe=True).query()
            for column in columns:
                marker = f"`{column}` DOUBLE"
                if marker not in sql:
                    offenders.append(f"{model.__name__}.{column}")

    assert offenders == []


def test_init_db_skips_create_tables_when_tables_already_exist(monkeypatch):
    calls = []

    class FakeDatabase:
        def get_tables(self):
            return [model._meta.table_name for model in models._MODELS]

        def create_tables(self, model_list, safe):
            calls.append((model_list, safe))

    @contextmanager
    def fake_connection():
        yield FakeDatabase()

    monkeypatch.setattr(models, "_connection", fake_connection)

    models.init_db()

    assert calls == []


def test_init_db_creates_only_missing_tables(monkeypatch):
    calls = []
    existing_tables = {models.User._meta.table_name, models.Group._meta.table_name}

    class FakeDatabase:
        def get_tables(self):
            return list(existing_tables)

        def create_tables(self, model_list, safe):
            calls.append((model_list, safe))

    @contextmanager
    def fake_connection():
        yield FakeDatabase()

    monkeypatch.setattr(models, "_connection", fake_connection)

    models.init_db()

    assert calls == [
        (
            [
                models.GroupMember,
                models.DirectChat,
                models.Message,
                models.ReadCursor,
                models.Setting,
            ],
            True,
        )
    ]
