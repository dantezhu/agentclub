"""`agentclub config show` — display the effective runtime configuration.

Useful for debugging "why did my server bind on the wrong port" and for
confirming which data directory is being used.
"""
from __future__ import annotations

import click

from ._common import bootstrap, echo_header


@click.group(name="config", help="Inspect AgentClub configuration.")
def config_group():
    pass


# Fields we surface. Purposely excludes ALLOWED_EXTENSIONS — it's a
# nested set/dict that doesn't translate cleanly to env vars and is
# kept as a source-only constant.
_EXPOSED = [
    "HOST", "PORT", "DEBUG",
    "SECRET_KEY",
    "DATABASE", "UPLOAD_FOLDER", "MAX_CONTENT_LENGTH",
    "LOG_DIR", "LOG_LEVEL", "LOG_MAX_SIZE_MB", "LOG_BACKUP_COUNT",
    "ALLOW_REGISTRATION", "MESSAGE_RETENTION_DAYS", "MESSAGE_PAGE_SIZE",
    "HEARTBEAT_INTERVAL", "ACTIVE_TIMEOUT", "PRESENCE_POLL_INTERVAL",
    "SITE_NAME", "SITE_LOGO", "SITE_LOGO_TEXT",
]


@config_group.command("show", help="Print the resolved effective config.")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--show-secrets", is_flag=True,
              help="Print SECRET_KEY in clear instead of redacting it.")
def config_show(data_dir_flag, show_secrets):
    data_dir = bootstrap(data_dir_flag, require_exists=True)
    from ..config import Config

    echo_header("AgentClub effective config")
    click.echo(f"  data dir : {data_dir}")
    click.echo("")
    for key in _EXPOSED:
        val = getattr(Config, key, None)
        if key == "SECRET_KEY" and not show_secrets and val:
            val = f"<redacted, {len(str(val))} chars>"
        click.echo(f"  {key:<24} = {val}")
