from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.main import create_app  # noqa: E402


@pytest.fixture()
def client(tmp_path):
    """Fresh SQLite file per test, seeded with the default conference."""
    app = create_app(db_url=f"sqlite:///{tmp_path / 'test.db'}", seed=True)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def empty_client(tmp_path):
    """Same app but without demo talks, so a test controls the talk list."""
    app = create_app(db_url=f"sqlite:///{tmp_path / 'empty.db'}", seed=False)
    with TestClient(app) as test_client:
        from app.seed import seed_if_empty

        session = app.state.session_factory()
        try:
            seed_if_empty(session)
            session.commit()
        finally:
            session.close()
        test_client.app.state.session_factory = app.state.session_factory
        # remove the demo talks, keep conference/rooms/blocks
        from sqlalchemy import delete

        from app.db import Talk

        session = app.state.session_factory()
        try:
            session.execute(delete(Talk))
            session.commit()
        finally:
            session.close()
        yield test_client
