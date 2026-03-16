# Exulu Python Integration

This directory contains Python scripts and utilities used by the Exulu backend. The integration is designed to be seamless for TypeScript developers, requiring minimal Python knowledge.

## Quick Start

### First-Time Setup

Run the setup command to configure your Python environment:

```bash
npm run python:setup
```

This will:
- ✅ Validate Python 3.10+ is installed
- ✅ Create a virtual environment at `ee/python/.venv`
- ✅ Install all required dependencies
- ✅ Verify the installation

**That's it!** You're ready to use Python scripts from TypeScript.

## Available npm Scripts

| Command | Description |
|---------|-------------|
| `npm run python:setup` | Initial setup - creates venv and installs dependencies |
| `npm run python:install` | Install/update Python dependencies |
| `npm run python:validate` | Verify Python environment is working |
| `npm run python:clean` | Clean Python cache and virtual environment |
| `npm run python:rebuild` | Clean and rebuild Python environment from scratch |

## Using Python Scripts from TypeScript

The `python-executor` utility provides a type-safe interface for calling Python scripts:

### Basic Example

```typescript
import { executePythonScript } from '../utils/python-executor';

// Execute a Python script
const result = await executePythonScript({
  scriptPath: 'ee/python/documents/processing/document_to_markdown.py',
  args: [
    '/path/to/document.pdf',
    '-o', '/output/processed.json',
    '--images-dir', '/output/images'
  ]
});

if (result.success) {
  console.log('Script executed successfully!');
  console.log('Output:', result.stdout);
} else {
  console.error('Script failed:', result.stderr);
}
```

### Simple Usage (throws on error)

```typescript
import { executePythonScriptSimple } from '../utils/python-executor';

// Get stdout directly, throws on error
const output = await executePythonScriptSimple({
  scriptPath: 'ee/python/my_script.py',
  args: ['arg1', 'arg2']
});

console.log('Output:', output);
```

### Advanced Configuration

```typescript
import { executePythonScript } from '../utils/python-executor';

const result = await executePythonScript({
  scriptPath: 'ee/python/my_script.py',
  args: ['--verbose'],
  cwd: process.cwd(),
  timeout: 600000, // 10 minutes
  env: {
    CUSTOM_VAR: 'value'
  },
  validateEnvironment: true // default
});
```

### Error Handling

```typescript
import {
  executePythonScript,
  PythonEnvironmentError,
  PythonExecutionError
} from '../utils/python-executor';

try {
  const result = await executePythonScript({
    scriptPath: 'ee/python/my_script.py'
  });

  // Handle success
  console.log(result.stdout);

} catch (error) {
  if (error instanceof PythonEnvironmentError) {
    // Python environment not set up
    console.error('Please run: npm run python:setup');
  } else if (error instanceof PythonExecutionError) {
    // Script execution failed
    console.error('Script error:', error.stderr);
    console.error('Exit code:', error.exitCode);
  }
}
```

### Check Environment Status

```typescript
import { isPythonEnvironmentReady } from '../utils/python-executor';

if (await isPythonEnvironmentReady()) {
  console.log('Python environment is ready!');
} else {
  console.log('Please run: npm run python:setup');
}
```

## Directory Structure

```
ee/python/
├── .venv/                    # Virtual environment (gitignored)
├── requirements.txt          # Python dependencies
├── setup.sh                  # Setup script
├── README.md                 # This file
└── documents/
    └── processing/
        ├── document_to_markdown.py
        └── ...
```

## Adding New Python Scripts

1. **Create your script** in an appropriate subdirectory under `ee/python/`

2. **Add dependencies** to `requirements.txt`:
   ```
   your-package==1.2.3
   ```

3. **Update dependencies**:
   ```bash
   npm run python:install
   ```

4. **Use from TypeScript**:
   ```typescript
   import { executePythonScript } from '../utils/python-executor';

   const result = await executePythonScript({
     scriptPath: 'ee/python/your-module/your-script.py',
     args: ['arg1', 'arg2']
   });
   ```

## Troubleshooting

### Python environment not found

```bash
npm run python:setup
```

### Dependencies not installing

```bash
npm run python:rebuild
```

### Script execution fails

1. **Validate environment**:
   ```bash
   npm run python:validate
   ```

2. **Check Python version**:
   ```bash
   source ee/python/.venv/bin/activate
   python --version  # Should be 3.10+
   ```

3. **Test manually**:
   ```bash
   source ee/python/.venv/bin/activate
   python ee/python/your-script.py --help
   ```

### Import errors in Python scripts

Make sure all required packages are in `requirements.txt` and run:
```bash
npm run python:install
```

## Requirements

- **Python**: 3.10 or higher
- **pip**: Latest version (auto-upgraded during setup)
- **Operating System**: macOS, Linux, or Windows with WSL

### Installing Python

**macOS:**
```bash
brew install python@3.12
```

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install python3.12 python3.12-venv python3-pip
```

**Windows:**
Download from [python.org](https://www.python.org/downloads/)

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Setup Python Environment
  run: npm run python:setup

- name: Validate Python Environment
  run: npm run python:validate

- name: Run Tests
  run: npm test
```

### Caching Virtual Environment

```yaml
- uses: actions/cache@v3
  with:
    path: ee/python/.venv
    key: ${{ runner.os }}-python-${{ hashFiles('ee/python/requirements.txt') }}
```

## Best Practices

1. **Always use the TypeScript wrapper** - Don't call Python directly with `exec()`
2. **Pin dependency versions** in `requirements.txt` for reproducibility
3. **Handle errors gracefully** - Use try/catch with specific error types
4. **Set appropriate timeouts** - Long-running scripts should have higher timeouts
5. **Log errors properly** - Both stdout and stderr should be logged
6. **Test environment setup** - Run `npm run python:validate` in CI

## Available Python Modules

### Document Processing

**Script:** `documents/processing/document_to_markdown.py`

Converts documents (PDF, DOCX, etc.) to structured JSON with markdown content.

**Usage:**
```typescript
import { executePythonScript } from '../utils/python-executor';

const result = await executePythonScript({
  scriptPath: 'ee/python/documents/processing/document_to_markdown.py',
  args: [
    '/path/to/document.pdf',
    '-o', '/output/processed.json',
    '--images-dir', '/output/images'
  ]
});

const pages = JSON.parse(result.stdout);
```

## Support

For issues or questions:
1. Check this README
2. Run `npm run python:validate`
3. Check the [troubleshooting](#troubleshooting) section
4. Open an issue with logs from `npm run python:validate`
