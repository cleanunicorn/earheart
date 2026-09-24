"""Exercise load_asr_model and CLI config wiring without a speech engine.

Unlike tests/test_server.py, this file has no autouse loader patch, so the real
load_asr_model (and cli.main) can be exercised against fakes.
"""

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import uvicorn
from onnx_asr.models.nemo import NemoConformerAED, NemoConformerTdt
from onnx_asr.models.whisper import WhisperHf, WhisperOrt

from earheart_stt import cli, server


@pytest.fixture(autouse=True)
def _isolate_hf_hub_cache(monkeypatch):
    # load_asr_model writes os.environ["HF_HUB_CACHE"] directly, which
    # monkeypatch never sees, so it can leak into the next test. Record the key
    # here so monkeypatch's teardown owns it and restores the original value.
    monkeypatch.setenv("HF_HUB_CACHE", os.environ.get("HF_HUB_CACHE", ""))


def test_cache_dir_sets_hf_hub_cache_and_omits_path(tmp_path, monkeypatch):
    calls = {}

    def load_model(*args, **kwargs):
        calls["args"] = args
        calls["kwargs"] = kwargs
        calls["env"] = dict(os.environ)
        return object()

    fake = SimpleNamespace(load_model=load_model)
    monkeypatch.setitem(sys.modules, "onnx_asr", fake)
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)

    server.load_asr_model(server.ServerConfig(cache_dir=str(cache_dir)))

    assert calls["args"] == ("nemo-parakeet-tdt-0.6b-v3",)
    assert calls["kwargs"] == {
        "quantization": None,
        "providers": ["CPUExecutionProvider"],
    }
    assert calls["env"]["HF_HUB_CACHE"] == str(cache_dir)


def test_no_cache_dir_leaves_hf_hub_cache_alone(monkeypatch):
    calls = {}

    def load_model(*args, **kwargs):
        calls["args"] = args
        calls["env"] = dict(os.environ)
        return object()

    fake = SimpleNamespace(load_model=load_model)
    monkeypatch.setitem(sys.modules, "onnx_asr", fake)
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)

    server.load_asr_model(server.ServerConfig())

    assert "HF_HUB_CACHE" not in calls["env"]
    assert calls["args"] == ("nemo-parakeet-tdt-0.6b-v3",)


def test_unknown_provider_raises(monkeypatch):
    def load_model(*args, **kwargs):
        raise AssertionError("load_model must not be called for an unknown provider")

    fake = SimpleNamespace(load_model=load_model)
    monkeypatch.setitem(sys.modules, "onnx_asr", fake)

    with pytest.raises(ValueError, match="Unknown provider 'gpu'"):
        server.load_asr_model(server.ServerConfig(provider="gpu"))


def test_honours_language_detects_whisper_and_canary():
    assert server.honours_language(SimpleNamespace(asr=object.__new__(WhisperHf)))
    assert server.honours_language(SimpleNamespace(asr=object.__new__(WhisperOrt)))
    assert server.honours_language(SimpleNamespace(asr=object.__new__(NemoConformerAED)))
    assert not server.honours_language(SimpleNamespace(asr=object.__new__(NemoConformerTdt)))
    assert not server.honours_language(SimpleNamespace())


@pytest.mark.parametrize(
    ("env_var", "value", "expected"),
    [
        ("EARHEART_STT_PROVIDER", "gpu", "EARHEART_STT_PROVIDER"),
        ("EARHEART_STT_QUANTIZATION", "fp16", "EARHEART_STT_QUANTIZATION"),
        ("EARHEART_STT_PORT", "abc", "argument --port"),
        ("EARHEART_STT_PORT", "70000", "argument --port"),
    ],
)
def test_invalid_env_fails_argparse_style(monkeypatch, capsys, env_var, value, expected):
    monkeypatch.setenv(env_var, value)
    monkeypatch.setattr(sys, "argv", ["earheart-stt"])
    # Never let a broken parser reach the real model loader: patch the startup
    # boundary so an unvalidated value fails the SystemExit assertion instead.
    monkeypatch.setattr(cli, "create_app", lambda config: object())
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: None)

    with pytest.raises(SystemExit) as exc:
        cli.main()

    assert exc.value.code == 2
    captured = capsys.readouterr()
    assert expected in captured.err
    assert "Traceback" not in captured.err


def test_valid_env_values_reach_config(monkeypatch):
    monkeypatch.setenv("EARHEART_STT_PROVIDER", "cuda")
    monkeypatch.setenv("EARHEART_STT_QUANTIZATION", "int8")
    monkeypatch.setenv("EARHEART_STT_PORT", "9000")
    monkeypatch.setattr(sys, "argv", ["earheart-stt"])

    configs = []
    monkeypatch.setattr(
        cli, "create_app", lambda config: (configs.append(config), object())[1]
    )
    run_kwargs = {}

    def fake_run(app, **kwargs):
        run_kwargs.update(kwargs)

    monkeypatch.setattr(uvicorn, "run", fake_run)

    cli.main()

    assert configs[0].provider == "cuda"
    assert configs[0].quantization == "int8"
    assert run_kwargs["port"] == 9000


def test_cli_flags_override_env(monkeypatch):
    monkeypatch.setenv("EARHEART_STT_PROVIDER", "cpu")
    monkeypatch.setattr(sys, "argv", ["earheart-stt", "--provider", "cuda"])

    configs = []
    monkeypatch.setattr(
        cli, "create_app", lambda config: (configs.append(config), object())[1]
    )
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: None)

    cli.main()

    assert configs[0].provider == "cuda"


BARE_PYPI_FORMS = [
    "uvx earheart-stt",
    "pip install earheart-stt",
    'pip install "earheart-stt',
]


def test_docs_do_not_advertise_bare_pypi_install():
    root = Path(__file__).resolve().parents[1]
    for path in (root / "README.md", root / "pyproject.toml"):
        text = path.read_text()
        for form in BARE_PYPI_FORMS:
            assert form not in text, f"{form!r} advertised in {path.name}"
