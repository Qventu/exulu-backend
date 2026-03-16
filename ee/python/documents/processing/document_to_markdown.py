#!/usr/bin/env python3
"""
Document to Markdown Converter using Docling
Converts a document to JSON with page-separated markdown and images.

Usage:
    document_to_markdown.py <document_file_path> [-o OUTPUT_PATH] [--images-dir IMAGES_DIR]
"""

import sys
import os
import warnings
import argparse
import json
from pathlib import Path
from PIL import Image

# Suppress warnings
warnings.filterwarnings('ignore')
os.environ['PYTHONWARNINGS'] = 'ignore'

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from hierarchical.postprocessor import ResultPostprocessor

IMAGE_RESOLUTION_SCALE = 2.0

def normalize_markdown_content(content: str) -> str:
    """
    Normalize markdown content by removing excessive whitespace,
    especially in table formatting.

    Args:
        content: Raw markdown content

    Returns:
        Normalized markdown content
    """
    import re

    lines = content.split('\n')
    normalized_lines = []

    for line in lines:
        # Check if this is a table row (contains |)
        if '|' in line:
            # Split by | and strip whitespace from each cell
            parts = line.split('|')
            cleaned_parts = [part.strip() for part in parts]
            # Rejoin with single space padding
            normalized_line = ' | '.join(cleaned_parts)
            normalized_lines.append(normalized_line)
        else:
            # For non-table lines, just strip trailing whitespace
            normalized_lines.append(line.rstrip())

    return '\n'.join(normalized_lines)


def extract_headings_from_markdown(markdown_content: str) -> list:
    """
    Extract all headings from markdown content as a list of (level, text) tuples.

    Args:
        markdown_content: Markdown text content

    Returns:
        List of (level, text) tuples in order of appearance
    """
    import re

    headings = []
    lines = markdown_content.split('\n')

    for line in lines:
        # Match markdown headings (# Header)
        heading_match = re.match(r'^(#{1,6})\s+(.+)$', line.strip())
        if heading_match:
            level = len(heading_match.group(1))  # Number of # symbols
            text = heading_match.group(2).strip()
            headings.append((level, text))

    return headings


def build_hierarchy_from_stack(heading_stack: list) -> dict:
    """
    Build a nested hierarchy dictionary from a heading stack.

    Args:
        heading_stack: List of (level, text) tuples representing the current path

    Returns:
        Nested dictionary representing the hierarchy
    """
    hierarchy = {}
    current = hierarchy

    for i, (level, heading_text) in enumerate(heading_stack):
        if i == len(heading_stack) - 1:
            # Last item in stack - set to null
            current[heading_text] = None
        else:
            # Not last item - create dict for children
            if heading_text not in current:
                current[heading_text] = {}
            current = current[heading_text]

    return hierarchy


def merge_hierarchies(h1: dict, h2: dict) -> dict:
    """
    Deep merge two hierarchy dictionaries, combining their structures.
    """
    if not h1:
        return h2.copy() if h2 else {}
    if not h2:
        return h1.copy()

    result = {}
    all_keys = set(h1.keys()) | set(h2.keys())

    for key in all_keys:
        if key in h1 and key in h2:
            # Both have this key
            if isinstance(h1[key], dict) and isinstance(h2[key], dict):
                result[key] = merge_hierarchies(h1[key], h2[key])
            elif h2[key] is not None:
                result[key] = h2[key]
            else:
                result[key] = h1[key]
        elif key in h1:
            result[key] = h1[key]
        else:
            result[key] = h2[key]

    return result


def parse_heading_hierarchy(markdown_content: str) -> dict:
    """
    Parse markdown content and build a nested heading hierarchy.
    Headings at the same level are siblings in the hierarchy.

    Args:
        markdown_content: Markdown text content

    Returns:
        Nested dictionary representing heading hierarchy
    """
    import re

    lines = markdown_content.split('\n')
    heading_stack = []  # Stack of (level, text) tuples
    hierarchy = {}

    for line in lines:
        # Match markdown headings (# Header)
        heading_match = re.match(r'^(#{1,6})\s+(.+)$', line.strip())
        if heading_match:
            level = len(heading_match.group(1))  # Number of # symbols
            text = heading_match.group(2).strip()

            # Pop headings from stack that are deeper than current level
            # (removes children when moving back up the hierarchy)
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()

            # Add this heading to stack
            heading_stack.append((level, text))

            # Build nested structure for current heading path
            current = hierarchy
            for i, (lvl, heading_text) in enumerate(heading_stack):
                if heading_text not in current:
                    # If this is the last heading in the stack, set to null
                    # Otherwise, set to empty dict for children
                    if i == len(heading_stack) - 1:
                        current[heading_text] = None
                    else:
                        current[heading_text] = {}

                # Navigate to the next level if not at the end
                if i < len(heading_stack) - 1:
                    if current[heading_text] is None:
                        current[heading_text] = {}
                    current = current[heading_text]

    return hierarchy


