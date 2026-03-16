# Python Integration Guide for @exulu/backend

This guide explains how to use Python-powered features in the `@exulu/backend` package.

## Overview

Some features in `@exulu/backend` use Python scripts for advanced document processing and other capabilities. The package handles Python setup automatically, but you can also manage it manually if needed.

## Automatic Setup (Recommended)

When you install `@exulu/backend`, the Python environment is automatically configured:

```bash
npm install @exulu/backend
```

The postinstall script will:
- ✅ Check if Python 3.10+ is installed
- ✅ Create a virtual environment
- ✅ Install all required dependencies
- ✅ Validate the installation

### Skipping Automatic Setup

If you want to skip automatic setup (e.g., in CI environments), set the environment variable:

```bash
SKIP_PYTHON_SETUP=1 npm install @exulu/backend
```

## Manual Setup

### Option 1: Using TypeScript API

```typescript
import { setupPythonEnvironment } from '@exulu/backend';

// Basic setup
const result = await setupPythonEnvironment();

if (result.success) {
  console.log('✓ Python environment ready!');
  console.log('Python version:', result.pythonVersion);
} else {
  console.error('Setup failed:', result.message);
}
```

### Option 2: Force Rebuild

```typescript
import { setupPythonEnvironment } from '@exulu/backend';

// Force rebuild even if environment exists
const result = await setupPythonEnvironment({
  force: true,
  verbose: true
});
```

### Option 3: Check Status

```typescript
import { isPythonEnvironmentSetup } from '@exulu/backend';

if (isPythonEnvironmentSetup()) {
  console.log('Python environment is ready!');
} else {
  console.log('Please run setup first');
}
```

## Using Python Scripts

### Execute Python Scripts from TypeScript

```typescript
import { executePythonScript } from '@exulu/backend';

// Execute a Python script
const result = await executePythonScript({
  scriptPath: 'ee/python/documents/processing/document_to_markdown.py',
  args: [
    '/path/to/document.pdf',
    '-o', '/output/processed.json',
    '--images-dir', '/output/images'
  ],
  timeout: 600000 // 10 minutes
});

if (result.success) {
  console.log('Output:', result.stdout);
} else {
  console.error('Error:', result.stderr);
}
```

### Simple Execution (throws on error)

```typescript
import { executePythonScriptSimple } from '@exulu/backend';

try {
  const output = await executePythonScriptSimple({
    scriptPath: 'ee/python/my_script.py',
    args: ['--verbose']
  });

  console.log('Success:', output);
} catch (error) {
  console.error('Failed:', error);
}
```

### Error Handling

```typescript
import {
  executePythonScript,
  PythonEnvironmentError,
  PythonExecutionError
} from '@exulu/backend';

try {
  const result = await executePythonScript({
    scriptPath: 'ee/python/my_script.py'
  });

} catch (error) {
  if (error instanceof PythonEnvironmentError) {
    // Python environment not set up
    console.error('Please run: await setupPythonEnvironment()');
  } else if (error instanceof PythonExecutionError) {
    // Script execution failed
    console.error('Script error:', error.stderr);
    console.error('Exit code:', error.exitCode);
  }
}
```

## Requirements

### System Requirements

- **Python**: 3.10 or higher
- **pip**: Latest version (auto-upgraded during setup)
- **Disk Space**: ~500MB for Python packages

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

## Validation

Check if your Python environment is properly configured:

```typescript
import { validatePythonEnvironment } from '@exulu/backend';

const validation = await validatePythonEnvironment();

if (validation.valid) {
  console.log('✓ Environment is valid');
} else {
  console.error('✗ Environment issue:', validation.message);
}
```

## Troubleshooting

### Issue: "Python environment not found"

**Solution:**
```typescript
import { setupPythonEnvironment } from '@exulu/backend';
await setupPythonEnvironment();
```

### Issue: "Python version too old"

**Solution:**
Install Python 3.10 or higher:
```bash
# macOS
brew install python@3.12

# Ubuntu/Debian
sudo apt-get install python3.12
```

