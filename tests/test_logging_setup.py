import logging
from datetime import datetime

from agentclub import logging_setup


def test_server_log_timestamp_includes_milliseconds():
    formatter = logging.Formatter(
        logging_setup._FORMAT,
        datefmt=logging_setup._DATEFMT,
    )
    record = logging.LogRecord(
        "agentclub.test",
        logging.INFO,
        __file__,
        1,
        "hello",
        (),
        None,
    )
    record.created = datetime(2026, 1, 2, 3, 4, 5, 678000).timestamp()
    record.msecs = 678

    assert formatter.format(record) == (
        "2026-01-02 03:04:05.678 INFO [agentclub.test] hello"
    )
