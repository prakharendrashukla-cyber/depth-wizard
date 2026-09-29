import io
from PIL import Image
from fastapi.testclient import TestClient
from app.main import app
from app.database import SessionLocal, User, Analysis
from app.identity import get_current_user

def test_history_owner_and_delete(owner):
    raw = io.BytesIO()
    Image.new("RGB", (24,24), "blue").save(raw, format="PNG")
    with TestClient(app) as client:
        response = client.post("/estimate", files={"image": ("scene.png", raw.getvalue(), "image/png")})
        assert response.status_code == 200, response.text
        aid = response.json()["analysis_id"]
        assert client.get("/analyses").json()["total"] == 1
        assert client.get("/analyses?page=2&page_size=1").json()["items"] == []
        saved = client.get(f"/analyses/{aid}").json()
        assert saved["point_cloud"] == response.json()["point_cloud"]
        with SessionLocal.begin() as db:
            other = User(email="other@example.com", name="Other", password_hash="test")
            db.add(other)
            db.flush()
        app.dependency_overrides[get_current_user] = lambda: other
        assert client.get(f"/analyses/{aid}").status_code == 404
        assert client.delete(f"/analyses/{aid}").status_code == 404
        app.dependency_overrides[get_current_user] = lambda: owner
        assert client.delete(f"/analyses/{aid}").status_code == 204
        assert client.get(f"/analyses/{aid}").status_code == 404
        with SessionLocal() as db:
            assert db.get(Analysis, aid) is None
