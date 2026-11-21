"""POST /api/score contract. HTTP is always mocked; no live model call (D-08)."""

from __future__ import annotations

import json

import pytest

from app import llm_score


class _FakeResponse:
    def __init__(self, content: str):
        self._content = content

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"choices": [{"message": {"content": self._content}}]}


@pytest.fixture()
def fake_llm(monkeypatch):
    """Replace httpx.post and hand back the captured request bodies."""

    def install(content: str):
        calls: list[dict] = []

        def fake_post(url, headers=None, json=None, timeout=None):
            calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
            return _FakeResponse(content)

        monkeypatch.setattr(llm_score.httpx, "post", fake_post)
        return calls

    return install


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("AGENDA_LLM_API_KEY", "test-key-not-real")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("AGENDA_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("AGENDA_LLM_MODEL", raising=False)


def post_score(client, **overrides):
    payload = {"title": "A talk", "abstract": "About things.", "length_min": 20, **overrides}
    return client.post("/api/score", json=payload)


def test_valid_json_is_returned_and_nothing_is_written(client, fake_llm):
    before = client.get("/api/talks").json()["total"]
    calls = fake_llm(json.dumps({"interest": 4, "heavy": True, "reason": "Dense but popular."}))
    response = post_score(client)
    assert response.status_code == 200, response.text
    assert response.json() == {"interest": 4, "heavy": True, "reason": "Dense but popular."}
    assert client.get("/api/talks").json()["total"] == before

    sent = calls[0]
    assert sent["url"] == "https://api.groq.com/openai/v1/chat/completions"
    assert sent["json"]["temperature"] == 0
    assert sent["json"]["model"] == "llama-3.1-8b-instant"
    assert sent["timeout"] == 20.0
    assert "test-key-not-real" not in json.dumps(sent["json"])
    joined = json.dumps(sent["json"])
    assert "About things." in joined and "A talk" in joined


def test_fenced_json_block_is_accepted(client, fake_llm):
    fake_llm('```json\n{"interest": 2, "heavy": false, "reason": "Niche."}\n```')
    response = post_score(client)
    assert response.status_code == 200, response.text
    assert response.json()["interest"] == 2
    assert response.json()["heavy"] is False


def test_interest_nine_is_rejected_not_clamped(client, fake_llm):
    fake_llm(json.dumps({"interest": 9, "heavy": False, "reason": "Too many."}))
    response = post_score(client)
    assert response.status_code == 502
    body = response.json()
    assert body["code"] == "LLM_BAD_RESPONSE"
    assert body["details"][0]["field"] == "interest"
    assert body["details"][0]["problem"] == "out_of_range"


def test_missing_reason_is_rejected(client, fake_llm):
    fake_llm(json.dumps({"interest": 3, "heavy": False}))
    response = post_score(client)
    assert response.status_code == 502
    assert response.json()["details"][0]["field"] == "reason"


def test_no_key_returns_503_and_manual_entry_stays_usable(client, monkeypatch, fake_llm):
    monkeypatch.delenv("AGENDA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("AGENDA_LLM_DEMO_FALLBACK", raising=False)
    calls = fake_llm(json.dumps({"interest": 4, "heavy": False, "reason": "x"}))
    response = post_score(client)
    assert response.status_code == 503
    body = response.json()
    assert body["code"] == "LLM_NOT_CONFIGURED"
    assert isinstance(body["details"], list)
    assert calls == []


def test_demo_fallback_off_means_no_call_even_when_explicitly_off(client, monkeypatch, fake_llm):
    monkeypatch.delenv("AGENDA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("AGENDA_LLM_DEMO_FALLBACK", "off")
    calls = fake_llm(json.dumps({"interest": 4, "heavy": False, "reason": "x"}))
    response = post_score(client)
    assert response.status_code == 503
    assert response.json()["code"] == "LLM_NOT_CONFIGURED"
    assert calls == []


def test_demo_fallback_on_without_key_marks_the_reason(client, monkeypatch, fake_llm):
    monkeypatch.delenv("AGENDA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("AGENDA_LLM_DEMO_FALLBACK", "on")
    calls = fake_llm(json.dumps({"interest": 3, "heavy": False, "reason": "Short and light."}))
    response = post_score(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["interest"] == 3 and body["heavy"] is False
    assert body["reason"] == "demo-unverified: Short and light."

    sent = calls[0]
    assert sent["url"] == llm_score.DEMO_FALLBACK_URL
    assert sent["timeout"] == 15.0
    assert sent["headers"] is None  # no Authorization header on the keyless path
    assert "model" in sent["json"] and "messages" in sent["json"]


def test_demo_fallback_on_still_validates_the_json(client, monkeypatch, fake_llm):
    monkeypatch.delenv("AGENDA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("AGENDA_LLM_DEMO_FALLBACK", "on")
    fake_llm(json.dumps({"interest": 0, "heavy": False, "reason": "Nope."}))
    response = post_score(client)
    assert response.status_code == 502
    assert response.json()["code"] == "LLM_BAD_RESPONSE"
    assert response.json()["details"][0]["field"] == "interest"


def test_demo_fallback_unreachable_is_503_not_a_score(client, monkeypatch):
    import httpx

    monkeypatch.delenv("AGENDA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("AGENDA_LLM_DEMO_FALLBACK", "on")

    def boom(url, json=None, timeout=None):
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(llm_score.httpx, "post", boom)
    response = post_score(client)
    assert response.status_code == 503
    assert response.json()["code"] == "LLM_NOT_CONFIGURED"


def test_demo_fallback_is_ignored_when_a_key_is_present(client, monkeypatch, fake_llm):
    monkeypatch.setenv("AGENDA_LLM_DEMO_FALLBACK", "on")
    calls = fake_llm(json.dumps({"interest": 4, "heavy": False, "reason": "Keyed."}))
    response = post_score(client)
    assert response.status_code == 200
    assert response.json()["reason"] == "Keyed."
    assert calls[0]["url"] == "https://api.groq.com/openai/v1/chat/completions"
    assert calls[0]["headers"] == {"Authorization": "Bearer test-key-not-real"}


def test_bad_length_is_422_before_any_model_call(client, fake_llm):
    calls = fake_llm(json.dumps({"interest": 4, "heavy": False, "reason": "x"}))
    response = post_score(client, length_min=90)
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert calls == []


def test_scheduler_does_not_import_the_model():
    import app.scheduler as scheduler

    assert "llm" not in vars(scheduler)
    source = open(scheduler.__file__, encoding="utf-8").read()
    assert "llm_score" not in source
    assert "httpx" not in source
