"""Tests for the forced-alignment licence guard in pipeline.py.

The guard exists so that an ordinary upload in one of a handful of languages
cannot pull a non-commercial or unlicensed wav2vec2 model onto the server.
These tests assert the two things that matter: the blocked models are never
loaded (so never downloaded), and a blocked language still produces a usable
transcript.

Run from the repo root with the venv active:
    cd ee/python/transcription && ../.venv/bin/python -m pytest tests
"""

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Make ee/python/transcription importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pipeline as pl  # noqa: E402


def _pipeline():
    p = pl.TranscriptionPipeline("large-v3", "cpu", 4)
    return p


# --- the block list itself -------------------------------------------------


def test_restricted_models_match_whisperx_defaults():
    """Every blocked id must actually be a model whisperx would resolve.

    Guards against a typo or an upstream rename silently disarming the guard.
    """
    from whisperx.alignment import DEFAULT_ALIGN_MODELS_HF

    defaults = set(DEFAULT_ALIGN_MODELS_HF.values())
    for model_id in pl.RESTRICTED_ALIGN_MODELS:
        assert model_id in defaults, (
            f"{model_id} is blocked but is no longer a whisperx default — "
            "the upstream table changed and the guard may be stale"
        )


@pytest.mark.parametrize(
    "language,expected_model",
    [
        ("vi", "nguyenvulebinh/wav2vec2-base-vi"),
        ("hr", "classla/wav2vec2-xls-r-parlaspeech-hr"),
        ("he", "imvladikon/wav2vec2-xls-r-300m-hebrew"),
        ("hi", "theainerd/Wav2Vec2-large-xlsr-hindi"),
        ("da", "saattrupdan/wav2vec2-xls-r-300m-ftspeech"),
    ],
)
def test_restricted_languages_resolve_to_blocked_models(language, expected_model):
    assert pl._default_align_model_for(language) == expected_model
    assert expected_model in pl.RESTRICTED_ALIGN_MODELS


# --- the guard -------------------------------------------------------------


@pytest.mark.parametrize("language", ["vi", "hr", "he", "hi", "da"])
def test_blocked_language_never_loads_a_model(language):
    """The decisive test: load_align_model must not be called at all.

    load_align_model is what reaches Hugging Face, so not calling it means the
    weights are neither downloaded nor used.
    """
    p = _pipeline()
    with patch.object(pl.whisperx, "load_align_model") as load:
        assert p._get_align_model(language) is None
        load.assert_not_called()


@pytest.mark.parametrize("language", ["vi", "hr", "he", "hi", "da"])
def test_blocked_language_records_and_logs_a_reason(language, capsys):
    p = _pipeline()
    with patch.object(pl.whisperx, "load_align_model"):
        p._get_align_model(language)

    assert language in p.align_skipped_reasons
    out = capsys.readouterr().out
    assert "WARNING" in out
    assert "not licence-cleared" in out
    assert pl.RESTRICTED_ALIGN_MODELS[pl._default_align_model_for(language)] in out


def test_blocked_result_is_cached_so_the_warning_is_not_repeated(capsys):
    p = _pipeline()
    with patch.object(pl.whisperx, "load_align_model") as load:
        p._get_align_model("vi")
        first = capsys.readouterr().out
        p._get_align_model("vi")
        second = capsys.readouterr().out
        load.assert_not_called()

    assert "WARNING" in first
    assert second.strip() == ""


# --- languages that are fine ------------------------------------------------


@pytest.mark.parametrize("language", ["en", "de", "nl", "fr", "es"])
def test_permitted_language_still_loads_normally(language):
    p = _pipeline()
    with patch.object(pl.whisperx, "load_align_model", return_value=("model", "meta")) as load:
        assert p._get_align_model(language) == ("model", "meta")
        load.assert_called_once()
        assert load.call_args.kwargs["language_code"] == language

    assert p.align_skipped_reasons == {}


def test_permitted_language_is_cached():
    p = _pipeline()
    with patch.object(pl.whisperx, "load_align_model", return_value=("m", "meta")) as load:
        p._get_align_model("en")
        p._get_align_model("en")
        load.assert_called_once()


# --- operator override ------------------------------------------------------


def test_override_re_enables_a_blocked_language(monkeypatch):
    monkeypatch.setenv("EXULU_ALIGN_MODEL_VI", "my-org/licensed-vi-aligner")
    p = _pipeline()
    with patch.object(pl.whisperx, "load_align_model", return_value=("m", "meta")) as load:
        assert p._get_align_model("vi") == ("m", "meta")
        assert load.call_args.kwargs["model_name"] == "my-org/licensed-vi-aligner"

    assert p.align_skipped_reasons == {}


def test_override_applies_to_a_permitted_language_too(monkeypatch):
    monkeypatch.setenv("EXULU_ALIGN_MODEL_EN", "my-org/custom-en")
    p = _pipeline()
    with patch.object(pl.whisperx, "load_align_model", return_value=("m", "meta")) as load:
        p._get_align_model("en")
        assert load.call_args.kwargs["model_name"] == "my-org/custom-en"


def test_no_override_passes_the_whisperx_default_through(monkeypatch):
    monkeypatch.delenv("EXULU_ALIGN_MODEL_EN", raising=False)
    p = _pipeline()
    with patch.object(pl.whisperx, "load_align_model", return_value=("m", "meta")) as load:
        p._get_align_model("en")
        assert load.call_args.kwargs["model_name"] == pl._default_align_model_for("en")


# --- graceful degradation ---------------------------------------------------


def test_unaligned_segments_carry_everything_the_output_needs():
    """transcribe() reads start/end/text/speaker; Whisper's own segments have
    the first three, so skipping alignment cannot break the response shape."""
    unaligned = {
        "segments": [{"start": 0.0, "end": 1.5, "text": "xin chao"}],
        "language": "vi",
    }
    for seg in unaligned["segments"]:
        assert "start" in seg and "end" in seg and "text" in seg


def test_assign_word_speakers_accepts_unaligned_input():
    """The diarization step must tolerate segments that have no 'words' key,
    otherwise a blocked language would crash instead of degrading."""
    import pandas as pd
    from whisperx.diarize import assign_word_speakers

    diarize_df = pd.DataFrame(
        [{"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00", "segment": None, "label": "a"}]
    )
    unaligned = {"segments": [{"start": 0.0, "end": 1.5, "text": "xin chao"}]}

    result = assign_word_speakers(diarize_df, unaligned)

    assert result["segments"][0]["speaker"] == "SPEAKER_00"
    assert result["segments"][0]["text"] == "xin chao"
