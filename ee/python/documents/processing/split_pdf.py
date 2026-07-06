#!/usr/bin/env python3
"""
PDF Splitter — splits a PDF into fixed-size page chunks using PyMuPDF.

Outputs a JSON array to stdout, each element:
  { "path": "<absolute-path>", "start_page": <int>, "end_page": <int> }

start_page is 0-indexed, end_page is exclusive (Python-slice convention).
If the document fits within chunk_size AND within max_size_bytes, a single
entry pointing to the original file is returned (no copy made).

Progress and diagnostics go to stderr so stdout stays clean JSON.

Usage:
    split_pdf.py <input_pdf> <output_dir> [--chunk-size N] [--max-size-mb F]
"""

import sys
import os
import json
import argparse

import fitz  # PyMuPDF — installed as a docling transitive dependency


def _write_chunk(
    doc: fitz.Document,
    output_dir: str,
    chunk_start: int,
    chunk_end: int,
    max_size_bytes: int | None,
) -> list[dict]:
    """Write pages [chunk_start, chunk_end) to a file.

    If the result exceeds max_size_bytes and contains more than one page,
    delete it and recurse with the range bisected. Single-page chunks that
    still exceed the limit are kept with a warning — they cannot be split
    further without re-encoding.
    """
    chunk_path = os.path.join(output_dir, f"chunk_{chunk_start}_{chunk_end - 1}.pdf")

    sub = fitz.open()
    sub.insert_pdf(doc, from_page=chunk_start, to_page=chunk_end - 1)
    sub.save(chunk_path)
    sub.close()

    chunk_bytes = os.path.getsize(chunk_path)
    n_pages = chunk_end - chunk_start

    if max_size_bytes and chunk_bytes > max_size_bytes and n_pages > 1:
        os.remove(chunk_path)
        mid = chunk_start + n_pages // 2
        return (
            _write_chunk(doc, output_dir, chunk_start, mid, max_size_bytes)
            + _write_chunk(doc, output_dir, mid, chunk_end, max_size_bytes)
        )

    if max_size_bytes and chunk_bytes > max_size_bytes:
        print(
            f"[split_pdf] WARNING: single-page chunk {chunk_start} is {chunk_bytes:,} bytes — "
            "exceeds size limit but cannot be split further",
            file=sys.stderr,
        )

    return [{"path": os.path.abspath(chunk_path), "start_page": chunk_start, "end_page": chunk_end}]


def split_pdf(
    input_path: str,
    output_dir: str,
    chunk_size: int,
    max_size_bytes: int | None = None,
) -> list[dict]:
    doc = fitz.open(input_path)

    # Some PDFs are saved with an empty owner/user password by certain writers
    # (e.g. older Adobe Acrobat exports). The OS opens them transparently by
    # trying "" first, but most libraries raise immediately. We replicate that
    # OS-level behaviour here.
    if doc.needs_pass:
        authenticated = doc.authenticate("")
        if not authenticated:
            raise ValueError(
                "PDF requires a non-empty password and cannot be opened automatically."
            )
        print("[split_pdf] Authenticated with empty password (phantom-password PDF)", file=sys.stderr)

    total_pages = len(doc)
    file_size = os.path.getsize(input_path)
    print(
        f"[split_pdf] Total pages: {total_pages}, chunk size: {chunk_size}, "
        f"file size: {file_size:,} bytes"
        + (f", max chunk size: {max_size_bytes:,} bytes" if max_size_bytes else ""),
        file=sys.stderr,
    )

    needs_split = total_pages > chunk_size or (max_size_bytes and file_size > max_size_bytes)

    if not needs_split:
        print("[split_pdf] No split needed — returning original path", file=sys.stderr)
        doc.close()
        return [{
            "path": os.path.abspath(input_path),
            "start_page": 0,
            "end_page": total_pages,
        }]

    os.makedirs(output_dir, exist_ok=True)

    chunks = []
    for start_page in range(0, total_pages, chunk_size):
        end_page = min(start_page + chunk_size, total_pages)
        sub_chunks = _write_chunk(doc, output_dir, start_page, end_page, max_size_bytes)
        for c in sub_chunks:
            print(
                f"[split_pdf] Chunk {len(chunks) + 1}: pages {c['start_page']}–{c['end_page'] - 1} "
                f"({os.path.getsize(c['path']):,} bytes) → {os.path.basename(c['path'])}",
                file=sys.stderr,
            )
        chunks.extend(sub_chunks)

    doc.close()
    return chunks


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Split a PDF into fixed-size page chunks.")
    parser.add_argument("input_pdf", help="Path to the input PDF")
    parser.add_argument("output_dir", help="Directory to write chunk PDFs into")
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=25,
        help="Maximum pages per chunk (default: 25)",
    )
    parser.add_argument(
        "--max-size-mb",
        type=float,
        default=None,
        help="Maximum chunk file size in MB — chunks exceeding this are bisected by page count (default: no limit)",
    )
    args = parser.parse_args()

    max_size_bytes = int(args.max_size_mb * 1024 * 1024) if args.max_size_mb is not None else None

    try:
        chunks = split_pdf(args.input_pdf, args.output_dir, args.chunk_size, max_size_bytes)
        print(json.dumps(chunks))
    except Exception as e:
        print(f"[split_pdf] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
