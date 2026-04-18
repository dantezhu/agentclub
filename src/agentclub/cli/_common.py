"""Shared utilities for all ``agentclub`` CLI subcommands.

The general flow every subcommand follows:

    1. Resolve the **data directory** (``--data-dir`` flag, else
       ``AGENTCLUB_HOME`` env, else ``~/.agentclub``).
    2. Load ``config.json`` from the data directory (if present) and
       propagate every UPPERCASE key into ``os.environ`` so that
       ``agentclub.config`` picks them up on import.
    3. Export ``AGENTCLUB_HOME`` so ``Config.BASE_DIR`` matches.
    4. Lazy-import the rest of the server (``agentclub.app`` /
       ``agentclub.models``) — this order matters: config must be
       materialized via env BEFORE those imports happen.

Keeping this all in one tiny module means every subcommand shares the
same precedence rules and error messages.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional

import click


CONFIG_FILENAME = "config.json"
DEFAULT_DATA_DIR = Path("~/.agentclub").expanduser()


def resolve_data_dir(cli_value: Optional[str]) -> Path:
    """Decide which directory is the runtime data root.

    Precedence: ``--data-dir`` flag > ``AGENTCLUB_HOME`` env >
    ``~/.agentclub``. The path is returned absolute so downstream
    code never has to re-resolve it."""
    if cli_value:
        return Path(cli_value).expanduser().resolve()
    env = os.environ.get("AGENTCLUB_HOME")
    if env:
        return Path(env).expanduser().resolve()
    return DEFAULT_DATA_DIR.resolve()


def config_path(data_dir: Path) -> Path:
    return data_dir / CONFIG_FILENAME


def load_config_file(data_dir: Path) -> dict:
    """Return the JSON config dict. Missing file → ``{}``."""
    path = config_path(data_dir)
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        raise click.ClickException(
            f"Invalid JSON in {path}: {e}"
        ) from e
    if not isinstance(data, dict):
        raise click.ClickException(
            f"Config file {path} must be a JSON object, got {type(data).__name__}"
        )
    return data


def apply_env(data_dir: Path, overrides: Optional[dict] = None) -> dict:
    """Propagate the resolved config into ``os.environ``.

    Precedence (lowest wins first — later overrides):

        1. existing env (kept as-is; only keys we don't set stay as env)
        2. ``config.json`` values
        3. explicit ``overrides`` (usually CLI flags)

    Any UPPERCASE key is exported; nested / non-string values are
    coerced via ``str(value)`` (``bool`` → ``"True"``/``"False"`` which
    ``Config._bool`` understands). Returns the merged dict for display.
    """
    file_cfg = load_config_file(data_dir)
    merged: dict = {}
    for src in (file_cfg, overrides or {}):
        for k, v in src.items():
            if not isinstance(k, str) or not k.isupper():
                continue
            merged[k] = v

    os.environ["AGENTCLUB_HOME"] = str(data_dir)
    for k, v in merged.items():
        if isinstance(v, bool):
            os.environ[k] = "true" if v else "false"
        else:
            os.environ[k] = str(v)

    # If ``agentclub.config`` was imported earlier in this process
    # (common during tests and when multiple CLI subcommands chain),
    # its class-level attributes are frozen to the values at first
    # import. Re-read from env to reflect our just-applied overrides.
    import sys as _sys
    if "agentclub.config" in _sys.modules:
        _sys.modules["agentclub.config"].refresh_config()

    return merged


def ensure_data_dir_exists(data_dir: Path) -> None:
    if not data_dir.exists():
        raise click.ClickException(
            f"Data directory does not exist: {data_dir}\n"
            f"Run `agentclub onboard --data-dir {data_dir}` first."
        )
    if not (data_dir / CONFIG_FILENAME).exists():
        raise click.ClickException(
            f"No config file at {data_dir / CONFIG_FILENAME}.\n"
            f"Run `agentclub onboard --data-dir {data_dir}` first."
        )


def bootstrap(data_dir_flag: Optional[str],
              *, require_exists: bool = True,
              overrides: Optional[dict] = None) -> Path:
    """Common prologue for every non-onboard subcommand.

    Resolves the data dir, loads config.json into env, optionally
    validates that the dir+config exist. Returns the resolved data dir
    so callers can print it or use it further.
    """
    data_dir = resolve_data_dir(data_dir_flag)
    if require_exists:
        ensure_data_dir_exists(data_dir)
    apply_env(data_dir, overrides=overrides)
    return data_dir


def echo_header(msg: str) -> None:
    click.echo(click.style(msg, bold=True))


def error_exit(msg: str, code: int = 1) -> None:
    click.echo(click.style(f"Error: {msg}", fg="red"), err=True)
    sys.exit(code)
