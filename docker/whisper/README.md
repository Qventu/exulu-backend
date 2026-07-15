# Exulu Whisper transcription server (Docker, CUDA)

Runs `npx @exulu/backend exulu-start-whisper` in a container: a Whisper speech
-to-text server (whisperx) with optional speaker diarization (pyannote),
GPU-accelerated via CUDA.

The container supervises a Python FastAPI server and exposes a small HTTP job
API on port **9876**.

---

## Prerequisites (on the host)

1. **NVIDIA GPU + driver.** Verify with `nvidia-smi`.
2. **Docker** with the **NVIDIA Container Toolkit** installed, so containers can
   see the GPU. Quick check:
   ```bash
   docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
   ```
   If that prints your GPU, you're set. Install guide:
   https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
3. **Docker Compose v2** (`docker compose version`).

The host driver must support CUDA 12.4 (driver >= 550). Older drivers: tell us
and we'll rebase the image on a matching CUDA tag.

---

## Setup

```bash
cp .env.example .env
# then edit .env — at minimum set HF_AUTH_TOKEN if you want diarization
```

For diarization, also accept the two pyannote licenses once (see `.env.example`),
otherwise every segment comes back as `speaker="unknown"`.

---

## Build & run

Build the image first, then start it. Building explicitly avoids Compose ever
trying to *pull* the (local-only) image from a registry:

```bash
docker compose build              # build the image locally (one-off, ~10-20 min)
docker compose up -d              # start in the background
docker compose logs -f            # watch startup
```

(`docker compose up --build -d` does both in one command on recent Compose
versions.)

**First start downloads the ~3 GB model** into your host HuggingFace cache
(`~/.cache/huggingface` by default), so it can take a while. The container is
marked healthy only once the model has loaded — watch for `[EXULU-WHISPER]
Ready.` in the logs. Subsequent starts are fast because the model is cached.

Check health:
```bash
curl http://localhost:9876/healthz
# {"ok":true,"device":"cuda","model":"large-v3","gpu":{...},"diarization":true}
```

`diarization: true` confirms the HF token + licenses are working.

Stop / restart:
```bash
docker compose down               # stop and remove the container
docker compose restart            # restart (model stays cached)
```

---

## Using the API

The server fetches audio from a URL you give it and processes it as an async job.

```bash
# Submit a job
curl -X POST http://localhost:9876/jobs \
  -H 'Content-Type: application/json' \
  -d '{"audio_url": "https://example.com/audio.mp3", "language": "de"}'
# → {"job_id":"...","status":"queued"}

# Poll for the result
curl http://localhost:9876/jobs/<job_id>
```

`POST /jobs` body fields: `audio_url` (required), `language`, `num_speakers`,
`hotwords` (array of strings). Other endpoints: `GET /jobs`, `GET /jobs/{id}`,
`DELETE /jobs/{id}`, `GET /healthz`.

To point the main Exulu app at this server, set `TRANSCRIPTION_SERVER` on the
app to `http://<this-host>:9876`.

---

## Configuration

All settings live in `.env` (see `.env.example` for the annotated list):

| Variable            | Default                    | Purpose                                    |
| ------------------- | -------------------------- | ------------------------------------------ |
| `HF_AUTH_TOKEN`     | –                          | HuggingFace token; enables diarization     |
| `WHISPER_MODEL`     | `large-v3`                 | Model id (`medium`/`small`/`base` = faster)|
| `WHISPER_DEVICE`    | `auto`                     | `auto` \| `cuda` \| `cpu`                   |
| `WHISPER_BATCH_SIZE`| `4`                        | Inference batch size                       |
| `WHISPER_PORT`      | `9876`                     | Published host port                        |
| `HF_CACHE_DIR`      | `~/.cache/huggingface`     | Host path bind-mounted for the model cache |
| `EXULU_VERSION`     | `latest`                   | Pin the `@exulu/backend` version           |

---

## Troubleshooting

- **`pull access denied for exulu-whisper ... repository does not exist`** — the
  image hasn't been built yet and Compose tried to pull it from a registry. Run
  `docker compose build` first (see above). On older Compose that ignores
  `pull_policy`, always use `docker compose up --build -d`.
- **`libcudnn... not found` / crashes on the first job** — the host driver is too
  old for CUDA 12.4, or the NVIDIA Container Toolkit isn't installed. Confirm the
  `docker run --gpus all ... nvidia-smi` check above works.
- **`healthz` shows `"device":"cpu"` on a GPU host** — the container can't see the
  GPU. Ensure the toolkit is installed and the `deploy.resources` block wasn't
  removed from `docker-compose.yml`.
- **`diarization: false`** — the HF token is missing/invalid, or you haven't
  accepted BOTH pyannote licenses. The logs print the exact URLs to accept.
- **Model re-downloads every start** — the cache mount isn't landing on the right
  host folder. Set `HF_CACHE_DIR` to an absolute path in `.env`. Note: running
  compose under `sudo` makes `$HOME` root's home — set `HF_CACHE_DIR` explicitly
  in that case.
- **Very slow transcription** — confirm it's on the GPU (`healthz` → `"device":
  "cuda"`); on CPU, `large-v3` is roughly real-time or worse. Try a smaller
  `WHISPER_MODEL`.
- **Build fails downloading Node** — the build needs internet access; behind a
  proxy, pass `--build-arg`/Docker proxy settings as usual.
