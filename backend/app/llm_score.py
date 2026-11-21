"""OpenAI-compatible chat client for ``POST /api/score`` (D-08).

Never imported by ``scheduler.py``: the model proposes ``interest`` and
``heavy``, the operator's save is the authority. No database access here.
"""

from __future__ import annotations

import json
import os
import re

import httpx

from .schemas import ApiError

DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "llama-3.1-8b-instant"
TIMEOUT_SECONDS = 20.0
MAX_REASON_CHARS = 400

SYSTEM_PROMPT = (
    "You score talks for a two-day analyst conference. "
    "Answer with JSON only, no prose and no code fence. "
    'The object has exactly three keys: "interest" (integer 1-5, 5 = expected to fill the room), '
    '"heavy" (boolean, true when the talk is dense or tiring to sit through), '
    'and "reason" (one short sentence explaining both values).'
)

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def config() -> tuple[str, str, str]:
    """Read the environment at request time; the key is never logged."""
    base_url = (os.environ.get("AGENDA_LLM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    api_key = os.environ.get("AGENDA_LLM_API_KEY") or os.environ.get("GROQ_API_KEY") or ""
    model = os.environ.get("AGENDA_LLM_MODEL") or DEFAULT_MODEL
    return base_url, api_key, model


def _bad_response(problem: str, received=None) -> ApiError:
    detail: dict = {"problem": problem}
    if received is not None:
        detail["received"] = received if isinstance(received, (int, float, str, bool)) else str(received)
    return ApiError(502, "LLM_BAD_RESPONSE", "the scoring model did not return a usable score", [detail])


def _chat_completion(base_url: str, api_key: str, model: str, messages: list[dict]) -> str:
    """One POST to ``{base}/chat/completions``. Tests monkeypatch this."""
    try:
        response = httpx.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": messages, "temperature": 0},
            timeout=TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError):
        raise _bad_response("upstream_error")


def _messages(title: str, abstract: str | None, length_min: int) -> list[dict]:
    user = (
        f"Title: {title}\n"
        f"Abstract: {abstract or '(none)'}\n"
        f"Length: {length_min} minutes\n"
        "Return the JSON object now."
    )
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def _extract(content) -> dict:
    if not isinstance(content, str):
        raise _bad_response("not_json", content)
    body = content.strip()
    fenced = _FENCE.search(body)
    if fenced:
        body = fenced.group(1).strip()
    try:
        return json.loads(body)
    except ValueError:
        raise _bad_response("not_json", body[:200])


def _validated(data) -> dict:
    if not isinstance(data, dict):
        raise _bad_response("not_an_object")
    details: list[dict] = []

    interest = data.get("interest")
    if "interest" not in data:
        details.append({"field": "interest", "problem": "missing"})
    elif isinstance(interest, bool) or not isinstance(interest, int) or not 1 <= interest <= 5:
        details.append({"field": "interest", "problem": "out_of_range", "received": interest, "allowed": "1..5"})

    heavy = data.get("heavy")
    if "heavy" not in data:
        details.append({"field": "heavy", "problem": "missing"})
    elif not isinstance(heavy, bool):
        details.append({"field": "heavy", "problem": "not_boolean", "received": heavy})

    reason = data.get("reason")
    if "reason" not in data:
        details.append({"field": "reason", "problem": "missing"})
    elif not isinstance(reason, str):
        details.append({"field": "reason", "problem": "not_a_string", "received": reason})

    if details:
        raise ApiError(502, "LLM_BAD_RESPONSE", "the scoring model returned an invalid score", details)

    return {"interest": interest, "heavy": heavy, "reason": reason.strip()[:MAX_REASON_CHARS]}


def score_talk(title: str, abstract: str | None, length_min: int) -> dict:
    base_url, api_key, model = config()
    if not api_key:
        raise ApiError(
            503,
            "LLM_NOT_CONFIGURED",
            "no AI scoring key is configured; set AGENDA_LLM_API_KEY or GROQ_API_KEY, "
            "or enter interest and heavy by hand",
            [],
        )
    content = _chat_completion(base_url, api_key, model, _messages(title, abstract, length_min))
    return _validated(_extract(content))
