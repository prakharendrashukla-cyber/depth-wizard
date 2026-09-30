"""Cookie JWT identity and Argon2 password hashing."""
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session
from app.database import User, get_db, DATA_DIR

COOKIE_NAME = "depthwizard_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
hasher = PasswordHasher()
_secret = None

def configure_secret():
    global _secret
    configured = os.getenv("SECRET_KEY", "").strip()
    if os.getenv("APP_ENV", "development").lower() == "production" and len(configured) < 32:
        raise RuntimeError("Production requires SECRET_KEY with at least 32 characters")
    if configured:
        _secret = configured
    else:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = DATA_DIR / ".development_secret"
        if not path.exists():
            try:
                with path.open("x", encoding="utf-8") as file:
                    file.write(secrets.token_urlsafe(48))
            except FileExistsError:
                pass
        _secret = path.read_text(encoding="utf-8").strip()
    return _secret

def public_user(user):
    return {"id": user.id, "email": user.email, "name": user.name, "role": user.role}

def secure_cookie(request):
    # Vite's proxy changes Host; Origin preserves the browser's actual hostname.
    hostname = urlsplit(request.headers.get("origin", "")).hostname or request.url.hostname
    return hostname not in {"localhost", "127.0.0.1", "::1"}

def set_session(response, request, user):
    now = datetime.now(timezone.utc)
    token = jwt.encode({"sub": str(user.id), "iat": now, "exp": now + timedelta(seconds=SESSION_SECONDS)},
                       _secret or configure_secret(), algorithm="HS256")
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=secure_cookie(request), samesite="lax", path="/")

def get_current_user(request: Request, db: Session = Depends(get_db)):
    if os.getenv("AUTH_PROVIDER", "local") == "supabase":
        from app.supabase_identity import processing_identity
        return processing_identity(request)
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Please log in")
    try:
        claims = jwt.decode(token, _secret or configure_secret(), algorithms=["HS256"], options={"require": ["sub", "exp", "iat"]})
        user_id = int(claims["sub"])
    except (jwt.InvalidTokenError, ValueError, TypeError):
        raise HTTPException(401, "Your session has expired. Please log in") from None
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, "Please log in")
    return user

def password_matches(encoded, password):
    try:
        return hasher.verify(encoded, password)
    except (VerificationError, InvalidHashError):
        return False
