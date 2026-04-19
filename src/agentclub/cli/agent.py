"""`agentclub agent ...` — manage agent (bot) accounts.

Scope:

    agent create <name> [--display-name NAME] [--description TEXT]
    agent list                                   # no token column
    agent edit <name> [--display-name NAME] [--description TEXT]
    agent reset-token <name>                    # prints new token ONCE
    agent delete <name> [--yes]                  # hard delete, with footprint

``edit`` and ``delete`` mirror the admin web UI's buttons. ``--username``
(rename) and ``--avatar`` are deliberately omitted from ``edit`` until
there's a real need; the web UI handles avatar uploads.

``--description`` is optional, free-form, and surfaced in two places:
the chat header subtitle when chatting 1-on-1 with the agent (so users
remember "what does this bot actually do?") and the agent list in the
admin web. Pass an empty string to clear it.

Tokens are always shown **once** on the command that mints them, never
on ``list``. Losing a token → ``reset-token``.
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime

import click

from ._common import bootstrap, echo_header


@click.group(name="agent", help="Manage agent (bot) accounts.")
def agent_group():
    pass


def _format_ts(ts):
    if not ts:
        return "never"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def _status(last_active_at, timeout):
    if not last_active_at:
        return "offline"
    return "online" if last_active_at >= time.time() - timeout else "offline"


@agent_group.command("create", help="Create a new agent account.")
@click.argument("name")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--display-name", default=None,
              help="Display name shown in the UI. Defaults to NAME.")
@click.option("--description", default="",
              help="Short bio shown under the agent name in chat headers "
                   "and the admin list. Optional.")
def agent_create(name, data_dir_flag, display_name, description):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models
    from ..auth import generate_agent_token

    if models.get_user_by_username(name):
        raise click.ClickException(f"An account named '{name}' already exists.")

    token = generate_agent_token()
    display = display_name or name
    desc = (description or "").strip()
    models.create_agent(name, display, token, description=desc)

    echo_header(f"✓ Agent '{name}' created")
    click.echo(f"  name     : {name}")
    click.echo(f"  display  : {display}")
    if desc:
        click.echo(f"  desc     : {desc}")
    click.echo("")
    click.echo(f"  token    : {click.style(token, fg='yellow', bold=True)}")
    click.echo(click.style(
        "  (this token will NOT be shown again — save it now)",
        fg="yellow",
    ))


@agent_group.command("list", help="List all agents (never prints tokens).")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
def agent_list(data_dir_flag):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models
    from ..config import Config

    agents = models.list_agents()
    if not agents:
        click.echo("No agents. Create one with: agentclub agent create <name>")
        return

    # Fixed-width columns; no external dep for pretty tables. Description
    # is optional and often long, so it gets truncated for the table view —
    # full text is always visible via the admin web UI / DB.
    headers = ("NAME", "DISPLAY", "STATUS", "LAST ACTIVE", "DESCRIPTION")
    rows = []
    for a in agents:
        desc = a.get("description") or ""
        if len(desc) > 40:
            desc = desc[:39] + "…"
        rows.append((
            a["username"],
            a["display_name"],
            _status(a.get("last_active_at"), Config.ACTIVE_TIMEOUT),
            _format_ts(a.get("last_active_at")),
            desc,
        ))
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    click.echo(fmt.format(*headers))
    click.echo(fmt.format(*("-" * w for w in widths)))
    for row in rows:
        click.echo(fmt.format(*row))


@agent_group.command("edit", help="Edit an agent's editable fields.")
@click.argument("name")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--display-name", "display_name", default=None,
              help="New display name shown in the UI. Empty string is "
                   "rejected; pass a real value or omit the flag.")
@click.option("--description", "description", default=None,
              help="New short bio. Pass an empty string to clear it.")
def agent_edit(name, data_dir_flag, display_name, description):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models

    agent = models.get_user_by_username(name)
    if not agent or not agent["is_agent"]:
        raise click.ClickException(f"Agent '{name}' not found.")

    updates = {}
    if display_name is not None:
        new_display = display_name.strip()
        if not new_display:
            raise click.ClickException("--display-name cannot be empty.")
        updates["display_name"] = new_display
    # description is intentionally allowed to be empty — that's how an
    # admin clears a previously-set bio. We only update when the flag was
    # explicitly passed (None means "leave alone").
    if description is not None:
        updates["description"] = description.strip()

    if not updates:
        raise click.ClickException(
            "Nothing to update. Pass at least one of: --display-name, "
            "--description."
        )

    models.update_user(agent["id"], **updates)

    echo_header(f"✓ Agent '{name}' updated")
    if "display_name" in updates:
        click.echo(f"  display  : {agent['display_name']} "
                   f"→ {click.style(updates['display_name'], fg='green')}")
    if "description" in updates:
        old = agent.get("description") or "(empty)"
        new = updates["description"] or "(empty)"
        click.echo(f"  desc     : {old} → {click.style(new, fg='green')}")


@agent_group.command("reset-token", help="Regenerate an agent's token.")
@click.argument("name")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
def agent_reset_token(name, data_dir_flag):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models
    from ..auth import generate_agent_token

    agent = models.get_user_by_username(name)
    if not agent or not agent["is_agent"]:
        raise click.ClickException(f"Agent '{name}' not found.")

    token = generate_agent_token()
    with models.get_db_ctx() as db:
        db.execute(
            "UPDATE users SET agent_token = ? WHERE id = ?",
            (token, agent["id"]),
        )

    echo_header(f"✓ Token reset for agent '{name}'")
    click.echo("")
    click.echo(f"  token    : {click.style(token, fg='yellow', bold=True)}")
    click.echo(click.style(
        "  (previous token is now invalid — update your channel config)",
        fg="yellow",
    ))


@agent_group.command("delete", help="Hard-delete an agent and ALL its data.")
@click.argument("name")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--yes", "-y", "assume_yes", is_flag=True,
              help="Skip the confirmation prompt. Use in scripts.")
def agent_delete(name, data_dir_flag, assume_yes):
    bootstrap(data_dir_flag, require_exists=True)
    from .. import models

    agent = models.get_user_by_username(name)
    if not agent or not agent["is_agent"]:
        raise click.ClickException(f"Agent '{name}' not found.")

    fp = models.get_user_footprint(agent["id"])

    echo_header(f"About to DELETE agent '{name}'")
    click.echo(f"  display       : {agent['display_name']}")
    click.echo(f"  id            : {agent['id']}")
    click.echo("")
    click.echo("  Footprint to be wiped:")
    click.echo(f"    - direct chats        : {fp['direct_chats']} "
               f"(with {fp['direct_messages']} message(s))")
    click.echo(f"    - groups it created   : {fp['owned_groups']} "
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
        if not click.confirm(f"Delete agent '{name}'?", default=False):
            click.echo("Aborted.")
            return

    try:
        models.delete_user(agent["id"])
    except sqlite3.IntegrityError as e:
        # delete_user is supposed to clean every reference; hitting this
        # means the schema grew a new FK someone forgot to wire in.
        raise click.ClickException(
            f"Delete failed — leftover references: {e}\n"
            "This is a bug in models.delete_user(); please report it."
        )

    click.echo(click.style(f"✓ Agent '{name}' deleted.", fg="green"))
