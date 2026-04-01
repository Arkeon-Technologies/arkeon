"""Lightweight Python SDK for the Arkeon API (arkeon-sdk)."""

import os
from typing import Any, Iterator

import httpx

_url = os.environ.get("ARKE_API_URL", "http://localhost:8000")
_key = os.environ.get("ARKE_API_KEY", "")
_network_id = os.environ.get("ARKE_NETWORK_ID", "")
_client = httpx.Client(
    base_url=_url,
    headers={"Authorization": f"ApiKey {_key}", "Content-Type": "application/json"},
)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def set_network_id(network_id: str):
    """Set the default network ID injected into requests."""
    global _network_id
    _network_id = network_id


def get_network_id() -> str:
    """Get the current default network ID."""
    return _network_id


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class ArkeError(Exception):
    """Structured error from the Arkeon API."""

    def __init__(self, status: int, message: str, request_id: str | None = None,
                 code: str | None = None, details: dict | None = None):
        super().__init__(message)
        self.status = status
        self.request_id = request_id
        self.code = code
        self.details = details


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse(r: httpx.Response):
    if not r.is_success:
        body = r.json() if "application/json" in r.headers.get("content-type", "") else None
        err = body.get("error", {}) if body else {}
        raise ArkeError(
            status=r.status_code,
            message=err.get("message", r.reason_phrase),
            request_id=err.get("request_id") or r.headers.get("x-request-id"),
            code=err.get("code"),
            details=err.get("details"),
        )
    if r.status_code == 204:
        return None
    ct = r.headers.get("content-type", "")
    if "application/json" in ct:
        return r.json()
    return r.text


def _inject_network_id(params: dict | None, is_body: bool) -> dict | None:
    """Auto-inject network_id if a default is set and not already present."""
    if not _network_id:
        return params
    if params and "network_id" in params:
        return params
    merged = {"network_id": _network_id}
    if params:
        merged.update(params)
    return merged


# ---------------------------------------------------------------------------
# HTTP methods
# ---------------------------------------------------------------------------

def get(path: str, params: dict | None = None):
    return _parse(_client.get(path, params=_inject_network_id(params, False)))


def post(path: str, json: Any = None):
    return _parse(_client.post(path, json=_inject_network_id(json, True)))


def put(path: str, json: Any = None):
    return _parse(_client.put(path, json=_inject_network_id(json, True)))


def patch(path: str, json: Any = None):
    return _parse(_client.patch(path, json=json))


def delete(path: str):
    return _parse(_client.delete(path))


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

def paginate(path: str, params: dict | None = None) -> Iterator[Any]:
    """Iterate through all pages of a list endpoint.

    Yields individual items from each page. The collection key is auto-detected
    from the response (the first list-valued field).

    Example::

        for entity in paginate("/entities", {"limit": 50}):
            print(entity["id"])
    """
    cursor = None
    while True:
        p = {**(params or {})}
        if cursor:
            p["cursor"] = cursor
        res = get(path, params=p)
        if not res or not isinstance(res, dict):
            return

        # Find the array of items
        items = next((v for v in res.values() if isinstance(v, list)), None)
        if not items:
            return
        yield from items
        cursor = res.get("cursor")
        if not cursor:
            return
