"""FastAPI server wrapping an onnx-asr model (NVIDIA Parakeet by default)
behind the OpenAI-compatible audio transcription API.

Endpoints:
    POST /v1/audio/transcriptions  - multipart upload, returns {"text": ...}
    GET  /v1/models                - lists the loaded model
    GET  /health                   - readiness probe
"""

from __future__ import annotations

import io
import logging
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

logger = logging.getLogger("earheart_stt")


@dataclass
class ServerConfig:
    model: str = "nemo-parakeet-tdt-0.6b-v3"
    quantization: str | None = None
    provider: str = "cpu"
    cache_dir: str | None = None
    # Languages Parakeet v3 supports are auto-detected; the `language` form
    # field is accepted for API compatibility and passed through when the
    # loaded model supports it.
    extra: dict = field(default_factory=dict)


PROVIDER_MAP = {
    "cpu": ["CPUExecutionProvider"],
    "cuda": ["CUDAExecutionProvider", "CPUExecutionProvider"],
    "tensorrt": [
        "TensorrtExecutionProvider",
        "CUDAExecutionProvider",
        "CPUExecutionProvider",
    ],
    "coreml": ["CoreMLExecutionProvider", "CPUExecutionProvider"],
    "directml": ["DmlExecutionProvider", "CPUExecutionProvider"],
}


def load_asr_model(config: ServerConfig):
    import onnx_asr

    providers = PROVIDER_MAP.get(config.provider, ["CPUExecutionProvider"])
    logger.info(
        "Loading model %s (quantization=%s, providers=%s) — first run downloads it...",
        config.model,
        config.quantization,
        providers,
    )
    started = time.monotonic()
    model = onnx_asr.load_model(
        config.model,
        config.cache_dir,
        quantization=config.quantization,
        providers=providers,
    )
    logger.info("Model ready in %.1fs", time.monotonic() - started)
    return model


def decode_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode an uploaded audio file to float32 mono."""
    try:
        waveform, sample_rate = sf.read(io.BytesIO(data), dtype="float32")
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not decode audio file: {exc}",
        ) from exc
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=1)
    return waveform, sample_rate


def resample_linear(waveform: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Lightweight linear resampler; dictation audio doesn't need polyphase."""
    if src_rate == dst_rate:
        return waveform
    duration = waveform.shape[0] / src_rate
    dst_len = int(round(duration * dst_rate))
    src_t = np.linspace(0.0, duration, num=waveform.shape[0], endpoint=False)
    dst_t = np.linspace(0.0, duration, num=dst_len, endpoint=False)
    return np.interp(dst_t, src_t, waveform).astype(np.float32)


TARGET_SAMPLE_RATE = 16000


def create_app(config: ServerConfig | None = None) -> FastAPI:
    config = config or ServerConfig()
    state: dict = {"model": None}
    inference_lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state["model"] = load_asr_model(config)
        yield

    app = FastAPI(title="earheart-stt", lifespan=lifespan)

    @app.get("/health")
    def health():
        return {"status": "ok", "model": config.model}

    @app.get("/v1/models")
    def models():
        return {
            "object": "list",
            "data": [{"id": config.model, "object": "model", "owned_by": "earheart-stt"}],
        }

    @app.post("/v1/audio/transcriptions")
    def transcribe(
        file: UploadFile = File(...),
        model: str = Form(""),  # accepted for API compatibility; ignored
        language: str = Form(""),
        response_format: str = Form("json"),
    ):
        asr = state["model"]
        if asr is None:
            raise HTTPException(status_code=503, detail="Model still loading")

        waveform, sample_rate = decode_audio(file.file.read())
        if waveform.shape[0] == 0:
            raise HTTPException(status_code=400, detail="Empty audio file")
        waveform = resample_linear(waveform, sample_rate, TARGET_SAMPLE_RATE)

        started = time.monotonic()
        kwargs = {}
        if language:
            kwargs["language"] = language
        # onnxruntime sessions are thread-safe, but serializing inference
        # keeps memory bounded when several requests land at once.
        with inference_lock:
            try:
                text = asr.recognize(
                    waveform, sample_rate=TARGET_SAMPLE_RATE, **kwargs
                )
            except TypeError:
                # Model doesn't take a language hint (e.g. English-only v2).
                text = asr.recognize(waveform, sample_rate=TARGET_SAMPLE_RATE)
        elapsed = time.monotonic() - started
        audio_seconds = waveform.shape[0] / TARGET_SAMPLE_RATE
        logger.info(
            "Transcribed %.1fs of audio in %.2fs (%.0fx realtime)",
            audio_seconds,
            elapsed,
            audio_seconds / elapsed if elapsed > 0 else 0,
        )

        text = (text or "").strip()
        if response_format == "text":
            return PlainTextResponse(text)
        if response_format == "verbose_json":
            return {
                "task": "transcribe",
                "duration": audio_seconds,
                "language": language or "auto",
                "text": text,
            }
        return {"text": text}

    return app
