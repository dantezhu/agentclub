"""Agent Club server package.

The installed console entry point is ``agentclub``. Runtime config is
materialized by the CLI before importing the Flask + Socket.IO app.
"""

from importlib.metadata import PackageNotFoundError, version as _pkg_version

try:
    # Single-sourced from pyproject.toml once installed.
    __version__ = _pkg_version("agentclub")
except PackageNotFoundError:
    # Happens when importing from an uninstalled source tree.
    __version__ = "0.0.0+unknown"
