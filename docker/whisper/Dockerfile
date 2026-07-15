# Exulu Whisper transcription server — CUDA image.
#
# Runs `npx @exulu/backend exulu-start-whisper`, which supervises a Python
# FastAPI/uvicorn Whisper server (whisperx + pyannote diarization).
#
# Base: CUDA 12.4 runtime WITH cuDNN. torch is installed from the cu124 wheel
# and the faster-whisper backend (ctranslate2) needs cuDNN at runtime, so the
# "-cudnn-runtime" flavour is required (the plain runtime image would crash
# with a "libcudnn ... not found" error the first time a job runs).
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# Node MUST be exactly 22.18.0 — @exulu/backend's preinstall hook hard-fails on
# any other version. Bump only in lockstep with the package's engines field.
ARG NODE_VERSION=22.18.0
# Pin this for reproducible builds, e.g. --build-arg EXULU_VERSION=0.3.13
ARG EXULU_VERSION=latest
# CUDA wheel index for torch. cu124 matches the CUDA 12.4 base image.
ARG TORCH_CUDA_INDEX=https://download.pytorch.org/whl/cu124

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies:
#   python3 + venv + dev  → the package builds a Python venv (needs >= 3.10; 22.04 ships 3.10)
#   ffmpeg                → whisperx decodes all audio through ffmpeg (mandatory)
#   git                   → some pip deps build from git
#   curl / xz-utils       → fetch + unpack the Node tarball; curl also used by the healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev python3-pip \
      ffmpeg git curl ca-certificates xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Install Node from the official binary tarball (exact version, no distro drift).
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && node --version && npm --version

WORKDIR /app

# Install the package. SKIP_PYTHON_SETUP=1 defers the heavy Python venv build to
# the explicit step below — the package's postinstall has a 10-minute timeout
# that the multi-GB CUDA torch download can blow past on a fresh build.
RUN SKIP_PYTHON_SETUP=1 npm install "@exulu/backend@${EXULU_VERSION}"

ENV VENV=/app/node_modules/@exulu/backend/ee/python/.venv

# Build the Python venv (whisperx, pyannote.audio, fastapi, uvicorn, …).
# No GPU is visible during `docker build`, so setup.sh installs the CPU torch
# wheel here. We overwrite it with the CUDA build in the next step.
RUN bash /app/node_modules/@exulu/backend/ee/python/setup.sh

# Swap in the CUDA torch wheels, matching the exact versions requirements.txt
# pins (2.5.1). Without this the server runs on CPU even on a GPU host — the
# base image's GPU is only usable if torch itself is the CUDA build.
RUN "${VENV}/bin/pip" install --no-cache-dir \
      torch==2.5.1 torchaudio==2.5.1 torchvision==0.20.1 \
      --index-url "${TORCH_CUDA_INDEX}" \
 && "${VENV}/bin/python" -c "import torch; assert torch.version.cuda, 'torch is not a CUDA build'; print('torch', torch.__version__, 'cuda', torch.version.cuda)"

# Container-appropriate runtime defaults. WHISPER_HOST=0.0.0.0 is critical: the
# package default (127.0.0.1) would make the port unreachable from outside the
# container. Everything here can be overridden via the .env file / compose.
ENV WHISPER_HOST=0.0.0.0 \
    WHISPER_PORT=9876 \
    WHISPER_DEVICE=auto \
    WHISPER_MODEL=large-v3 \
    WHISPER_BATCH_SIZE=4

EXPOSE 9876

CMD ["npx", "@exulu/backend", "exulu-start-whisper"]
