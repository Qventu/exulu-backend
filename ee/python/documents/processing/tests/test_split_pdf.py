"""Tests for split_pdf.py.

Builds real PDFs with pypdf rather than using fixtures, so the suite is
self-contained and the page counts/byte sizes are known exactly.

Run from the repo root with the venv active:
    cd ee/python/documents/processing && ../../.venv/bin/python -m pytest tests
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

# Make ee/python/documents/processing importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import split_pdf as sp  # noqa: E402

SCRIPT = Path(__file__).resolve().parent.parent / "split_pdf.py"


def _make_pdf(path: Path, pages: int, page_bytes: int = 0) -> Path:
    """Write a PDF whose pages carry a real content stream.

    Each page's stream holds a `% exulu-page-N` marker so tests can assert the
    page order survived, plus `page_bytes` of incompressible padding so the
    byte-size bisection tests get a file whose size scales with page count.
    Page content is used rather than custom dictionary keys because a PDF
    library is free to drop unknown keys when it rebuilds pages, and PyMuPDF
    does exactly that.
    """
    writer = PdfWriter()
    for i in range(pages):
        writer.add_blank_page(width=200, height=200)
        body = f"% exulu-page-{i}\n".encode()
        if page_bytes:
            body += b"% " + os.urandom(page_bytes).hex().encode() + b"\n"
        stream = DecodedStreamObject()
        stream.set_data(body)
        writer.pages[i][NameObject("/Contents")] = writer._add_object(stream)
    with open(path, "wb") as fh:
        writer.write(fh)
    return path


def _page_markers(pdf_path: str) -> list[str]:
    """Read back the `% exulu-page-N` marker from every page of a chunk."""
    markers = []
    for page in PdfReader(pdf_path).pages:
        data = page["/Contents"].get_data().decode("latin-1")
        markers.append(data.splitlines()[0].removeprefix("% "))
    return markers


def _run_script(*args: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


# --- no-split path -----------------------------------------------------------


def test_returns_original_when_within_limits(tmp_path):
    src = _make_pdf(tmp_path / "small.pdf", pages=3)
    chunks = sp.split_pdf(str(src), str(tmp_path / "out"), chunk_size=25)

    assert len(chunks) == 1
    assert chunks[0]["path"] == str(src.resolve())
    assert chunks[0]["start_page"] == 0
    assert chunks[0]["end_page"] == 3
    # No copy is made, so the output dir is never created.
    assert not (tmp_path / "out").exists()


# --- page-count splitting ----------------------------------------------------


def test_splits_on_page_count(tmp_path):
    src = _make_pdf(tmp_path / "big.pdf", pages=10)
    out = tmp_path / "out"
    chunks = sp.split_pdf(str(src), str(out), chunk_size=4)

    assert [(c["start_page"], c["end_page"]) for c in chunks] == [(0, 4), (4, 8), (8, 10)]
    for c in chunks:
        assert Path(c["path"]).exists()
    assert [len(PdfReader(c["path"]).pages) for c in chunks] == [4, 4, 2]


def test_chunk_ranges_are_contiguous_and_cover_every_page(tmp_path):
    src = _make_pdf(tmp_path / "doc.pdf", pages=17)
    chunks = sp.split_pdf(str(src), str(tmp_path / "out"), chunk_size=5)

    assert chunks[0]["start_page"] == 0
    assert chunks[-1]["end_page"] == 17
    for prev, nxt in zip(chunks, chunks[1:]):
        assert prev["end_page"] == nxt["start_page"]
    assert sum(len(PdfReader(c["path"]).pages) for c in chunks) == 17


def test_exact_multiple_of_chunk_size_produces_no_empty_trailing_chunk(tmp_path):
    src = _make_pdf(tmp_path / "doc.pdf", pages=8)
    chunks = sp.split_pdf(str(src), str(tmp_path / "out"), chunk_size=4)

    assert [(c["start_page"], c["end_page"]) for c in chunks] == [(0, 4), (4, 8)]


def test_page_content_is_preserved_in_order(tmp_path):
    """The Nth page of the source must land at the right offset in its chunk."""
    src = _make_pdf(tmp_path / "marked.pdf", pages=6)

    chunks = sp.split_pdf(str(src), str(tmp_path / "out"), chunk_size=2)

    seen = []
    for c in chunks:
        seen.extend(_page_markers(c["path"]))
    assert seen == [f"exulu-page-{i}" for i in range(6)]


# --- byte-size bisection -----------------------------------------------------


def test_oversized_chunk_is_bisected_by_page_count(tmp_path):
    # 4 pages, ~40 KB each. A 4-page chunk exceeds 100 KB and must bisect.
    src = _make_pdf(tmp_path / "heavy.pdf", pages=4, page_bytes=20_000)
    chunks = sp.split_pdf(
        str(src), str(tmp_path / "out"), chunk_size=4, max_size_bytes=100_000
    )

    assert len(chunks) > 1
    assert [(c["start_page"], c["end_page"]) for c in chunks][0][0] == 0
    assert chunks[-1]["end_page"] == 4
    for prev, nxt in zip(chunks, chunks[1:]):
        assert prev["end_page"] == nxt["start_page"]


def test_single_page_over_limit_is_kept_with_a_warning(tmp_path, capsys):
    src = _make_pdf(tmp_path / "huge-page.pdf", pages=1, page_bytes=60_000)
    # Force the split path: max_size_bytes below the file size.
    chunks = sp.split_pdf(
        str(src), str(tmp_path / "out"), chunk_size=1, max_size_bytes=1_000
    )

    assert len(chunks) == 1
    assert Path(chunks[0]["path"]).exists()
    assert "cannot be split further" in capsys.readouterr().err


def test_file_over_size_limit_splits_even_when_page_count_fits(tmp_path):
    src = _make_pdf(tmp_path / "wide.pdf", pages=4, page_bytes=20_000)
    chunks = sp.split_pdf(
        str(src), str(tmp_path / "out"), chunk_size=25, max_size_bytes=50_000
    )

    # chunk_size alone would have returned the original untouched.
    assert len(chunks) > 1


# --- encryption --------------------------------------------------------------


def test_opens_phantom_password_pdf(tmp_path):
    """A PDF encrypted with an empty password must open, as the OS does."""
    writer = PdfWriter()
    for _ in range(6):
        writer.add_blank_page(width=200, height=200)
    writer.encrypt("")
    src = tmp_path / "phantom.pdf"
    with open(src, "wb") as fh:
        writer.write(fh)

    assert PdfReader(src).is_encrypted

    chunks = sp.split_pdf(str(src), str(tmp_path / "out"), chunk_size=2)
    assert len(chunks) == 3
    assert sum(len(PdfReader(c["path"]).pages) for c in chunks) == 6


def test_rejects_pdf_with_a_real_password(tmp_path):
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.encrypt("hunter2")
    src = tmp_path / "locked.pdf"
    with open(src, "wb") as fh:
        writer.write(fh)

    with pytest.raises(ValueError, match="non-empty password"):
        sp.split_pdf(str(src), str(tmp_path / "out"), chunk_size=1)


# --- CLI contract ------------------------------------------------------------


def test_stdout_is_pure_json(tmp_path):
    src = _make_pdf(tmp_path / "doc.pdf", pages=6)
    code, out, err = _run_script(str(src), str(tmp_path / "out"), "--chunk-size", "2")

    assert code == 0
    parsed = json.loads(out)  # must not raise: nothing but JSON on stdout
    assert len(parsed) == 3
    # Diagnostics go to stderr, not stdout.
    assert "[split_pdf]" in err
    assert "[split_pdf]" not in out


def test_cli_max_size_mb_is_converted_to_bytes(tmp_path):
    src = _make_pdf(tmp_path / "heavy.pdf", pages=4, page_bytes=20_000)
    code, out, _ = _run_script(
        str(src), str(tmp_path / "out"), "--chunk-size", "4", "--max-size-mb", "0.05"
    )

    assert code == 0
    assert len(json.loads(out)) > 1


def test_exits_nonzero_on_failure(tmp_path):
    code, out, err = _run_script(str(tmp_path / "missing.pdf"), str(tmp_path / "out"))

    assert code == 1
    assert "[split_pdf] ERROR" in err
    assert out.strip() == ""
