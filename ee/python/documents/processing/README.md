# Document Processing Module

Python scripts for processing documents (PDF, DOCX, etc.) into structured formats.

## document_to_markdown.py

Converts documents to structured JSON with page-separated markdown content and extracted images.

### Features

- ✅ PDF, DOCX, PPTX, and other document formats
- ✅ Page-by-page content extraction
- ✅ Hierarchical heading structure
- ✅ Image extraction with high resolution
- ✅ Table preservation in markdown format
- ✅ Normalized whitespace handling

### Usage from TypeScript

```typescript
import { executePythonScript } from '../../../../src/utils/python-executor';
import { readFile } from 'fs/promises';
import { join } from 'path';

async function processDocument(documentPath: string, outputDir: string) {
  try {
    // Execute the document processor
    const result = await executePythonScript({
      scriptPath: 'ee/python/documents/processing/document_to_markdown.py',
      args: [
        documentPath,
        '-o', join(outputDir, 'processed.json'),
        '--images-dir', join(outputDir, 'images')
      ],
      timeout: 600000 // 10 minutes for large documents
    });

    if (!result.success) {
      throw new Error(`Processing failed: ${result.stderr}`);
    }

    // Read the processed JSON
    const processedData = JSON.parse(
      await readFile(join(outputDir, 'processed.json'), 'utf-8')
    );

    return processedData;
  } catch (error) {
    console.error('Document processing error:', error);
    throw error;
  }
}

// Example usage
const pages = await processDocument(
  '/path/to/document.pdf',
  '/output/directory'
);

// Access page content
pages.forEach((page, index) => {
  console.log(`Page ${page.page}:`);
  console.log(`Content: ${page.content.substring(0, 100)}...`);
  console.log(`Image: ${page.image || 'None'}`);
  console.log(`Headings:`, page.headings);
});
```

### Command-Line Usage

```bash
# Activate virtual environment
source ee/python/.venv/bin/activate

# Process a document
python ee/python/documents/processing/document_to_markdown.py \
  /path/to/document.pdf \
  -o /output/processed.json \
  --images-dir /output/images
```

### Output Format

The script outputs a JSON array with page objects:

```json
[
  {
    "page": 1,
    "content": "# Document Title\n\nFirst paragraph...",
    "image": "/output/images/page_1.png",
    "headings": {
      "Document Title": null
    }
  },
  {
    "page": 2,
    "content": "## Section 1\n\nMore content...",
    "image": "/output/images/page_2.png",
    "headings": {
      "Document Title": {
        "Section 1": null
      }
    }
  }
]
```

### Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `pdf_path` | Path to the document file | Yes |
| `-o, --output` | Output path for JSON file | No (default: `<document_name>/processed.json`) |
| `--images-dir` | Directory to save page images | No (default: `<output_dir>/images`) |

### Configuration

You can modify these constants in the script:

```python
IMAGE_RESOLUTION_SCALE = 2.0  # Image resolution multiplier
```

### Dependencies

This script requires the following Python packages (installed via `npm run python:setup`):

- `docling` - Document conversion
- `docling-hierarchical-pdf` - Hierarchical heading processing
- `transformers` - ML-based text processing
- `PIL` - Image handling

### Troubleshooting

**Issue: ImportError for docling**
```bash
npm run python:install
```

**Issue: Script timeout for large documents**
```typescript
// Increase timeout
const result = await executePythonScript({
  scriptPath: '...',
  timeout: 1200000 // 20 minutes
});
```

**Issue: Low-quality images**

Increase `IMAGE_RESOLUTION_SCALE` in the script:
```python
IMAGE_RESOLUTION_SCALE = 3.0  # Higher quality
```
