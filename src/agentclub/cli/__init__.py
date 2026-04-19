"""The ``agentclub`` command-line entry point.

Exposed via ``pyproject.toml``'s ``[project.scripts]`` as
``agentclub = "agentclub.cli:main"``.
"""
from __future__ import annotations

import click

from .. import __version__
from .serve import serve
from .onboard import onboard
from .config_cmd import config_group
from .user import user_group
from .agent import agent_group


@click.group(
    context_settings={"help_option_names": ["-h", "--help"]},
    help="AgentClub server — a Slack-like chat backend for humans + AI agents.",
)
@click.version_option(__version__, "-V", "--version", package_name="agentclub")
def main():
    """Root command. Subcommands do the work."""


main.add_command(serve)
main.add_command(onboard)
main.add_command(config_group, name="config")
main.add_command(user_group, name="user")
main.add_command(agent_group, name="agent")


if __name__ == "__main__":
    main()
