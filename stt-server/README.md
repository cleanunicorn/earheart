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

With [uv](https://docs.astral.sh/uv/) (recommended):

```bash
uvx earheart-stt
# or from a checkout of this repo:
cd stt-server && uv run earheart-stt
```

Or with pip:

```bash
pip install earheart-stt   # from a checkout: pip install ./stt-server
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

## Options

| Flag | Env var | Default | Notes |
| --- | --- | --- | --- |
| `--host` | `EARHEART_STT_HOST` | `127.0.0.1` | Local-only by default |
| `--port` | `EARHEART_STT_PORT` | `8484` | |
| `--model` | `EARHEART_STT_MODEL` | `nemo-parakeet-tdt-0.6b-v3` | Multilingual (25 European languages) |
| `--quantization` | `EARHEART_STT_QUANTIZATION` | full precision | `int8` is smaller and faster on CPU |
| `--provider` | `EARHEART_STT_PROVIDER` | `cpu` | `cuda`, `tensorrt`, `coreml`, `directml` |
| `--cache-dir` | `EARHEART_STT_CACHE_DIR` | HF cache | Model download location |

Other models: any model supported by onnx-asr works, e.g.
`nemo-parakeet-tdt-0.6b-v2` (English-only) or
`onnx-community/whisper-large-v3-turbo`.

### GPU

```bash
pip install "earheart-stt[gpu]"
earheart-stt --provider cuda
```

Parakeet 0.6B runs comfortably faster than realtime on modern CPUs, so a GPU
is optional.

## Using it from other apps

Anything with a "custom OpenAI-compatible endpoint" option works. Point it at
`http://127.0.0.1:8484/v1`; the API key can be anything (it is ignored).
