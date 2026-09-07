"""Exercise the real multipart endpoints without loading a speech engine."""

import io
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from earheart_stt import server


def wav(samples=None, rate=16000):
    if samples is None:
        samples = np.zeros(1600, dtype=np.float32)
    output = io.BytesIO()
    sf.write(output, samples, rate, format="WAV", subtype="FLOAT")
    return output.getvalue()


def transcribe(client, audio=None, **fields):
    return client.post(
        "/v1/audio/transcriptions",
        files={"file": ("speech.wav", wav() if audio is None else audio, "audio/wav")},
        data=fields,
    )


@pytest.fixture(autouse=True)
def loader(monkeypatch):
    # Every test is guarded, including tests that don't enter the lifespan.
    # An accidental unconfigured startup fails instead of downloading weights.
    fake = Mock(side_effect=AssertionError("Test must supply a fake recognizer"))
    monkeypatch.setattr(server, "load_asr_model", fake)
    return fake


@pytest.fixture
def recognizer():
    return SimpleNamespace(recognize=Mock(return_value="  Hello world. \n"))


@pytest.fixture
def client_factory(loader):
    @contextmanager
    def start(recognizer, config=None):
        loader.side_effect = None
        loader.return_value = recognizer
        with TestClient(server.create_app(config)) as client:
            yield client

    return start


@pytest.fixture
def client(client_factory, recognizer):
    with client_factory(recognizer) as client:
        yield client


def test_startup_and_discovery(client_factory, recognizer, loader):
    config = server.ServerConfig(model="test-model")
    with client_factory(recognizer, config) as client:
        loader.assert_called_once_with(config)
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {"status": "ok", "model": "test-model"}
        models = client.get("/v1/models")
        assert models.status_code == 200
        assert models.json() == {
            "object": "list",
            "data": [{"id": "test-model", "object": "model", "owned_by": "earheart-stt"}],
        }


@pytest.mark.parametrize("response_format", [None, "json", "text", "verbose_json"])
def test_response_formats(client, recognizer, response_format):
    fields = {"model": "client-model-is-ignored"}
    if response_format is not None:
        fields["response_format"] = response_format
    response = transcribe(client, **fields)
    assert response.status_code == 200
    if response_format == "text":
        assert response.headers["content-type"] == "text/plain; charset=utf-8"
        assert response.text == "Hello world."
    else:
        assert response.headers["content-type"] == "application/json"
        expected = {"text": "Hello world."}
        if response_format == "verbose_json":
            expected.update(task="transcribe", duration=0.1, language="auto")
        assert response.json() == expected
    recognizer.recognize.assert_called_once()
    assert recognizer.recognize.call_args.kwargs == {"sample_rate": 16000}


@pytest.mark.parametrize("response_format", ["srt", "vtt", "JSON"])
def test_unsupported_response_format(client, recognizer, response_format):
    response = transcribe(client, response_format=response_format)
    assert response.status_code == 400
    assert response.json()["detail"] == (
        f"Unsupported response_format {response_format!r} "
        "(supported: json, text, verbose_json)"
    )
    recognizer.recognize.assert_not_called()


@pytest.mark.parametrize("audio", [b"", b"not an audio file"])
def test_invalid_audio(client, recognizer, audio):
    response = transcribe(client, audio)
    assert response.status_code == 400
    assert response.json()["detail"].startswith("Could not decode audio file:")
    recognizer.recognize.assert_not_called()


def test_empty_wav(client, recognizer):
    response = transcribe(client, wav(np.zeros(0, dtype=np.float32)))
    assert response.status_code == 400
    assert response.json() == {"detail": "Empty audio file"}
    recognizer.recognize.assert_not_called()


def test_missing_upload(client, recognizer):
    assert client.post("/v1/audio/transcriptions").status_code == 422
    recognizer.recognize.assert_not_called()


