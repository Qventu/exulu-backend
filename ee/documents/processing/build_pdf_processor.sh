#!/bin/bash
# Build script for pdf_processor executable

set -e

echo "Building pdf_processor executable with PyInstaller..."
echo ""

# Check if PyInstaller is installed
if ! command -v pyinstaller &> /dev/null; then
    echo "PyInstaller not found. Installing dependencies..."
    pip install -r requirements.txt
fi

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf build dist

# Build the executable
echo "Building executable..."
pyinstaller pdf_processor.spec

# Check if build was successful
if [ -f "dist/pdf_processor" ]; then
    echo ""
    echo "✓ Build successful!"
    echo "Executable created at: document-processing/dist/pdf_processor"
    echo ""
    echo "You can now use it in your TypeScript code:"
    echo "  const { stdout, stderr } = await execAsync(\`./document-processing/dist/pdf_processor \${pdf}\`);"
else
    echo ""
    echo "✗ Build failed!"
    exit 1
fi
