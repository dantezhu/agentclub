from importlib.metadata import PackageNotFoundError, version as _pkg_version

from .channel import AgentClubChannel

try:
    # Single-sourced from `pyproject.toml` via `importlib.metadata` so the
    # distribution version never drifts from a hand-maintained constant.
    # Dist name is dash-form; metadata lookup ignores the dash-vs-underscore
    # difference between dist and import names.
    __version__ = _pkg_version("nanobot-channel-agentclub")
except PackageNotFoundError:
    # Running straight out of the source tree without `pip install -e .`.
    __version__ = "0.0.0+unknown"

__all__ = ["AgentClubChannel", "__version__"]
