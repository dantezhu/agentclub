"""`agentclub onboard` — one-shot, non-interactive first-time setup.

Creates (in order):
    - the data directory
    - config.json with HOST/PORT + a freshly minted SECRET_KEY
    - the SQLite database with the current schema
    - an admin account (password random-generated if not supplied)

Idempotency is strict by design: re-running on a populated data
directory fails unless ``--force`` is given. This mirrors
``django-admin startproject`` and avoids the classic footgun where a
second ``onboard`` silently overwrites the SECRET_KEY and breaks every
signed cookie / session in flight.

Passwords have two input channels:
    --admin-password PASS        inline (convenient but leaks to $hist)
    --admin-password-stdin       read from stdin (script / pipe friendly)
If neither is provided, a 20-char random one is generated and printed
ONCE.
"""
from __future__ import annotations

import json
import os
import secrets
import sys
from pathlib import Path

import click

from ._common import (
    CONFIG_FILENAME,
    apply_env,
    config_path,
    echo_header,
    resolve_data_dir,
)


def _read_password_from_stdin() -> str:
    data = sys.stdin.read().strip()
    if not data:
        raise click.ClickException("No password received on stdin.")
    return data


def _random_password(length: int = 20) -> str:
    # URL-safe alphabet, ~128 bits of entropy at length 20.
    return secrets.token_urlsafe(length)[:length]


@click.command(help="Initialize a new AgentClub data directory.")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Where to create the data directory. Defaults to "
                   "$AGENTCLUB_HOME or ~/.agentclub.")
@click.option("--host", default="0.0.0.0", show_default=True,
              help="Bind address to write into config.json.")
@click.option("--port", default=5555, show_default=True, type=int,
              help="Bind port to write into config.json.")
@click.option("--admin-username", default="admin", show_default=True,
              help="Initial admin username.")
@click.option("--admin-display-name", default=None,
              help="Initial admin display name. Defaults to --admin-username.")
@click.option("--admin-password", default=None,
              help="Initial admin password (inline). Discouraged — use "
                   "--admin-password-stdin for scripts.")
@click.option("--admin-password-stdin", is_flag=True,
              help="Read the admin password from stdin.")
@click.option("--force", is_flag=True,
              help="Overwrite an existing data directory (rewrites config "
                   "+ re-initializes DB but preserves already-stored data).")
def onboard(data_dir_flag, host, port, admin_username, admin_display_name,
            admin_password, admin_password_stdin, force):
    data_dir = resolve_data_dir(data_dir_flag)
    cfg_path = config_path(data_dir)

    if cfg_path.exists() and not force:
        raise click.ClickException(
            f"{cfg_path} already exists. Use --force to overwrite, or pick a "
            f"different --data-dir."
        )

    # Resolve password.
    if admin_password and admin_password_stdin:
        raise click.ClickException(
            "Use either --admin-password or --admin-password-stdin, not both."
        )
    generated_password = False
    if admin_password_stdin:
        admin_password = _read_password_from_stdin()
    elif not admin_password:
        admin_password = _random_password()
        generated_password = True

    # ── Create dirs, write config.json ──
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "media" / "uploads").mkdir(parents=True, exist_ok=True)
    (data_dir / "logs").mkdir(exist_ok=True)

    config_data = {
        "HOST": host,
        "PORT": port,
        "SECRET_KEY": secrets.token_hex(32),
    }
    with cfg_path.open("w", encoding="utf-8") as f:
        json.dump(config_data, f, indent=2)
        f.write("\n")

    # ── Load the config we just wrote into env, then init DB ──
    apply_env(data_dir)
    from .. import models  # noqa: WPS433 — lazy on purpose
    from ..auth import hash_password
    models.init_db()

    # ── Upsert the admin ──
    existing = models.get_user_by_username(admin_username)
    display = admin_display_name or admin_username
    if existing:
        # The onboard command is idempotent-with-force: reset the password
        # and role rather than refusing, so the user's recovery path is
        # "re-run onboard --force" without needing a separate `admin passwd`.
        models.update_user(
            existing["id"],
            password_hash=hash_password(admin_password),
            role="admin",
            display_name=display,
        )
    else:
        models.create_user(admin_username, hash_password(admin_password),
                           display, role="admin")

    # ── Pretty summary ──
    click.echo("")
    echo_header("✓ AgentClub onboarded")
    click.echo(f"  data dir  : {data_dir}")
    click.echo(f"  config    : {cfg_path}")
    click.echo(f"  database  : {data_dir / 'agentclub.db'}")
    click.echo(f"  uploads   : {data_dir / 'media' / 'uploads'}")
    click.echo(f"  logs      : {data_dir / 'logs'}")
    click.echo("")
    click.echo(f"  admin     : {admin_username}")
    if generated_password:
        click.echo(
            f"  password  : {click.style(admin_password, fg='yellow', bold=True)}"
        )
        click.echo(click.style(
            "  (this password will NOT be shown again — save it now)",
            fg="yellow",
        ))
    else:
        click.echo("  password  : (as provided)")
    click.echo("")
    click.echo("Start the server with:")
    click.echo(f"  agentclub serve --data-dir {data_dir}")
    click.echo("")
