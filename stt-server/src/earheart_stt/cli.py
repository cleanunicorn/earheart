"""Command-line entry point: `earheart-stt [options]`."""

from __future__ import annotations

import argparse
import logging
import os

from .server import PROVIDER_MAP, ServerConfig, create_app


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid port {value!r}") from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError(f"port must be 1-65535, got {port}")
    return port


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
        type=_port,
        default=os.environ.get("EARHEART_STT_PORT", "8484"),
        help="Port (default: 8484)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("EARHEART_STT_MODEL", "nemo-parakeet-tdt-0.6b-v3"),
        help=(
            "onnx-asr model name or Hugging Face repo id (default: "
            "nemo-parakeet-tdt-0.6b-v3, multilingual; use "
            "nemo-parakeet-tdt-0.6b-v2 for English-only)"
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
        choices=list(PROVIDER_MAP),
        help="ONNX Runtime execution provider (default: cpu)",
    )
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("EARHEART_STT_CACHE_DIR") or None,
        help=(
            "Hugging Face cache root (sets HF_HUB_CACHE); several models can "
            "share it (default: Hugging Face cache)"
        ),
    )
    args = parser.parse_args()

    # argparse applies `type`/`choices` only to values given on the command
    # line, so an environment default can carry an invalid value straight
    # through. Validate the env-sourced fields here with the same argparse
    # error style, naming the env var that set them.
    if args.quantization not in (None, "int8"):
        parser.error(
            f"EARHEART_STT_QUANTIZATION: invalid choice {args.quantization!r} "
            "(choose from None, int8)"
        )
    if args.provider not in PROVIDER_MAP:
        parser.error(
            f"EARHEART_STT_PROVIDER: invalid choice {args.provider!r} "
            f"(choose from {', '.join(PROVIDER_MAP)})"
        )

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
