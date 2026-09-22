"""Exercise load_asr_model and CLI config wiring without a speech engine.

Unlike tests/test_server.py, this file has no autouse loader patch, so the real
load_asr_model (and cli.main) can be exercised against fakes.
"""

import os
import sys
from types import SimpleNamespace

import pytest

from earheart_stt import server


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
