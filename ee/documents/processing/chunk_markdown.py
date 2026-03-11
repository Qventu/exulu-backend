#!/usr/bin/env python3
"""
Markdown Chunker using Docling HybridChunker
Converts markdown files into chunks using Docling's hybrid chunking approach.

Usage:
    chunk_markdown.py <markdown_file_path> [-o OUTPUT_PATH] [--max-tokens MAX_TOKENS]
"""

import sys
import os
import warnings
import argparse
import json
from pathlib import Path

# Suppress warnings
warnings.filterwarnings('ignore')
os.environ['PYTHONWARNINGS'] = 'ignore'

from docling.document_converter import DocumentConverter
from docling.chunking import HybridChunker


def find_page_for_chunk(chunk_text: str, pages_data: list) -> int:
    """
    Find which page a chunk belongs to by matching text content.

    Args:
        chunk_text: The text content of the chunk
        pages_data: List of page objects from index_validated.json

    Returns:
        Page number (1-indexed) or None if not found
    """
    # Take first 100 characters for matching (remove extra whitespace)
    search_text = ' '.join(chunk_text[:100].split())

    # Search through all pages
    for page in pages_data:
        # Check both content and vlm_corrected_text
        content_sources = [page.get('content', '')]
        if page.get('vlm_corrected_text'):
            content_sources.append(page['vlm_corrected_text'])

        for content in content_sources:
            # Normalize whitespace in content for comparison
            normalized_content = ' '.join(content.split())

            if search_text in normalized_content:
                return page.get('page')

    return None


def chunk_markdown_file(markdown_path: str, max_tokens: int = 512, output_path: str = None, use_markdown_tables: bool = True, index_json_path: str = None) -> dict:
    """
    Chunk a markdown file using Docling's HybridChunker.

    Args:
        markdown_path: Path to the markdown file
        max_tokens: Maximum number of tokens per chunk (default: 512)
        output_path: Optional output path for JSON file
        use_markdown_tables: Use markdown table format instead of triplets (default: True)
        index_json_path: Optional path to index_validated.json for page mapping

    Returns:
        Dictionary containing chunks and metadata
    """
    # Convert the markdown document
    print(f"Converting markdown document: {markdown_path}", file=sys.stderr)
    converter = DocumentConverter()
    result = converter.convert(source=markdown_path)
    doc = result.document

    # Initialize the chunker with specified max_tokens and markdown tables enabled
    print(f"Initializing HybridChunker with max_tokens={max_tokens}, use_markdown_tables={use_markdown_tables}", file=sys.stderr)
    chunker = HybridChunker(
        max_tokens=max_tokens,
        use_markdown_tables=use_markdown_tables
    )

    # Load page data for page mapping if provided
    pages_data = None
    if index_json_path and Path(index_json_path).exists():
        print(f"Loading page data from: {index_json_path}", file=sys.stderr)
        with open(index_json_path, 'r', encoding='utf-8') as f:
            pages_data = json.load(f)

    # Chunk the document
    print(f"Chunking document...", file=sys.stderr)
    chunk_iter = chunker.chunk(dl_doc=doc)

    # Process chunks and collect results
    chunks = []
    for i, chunk in enumerate(chunk_iter):
        # Get the context-enriched text (recommended for embeddings)
        enriched_text = chunker.contextualize(chunk=chunk)

        # Extract heading hierarchy from chunk metadata
        heading_hierarchy = []
        if hasattr(chunk.meta, 'headings') and chunk.meta.headings:
            heading_hierarchy = chunk.meta.headings if isinstance(chunk.meta.headings, list) else [chunk.meta.headings]

        # Find page number by matching chunk text with pages data
        page_number = None
        if pages_data:
            page_number = find_page_for_chunk(chunk.text, pages_data)

        # Debug for first few chunks
        if i < 3:
            print(f"\nDEBUG Chunk {i}:", file=sys.stderr)
            print(f"  Text preview: {chunk.text[:100]}...", file=sys.stderr)
            print(f"  Heading hierarchy: {heading_hierarchy}", file=sys.stderr)
            print(f"  Page number: {page_number}", file=sys.stderr)

        chunks.append({
            "chunk_id": i,
            "text": chunk.text,
            "enriched_text": enriched_text,
            "metadata": {
                "page": page_number,
                "path": getattr(chunk, 'path', None),
                "headings": heading_hierarchy
            }
        })

    # Return the results
    return {
        "source": markdown_path,
        "total_chunks": len(chunks),
        "max_tokens": max_tokens,
        "chunks": chunks
    }


