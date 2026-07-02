#!/usr/bin/env python3
"""
PDF Splitter — splits a PDF into fixed-size page chunks using PyMuPDF.

Outputs a JSON array to stdout, each element:
  { "path": "<absolute-path>", "start_page": <int>, "end_page": <int> }

start_page is 0-indexed, end_page is exclusive (Python-slice convention).
If the document fits within chunk_size, a single entry pointing to the
original file is returned (no copy made).

Progress and diagnostics go to stderr so stdout stays clean JSON.

Usage:
    split_pdf.py <input_pdf> <output_dir> [--chunk-size N]
"""

import sys
import os
import json
import argparse

import fitz  # PyMuPDF — installed as a docling transitive dependency


def split_pdf(input_path: str, output_dir: str, chunk_size: int) -> list[dict]:
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
    print(f"[split_pdf] Total pages: {total_pages}, chunk size: {chunk_size}", file=sys.stderr)

    if total_pages <= chunk_size:
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
        chunk_filename = f"chunk_{start_page}_{end_page - 1}.pdf"
        chunk_path = os.path.join(output_dir, chunk_filename)

        chunk_doc = fitz.open()
        chunk_doc.insert_pdf(doc, from_page=start_page, to_page=end_page - 1)
        chunk_doc.save(chunk_path)
        chunk_doc.close()

        chunks.append({
            "path": os.path.abspath(chunk_path),
            "start_page": start_page,
            "end_page": end_page,
        })
        print(
            f"[split_pdf] Chunk {len(chunks)}: pages {start_page}–{end_page - 1} → {chunk_filename}",
            file=sys.stderr,
        )

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
    args = parser.parse_args()

    try:
        chunks = split_pdf(args.input_pdf, args.output_dir, args.chunk_size)
        print(json.dumps(chunks))
    except Exception as e:
        print(f"[split_pdf] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