Then rebuild the environment:
```typescript
import { setupPythonEnvironment } from '@exulu/backend';
await setupPythonEnvironment({ force: true });
```

### Issue: Script execution timeout

**Solution:**
Increase the timeout for long-running scripts:
```typescript
const result = await executePythonScript({
  scriptPath: 'ee/python/my_script.py',
  timeout: 1200000 // 20 minutes
});
```

### Issue: Import errors in Python

**Solution:**
Rebuild the Python environment:
```typescript
import { setupPythonEnvironment } from '@exulu/backend';
await setupPythonEnvironment({ force: true });
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '22'

      - name: Setup Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: npm install
        env:
          # Python setup will run automatically during npm install
          SETUP_PYTHON_IN_CI: 1

      - name: Run tests
        run: npm test
```

### Caching Python Environment

```yaml
- name: Cache Python venv
  uses: actions/cache@v3
  with:
    path: node_modules/@exulu/backend/ee/python/.venv
    key: ${{ runner.os }}-python-${{ hashFiles('**/requirements.txt') }}
```

## Advanced Configuration

### Custom Working Directory

```typescript
import { setupPythonEnvironment } from '@exulu/backend';

const result = await setupPythonEnvironment({
  cwd: '/custom/path/to/package',
  verbose: true
});
```

### Environment Variables

```typescript
import { executePythonScript } from '@exulu/backend';

const result = await executePythonScript({
  scriptPath: 'ee/python/my_script.py',
  env: {
    CUSTOM_API_KEY: 'your-key-here',
    DEBUG: 'true'
  }
});
```

## Available Python Modules

### Document Processing

Convert documents to structured markdown with metadata:

```typescript
import { executePythonScript } from '@exulu/backend';
import { readFile } from 'fs/promises';

const result = await executePythonScript({
  scriptPath: 'ee/python/documents/processing/document_to_markdown.py',
  args: [
    '/path/to/document.pdf',
    '-o', '/output/result.json',
    '--images-dir', '/output/images'
  ]
});

const pages = JSON.parse(result.stdout);

// Access processed data
pages.forEach(page => {
  console.log(`Page ${page.page}:`, page.content);
  console.log('Headings:', page.headings);
  console.log('Image:', page.image);
});
```

## Best Practices

1. **Always handle errors** - Use try/catch with specific error types
2. **Set appropriate timeouts** - Long-running scripts need higher timeouts
3. **Validate environment** - Check setup before running critical operations
4. **Cache in CI** - Cache the virtual environment for faster builds
5. **Log outputs** - Both stdout and stderr should be logged for debugging

## Support

For issues or questions:
1. Check this documentation
2. Validate your environment: `await validatePythonEnvironment()`
3. Try rebuilding: `await setupPythonEnvironment({ force: true })`
4. Open an issue on GitHub with logs

## API Reference

### setupPythonEnvironment(options?)

Set up the Python virtual environment.

**Parameters:**
- `options.cwd` - Working directory (default: `process.cwd()`)
- `options.force` - Force rebuild (default: `false`)
- `options.verbose` - Show detailed output (default: `false`)
- `options.timeout` - Setup timeout in ms (default: `600000`)

**Returns:** `Promise<PythonSetupResult>`

### executePythonScript(config)

Execute a Python script with the virtual environment.

**Parameters:**
- `config.scriptPath` - Path to Python script (required)
- `config.args` - Command-line arguments
- `config.cwd` - Working directory
- `config.timeout` - Execution timeout in ms (default: `300000`)
- `config.env` - Environment variables
- `config.validateEnvironment` - Validate before execution (default: `true`)

**Returns:** `Promise<PythonScriptResult>`

### isPythonEnvironmentSetup(cwd?)

Check if Python environment exists.

**Returns:** `boolean`

### validatePythonEnvironment(cwd?)

Validate Python environment and get status.

**Returns:** `Promise<{ valid: boolean, message: string }>`
