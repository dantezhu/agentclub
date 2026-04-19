"""AgentClub — a Slack-like chat server built for humans + AI agents.

Public surface:
    from agentclub.app import app, socketio    # Flask + Socket.IO instance
    from agentclub.config import Config        # effective runtime config
    from agentclub import models               # DB layer

The CLI entry point is ``agentclub.cli:main`` (installed as ``agentclub``
by ``pyproject.toml``).
"""

__version__ = "0.1.12"