def process_pdf_to_json(pdf_path: str, output_path: str = None, images_dir: str = None) -> list:
    """
    Process a PDF file using Docling and return JSON with page-separated markdown and images.

    Args:
        pdf_path: Path to the PDF file
        output_path: Optional output path for JSON file
        images_dir: Directory to save page images (should be passed from main)

    Returns:
        List of page objects with content and image references
    """
    # Configure PDF pipeline with image generation
    pipeline_options = PdfPipelineOptions()
    pipeline_options.images_scale = IMAGE_RESOLUTION_SCALE
    pipeline_options.generate_page_images = True  # Generate page images

    # Convert the PDF document
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
        }
    )
    result = converter.convert(source=pdf_path)

    # Apply hierarchical post-processing to fix heading hierarchy
    print(f"Applying hierarchical post-processing...", file=sys.stderr)
    ResultPostprocessor(result, source=pdf_path).process()

    doc = result.document

    # Export full markdown with page markers
    full_markdown = doc.export_to_markdown(page_break_placeholder="<!-- END_OF_PAGE -->")

    # Split by page markers
    pages = full_markdown.split("<!-- END_OF_PAGE -->")

    # Ensure images_dir is a Path object
    images_dir = Path(images_dir)
    images_dir.mkdir(exist_ok=True)

    # Extract and save page images from the conversion result
    page_images = {}

    # Check if page images are in the result object
    if hasattr(result, 'pages') and result.pages:
        # Create images directory if it doesn't exist
        images_dir.mkdir(exist_ok=True)

        for page_data in result.pages:
            # Get page number
            page_no = getattr(page_data, 'page_no', None) or getattr(page_data, 'page_number', None)

            # Check for image attribute
            if hasattr(page_data, 'image') and page_data.image:
                # Save the PIL image to disk
                image_filename = f"page_{page_no}.png"
                image_path = images_dir / image_filename

                # Save the image
                if isinstance(page_data.image, Image.Image):
                    page_data.image.save(str(image_path), 'PNG')
                    page_images[page_no] = str(image_path)
                    print(f"Saved page {page_no} image to: {image_path}", file=sys.stderr)

    # Build page objects with cumulative heading hierarchy
    page_objects = []
    cumulative_markdown = ""  # Track all markdown up to and including current page
    heading_stack = []  # Current heading context (stack of (level, text) tuples)

    # Build JSON structure with page-separated content
    for page_num, page_content in enumerate(pages, start=1):
        # Skip empty pages
        if not page_content.strip():
            continue

        # Add current page to cumulative markdown
        cumulative_markdown += page_content + "\n"

        # Extract headings from current page only
        page_headings = extract_headings_from_markdown(page_content)

        # Track all heading contexts that appear on this page
        page_hierarchy = {}

        # If no headings on this page, use the current stack context
        if not page_headings:
            if heading_stack:
                page_hierarchy = build_hierarchy_from_stack(heading_stack)
        else:
            # Process each heading on the current page
            for level, text in page_headings:
                # Pop headings from stack that are at same or deeper level
                while heading_stack and heading_stack[-1][0] >= level:
                    heading_stack.pop()

                # Add this heading to stack
                heading_stack.append((level, text))

                # Build hierarchy for this context and merge it
                context_hierarchy = build_hierarchy_from_stack(heading_stack)
                page_hierarchy = merge_hierarchies(page_hierarchy, context_hierarchy)

        # Get image path if available
        page_image_path = page_images.get(page_num)

        # Normalize the content to remove excessive whitespace
        normalized_content = normalize_markdown_content(page_content.strip())

        page_objects.append({
            "page": page_num,
            "content": normalized_content,
            "image": page_image_path,
            "headings": page_hierarchy
        })

    # Save to JSON file if output path provided
    if output_path:
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(page_objects, f, indent=2, ensure_ascii=False)
            f.flush()
        print(f"Successfully saved JSON to: {output_path}", file=sys.stderr)
        print(f"Images saved to: {images_dir}", file=sys.stderr)

    return page_objects


def main():
    """Main entry point for the script."""
    # Set up argument parser
    parser = argparse.ArgumentParser(
        description='Convert PDF to Markdown using Docling with hierarchical headings and page markers',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        'pdf_path',
        type=str,
        help='Path to the PDF file to convert'
    )

    parser.add_argument(
        '-o', '--output',
        type=str,
        dest='output_path',
        help='Output path for the JSON file (default: same name as PDF with .json extension)'
    )

    parser.add_argument(
        '--images-dir',
        type=str,
        dest='images_dir',
        help='Directory to save page images (default: <pdf_name>_images/)'
    )

    # Parse arguments
    args = parser.parse_args()

    pdf_path = args.pdf_path
    output_path = args.output_path
    images_dir = args.images_dir

    # Validate the file exists
    if not Path(pdf_path).exists():
        print(f"Error: File not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    # Create a shared folder named after the source file
    pdf_file = Path(pdf_path)
    shared_folder = pdf_file.parent / pdf_file.stem
    shared_folder.mkdir(exist_ok=True)

    # Default: JSON file inside the shared folder
    if not output_path:
        output_path = str(shared_folder / "processed.json")
    else:
        # If output_path is a directory, append docling.json
        output_path_obj = Path(output_path)
        if output_path_obj.is_dir():
            output_path = str(output_path_obj / "processed.json")
        elif not output_path_obj.suffix:
            # If no extension provided, treat as directory
            output_path_obj.mkdir(exist_ok=True)
            output_path = str(output_path_obj / "processed.json")

    # Default: images directory inside the shared folder
    if not images_dir:
        # If output_path was provided and is in a custom location, use that location's parent
        output_parent = Path(output_path).parent
        images_dir = str(output_parent / "images")

    try:
        # Process the PDF
        print(f"Processing PDF: {pdf_path}", file=sys.stderr)
        page_objects = process_pdf_to_json(pdf_path, output_path, images_dir)

        # Print stats
        total_content_length = sum(len(page['content']) for page in page_objects)
        images_with_content = sum(1 for page in page_objects if page.get('image'))

        print(f"\nJSON output stats:", file=sys.stderr)
        print(f"  Total pages: {len(page_objects)}", file=sys.stderr)
        print(f"  Pages with images: {images_with_content}", file=sys.stderr)
        print(f"  Total content characters: {total_content_length}", file=sys.stderr)

        # Exit cleanly
        sys.stderr.flush()
        sys.stdout.flush()
        os._exit(0)

    except Exception as e:
        print(f"Error processing PDF: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        os._exit(1)


if __name__ == "__main__":
    main()
