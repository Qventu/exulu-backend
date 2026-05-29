"""
WhisperX + pyannote transcription pipeline.

Loads models once at startup; one transcribe() call per audio file.
Adapted from audio-transcription/src/transcription.py, but reshaped so the
pipeline can serve multiple jobs from a long-running FastAPI process.
"""

import os
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import pandas as pd
import torch
import whisperx
from whisperx.audio import SAMPLE_RATE


@dataclass
class TranscriptionOptions:
    language: Optional[str] = None  # None = auto-detect
    num_speakers: Optional[int] = None  # None = auto-detect
    hotwords: list[str] = field(default_factory=list)


@dataclass
class TranscriptionResult:
    segments: list[dict]
    language: str
    duration_seconds: float


class CancelledError(Exception):
    pass


def detect_device(requested: str = "auto") -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def describe_gpu(device: str) -> dict:
    if device == "cuda":
        try:
            name = torch.cuda.get_device_name(0)
            vram_gb = round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1)
            return {"available": True, "kind": "cuda", "name": name, "vram_gb": vram_gb}
        except Exception:
            return {"available": True, "kind": "cuda", "name": "unknown", "vram_gb": None}
    if device == "mps":
        return {"available": True, "kind": "mps", "name": "Apple Silicon MPS", "vram_gb": None}
    return {"available": False, "kind": "cpu", "name": None, "vram_gb": None}


class TranscriptionPipeline:
    """
    Loads whisper + pyannote once; serves multiple transcribe() calls.
    Not thread-safe — designed for the single-consumer worker.
    """

    def __init__(self, model_name: str, device: str, batch_size: int):
        self.model_name = model_name
        self.device = device
        self.batch_size = batch_size
        self.model = None
        self.diarize_model = None
        self.diarization_enabled = False
        self.diarization_disabled_reason: str = "not attempted"
        self.align_models: dict[str, tuple] = {}

    def load(self) -> None:
        # whisperx doesn't ship MPS support; run whisper on CPU when DEVICE=mps
        # (faster than torch CPU fallback because whisperx uses CTranslate2 int8).
        whisper_device = "cpu" if self.device == "mps" else self.device
        compute_type = (
            "float16" if self.device == "cuda" else "int8"
        )
        print(f"[pipeline] Loading whisper '{self.model_name}' on {whisper_device} (compute_type={compute_type})", flush=True)
        self.model = whisperx.load_model(
            self.model_name,
            device=whisper_device,
            compute_type=compute_type,
        )

        hf_token = os.getenv("HF_AUTH_TOKEN")
        if not hf_token:
            self.diarization_disabled_reason = "HF_AUTH_TOKEN not set"
            print(f"[pipeline] {self.diarization_disabled_reason}; diarization disabled", flush=True)
            return

        try:
            from pyannote.audio import Pipeline as PyannotePipeline
            self.diarize_model = PyannotePipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=hf_token,
            )
            if self.diarize_model is None:
                # pyannote.from_pretrained returns None (rather than raising)
                # when the user has the token but hasn't accepted the gated
                # repo's terms of use. Surface that distinctly.
                self.diarization_disabled_reason = (
                    "pyannote model could not be loaded — likely a gated-repo "
                    "ToS not accepted. Accept both at "
                    "https://huggingface.co/pyannote/segmentation-3.0 and "
                    "https://huggingface.co/pyannote/speaker-diarization-3.1 "
                    "using the account that owns HF_AUTH_TOKEN"
                )
                raise RuntimeError(self.diarization_disabled_reason)
            if self.device == "cuda":
                self.diarize_model.to(torch.device("cuda"))
            self.diarization_enabled = True
            self.diarization_disabled_reason = ""
            print("[pipeline] Diarization enabled (pyannote)", flush=True)
        except Exception as e:
            self.diarization_disabled_reason = f"{type(e).__name__}: {e}"
            print(f"[pipeline] Failed to load pyannote ({self.diarization_disabled_reason}); diarization disabled", flush=True)

    def _get_align_model(self, language_code: str):
        if language_code not in self.align_models:
            device = "cpu" if self.device == "mps" else self.device
            print(f"[pipeline] Loading align model for {language_code}", flush=True)
            self.align_models[language_code] = whisperx.load_align_model(
                language_code=language_code, device=device
            )
        return self.align_models[language_code]

    def transcribe(
        self,
        audio_path: str,
        options: TranscriptionOptions,
        is_cancelled: Callable[[], bool] = lambda: False,
        on_audio_loaded: Optional[Callable[[float], None]] = None,
    ) -> TranscriptionResult:
        if self.model is None:
            raise RuntimeError("Pipeline not loaded; call load() first")

        t0 = time.time()
        audio = whisperx.load_audio(audio_path)
        duration_seconds = len(audio) / SAMPLE_RATE
        if on_audio_loaded is not None:
            try:
                on_audio_loaded(duration_seconds)
            except Exception:
                pass

        if is_cancelled():
            raise CancelledError()

        hotwords = options.hotwords or []
        if hotwords:
            self.model.options = self.model.options._replace(prefix=" ".join(hotwords))
        try:
            transcribe_result = self.model.transcribe(
                audio,
                batch_size=self.batch_size,
                language=options.language,
            )
        finally:
            if hotwords:
                self.model.options = self.model.options._replace(prefix=None)

        if is_cancelled():
            raise CancelledError()

        language = transcribe_result["language"]
        align_device = "cpu" if self.device == "mps" else self.device
        model_a, metadata = self._get_align_model(language)
        aligned = whisperx.align(
            transcribe_result["segments"],
            model_a,
            metadata,
            audio,
            align_device,
            return_char_alignments=False,
        )

        if is_cancelled():
            raise CancelledError()

        if self.diarization_enabled:
            audio_data = {
                "waveform": torch.from_numpy(audio[None, :]),
                "sample_rate": SAMPLE_RATE,
            }
            kwargs = {}
            if options.num_speakers is not None:
                kwargs["num_speakers"] = options.num_speakers
            diarize_segments = self.diarize_model(audio_data, **kwargs)
            diarize_df = pd.DataFrame(
                diarize_segments.itertracks(yield_label=True),
                columns=["segment", "label", "speaker"],
            )
            diarize_df["start"] = diarize_df["segment"].apply(lambda x: x.start)
            diarize_df["end"] = diarize_df["segment"].apply(lambda x: x.end)
            assigned = whisperx.assign_word_speakers(diarize_df, aligned)
        else:
            assigned = aligned
            for seg in assigned["segments"]:
                seg["speaker"] = "unknown"

        if self.device == "cuda":
            torch.cuda.empty_cache()
        elif self.device == "mps":
            try:
                torch.mps.empty_cache()
            except Exception:
                pass

        segments: list[dict] = []
        for seg in assigned["segments"]:
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            segments.append({
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "text": text,
                "speaker": seg.get("speaker") or "unknown",
            })

        print(f"[pipeline] Done in {time.time() - t0:.1f}s ({len(segments)} segments)", flush=True)
        return TranscriptionResult(
            segments=segments,
            language=language,
            duration_seconds=duration_seconds,
        )
