"""
FastAPI server exposing the whisper transcription API.

Spawned as a sidecar by the @exulu/backend whisper supervisor, but also
runnable standalone (typically on a separate GPU box) by setting
TRANSCRIPTION_SERVER on the main app to point here.
"""

import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from pipeline import (
    TranscriptionOptions,
    TranscriptionPipeline,
    describe_gpu,
    detect_device,
)
from worker import TranscriptionWorker


WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "auto")
WHISPER_BATCH_SIZE = int(os.getenv("WHISPER_BATCH_SIZE", "4"))


def _log(msg: str) -> None:
    print(f"[EXULU-WHISPER] {msg}", flush=True)


state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    device = detect_device(WHISPER_DEVICE)
    gpu = describe_gpu(device)

    if gpu["available"]:
        if gpu["kind"] == "cuda":
            _log(f"GPU support: enabled (CUDA, {gpu['name']}, {gpu['vram_gb']} GB VRAM)")
        else:
            _log("GPU support: enabled (Apple Silicon MPS)")
    else:
        _log("GPU support: disabled (CPU only). Transcription will be slow.")
        _log("  To enable on Linux/Windows: install CUDA + re-run `WHISPER_GPU=cuda npm install`")
        _log("  To enable on macOS Apple Silicon: no setup needed (will auto-use MPS)")

    _log(f"Model: {WHISPER_MODEL} (loading… ~30s first run)")
    pipeline = TranscriptionPipeline(WHISPER_MODEL, device, WHISPER_BATCH_SIZE)
    pipeline.load()

    if pipeline.diarization_enabled:
        _log("Diarization: enabled (pyannote)")
    else:
        reason = pipeline.diarization_disabled_reason or "unknown reason"
        _log(f'Diarization: disabled ({reason}). All segments will get speaker="unknown".')
        if not os.getenv("HF_AUTH_TOKEN"):
            _log("  To enable: set HF_AUTH_TOKEN to a Hugging Face token, then accept ToS at")
            _log("  https://huggingface.co/pyannote/segmentation-3.0 and")
            _log("  https://huggingface.co/pyannote/speaker-diarization-3.1")
        else:
            _log("  Token is set; the missing piece is usually accepting the gated-repo ToS at")
            _log("  https://huggingface.co/pyannote/segmentation-3.0 and")
            _log("  https://huggingface.co/pyannote/speaker-diarization-3.1")

    worker = TranscriptionWorker(pipeline)
    worker.start()

    state["device"] = device
    state["gpu"] = gpu
    state["pipeline"] = pipeline
    state["worker"] = worker

    _log("Ready.")
    yield


app = FastAPI(lifespan=lifespan)


class JobCreate(BaseModel):
    audio_url: str
    language: Optional[str] = None
    num_speakers: Optional[int] = None
    hotwords: Optional[list[str]] = None


def _job_to_dict(job) -> dict:
    return {
        "job_id": job.job_id,
        "status": job.status,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "segments": job.segments,
        "language": job.language,
        "duration_seconds": job.duration_seconds,
        "error": job.error,
    }


@app.post("/jobs")
async def create_job(body: JobCreate):
    worker: TranscriptionWorker = state["worker"]
    opts = TranscriptionOptions(
        language=body.language,
        num_speakers=body.num_speakers,
        hotwords=body.hotwords or [],
    )
    job_id = worker.submit(body.audio_url, opts)
    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs")
async def list_jobs():
    worker: TranscriptionWorker = state["worker"]
    return [_job_to_dict(j) for j in worker.list_jobs()]


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    worker: TranscriptionWorker = state["worker"]
    job = worker.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return _job_to_dict(job)


@app.delete("/jobs/{job_id}")
async def cancel_job(job_id: str):
    worker: TranscriptionWorker = state["worker"]
    job = worker.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    worker.cancel(job_id)
    return {"job_id": job_id, "status": job.status}


@app.get("/healthz")
async def healthz():
    pipeline: Optional[TranscriptionPipeline] = state.get("pipeline")
    return {
        "ok": True,
        "device": state.get("device"),
        "model": WHISPER_MODEL,
        "gpu": state.get("gpu"),
        "diarization": pipeline.diarization_enabled if pipeline else False,
    }
