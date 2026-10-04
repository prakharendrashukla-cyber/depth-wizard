"""Server-side Supabase Storage and Auth administration for the existing project."""
import logging
import os
from datetime import datetime, timezone

import httpx

logger = logging.getLogger(__name__)
BUCKET = "depth-wizard"


def _credentials() -> tuple[str, str]:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url.startswith("https://") or not key:
        raise RuntimeError("Supabase server administration is not configured")
    return url, key


def _headers(key: str) -> dict[str, str]:
    return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


async def _delete_objects(client: httpx.AsyncClient, base: str, headers: dict, paths: list[str]) -> None:
    unique = list(dict.fromkeys(path for path in paths if path))
    for start in range(0, len(unique), 1000):
        response = await client.request(
            "DELETE", f"{base}/storage/v1/object/{BUCKET}", headers=headers,
            json={"prefixes": unique[start:start + 1000]},
        )
        if response.status_code >= 400:
            logger.warning("Supabase Storage cleanup failed with status %s", response.status_code)
            raise RuntimeError("Could not remove stored files")


async def delete_account_data(user_id: str) -> None:
    """Delete a verified user's files and rows before deleting their Auth record."""
    base, key = _credentials()
    headers = _headers(key)
    timeout = httpx.Timeout(10.0, connect=3.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        while True:
            response = await client.get(
                f"{base}/rest/v1/analyses",
                headers=headers,
                params={
                    "select": "id,image_path,depth_path,preview_path,cloud_path,ply_path",
                    "user_id": f"eq.{user_id}", "order": "id.asc", "limit": "100",
                },
            )
            if response.status_code >= 400:
                raise RuntimeError("Could not read saved analysis paths")
            rows = response.json()
            if not rows:
                break
            paths = [row.get(column) for row in rows for column in
                     ("image_path", "depth_path", "preview_path", "cloud_path", "ply_path")]
            await _delete_objects(client, base, headers, paths)
            ids = [str(row["id"]) for row in rows]
            deleted = await client.delete(
                f"{base}/rest/v1/analyses", headers=headers,
                params={"user_id": f"eq.{user_id}", "id": f"in.({','.join(ids)})"},
            )
            if deleted.status_code >= 400:
                raise RuntimeError("Could not remove saved analysis records")
        account = await client.delete(f"{base}/auth/v1/admin/users/{user_id}", headers=headers)
        if account.status_code >= 400:
            logger.warning("Supabase account deletion failed with status %s", account.status_code)
            raise RuntimeError("Could not delete the account")


async def cleanup_expired_analyses(retention_days: int) -> int:
    """Remove expired objects via Storage API, then delete their owner-scoped rows."""
    base, key = _credentials()
    headers = _headers(key)
    timeout = httpx.Timeout(20.0, connect=3.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        claim = await client.post(
            f"{base}/rest/v1/rpc/claim_depth_wizard_retention", headers=headers,
            json={"p_cooldown_seconds": 86400},
        )
        if claim.status_code >= 400:
            logger.warning("Retention schedule claim failed with status %s", claim.status_code)
            raise RuntimeError("Retention is not configured")
        if claim.json() is not True:
            return 0

        from datetime import timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).replace(microsecond=0).isoformat()
        succeeded = False
        try:
            total = 0
            while True:
                response = await client.get(
                    f"{base}/rest/v1/analyses", headers=headers,
                    params={
                        "select": "id,image_path,depth_path,preview_path,cloud_path,ply_path",
                        "created_at": f"lt.{cutoff}", "order": "created_at.asc", "limit": "100",
                    },
                )
                if response.status_code >= 400:
                    raise RuntimeError("Could not read expired analysis records")
                rows = response.json()
                if not rows:
                    succeeded = True
                    return total
                paths = [row.get(column) for row in rows for column in
                         ("image_path", "depth_path", "preview_path", "cloud_path", "ply_path")]
                await _delete_objects(client, base, headers, paths)
                ids = [str(row["id"]) for row in rows]
                deleted = await client.delete(
                    f"{base}/rest/v1/analyses", headers=headers,
                    params={"id": f"in.({','.join(ids)})"},
                )
                if deleted.status_code >= 400:
                    raise RuntimeError("Could not remove expired analysis records")
                total += len(rows)
                if len(rows) < 100:
                    succeeded = True
                    return total
        finally:
            await client.post(
                f"{base}/rest/v1/rpc/finish_depth_wizard_retention", headers=headers,
                json={"p_succeeded": succeeded},
            )