@pytest.mark.parametrize("rate", [8000, 16000, 48000])
@pytest.mark.parametrize("channels", [1, 2])
def test_audio_is_mono_float32_at_16khz(client, recognizer, rate, channels):
    # A ramp has an analytic interpolation result; distinct stereo channels
    # also make it impossible to pass by keeping only one channel.
    ramp = np.arange(rate // 10, dtype=np.float32) / rate
    samples = ramp if channels == 1 else np.column_stack((ramp, ramp + 0.2))
    response = transcribe(client, wav(samples, rate), response_format="verbose_json")
    assert response.status_code == 200
    assert response.json()["duration"] == pytest.approx(0.1)
    recognizer.recognize.assert_called_once()
    args, kwargs = recognizer.recognize.call_args
    assert kwargs == {"sample_rate": 16000}
    actual = args[0]
    assert actual.dtype == np.float32
    assert actual.shape == (1600,)
    expected = np.minimum(np.arange(1600) / 16000, ramp[-1])
    if channels == 2:
        expected += 0.1
    np.testing.assert_allclose(actual, expected, atol=1e-7)


def test_model_not_loaded(loader):
    # TestClient without a context deliberately skips startup, leaving the
    # app in its initial model-loading state.
    client = TestClient(server.create_app())
    try:
        response = transcribe(client)
        assert response.status_code == 503
        assert response.json() == {"detail": "Model still loading"}
        loader.assert_not_called()
    finally:
        client.close()


def test_supported_language(client, recognizer):
    response = transcribe(client, language="ro", response_format="verbose_json")
    assert response.status_code == 200
    assert response.json()["language"] == "ro"
    assert recognizer.recognize.call_args.kwargs == {"sample_rate": 16000, "language": "ro"}


def test_unsupported_language(client, recognizer):
    recognizer.recognize.side_effect = ValueError("Unsupported language: xx")
    response = transcribe(client, language="xx")
    assert response.status_code == 400
    assert response.json() == {"detail": "Unsupported language: xx"}
    recognizer.recognize.assert_called_once()
    assert recognizer.recognize.call_args.kwargs["language"] == "xx"


def test_model_without_language_parameter(client_factory):
    calls = []

    def recognize(waveform, *, sample_rate):
        calls.append((waveform, sample_rate))
        return "English only."

    with client_factory(SimpleNamespace(recognize=recognize)) as client:
        response = transcribe(client, language="en")
    assert response.status_code == 200
    assert response.json() == {"text": "English only."}
    assert len(calls) == 1
    assert calls[0][1] == 16000


@pytest.mark.parametrize("result", [None, "", " \n "])
def test_silent_recognition(client, recognizer, result):
    recognizer.recognize.return_value = result
    response = transcribe(client)
    assert response.status_code == 200
    assert response.json() == {"text": ""}


def test_concurrent_inference_is_serialized(client_factory, monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    contended = threading.Event()
    calls = []

    class ObservedLock:
        """Keep real locking; expose when the second request reaches it."""

        def __init__(self):
            self.lock = threading.Lock()

        def __enter__(self):
            if not self.lock.acquire(blocking=False):
                contended.set()
                self.lock.acquire()

        def __exit__(self, *exc):
            self.lock.release()

    # Replace only the server's namespace, never threading.Lock globally.
    monkeypatch.setattr(server, "threading", SimpleNamespace(Lock=ObservedLock))

    def recognize(waveform, *, sample_rate):
        calls.append(sample_rate)
        entered.set()
        assert release.wait(10), "Timed out waiting to release inference"
        return "Hello."

    with client_factory(SimpleNamespace(recognize=recognize)) as client:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(transcribe, client)
            try:
                assert entered.wait(5), "First request never entered inference"
                second = pool.submit(transcribe, client)
                assert contended.wait(5), "Second request never waited for inference"
                assert calls == [16000]
                assert not first.done()
                assert not second.done()
            finally:
                release.set()
            for future in (first, second):
                response = future.result(timeout=5)
                assert response.status_code == 200
                assert response.json() == {"text": "Hello."}
    assert calls == [16000, 16000]
