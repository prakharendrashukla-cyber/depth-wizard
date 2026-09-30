import os
import tempfile
from pathlib import Path
_TEST_ROOT = tempfile.TemporaryDirectory(prefix="depthwizard-tests-")
os.environ["DATABASE_URL"] = "sqlite:///" + (Path(_TEST_ROOT.name) / "test.db").as_posix()
os.environ["SECRET_KEY"] = "test-secret-only-not-for-production-123456789"
os.environ["DEPTH_MODEL"] = "procedural-fallback"
# Local auth tests must not inherit the developer's live Supabase settings.
# Cloud identity tests explicitly opt in with their own monkeypatched config.
os.environ["AUTH_PROVIDER"] = "local"
import pytest
from app import analyses
from app import database
database.UPLOAD_DIR = Path(_TEST_ROOT.name) / "uploads"
analyses.UPLOAD_DIR = database.UPLOAD_DIR
from app.main import app
from app.identity import get_current_user

@pytest.fixture(autouse=True)
def isolate_db():
    from app.auth import _attempts
    _attempts.clear()
    database.Base.metadata.drop_all(database.engine)
    database.init_db()
    yield
    app.dependency_overrides.clear()

@pytest.fixture
def owner():
    with database.SessionLocal.begin() as db:
        user = database.User(email="owner@example.com", name="Owner", password_hash="test")
        db.add(user)
        db.flush()
    app.dependency_overrides[get_current_user] = lambda: user
    return user

def pytest_sessionfinish(session, exitstatus):
    database.engine.dispose()
    _TEST_ROOT.cleanup()
