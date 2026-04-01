"""Lightweight Python SDK for the Arkeon API (arkeon-sdk)."""

import os

import httpx

_url = os.environ.get("ARKE_API_URL", "http://localhost:8000")
_key = os.environ.get("ARKE_API_KEY", "")
_client = httpx.Client(
    base_url=_url,
    headers={"Authorization": f"ApiKey {_key}", "Content-Type": "application/json"},
)


def _parse(r: httpx.Response):
    r.raise_for_status()
    ct = r.headers.get("content-type", "")
    if "application/json" in ct:
        return r.json()
    return r.text


def get(path: str, params: dict | None = None):
    return _parse(_client.get(path, params=params))


def post(path: str, json=None):
    return _parse(_client.post(path, json=json))


def put(path: str, json=None):
    return _parse(_client.put(path, json=json))


def delete(path: str):
    return _parse(_client.delete(path))
