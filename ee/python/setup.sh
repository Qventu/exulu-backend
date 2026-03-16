#!/bin/bash
# Python Environment Setup Script
# Sets up Python virtual environment and installs dependencies for @exulu/backend

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
VENV_DIR="${SCRIPT_DIR}/.venv"
REQUIREMENTS_FILE="${SCRIPT_DIR}/requirements.txt"

# Minimum Python version required
MIN_PYTHON_MAJOR=3
MIN_PYTHON_MINOR=10

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Exulu Python Environment Setup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Function to print colored messages
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}!${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Function to check Python version
check_python_version() {
    local python_cmd=$1

    if ! command -v "$python_cmd" &> /dev/null; then
        return 1
    fi

    # Get Python version
    local version=$($python_cmd --version 2>&1 | awk '{print $2}')
    local major=$(echo "$version" | cut -d. -f1)
    local minor=$(echo "$version" | cut -d. -f2)

    # Check if version meets requirements
    if [ "$major" -gt "$MIN_PYTHON_MAJOR" ] || \
       ([ "$major" -eq "$MIN_PYTHON_MAJOR" ] && [ "$minor" -ge "$MIN_PYTHON_MINOR" ]); then
        echo "$python_cmd"
        return 0
    fi

    return 1
}

# Step 1: Check for Python installation
echo "Step 1: Checking Python installation..."
PYTHON_CMD=""

# Try different Python commands
for cmd in python3.12 python3.11 python3.10 python3 python; do
    if PYTHON_CMD=$(check_python_version "$cmd"); then
        break
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    print_error "Python ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}+ is required but not found"
    echo ""
    echo "Please install Python ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR} or higher:"
    echo "  - macOS: brew install python@3.12"
    echo "  - Ubuntu/Debian: sudo apt-get install python3.12"
    echo "  - Windows: Download from https://www.python.org/downloads/"
    echo ""
    exit 1
fi

PYTHON_VERSION=$($PYTHON_CMD --version 2>&1 | awk '{print $2}')
print_success "Found Python $PYTHON_VERSION at $(which $PYTHON_CMD)"

# Step 2: Check for pip
echo ""
echo "Step 2: Checking pip installation..."
if ! $PYTHON_CMD -m pip --version &> /dev/null; then
    print_warning "pip is not installed, attempting to bootstrap..."

    # Try to use ensurepip to bootstrap pip
    if $PYTHON_CMD -m ensurepip --version &> /dev/null; then
        print_info "Using ensurepip to install pip..."
        $PYTHON_CMD -m ensurepip --default-pip || {
            print_error "Failed to bootstrap pip using ensurepip"
            echo ""
            echo "Please install pip manually:"
            echo "  Ubuntu/Debian: sudo apt-get install python3-pip"
            echo "  Alpine: apk add py3-pip"
            echo "  Or using get-pip.py:"
            echo "    curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py"
            echo "    $PYTHON_CMD get-pip.py"
            echo ""
            exit 1
        }
        print_success "pip bootstrapped successfully using ensurepip"
    else
        print_error "pip is not installed and ensurepip is not available"
        echo ""
        echo "Please install pip manually:"
        echo "  Ubuntu/Debian: sudo apt-get install python3-pip"
        echo "  Alpine: apk add py3-pip"
        echo "  Or using get-pip.py:"
        echo "    curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py"
        echo "    $PYTHON_CMD get-pip.py"
        echo ""
        exit 1
    fi
fi

PIP_VERSION=$($PYTHON_CMD -m pip --version | awk '{print $2}')
print_success "Found pip $PIP_VERSION"

# Step 3: Check for venv module
echo ""
echo "Step 3: Checking venv module..."
if ! $PYTHON_CMD -m venv --help &> /dev/null; then
    print_error "venv module is not available"
    echo ""
    echo "The venv module is required to create virtual environments."
    echo "Please install it:"
    echo "  Ubuntu/Debian: sudo apt-get install python3-venv"
    echo "  Alpine: apk add python3-dev"
    echo ""
    exit 1
fi
print_success "venv module is available"

# Step 4: Create or update virtual environment
echo ""
echo "Step 4: Setting up virtual environment..."
if [ -d "$VENV_DIR" ]; then
    # Check if virtual environment is valid
    if [ -f "$VENV_DIR/bin/activate" ] && [ -f "$VENV_DIR/bin/python" ]; then
        print_info "Virtual environment already exists at $VENV_DIR"
        print_info "Updating existing environment..."
    else
        print_warning "Virtual environment is corrupted, recreating..."
        rm -rf "$VENV_DIR"
        $PYTHON_CMD -m venv "$VENV_DIR" || {
            print_error "Failed to create virtual environment"
            echo ""
            echo "This usually means the venv module is not properly installed."
            echo "Try installing: sudo apt-get install python3-venv python3-dev"
            echo ""
            exit 1
        }
        print_success "Virtual environment created"
    fi
else
    print_info "Creating virtual environment at $VENV_DIR"
    $PYTHON_CMD -m venv "$VENV_DIR" || {
        print_error "Failed to create virtual environment"
        echo ""
        echo "This usually means the venv module is not properly installed."
        echo "Try installing: sudo apt-get install python3-venv python3-dev"
        echo ""
        exit 1
    }
    print_success "Virtual environment created"
fi

# Step 5: Activate virtual environment and upgrade pip
echo ""
echo "Step 5: Activating virtual environment..."
source "$VENV_DIR/bin/activate"
print_success "Virtual environment activated"

# Upgrade pip in virtual environment
print_info "Upgrading pip in virtual environment..."
pip install --upgrade pip > /dev/null 2>&1
print_success "pip upgraded to latest version"

# Step 6: Install dependencies
echo ""
echo "Step 6: Installing Python dependencies..."
if [ ! -f "$REQUIREMENTS_FILE" ]; then
    print_error "Requirements file not found: $REQUIREMENTS_FILE"
    exit 1
fi

print_info "Installing packages from requirements.txt..."
echo ""
pip install -r "$REQUIREMENTS_FILE"

print_success "All dependencies installed successfully"

# Step 7: Validate installation
echo ""
echo "Step 7: Validating installation..."

# Test critical imports
print_info "Testing critical imports..."
$PYTHON_CMD -c "import docling" 2>/dev/null && print_success "docling imported successfully" || print_error "Failed to import docling"
$PYTHON_CMD -c "import transformers" 2>/dev/null && print_success "transformers imported successfully" || print_error "Failed to import transformers"

# Step 8: Display summary
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
print_success "Python environment is ready to use"
echo ""
echo "Virtual environment location: $VENV_DIR"
echo "Python version: $PYTHON_VERSION"
echo ""
echo "To activate the virtual environment manually:"
echo "  source $VENV_DIR/bin/activate"
echo ""
echo "To use Python scripts from TypeScript:"
echo "  import { executePythonScript } from './utils/python-executor';"
echo ""
print_info "Your Python environment is now configured and ready!"
