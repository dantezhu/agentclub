"""AgentClub — a Slack-like chat server built for humans + AI agents.

Public surface:
    from agentclub.app import app, socketio    # Flask + Socket.IO instance
    from agentclub.config import Config        # effective runtime config
    from agentclub import models               # DB layer

The CLI entry point is ``agentclub.cli:main`` (installed as ``agentclub``
by ``pyproject.toml``).
"""

from importlib.metadata import PackageNotFoundError, version as _pkg_version

try:
    # Single-sourced from `pyproject.toml`; populated once the wheel is
    # installed (editable or otherwise). Avoids the "I bumped pyproject
    # but forgot to bump `__version__`" drift that bit us between 0.1.18
    # and 0.1.21.
    __version__ = _pkg_version("agentclub")
except PackageNotFoundError:
    # Happens when the source tree is imported without ever being installed
    # (e.g. running straight out of a clone). Not an error path we care to
    # surface loudly — the CLI still works, the version string is just a
    # dev sentinel.
    __version__ = "0.0.0+unknown"