def main():
    """Main entry point for the script."""
    # Set up argument parser
    parser = argparse.ArgumentParser(
        description='Chunk markdown file using Docling HybridChunker',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        'markdown_path',
        type=str,
        help='Path to the markdown file to chunk'
    )

    parser.add_argument(
        '-o', '--output',
        type=str,
        dest='output_path',
        help='Output path for the JSON file (default: same name as markdown with _chunks.json suffix)'
    )

    parser.add_argument(
        '--max-tokens',
        type=int,
        dest='max_tokens',
        default=512,
        help='Maximum number of tokens per chunk (default: 512)'
    )

    parser.add_argument(
        '--no-markdown-tables',
        action='store_true',
        dest='no_markdown_tables',
        help='Disable markdown table format (use triplets instead)'
    )

    parser.add_argument(
        '--index-json',
        type=str,
        dest='index_json_path',
        help='Path to processed.json for page number mapping'
    )

    # Parse arguments
    args = parser.parse_args()

    markdown_path = args.markdown_path
    output_path = args.output_path
    max_tokens = args.max_tokens
    use_markdown_tables = not args.no_markdown_tables
    index_json_path = args.index_json_path

    # Auto-detect index_validated.json if not provided
    if not index_json_path:
        # Try to find index_validated.json in the same directory as the markdown file
        markdown_dir = Path(markdown_path).parent
        potential_index = markdown_dir / 'processed.json'
        if potential_index.exists():
            index_json_path = str(potential_index)
            print(f"Auto-detected index file: {index_json_path}", file=sys.stderr)

    # Validate the file exists
    if not Path(markdown_path).exists():
        print(f"Error: File not found: {markdown_path}", file=sys.stderr)
        sys.exit(1)

    # Default: same name as markdown but with _chunks.json suffix
    if not output_path:
        markdown_file = Path(markdown_path)
        output_path = str(markdown_file.parent / f"chunks.json")
    else:
        # If output_path is a directory, append default filename
        output_path_obj = Path(output_path)
        if output_path_obj.is_dir():
            markdown_file = Path(markdown_path)
            output_path = str(output_path_obj / f"chunks.json")
        elif not output_path_obj.suffix:
            # If no extension provided, treat as directory
            output_path_obj.mkdir(exist_ok=True)
            markdown_file = Path(markdown_path)
            output_path = str(output_path_obj / f"chunks.json")

    try:
        # Chunk the markdown file
        print(f"Processing markdown: {markdown_path}", file=sys.stderr)
        print(f"Max tokens per chunk: {max_tokens}", file=sys.stderr)
        print(f"Use markdown tables: {use_markdown_tables}", file=sys.stderr)
        result = chunk_markdown_file(
            markdown_path,
            max_tokens=max_tokens,
            output_path=output_path,
            use_markdown_tables=use_markdown_tables,
            index_json_path=index_json_path
        )

        # Save to JSON file
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
            f.flush()

        print(f"\nSuccessfully saved {result['total_chunks']} chunks to: {output_path}", file=sys.stderr)

        # Print stats
        total_chars = sum(len(chunk['text']) for chunk in result['chunks'])
        avg_chars = total_chars / len(result['chunks']) if result['chunks'] else 0

        print(f"\nChunking stats:", file=sys.stderr)
        print(f"  Total chunks: {result['total_chunks']}", file=sys.stderr)
        print(f"  Total characters: {total_chars}", file=sys.stderr)
        print(f"  Average characters per chunk: {avg_chars:.0f}", file=sys.stderr)

        sys.stderr.flush()
        sys.stdout.flush()

        # Exit cleanly
        os._exit(0)

    except Exception as e:
        print(f"Error processing markdown: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        os._exit(1)


if __name__ == "__main__":
    main()
