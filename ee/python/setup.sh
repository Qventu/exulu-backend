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

# Conditional torch wheel for the whisper transcription server.
# WhisperX depends on torch transitively; by default pip would install the
# CPU build, which works everywhere but is slow. On CUDA hosts we want the
# CUDA build instead. Selection rule:
#   - WHISPER_GPU=cuda explicit OR `nvidia-smi` present → install CUDA wheel
#   - WHISPER_GPU=cpu/mps/skip OR no GPU detected         → fall through to default
WHISPER_GPU_MODE="${WHISPER_GPU:-auto}"
if [ "$WHISPER_GPU_MODE" = "auto" ]; then
    if command -v nvidia-smi &> /dev/null; then
        WHISPER_GPU_MODE="cuda"
    elif [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
        WHISPER_GPU_MODE="mps"
    else
        WHISPER_GPU_MODE="cpu"
    fi
fi

case "$WHISPER_GPU_MODE" in
    cuda)
        print_info "Installing CUDA torch wheel (WHISPER_GPU=$WHISPER_GPU_MODE)…"
        pip install torch==2.5.0 torchaudio==2.5.0 \
            --index-url https://download.pytorch.org/whl/cu124 || {
            print_warning "CUDA torch install failed; falling back to default torch."
        }
        ;;
    mps|cpu)
        print_info "Installing default torch wheel (WHISPER_GPU=$WHISPER_GPU_MODE)…"
        ;;
    skip)
        print_warning "WHISPER_GPU=skip — torch install skipped; transcription server will not work."
        ;;
    *)
        print_warning "Unknown WHISPER_GPU=$WHISPER_GPU_MODE — falling back to default torch."
        ;;
esac

pip install -r "$REQUIREMENTS_FILE"

print_success "All dependencies installed successfully"

# Step 6.5: Generate Prisma client for LiteLLM database mode.
# LiteLLM's PrismaClient does `from prisma import Prisma`, which only works
# after `prisma generate` has materialized the Python client against
# LiteLLM's bundled schema. Skip silently if LiteLLM isn't installed or its
# schema isn't where we expect — database mode is opt-in via config.litellm.yaml.
LITELLM_PROXY_DIR=$(find "$VENV_DIR/lib" -path "*/litellm/proxy" -type d 2>/dev/null | head -1)
if [ -n "$LITELLM_PROXY_DIR" ] && [ -f "$LITELLM_PROXY_DIR/schema.prisma" ]; then
    print_info "Generating Prisma client for LiteLLM..."
    (cd "$LITELLM_PROXY_DIR" && PATH="$VENV_DIR/bin:$PATH" "$VENV_DIR/bin/prisma" generate > /dev/null 2>&1) \
        && print_success "Prisma client generated for LiteLLM" \
        || print_warning "Prisma generate failed; LiteLLM database mode (database_url in config.litellm.yaml) may not work until you run 'cd $LITELLM_PROXY_DIR && PATH=$VENV_DIR/bin:\$PATH $VENV_DIR/bin/prisma generate'"
fi

# Step 6.6: Install the Hermes Agent harness (advanced agent mode).
# Opt-in via ENABLE_HERMES_AGENT=true. Hermes is NOT a pip package — it ships
# as a standalone binary via Nous Research's official installer (lands in
# ~/.local/bin/hermes). We only install if it's not already present so re-runs
# are fast, and we never fail the whole setup if the install fails (advanced
# mode is optional; the operator can install it manually and retry).
if [ "${ENABLE_HERMES_AGENT}" = "true" ]; then
    echo ""
    echo "Step 6.6: Installing Hermes Agent harness (ENABLE_HERMES_AGENT=true)..."
    if command -v hermes &> /dev/null || [ -x "$HOME/.local/bin/hermes" ]; then
        HERMES_VERSION=$( (command -v hermes &> /dev/null && hermes --version 2>/dev/null) || "$HOME/.local/bin/hermes" --version 2>/dev/null || echo "unknown")
        print_success "Hermes already installed ($HERMES_VERSION) — skipping installer"
    else
        print_info "Running Hermes official installer..."
        if curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash; then
            print_success "Hermes Agent installed (binary at ~/.local/bin/hermes)"
        else
            print_warning "Hermes installer failed. Advanced agent mode will be unavailable until 'hermes' is on PATH. Install manually: https://hermes-agent.nousresearch.com/docs/getting-started/installation"
        fi
    fi
fi

# Step 7: Validate installation
echo ""
echo "Step 7: Validating installation..."

# Test critical imports
print_info "Testing critical imports..."
$PYTHON_CMD -c "import docling" 2>/dev/null && print_success "docling imported successfully" || print_error "Failed to import docling"
$PYTHON_CMD -c "import transformers" 2>/dev/null && print_success "transformers imported successfully" || print_error "Failed to import transformers"

# Whisper transcription server imports — non-fatal: only needed for
# `npx @exulu/backend exulu-start-whisper`. If these fail, the rest of
# the @exulu/backend package still works fine.
$PYTHON_CMD -c "import whisperx" 2>/dev/null && print_success "whisperx imported successfully" || print_warning "whisperx not importable (transcription server will not start)"
$PYTHON_CMD -c "import pyannote.audio" 2>/dev/null && print_success "pyannote.audio imported successfully" || print_warning "pyannote.audio not importable (diarization will be disabled even with HF_AUTH_TOKEN)"
$PYTHON_CMD -c "import fastapi, uvicorn" 2>/dev/null && print_success "fastapi/uvicorn imported successfully" || print_warning "fastapi/uvicorn not importable (transcription server will not start)"

# Hermes Agent binary check (advanced agent mode) — only when opted in.
if [ "${ENABLE_HERMES_AGENT}" = "true" ]; then
    if command -v hermes &> /dev/null || [ -x "$HOME/.local/bin/hermes" ]; then
        print_success "hermes binary available (advanced agent mode ready)"
    else
        print_warning "hermes binary not found (advanced agent mode will be unavailable)"
    fi
fi

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
