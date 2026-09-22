"""FastAPI server wrapping an onnx-asr model (NVIDIA Parakeet by default)
behind the OpenAI-compatible audio transcription API.

Endpoints:
    POST /v1/audio/transcriptions  - multipart upload, returns {"text": ...}
    GET  /v1/models                - lists the loaded model
    GET  /health                   - liveness probe (the server only listens once the model is loaded)
"""

from __future__ import annotations

import io
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

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
    if config.provider not in PROVIDER_MAP:
        raise ValueError(f"Unknown provider {config.provider!r}")
    providers = PROVIDER_MAP[config.provider]

    if config.cache_dir is not None:
        # huggingface_hub reads HF_HUB_CACHE when its constants module is
        # imported, and onnx-asr imports huggingface_hub lazily on first
        # download — so set the env var before importing onnx_asr. This turns
        # --cache-dir into a real download cache root that several models can
        # share, instead of onnx-asr's model-files directory.
        os.environ["HF_HUB_CACHE"] = str(Path(config.cache_dir).expanduser())

    import onnx_asr

    logger.info(
        "Loading model %s (quantization=%s, providers=%s) — first run downloads it...",
        config.model,
        config.quantization,
        providers,
    )
    started = time.monotonic()
    model = onnx_asr.load_model(
        config.model,
        quantization=config.quantization,
        providers=providers,
    )
    logger.info("Model ready in %.1fs", time.monotonic() - started)
    return model


def honours_language(asr) -> bool:
    """Whether a model's recognize() honours the `language` kwarg.

    onnx-asr documents `language` as "only for Whisper and Canary models"
    (RecognizeOptions). Detect those by the concrete model class the adapter
    wraps, rather than by model name, so custom Hugging Face repos typed by
    their config.json are handled too.
    """
    from onnx_asr.models.nemo import NemoConformerAED
    from onnx_asr.models.whisper import WhisperHf, WhisperOrt

    return isinstance(getattr(asr, "asr", None), (WhisperHf, WhisperOrt, NemoConformerAED))


MAX_DECODED_BYTES = 256 * 1024 * 1024


def decode_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode an uploaded audio file to float32 mono, bounded before decode."""
    buffer = io.BytesIO(data)
    try:
        info = sf.info(buffer)
    except Exception as exc:
        logger.warning("Could not decode audio upload: %s", exc)
        raise HTTPException(
            status_code=400, detail="Could not decode audio file"
        ) from exc

    max_frames = MAX_DECODED_BYTES // (4 * max(info.channels, 1))
    if info.frames > max_frames:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Decoded audio exceeds the "
                f"{MAX_DECODED_BYTES // (1024 * 1024)} MiB limit"
            ),
        )

    # The source bound above misses the 16 kHz resample: low-rate audio (e.g.
    # 8 kHz) projects to more output frames than it decodes. Bound the
    # projected mono output too, so resample_linear cannot expand past budget.
    projected_frames = int(round(info.frames * TARGET_SAMPLE_RATE / info.samplerate))
    if projected_frames * 4 > MAX_DECODED_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Decoded audio exceeds the "
                f"{MAX_DECODED_BYTES // (1024 * 1024)} MiB limit"
            ),
        )

    buffer.seek(0)
    try:
        waveform, sample_rate = sf.read(
            buffer, dtype="float32", frames=max_frames + 1
        )
    except Exception as exc:
        logger.warning("Could not decode audio upload: %s", exc)
        raise HTTPException(
            status_code=400, detail="Could not decode audio file"
        ) from exc

    if waveform.shape[0] > max_frames:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Decoded audio exceeds the "
                f"{MAX_DECODED_BYTES // (1024 * 1024)} MiB limit"
            ),
        )

    if waveform.ndim > 1:
        waveform = waveform.mean(axis=1)
    return waveform, sample_rate


def resample_linear(waveform: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Lightweight linear resampler; dictation audio doesn't need polyphase."""
    if src_rate == dst_rate:
        return waveform
    duration = waveform.shape[0] / src_rate
    # A non-empty clip shorter than half a destination sample would otherwise
    # round down to zero after it already passed the endpoint's empty check.
    dst_len = max(1, int(round(duration * dst_rate)))
    src_t = np.linspace(0.0, duration, num=waveform.shape[0], endpoint=False)
    dst_t = np.linspace(0.0, duration, num=dst_len, endpoint=False)
    return np.interp(dst_t, src_t, waveform).astype(np.float32)


TARGET_SAMPLE_RATE = 16000
MAX_UPLOAD_BYTES = 64 * 1024 * 1024


def read_upload(file: UploadFile) -> bytes:
    """Read one upload without allowing an unbounded in-memory allocation."""
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio upload exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB limit",
        )
    return data


def create_app(config: ServerConfig | None = None) -> FastAPI:
    config = config or ServerConfig()
    state: dict = {"model": None}
    inference_lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state["model"] = load_asr_model(config)
        state["honours_language"] = honours_language(state["model"])
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
        # Passed to recognize() only for models that honour it (Whisper and
        # Canary); ignored — and echoed as "auto" in verbose_json — for others.
        language: str = Form(""),
        response_format: str = Form("json"),
    ):
        asr = state["model"]
        if response_format not in ("json", "text", "verbose_json"):
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported response_format {response_format!r} "
                "(supported: json, text, verbose_json)",
            )

        waveform, sample_rate = decode_audio(read_upload(file))
        if waveform.shape[0] == 0:
            raise HTTPException(status_code=400, detail="Empty audio file")
        waveform = resample_linear(waveform, sample_rate, TARGET_SAMPLE_RATE)

        started = time.monotonic()
        kwargs = {}
        if language and state["honours_language"]:
            kwargs["language"] = language
        # onnxruntime sessions are thread-safe, but serializing inference
        # keeps memory bounded when several requests land at once.
        with inference_lock:
            try:
                text = asr.recognize(
                    waveform, sample_rate=TARGET_SAMPLE_RATE, **kwargs
                )
            except Exception as exc:
                if isinstance(exc, KeyError) and exc.args == (f"<|{language}|>",):
                    # e.g. a language code the model doesn't support.
                    raise HTTPException(
                        status_code=400, detail=f"Unsupported language {language[:32]!r}"
                    ) from None
                logger.exception("Transcription failed")
                raise HTTPException(
                    status_code=500, detail="Transcription failed"
                ) from None
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
                "language": (
                    language if (language and state["honours_language"]) else "auto"
                ),
                "text": text,
            }
        return {"text": text}

    return app
