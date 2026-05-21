"""Hermes Agent platform adapter for Agent Club."""

from importlib.metadata import PackageNotFoundError, version as _pkg_version

from .adapter import AgentClubAdapter, register

try:
    # Single-sourced from `pyproject.toml` via package metadata so the
    # distribution version never drifts from a hand-maintained constant.
    __version__ = _pkg_version("hermes-channel-agentclub")
except PackageNotFoundError:
    # Running straight out of the source tree without `pip install -e .`.
    __version__ = "0.0.0+unknown"

__all__ = ["AgentClubAdapter", "register", "__version__"]
