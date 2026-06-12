"""Command-line entry point: `earheart-stt [options]`."""

from __future__ import annotations

import argparse
import logging
import os

from .server import ServerConfig, create_app


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="earheart-stt",
        description=(
            "Local speech-to-text server (NVIDIA Parakeet via ONNX) with an "
            "OpenAI-compatible /v1/audio/transcriptions endpoint."
        ),
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("EARHEART_STT_HOST", "127.0.0.1"),
        help="Bind address (default: 127.0.0.1 — local only)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("EARHEART_STT_PORT", "8484")),
        help="Port (default: 8484)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("EARHEART_STT_MODEL", "nemo-parakeet-tdt-0.6b-v3"),
        help=(
            "onnx-asr model name or local path (default: nemo-parakeet-tdt-0.6b-v3, "
            "multilingual; use nemo-parakeet-tdt-0.6b-v2 for English-only)"
        ),
    )
    parser.add_argument(
        "--quantization",
        default=os.environ.get("EARHEART_STT_QUANTIZATION") or None,
        choices=[None, "int8"],
        help="Model quantization; int8 is smaller/faster on CPU (default: full precision)",
    )
    parser.add_argument(
        "--provider",
        default=os.environ.get("EARHEART_STT_PROVIDER", "cpu"),
        choices=["cpu", "cuda", "tensorrt", "coreml", "directml"],
        help="ONNX Runtime execution provider (default: cpu)",
    )
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("EARHEART_STT_CACHE_DIR") or None,
        help="Where to cache downloaded models (default: Hugging Face cache)",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    config = ServerConfig(
        model=args.model,
        quantization=args.quantization,
        provider=args.provider,
        cache_dir=args.cache_dir,
    )

    import uvicorn

    uvicorn.run(create_app(config), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
