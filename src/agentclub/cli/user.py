"""`agentclub user ...` — manage human (non-agent) accounts.

Sibling of ``agentclub agent``. The split is intentional:

  - agents are token-authenticated bots, never log in via the web, and
    have a one-time-printed credential ⇒ ``agent create / list / edit /
    reset-token / delete`` lives in ``cli/agent.py``.
  - humans log in via the web with a username + password and may have
    role=admin or role=user ⇒ all human ops live here.

Why CLI at all when the admin web UI exists? Two real reasons:

  1. ``ALLOW_REGISTRATION`` defaults to False. After the very first
     account (created by ``onboard``), the web sign-up form is closed
     — a deployer who wants to add a teammate has nowhere to do it
     except this CLI (or hand-editing the DB).
  2. Lost-password recovery. ``user edit alice --password ...`` works
     before the server is even running.

Scope:

    user create <username> [--role admin|user] [--display-name NAME] \
                           [--password / --password-stdin]
    user list
    user edit <username>   [--role ...] [--display-name ...] \
                           [--password / --password-stdin]
    user delete <username> [--yes]

All commands operate on **non-agent** rows only. Trying to touch an
agent's row through ``user ...`` is rejected with a hint pointing at
the ``agent`` subcommand — keeps the two namespaces non-overlapping.
"""
from __future__ import annotations

import secrets
import sqlite3
import sys
import time
from datetime import datetime
from typing import Optional

import click

from ._common import bootstrap, echo_header


@click.group(name="user", help="Manage human (non-agent) accounts.")
def user_group():
    pass


# ── Shared helpers ──────────────────────────────────────────────────────

VALID_ROLES = ("admin", "user")


def _resolve_password(inline: Optional[str], from_stdin: bool) -> tuple[str, bool]:
    """Return ``(password, was_generated)``.

    Same shape as the old ``cli/admin.py`` helper. ``inline + stdin`` is a
    user error; neither → mint a 20-char random password and signal so
    callers print it exactly once.
    """
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


def _format_ts(ts):
    if not ts:
        return "never"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def _status(last_active_at, timeout):
    if not last_active_at:
        return "offline"
    return "online" if last_active_at >= time.time() - timeout else "offline"


def _require_human(models_mod, username: str):
    """Look up a non-agent user or raise. Bots get a CLI hint."""
    user = models_mod.get_user_by_username(username)
    if not user:
        raise click.ClickException(f"User '{username}' not found.")
    if user["is_agent"]:
        raise click.ClickException(
            f"'{username}' is an agent. Use ``agentclub agent ...`` instead."
        )
    return user


# ── Subcommands ─────────────────────────────────────────────────────────

@user_group.command("create", help="Create a new human account.")
@click.argument("username")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--role", default="user", show_default=True,
              type=click.Choice(VALID_ROLES, case_sensitive=False),
              help="Account role.")
@click.option("--display-name", default=None,
              help="Display name shown in the UI. Defaults to USERNAME.")
@click.option("--password", default=None,
              help="Password (inline). Discouraged — prefer --password-stdin.")
@click.option("--password-stdin", is_flag=True,
              help="Read password from stdin.")
def user_create(username, data_dir_flag, role, display_name, password,
                password_stdin):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models
    from ..auth import hash_password

    if models.get_user_by_username(username):
        raise click.ClickException(f"User '{username}' already exists.")

    pw, generated = _resolve_password(password, password_stdin)
    display = display_name or username
    role = role.lower()
    models.create_user(username, hash_password(pw), display, role=role)

    echo_header(f"✓ User '{username}' created")
    click.echo(f"  username : {username}")
    click.echo(f"  display  : {display}")
    click.echo(f"  role     : {role}")
    _print_password(pw, generated)


@user_group.command("list", help="List all human (non-agent) accounts.")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
def user_list(data_dir_flag):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models
    from ..config import Config

    # list_users returns everyone; filter agents inline since callers of
    # the model layer (settings page, member picker, etc.) actually want
    # the unfiltered list.
    humans = [u for u in models.list_users() if not u["is_agent"]]
    if not humans:
        click.echo("No users yet. Create one with: agentclub user create <name>")
        return

    headers = ("USERNAME", "DISPLAY", "ROLE", "STATUS", "LAST ACTIVE")
    rows = []
    for u in humans:
        rows.append((
            u["username"],
            u["display_name"],
            u["role"],
            _status(u.get("last_active_at"), Config.ACTIVE_TIMEOUT),
            _format_ts(u.get("last_active_at")),
        ))
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    click.echo(fmt.format(*headers))
    click.echo(fmt.format(*("-" * w for w in widths)))
    for row in rows:
        click.echo(fmt.format(*row))


