"""Verify Supabase access tokens; guest identity is never accepted for cloud APIs."""
import os
from functools import lru_cache
from uuid import UUID

import httpx
import jwt
from fastapi import HTTPException, Request


@lru_cache(maxsize=4)
def jwks_client(url):
    # Short cache lifetime also allows signing-key rotation to take effect.
    return jwt.PyJWKClient(url + "/auth/v1/.well-known/jwks.json", lifespan=300, timeout=5)


def verify_supabase_token(token):
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    if not url.startswith("https://"):
        raise HTTPException(503, "Cloud login is not configured on the server")
    try:
        header = jwt.get_unverified_header(token)  # Used ONLY to select a verification method.
        if header.get("alg") == "HS256":
            # Supabase recommends Auth server validation for legacy shared-secret projects.
            key = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
            if not key:
                raise HTTPException(503, "Legacy token verification is not configured")
            with httpx.Client(timeout=5) as client:
                response = client.get(url + "/auth/v1/user", headers={"apikey": key, "Authorization": "Bearer " + token})
            if response.status_code >= 500 or response.status_code == 429:
                raise HTTPException(503, "Login verification is temporarily unavailable")
            if response.status_code != 200:
                raise HTTPException(401, "Your session expired. Please log in again")
            user = response.json()
            uid = str(UUID(user["id"]))
            if user.get("is_anonymous"):
                raise HTTPException(401, "Please use email or Google login")
            return {"id": uid, "email": user.get("email")}
        if header.get("alg") not in {"ES256", "RS256"}:
            raise HTTPException(401, "Unsupported login token")
        key = jwks_client(url).get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["ES256", "RS256"],
                            audience="authenticated", issuer=url + "/auth/v1",
                            options={"require": ["exp", "iat", "sub", "aud", "iss"]})
        if claims.get("role") != "authenticated" or claims.get("is_anonymous", False):
            raise HTTPException(401, "Please use email or Google login")
        return {"id": str(UUID(claims["sub"])), "email": claims.get("email")}
    except (jwt.PyJWKClientConnectionError, httpx.RequestError) as exc:
        raise HTTPException(503, "Login verification is temporarily unavailable") from exc
    except (jwt.PyJWTError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(401, "Your session expired. Please log in again") from exc


def processing_identity(request: Request):
    header = request.headers.get("authorization")
    if not header:
        raise HTTPException(401, "Please log in")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, "Invalid authorization header")
    # A missing, invalid, anonymous, or forged token is never silently downgraded.
    return verify_supabase_token(token.strip())
