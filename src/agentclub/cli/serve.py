"""`agentclub serve` — run the Flask + Socket.IO server."""
from __future__ import annotations

import os

import click

from ._common import bootstrap, echo_header


@click.command(help="Start the AgentClub server.")
@click.option("--data-dir", "data_dir_flag", type=click.Path(),
              help="Runtime data directory. Defaults to $AGENTCLUB_HOME or "
                   "~/.agentclub.")
@click.option("--host", default=None,
              help="Bind address. Overrides config.json HOST.")
@click.option("--port", type=int, default=None,
              help="Bind port. Overrides config.json PORT.")
@click.option("--debug/--no-debug", default=None,
              help="Enable Flask debug + reloader.")
def serve(data_dir_flag, host, port, debug):
    overrides = {}
    if host is not None:
        overrides["HOST"] = host
    if port is not None:
        overrides["PORT"] = port
    if debug is not None:
        overrides["DEBUG"] = debug

    data_dir = bootstrap(data_dir_flag, require_exists=True, overrides=overrides)

    # Imports must come AFTER bootstrap() so Config reads the right env.
    from ..app import app, socketio
    from ..config import Config
    from .. import models

    models.init_db()
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)

    echo_header("AgentClub")
    click.echo(f"  data dir : {data_dir}")
    click.echo(f"  database : {Config.DATABASE}")
    click.echo(f"  uploads  : {Config.UPLOAD_FOLDER}")
    click.echo(f"  listening: http://{Config.HOST}:{Config.PORT}")
    click.echo("")

    socketio.run(app, host=Config.HOST, port=Config.PORT,
                 debug=Config.DEBUG, allow_unsafe_werkzeug=True)
