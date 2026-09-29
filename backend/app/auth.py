"""Prototype registration, login and per-IP throttling."""
import os
import threading
import time
from collections import deque
from email_validator import validate_email, EmailNotValidError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.database import User, get_db, SessionLocal
from app.identity import (COOKIE_NAME, get_current_user, hasher, password_matches,
                          public_user, secure_cookie, set_session)

router = APIRouter(prefix="/auth", tags=["auth"])
_attempts = {}
_rate_lock = threading.Lock()
# A fixed dummy hash avoids skipping expensive verification for unknown emails.
_dummy_hash = hasher.hash("not-a-real-user-password")

def rate_limit(request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _rate_lock:
        for key in list(_attempts):
            if not _attempts[key] or _attempts[key][-1] <= now - 60:
                del _attempts[key]
        attempts = _attempts.setdefault(ip, deque())
        while attempts and attempts[0] <= now - 60:
            attempts.popleft()
        if len(attempts) >= 10:
            raise HTTPException(429, "Too many attempts. Try again in a minute", headers={"Retry-After": "60"})
        attempts.append(now)

class Credentials(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=1024)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value):
        try:
            return validate_email(value.strip(), check_deliverability=False).normalized.lower()
        except EmailNotValidError:
            raise ValueError("Enter a valid email address") from None

class Registration(Credentials):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value):
        if not value.strip():
            raise ValueError("Enter your name")
        return value.strip()

@router.post("/register", status_code=201, dependencies=[Depends(rate_limit)])
def register(data: Registration, request: Request, response: Response, db: Session = Depends(get_db)):
    user = User(email=data.email, name=data.name, password_hash=hasher.hash(data.password), role="user")
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An account with this email already exists") from None
    set_session(response, request, user)
    return public_user(user)

@router.post("/login", dependencies=[Depends(rate_limit)])
def login(data: Credentials, request: Request, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == data.email))
    valid = password_matches(user.password_hash if user else _dummy_hash, data.password)
    if not valid or user is None or not user.is_active:
        raise HTTPException(401, "Incorrect email or password")
    if hasher.check_needs_rehash(user.password_hash):
        user.password_hash = hasher.hash(data.password)
        db.commit()
    set_session(response, request, user)
    return public_user(user)

@router.post("/logout", status_code=204)
def logout(request: Request, response: Response):
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=secure_cookie(request))

@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return public_user(user)

def create_first_admin():
    email, password = os.getenv("ADMIN_EMAIL"), os.getenv("ADMIN_PASSWORD")
    if not email and not password:
        return
    if not email or not password:
        raise RuntimeError("Set both ADMIN_EMAIL and ADMIN_PASSWORD")
    data = Registration(email=email, password=password, name="Administrator")
    with SessionLocal.begin() as db:
        if db.scalar(select(User).where(User.email == data.email)) is None:
            db.add(User(email=data.email, name=data.name, password_hash=hasher.hash(data.password), role="admin"))
