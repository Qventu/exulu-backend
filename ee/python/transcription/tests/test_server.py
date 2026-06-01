"""
FastAPI testclient tests for the whisper server endpoints.

Stubs the pipeline so we exercise routing/state transitions, not the actual
whisperx/pyannote stack — which is slow and needs a GPU + model downloads.

Run from the repo root with the venv active:
    cd ee/python/transcription && ../.venv/bin/python -m pytest tests
"""

from unittest.mock import patch
import asyncio
import sys
from pathlib import Path

import pytest

# Make ee/python/transcription importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class StubPipeline:
    def __init__(self, *args, **kwargs):
        self.diarization_enabled = True

    def load(self):
        return None


class StubResult:
    def __init__(self):
        self.segments = [
            {"start": 0.0, "end": 1.0, "text": "Hello", "speaker": "SPEAKER_00"},
            {"start": 1.0, "end": 2.0, "text": "Hi there", "speaker": "SPEAKER_01"},
        ]
        self.language = "en"
        self.duration_seconds = 2.0


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr("pipeline.TranscriptionPipeline", StubPipeline)
    monkeypatch.setattr("pipeline.detect_device", lambda _r="auto": "cpu")
    monkeypatch.setattr(
        "pipeline.describe_gpu",
        lambda _d: {"available": False, "kind": "cpu", "name": None, "vram_gb": None},
    )
    # Patch the worker's download to avoid hitting the network.
    monkeypatch.setattr("worker._download_sync", lambda _u: "/tmp/dummy")

    from fastapi.testclient import TestClient

    # Reload server so it picks up the patched pipeline at import time.
    if "server" in sys.modules:
        del sys.modules["server"]
    import server

    # Make the pipeline's transcribe return a deterministic result.
    monkeypatch.setattr(
        "pipeline.TranscriptionPipeline.transcribe",
        lambda self, path, options, is_cancelled=None: StubResult(),
        raising=False,
    )

    with TestClient(server.app) as c:
        yield c


def test_healthz_shape(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "device" in body
    assert "model" in body
    assert "gpu" in body
    assert isinstance(body["diarization"], bool)


def test_create_job_returns_job_id(client):
    r = client.post("/jobs", json={"audio_url": "http://example.com/audio.wav"})
    assert r.status_code == 200
    body = r.json()
    assert "job_id" in body
    assert body["status"] == "queued"


def test_get_unknown_job_is_404(client):
    r = client.get("/jobs/nonexistent-id")
    assert r.status_code == 404


def test_list_jobs_returns_array(client):
    r = client.get("/jobs")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_delete_unknown_job_is_404(client):
    r = client.delete("/jobs/nonexistent-id")
    assert r.status_code == 404


def test_create_then_get_job(client):
    create = client.post("/jobs", json={"audio_url": "http://example.com/audio.wav"}).json()
    job_id = create["job_id"]
    r = client.get(f"/jobs/{job_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["job_id"] == job_id
    assert body["status"] in {"queued", "running", "completed", "failed", "cancelled"}