@user_group.command("edit", help="Edit a human account.")
@click.argument("username")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--role", default=None,
              type=click.Choice(VALID_ROLES, case_sensitive=False),
              help="Change role. Same choices as --role on create.")
@click.option("--display-name", "display_name", default=None,
              help="New display name. Empty string is rejected.")
@click.option("--password", default=None,
              help="New password (inline). Discouraged — prefer --password-stdin.")
@click.option("--password-stdin", is_flag=True,
              help="Read new password from stdin.")
def user_edit(username, data_dir_flag, role, display_name, password,
              password_stdin):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models
    from ..auth import hash_password

    user = _require_human(models, username)

    updates = {}
    pw_to_print = None
    pw_was_generated = False

    if display_name is not None:
        new_display = display_name.strip()
        if not new_display:
            raise click.ClickException("--display-name cannot be empty.")
        updates["display_name"] = new_display

    if role is not None:
        new_role = role.lower()
        if new_role != user["role"]:
            updates["role"] = new_role

    if password is not None or password_stdin:
        pw_to_print, pw_was_generated = _resolve_password(password, password_stdin)
        updates["password_hash"] = hash_password(pw_to_print)

    if not updates:
        raise click.ClickException(
            "Nothing to update. Pass at least one of: --display-name, "
            "--role, --password / --password-stdin."
        )

    models.update_user(user["id"], **updates)

    echo_header(f"✓ User '{username}' updated")
    if "display_name" in updates:
        click.echo(f"  display  : {user['display_name']} "
                   f"→ {click.style(updates['display_name'], fg='green')}")
    if "role" in updates:
        click.echo(f"  role     : {user['role']} "
                   f"→ {click.style(updates['role'], fg='green')}")
    if "password_hash" in updates:
        click.echo(f"  password : {click.style('(updated)', fg='green')}")
        # Only echo the actual value when we generated it. If the operator
        # supplied --password / --password-stdin they already have it.
        _print_password(pw_to_print, pw_was_generated)


@user_group.command("delete", help="Hard-delete a user and ALL their data.")
@click.argument("username")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--yes", "-y", "assume_yes", is_flag=True,
              help="Skip the confirmation prompt. Use in scripts.")
def user_delete(username, data_dir_flag, assume_yes):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models

    user = _require_human(models, username)
    fp = models.get_user_footprint(user["id"])

    echo_header(f"About to DELETE user '{username}'")
    click.echo(f"  display       : {user['display_name']}")
    click.echo(f"  role          : {user['role']}")
    click.echo(f"  id            : {user['id']}")
    click.echo("")
    click.echo("  Footprint to be wiped:")
    click.echo(f"    - direct chats        : {fp['direct_chats']} "
               f"(with {fp['direct_messages']} message(s))")
    click.echo(f"    - groups they created : {fp['owned_groups']} "
               f"(with {fp['owned_group_messages']} message(s), "
               f"members will be kicked)")
    click.echo(f"    - other groups joined : {fp['joined_groups']} "
               f"(membership removed; groups stay)")
    click.echo(f"    - own messages total  : {fp['own_messages']} "
               f"(includes the above)")
    click.echo("")
    click.echo(click.style(
        "  This is permanent. There is no undo.", fg="red", bold=True,
    ))

    if not assume_yes:
        click.echo("")
        if not click.confirm(f"Delete user '{username}'?", default=False):
            click.echo("Aborted.")
            return

    try:
        models.delete_user(user["id"])
    except sqlite3.IntegrityError as e:
        # See note in agent.py: this means the schema grew a new FK that
        # delete_user doesn't know how to clean up. It's a bug, not user
        # error, so surface the original message.
        raise click.ClickException(
            f"Delete failed — leftover references: {e}\n"
            "This is a bug in models.delete_user(); please report it."
        )

    click.echo(click.style(f"✓ User '{username}' deleted.", fg="green"))
