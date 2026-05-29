"""
Single-consumer asyncio worker queue.
Pulls one job at a time from the queue, downloads audio, runs the pipeline.
"""

import asyncio
import os
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import requests

from pipeline import (
    CancelledError,
    TranscriptionOptions,
    TranscriptionPipeline,
)


@dataclass
class Job:
    job_id: str
    audio_url: str
    options: TranscriptionOptions
    status: str = "queued"  # queued|running|completed|failed|cancelled
    segments: Optional[list] = None
    language: Optional[str] = None
    duration_seconds: Optional[float] = None
    error: Optional[str] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    cancel_requested: bool = False


def _download_sync(url: str) -> str:
    """Download a presigned URL to a temp file. Returns the local path."""
    fd, path = tempfile.mkstemp(prefix="exulu-whisper-", suffix=".audio")
    os.close(fd)
    with requests.get(url, stream=True, timeout=300) as resp:
        resp.raise_for_status()
        with open(path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
    return path


class TranscriptionWorker:
    def __init__(self, pipeline: TranscriptionPipeline):
        self.pipeline = pipeline
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.jobs: dict[str, Job] = {}
        self._task: Optional[asyncio.Task] = None

    def submit(self, audio_url: str, options: TranscriptionOptions) -> str:
        job_id = str(uuid.uuid4())
        self.jobs[job_id] = Job(job_id=job_id, audio_url=audio_url, options=options)
        self.queue.put_nowait(job_id)
        return job_id

    def get(self, job_id: str) -> Optional[Job]:
        return self.jobs.get(job_id)

    def list_jobs(self) -> list[Job]:
        return list(self.jobs.values())

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        if job.status == "queued":
            job.status = "cancelled"
            job.finished_at = time.time()
            return True
        if job.status == "running":
            job.cancel_requested = True
            return True
        return False

    def start(self) -> None:
        loop = asyncio.get_event_loop()
        self._task = loop.create_task(self._run_loop())

    async def _run_loop(self) -> None:
        while True:
            job_id = await self.queue.get()
            job = self.jobs.get(job_id)
            if not job:
                continue
            if job.status == "cancelled":
                # Cancelled while queued — skip.
                continue
            await self._process(job)

    async def _process(self, job: Job) -> None:
        job.status = "running"
        job.started_at = time.time()

        def on_audio_loaded(duration: float) -> None:
            # Surfacing duration before transcription completes lets the
            # backend show the user the length of the audio while the slow
            # part is still running.
            job.duration_seconds = duration

        def work():
            audio_path = _download_sync(job.audio_url)
            try:
                return self.pipeline.transcribe(
                    audio_path,
                    job.options,
                    is_cancelled=lambda: job.cancel_requested,
                    on_audio_loaded=on_audio_loaded,
                )
            finally:
                try:
                    os.unlink(audio_path)
                except OSError:
                    pass

        try:
            result = await asyncio.to_thread(work)
            job.segments = result.segments
            job.language = result.language
            job.duration_seconds = result.duration_seconds
            job.status = "completed"
        except CancelledError:
            job.status = "cancelled"
        except Exception as e:
            job.status = "failed"
            job.error = f"{type(e).__name__}: {e}"
        finally:
            job.finished_at = time.time()
