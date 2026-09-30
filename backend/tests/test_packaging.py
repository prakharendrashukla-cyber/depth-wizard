"""Source sharing must never include stored credentials or analysis data."""
import importlib.util
from pathlib import Path
import zipfile


def test_source_archive_excludes_private_files(tmp_path):
    script = Path(__file__).resolve().parents[2] / "scripts" / "create_clean_zip.py"
    spec = importlib.util.spec_from_file_location("archive_helper", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    files = ["README.md", ".env.example", ".env", ".env.local",
             "backend/data/depthwizard.db", "backend/data/uploads/1/image.png",
             ".venv/secret.txt", ".scratch/browser.db", "tools/cloudflared.exe",
             "backend/weights/model.pt", "frontend/src/App.jsx"]
    for filename in files:
        path = tmp_path / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")
    destination, count = module.create_archive(tmp_path)
    with zipfile.ZipFile(destination) as archive:
        assert set(archive.namelist()) == {
            "depth-wizard/README.md", "depth-wizard/.env.example",
            "depth-wizard/frontend/src/App.jsx",
        }
    assert count == 3
