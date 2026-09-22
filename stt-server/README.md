# earheart-stt

Local, private speech-to-text server built on **NVIDIA Parakeet TDT** (via
[onnx-asr](https://github.com/istupakov/onnx-asr) and ONNX Runtime), exposing
the OpenAI-compatible transcription API:

```
POST /v1/audio/transcriptions   (multipart: file, model, language, response_format)
GET  /v1/models
GET  /health
```

Because it speaks the standard API, it works with the Earheart desktop app —
and with any other client that supports a custom OpenAI-compatible
transcription endpoint (OpenWhispr, scripts using the OpenAI SDK, `curl`, …).

No audio ever leaves your machine.

## Quick start

From a checkout of this repo (with [uv](https://docs.astral.sh/uv/), recommended):

```bash
cd stt-server && uv run earheart-stt
```

Or without cloning, via uv's VCS support:

```bash
uvx --from "git+https://github.com/cleanunicorn/earheart#subdirectory=stt-server" earheart-stt
```

Or with pip:

```bash
pip install ./stt-server
earheart-stt
```

The first run downloads the model from Hugging Face (≈ 2.4 GB full precision,
≈ 660 MB with `--quantization int8`), then serves on
`http://127.0.0.1:8484/v1`.

Test it:

```bash
curl -s http://127.0.0.1:8484/v1/audio/transcriptions \
  -F file=@speech.wav -F response_format=json
```

Audio uploads are limited to 64 MiB (encoded). Decoded audio is capped at
256 MiB — about 70 minutes of 16 kHz mono — and rejected with `413` before it
is decoded.

## Options

| Flag | Env var | Default | Notes |
| --- | --- | --- | --- |
| `--host` | `EARHEART_STT_HOST` | `127.0.0.1` | Local-only by default |
| `--port` | `EARHEART_STT_PORT` | `8484` | |
| `--model` | `EARHEART_STT_MODEL` | `nemo-parakeet-tdt-0.6b-v3` | Multilingual (25 European languages) |
| `--quantization` | `EARHEART_STT_QUANTIZATION` | full precision | `int8` is smaller and faster on CPU |
| `--provider` | `EARHEART_STT_PROVIDER` | `cpu` | `cuda`, `tensorrt`, `coreml`, `directml` |
| `--cache-dir` | `EARHEART_STT_CACHE_DIR` | HF cache | Hugging Face cache root; several models can share it |

Environment variables are validated like CLI flags: an invalid
`EARHEART_STT_PROVIDER`, `EARHEART_STT_QUANTIZATION`, or `EARHEART_STT_PORT`
fails at startup with an error instead of silently falling back to CPU.

Other models: any model supported by onnx-asr works, e.g.
`nemo-parakeet-tdt-0.6b-v2` (English-only) or
`onnx-community/whisper-large-v3-turbo`. The `language` field is only honoured
by Whisper and Canary models; for others it is ignored and `verbose_json`
reports `auto`. An unsupported language on a Whisper/Canary model returns `400`.

`GET /health` is a liveness probe — the server only starts listening once the
model has finished loading.

### GPU

```bash
cd stt-server && uv run --extra gpu earheart-stt --provider cuda
# or with pip:
pip install "./stt-server[gpu]"
earheart-stt --provider cuda
```

Parakeet 0.6B runs comfortably faster than realtime on modern CPUs, so a GPU
is optional.

## Using it from other apps

Anything with a "custom OpenAI-compatible endpoint" option works. Point it at
`http://127.0.0.1:8484/v1`; the API key can be anything (it is ignored).

## Tests

From `stt-server/`, run `uv run --locked --extra test python -m pytest` (or install
`pip install -e ".[test]"` and run `python -m pytest`). The endpoint tests use
synthetic WAV uploads and replace the model loader with fake recognizers;
they do not download model weights or initialize a speech engine.
