"""SQLAlchemy persistence; files live outside the database."""
import os
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, String, create_engine, event, update
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from app.config import BACKEND_DIR

DATA_DIR = BACKEND_DIR / "data"
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///" + (DATA_DIR / "depthwizard.db").as_posix())
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", str(DATA_DIR / "uploads")))
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(engine, expire_on_commit=False)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def sqlite_foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")

def now():
    return datetime.now(timezone.utc)

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str] = mapped_column(String(512))
    role: Mapped[str] = mapped_column(String(10), default="user")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class Analysis(Base):
    __tablename__ = "analyses"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    model_id: Mapped[str] = mapped_column(String(100))
    analysis_metadata: Mapped[dict] = mapped_column("metadata", JSON)
    height_summary: Mapped[dict] = mapped_column(JSON)
    depth_map_path: Mapped[str] = mapped_column(String(512))
    original_image_path: Mapped[str] = mapped_column(String(512))
    result_path: Mapped[str] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class BatchJobRecord(Base):
    __tablename__ = "batch_jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(24), default="pending")
    progress: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    with SessionLocal.begin() as db:
        db.execute(update(BatchJobRecord).where(BatchJobRecord.status.in_(["pending", "processing"])).values(status="interrupted", updated_at=now()))

def get_db():
    with SessionLocal() as db:
        yield db
