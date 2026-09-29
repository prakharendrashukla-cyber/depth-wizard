"""Owned analysis history and disk artifacts."""
import base64
import json
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from app.database import Analysis, User, get_db, UPLOAD_DIR
from app.identity import get_current_user
from app.safety import safe_path

router = APIRouter(prefix="/analyses", tags=["history"])

def summary(row):
    return {"id": row.id, "filename": row.filename, "model_id": row.model_id,
            "metadata": row.analysis_metadata, "height_summary": row.height_summary,
            "created_at": row.created_at.isoformat()}

def save_analysis(db, user, result):
    directory = UPLOAD_DIR / str(user.id)
    directory.mkdir(parents=True, exist_ok=True)
    stem = uuid.uuid4().hex
    depth = directory / (stem + "_depth.png")
    original = directory / (stem + "_original.jpg")
    snapshot = directory / (stem + "_result.json")
    try:
        depth.write_bytes(base64.b64decode(result["depth_map"]))
        original.write_bytes(base64.b64decode(result["original_image"]))
        snapshot.write_text(json.dumps({k: v for k, v in result.items() if k not in {"depth_map", "original_image"}}), encoding="utf-8")
        row = Analysis(user_id=user.id, filename=Path(result["metadata"]["filename"]).name[:255],
                       model_id=result["model_id"], analysis_metadata=result["metadata"],
                       height_summary=result["height_analysis"],
                       depth_map_path=str(depth.relative_to(UPLOAD_DIR)),
                       original_image_path=str(original.relative_to(UPLOAD_DIR)),
                       result_path=str(snapshot.relative_to(UPLOAD_DIR)))
        db.add(row)
        db.commit()
        return row.id
    except Exception:
        db.rollback()
        for path in (depth, original, snapshot):
            path.unlink(missing_ok=True)
        raise

def owned(db, user, analysis_id):
    row = db.scalar(select(Analysis).where(Analysis.id == analysis_id, Analysis.user_id == user.id))
    if row is None:
        raise HTTPException(404, "Analysis not found")
    return row

@router.get("")
def list_analyses(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
                  user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    query = select(Analysis).where(Analysis.user_id == user.id)
    total = db.scalar(select(func.count()).select_from(Analysis).where(Analysis.user_id == user.id))
    rows = db.scalars(query.order_by(Analysis.created_at.desc(), Analysis.id.desc()).offset((page-1)*page_size).limit(page_size)).all()
    return {"items": [summary(row) for row in rows], "total": total, "page": page, "page_size": page_size}

@router.get("/{analysis_id}")
def get_analysis(analysis_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = owned(db, user, analysis_id)
    try:
        result = json.loads(Path(safe_path(UPLOAD_DIR, row.result_path)).read_text(encoding="utf-8"))
        result["depth_map"] = base64.b64encode(Path(safe_path(UPLOAD_DIR, row.depth_map_path)).read_bytes()).decode()
        result["original_image"] = base64.b64encode(Path(safe_path(UPLOAD_DIR, row.original_image_path)).read_bytes()).decode()
    except FileNotFoundError:
        raise HTTPException(410, "Saved analysis files are no longer available") from None
    result["analysis_id"] = row.id
    return result

@router.delete("/{analysis_id}", status_code=204)
def delete_analysis(analysis_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = owned(db, user, analysis_id)
    paths = [safe_path(UPLOAD_DIR, value) for value in (row.depth_map_path, row.original_image_path, row.result_path)]
    db.delete(row)
    db.commit()
    for path in paths:
        Path(path).unlink(missing_ok=True)
    return Response(status_code=204)
