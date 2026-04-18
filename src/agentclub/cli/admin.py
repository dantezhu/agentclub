"""`agentclub admin ...` — manage admin accounts.

Scope is deliberately small, matching Django's ``createsuperuser`` /
``changepassword`` philosophy: only the two operations that have **no
GUI alternative on a fresh install or after a lost password**. Listing,
revoking, deleting etc. should happen via the web admin UI once the
server is up.

    admin create <username> [--password / --password-stdin] [--display-name NAME]
    admin passwd <username> [--password / --password-stdin]
"""
from __future__ import annotations

import secrets
import sys
from typing import Optional

import click

from ._common import bootstrap, echo_header


@click.group(name="admin", help="Manage admin accounts.")
def admin_group():
    pass


def _resolve_password(inline: Optional[str], from_stdin: bool) -> tuple[str, bool]:
    """Return ``(password, was_generated)``.

    Error if both channels are used. If neither is used, generate a
    20-char random password and signal it so callers can print it
    exactly once."""
    if inline and from_stdin:
        raise click.ClickException(
            "Use either --password or --password-stdin, not both."
        )
    if from_stdin:
        value = sys.stdin.read().strip()
        if not value:
            raise click.ClickException("No password received on stdin.")
        return value, False
    if inline:
        return inline, False
    return secrets.token_urlsafe(20)[:20], True


def _print_password(value: str, generated: bool) -> None:
    if generated:
        click.echo("")
        click.echo(
            f"  password : {click.style(value, fg='yellow', bold=True)}"
        )
        click.echo(click.style(
            "  (this password will NOT be shown again — save it now)",
            fg="yellow",
        ))


@admin_group.command("create", help="Create a new admin account.")
@click.argument("username")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--display-name", default=None,
              help="Display name shown in the UI. Defaults to USERNAME.")
@click.option("--password", default=None,
              help="Password (inline). Discouraged — prefer --password-stdin.")
@click.option("--password-stdin", is_flag=True,
              help="Read password from stdin.")
def admin_create(username, data_dir_flag, display_name, password, password_stdin):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models
    from ..auth import hash_password

    if models.get_user_by_username(username):
        raise click.ClickException(f"User '{username}' already exists.")

    pw, generated = _resolve_password(password, password_stdin)
    display = display_name or username
    models.create_user(username, hash_password(pw), display, role="admin")

    echo_header(f"✓ Admin '{username}' created")
    click.echo(f"  username : {username}")
    click.echo(f"  display  : {display}")
    _print_password(pw, generated)


@admin_group.command("passwd", help="Reset an admin's password.")
@click.argument("username")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--password", default=None,
              help="New password (inline). Discouraged — prefer --password-stdin.")
@click.option("--password-stdin", is_flag=True,
              help="Read new password from stdin.")
def admin_passwd(username, data_dir_flag, password, password_stdin):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models
    from ..auth import hash_password

    user = models.get_user_by_username(username)
    if not user:
        raise click.ClickException(f"User '{username}' not found.")
    # Scope this command to admins only, not arbitrary users. If someone
    # needs to reset a regular user's password they can do it in the web
    # admin UI (or use the DB). Keeping the CLI narrow makes its guarantees
    # easier to reason about.
    if user["role"] != "admin":
        raise click.ClickException(
            f"User '{username}' is not an admin (role={user['role']}). "
            f"Password changes for non-admins happen in the web UI."
        )

    pw, generated = _resolve_password(password, password_stdin)
    models.update_user(user["id"], password_hash=hash_password(pw))

    echo_header(f"✓ Password updated for admin '{username}'")
    _print_password(pw, generated)
