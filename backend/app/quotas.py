"""Shared Supabase-backed admission and storage quota checks."""
import hashlib
import hmac
import ipaddress
import logging
import os
from typing import Any

import httpx
from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)


def _positive_int(name: str, default: int, *, maximum: int = 1_000_000) -> int:
    value = os.getenv(name, str(default)).strip()
    try:
        parsed = int(value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive integer") from exc
    if not 1 <= parsed <= maximum:
        raise RuntimeError(f"{name} is outside the allowed range")
    return parsed


def quota_settings() -> dict:
    return {
        "user_daily": _positive_int("MAX_USER_DAILY_ANALYSES", 5),
        "ip_minute": _positive_int("MAX_IP_ANALYSES_PER_MINUTE", 5),
        "global_daily": _positive_int("MAX_GLOBAL_DAILY_ANALYSES", 50),
        "storage_bytes": _positive_int("MAX_USER_STORAGE_MB", 50, maximum=1024 * 1024) * 1024 * 1024,
        "retention_days": _positive_int("UPLOAD_RETENTION_DAYS", 365, maximum=3650),
    }


def _service_credentials() -> tuple[str, str]:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url.startswith("https://") or not key:
        raise HTTPException(503, "Analysis protection is not configured on the server")
    return url, key


def _client_ip(request: Request) -> str:
    """Resolve an IP using only the explicitly configured trusted proxy suffix."""
    direct = request.client.host if request.client else "unknown"
    try:
        trusted_hops = int(os.getenv("TRUSTED_PROXY_HOPS", "0"))
    except ValueError as exc:
        raise RuntimeError("TRUSTED_PROXY_HOPS must be an integer") from exc
    if not 0 <= trusted_hops <= 8:
        raise RuntimeError("TRUSTED_PROXY_HOPS must be between 0 and 8")
    if trusted_hops:
        forwarded = request.headers.get("x-forwarded-for", "")
        parts = [part.strip() for part in forwarded.split(",")]
        # X-Forwarded-For lists the client followed by each forwarding proxy;
        # request.client is the final peer and is not included in that header.
        index = len(parts) - trusted_hops
        if index >= 0:
            try:
                return str(ipaddress.ip_address(parts[index]))
            except ValueError:
                pass
    try:
        return str(ipaddress.ip_address(direct))
    except ValueError:
        return "unknown"


def _ip_hash(request: Request, key: str) -> str:
    ip = _client_ip(request)
    return hmac.new(key.encode("utf-8"), ip.encode("utf-8"), hashlib.sha256).hexdigest()


async def _rpc(function: str, payload: dict) -> Any:
    url, key = _service_credentials()
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=3.0)) as client:
            response = await client.post(f"{url}/rest/v1/rpc/{function}", headers=headers, json=payload)
        if response.status_code >= 400:
            logger.warning("Supabase quota RPC failed with status %s", response.status_code)
            raise HTTPException(503, "Analysis protection is temporarily unavailable")
        if response.status_code == 204:
            return None
        return response.json()
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Supabase quota check unavailable (%s)", type(exc).__name__)
        raise HTTPException(503, "Analysis protection is temporarily unavailable") from None


async def reserve_analysis(request: Request, user_id: str) -> dict:
    url, key = _service_credentials()
    del url
    limits = quota_settings()
    response = await _rpc("reserve_depth_wizard_quota", {
        "p_user_id": user_id,
        "p_ip_hash": _ip_hash(request, key),
        "p_user_daily_limit": limits["user_daily"],
        "p_ip_minute_limit": limits["ip_minute"],
        "p_global_daily_limit": limits["global_daily"],
        "p_user_storage_bytes": limits["storage_bytes"],
        "p_retention_days": limits["retention_days"],
    })
    if not isinstance(response, dict):
        raise HTTPException(503, "Analysis protection is temporarily unavailable")
    if response.get("allowed") is True:
        return response
    code = response.get("code")
    if code == "capacity_reached":
        raise HTTPException(429, "Daily analysis capacity reached. Please try again tomorrow.",
                            headers={"Retry-After": "3600", "X-Quota-State": "capacity-reached"})
    if code == "daily_limit_reached":
        raise HTTPException(429, "Your daily analysis limit has been reached. Please try again tomorrow.",
                            headers={"Retry-After": "3600", "X-Quota-State": "daily-limit"})
    if code == "ip_rate_limited":
        raise HTTPException(429, "Too many analyses from this network. Wait a minute and try again.",
                            headers={"Retry-After": "60", "X-Quota-State": "ip-rate-limit"})
    raise HTTPException(503, "Analysis protection is temporarily unavailable")


async def read_user_quota(user_id: str) -> dict:
    limits = quota_settings()
    response = await _rpc("get_depth_wizard_quota", {
        "p_user_id": user_id,
        "p_user_daily_limit": limits["user_daily"],
        "p_user_storage_bytes": limits["storage_bytes"],
        "p_retention_days": limits["retention_days"],
    })
    if not isinstance(response, dict):
        raise HTTPException(503, "Analysis protection is temporarily unavailable")
    return response


async def retention_claim() -> bool:
    response = await _rpc("claim_depth_wizard_retention", {"p_cooldown_seconds": 86400})
    return response is True


async def retention_finish(succeeded: bool) -> None:
    await _rpc("finish_depth_wizard_retention", {"p_succeeded": succeeded})
