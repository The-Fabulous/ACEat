"""Copied from Classifi 93d232d; maintained locally in ACEat. See ORIGIN.md."""
import json
import os
from pathlib import Path
import requests

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class LLMRequestError(RuntimeError):
    pass


def load_config() -> dict[str, str]:
    config = {
        "OPENAI_API_KEY": "",
        "OPENAI_BASE_URL": "https://llm.alem.ai/v1",
        "GEMMA_MODEL": "gemma4",
    }
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() in config:
                config[key.strip()] = value.strip().strip("\"'")

    for key in config:
        if key in os.environ:
            config[key] = os.environ[key]
    return config


def request_completion(messages: list[dict[str, str]]) -> str:
    config = load_config()
    api_key = config["OPENAI_API_KEY"]
    if not api_key:
        raise LLMRequestError("API key is missing. Add OPENAI_API_KEY to .env.")

    endpoint = f'{config["OPENAI_BASE_URL"].rstrip("/")}/chat/completions'
    payload = {
        "model": config["GEMMA_MODEL"],
        "messages": messages,
    }
    try:
        response = requests.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        data = response.json()
        content = data["choices"][0]["message"]["content"]
    except requests.RequestException as error:
        if error.response is not None and error.response.status_code in (401, 403):
            message = "The API rejected the key or account access."
        elif error.response is not None and error.response.status_code == 429:
            message = "The API is rate-limited or the account has no available quota."
        elif error.response is not None:
            message = f"The API returned HTTP {error.response.status_code}."
        else:
            message = "Could not connect to the LLM API."
        raise LLMRequestError(message) from error
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise LLMRequestError(
            "The API returned an invalid response or no completion."
        ) from error

    if not isinstance(content, str) or not content.strip():
        raise LLMRequestError("The API returned an empty completion.")
    return content.strip()
