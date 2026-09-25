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
        # The var is process-global and never cleared: load_asr_model runs
        # once per process (lifespan), and huggingface_hub bakes HF_HUB_CACHE
        # into a module constant at first import, so clearing it later would
        # have no effect anyway.
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


TARGET_SAMPLE_RATE = 16000
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_DECODED_BYTES = 256 * 1024 * 1024
FLOAT32_BYTES = np.dtype(np.float32).itemsize
FLOAT64_BYTES = np.dtype(np.float64).itemsize


def _undecodable(exc: Exception) -> HTTPException:
    logger.warning("Could not decode audio upload: %s", exc)
    return HTTPException(status_code=400, detail="Could not decode audio file")


def _too_large() -> HTTPException:
    return HTTPException(
        status_code=413,
        detail=f"Decoded audio exceeds the {MAX_DECODED_BYTES // (1024 * 1024)} MiB limit",
    )


def resampled_frame_count(frames: int, src_rate: int, dst_rate: int) -> int:
    """Return the linear resampler's output length without float rounding drift."""
    if frames == 0 or src_rate == dst_rate:
        return frames
    numerator = frames * dst_rate
    quotient, remainder = divmod(numerator, src_rate)
    doubled_remainder = remainder * 2
    if doubled_remainder > src_rate or (
        doubled_remainder == src_rate and quotient % 2
    ):
        quotient += 1
    return max(1, quotient)


def peak_working_set_bytes(frames: int, sample_rate: int, channels: int) -> int:
    """Estimate the maximum simultaneously live decode/resample arrays."""
    if frames < 0 or sample_rate <= 0 or channels <= 0:
        raise ValueError("Invalid audio metadata")

    source_bytes = frames * channels * FLOAT32_BYTES
    if channels > 1:
        # ndarray.mean(float32) produces float32, while the decoded source is
        # still referenced during the conversion.
        peak_bytes = source_bytes + frames * FLOAT32_BYTES
    else:
        peak_bytes = source_bytes

    if sample_rate == TARGET_SAMPLE_RATE or frames == 0:
        return peak_bytes

    destination_frames = resampled_frame_count(frames, sample_rate, TARGET_SAMPLE_RATE)
    # np.interp converts float32 sample values to a contiguous float64 input
    # and returns float64. During astype(float32), both are live with the
    # source waveform and both timelines.
    resample_bytes = (
        frames * FLOAT32_BYTES
        + frames * FLOAT64_BYTES
        + frames * FLOAT64_BYTES
        + destination_frames * FLOAT64_BYTES
        + destination_frames * FLOAT64_BYTES
        + destination_frames * FLOAT32_BYTES
    )
    return max(peak_bytes, resample_bytes)


def maximum_admitted_frames(sample_rate: int, channels: int) -> int:
    """Largest advertised frame count whose one-frame read probe is safe."""
    if sample_rate <= 0 or channels <= 0:
        raise ValueError("Invalid audio metadata")
    if peak_working_set_bytes(1, sample_rate, channels) > MAX_DECODED_BYTES:
        return -1

    # Every frame includes at least one float32 sample, so this is a safe
    # finite upper bound. Binary search keeps the admission calculation pure.
    low = 0
    high = MAX_DECODED_BYTES // FLOAT32_BYTES
    while low < high:
        midpoint = (low + high + 1) // 2
        if peak_working_set_bytes(midpoint + 1, sample_rate, channels) <= MAX_DECODED_BYTES:
            low = midpoint
        else:
            high = midpoint - 1
    return low


def decode_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode an uploaded audio file to float32 mono, bounded before decode."""
    buffer = io.BytesIO(data)
    try:
        info = sf.info(buffer)
    except Exception as exc:
        raise _undecodable(exc) from exc

    if (
        not isinstance(info.frames, (int, np.integer))
        or not isinstance(info.channels, (int, np.integer))
        or not isinstance(info.samplerate, (int, np.integer))
        or info.frames < 0
    ):
        raise _undecodable(ValueError("Invalid audio metadata"))
    try:
        max_frames = maximum_admitted_frames(info.samplerate, info.channels)
    except ValueError as exc:
        raise _undecodable(exc) from exc
    if max_frames < 0 or info.frames > max_frames:
        raise _too_large()

    buffer.seek(0)
    try:
        waveform, sample_rate = sf.read(
            buffer, dtype="float32", frames=max_frames + 1
        )
    except Exception as exc:
        raise _undecodable(exc) from exc

    if waveform.shape[0] > max_frames:
        raise _too_large()

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
    dst_len = resampled_frame_count(waveform.shape[0], src_rate, dst_rate)
    src_t = np.linspace(0.0, duration, num=waveform.shape[0], endpoint=False)
    dst_t = np.linspace(0.0, duration, num=dst_len, endpoint=False)
    return np.interp(dst_t, src_t, waveform).astype(np.float32)


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
    state: dict = {}
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

        kwargs = {}
        if language and state["honours_language"]:
            kwargs["language"] = language
        # The entire decoded/resampling working set must be serialized too,
        # not only onnxruntime inference.
        with inference_lock:
            waveform, sample_rate = decode_audio(read_upload(file))
            if waveform.shape[0] == 0:
                raise HTTPException(status_code=400, detail="Empty audio file")
            waveform = resample_linear(waveform, sample_rate, TARGET_SAMPLE_RATE)
            started = time.monotonic()
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
