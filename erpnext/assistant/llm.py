# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Client for a local Ollama server. Nothing here talks to a remote service.

Site config (all optional):
	assistant_llm_url    base URL of the Ollama server, default http://127.0.0.1:11434
	assistant_llm_model  model to use; by default the best installed one from PREFERRED_MODELS
"""

import json
import time
from typing import Any

import frappe
import requests
from frappe import _

DEFAULT_URL = "http://127.0.0.1:11434"

# Keep this in step with the model warm-up in start-erpnext.command: asking Ollama for a different context
# size reloads the model, and the default (40k) needs ~6 GB more memory than this.
NUM_CTX = 4096

# Best first. Used only when `assistant_llm_model` is not set.
PREFERRED_MODELS = ("qwen3:14b", "qwen3:8b", "gemma4-e2b")

# Ollama is often shared with other tools (editors, agents) that can keep a big model busy for a minute or
# more. So the best model gets a short first try; if it does not answer, the next one takes over, and the
# slow one is left alone for a while. A model set in `assistant_llm_model` is always used on its own.
FIRST_TRY_SECONDS = 20
BUSY_FOR_SECONDS = 120
_busy_until: dict[str, float] = {}


class LLMError(Exception):
	"""The local model could not answer. The message is safe to show to the user."""


def _base_url() -> str:
	return (frappe.conf.get("assistant_llm_url") or DEFAULT_URL).rstrip("/")


def _bare(name: str) -> str:
	return name.removesuffix(":latest")


def pick_model(available: list[str], configured: str | None = None) -> str | None:
	"""The configured model, else the best installed preferred one, else whatever is installed."""
	if configured:
		return configured
	installed = {_bare(name): name for name in available}
	for preferred in PREFERRED_MODELS:
		if preferred in installed:
			return installed[preferred]
	return available[0] if available else None


def list_models() -> list[str]:
	try:
		response = requests.get(f"{_base_url()}/api/tags", timeout=3)
		response.raise_for_status()
		return [model["name"] for model in response.json().get("models", [])]
	except requests.RequestException as e:
		raise LLMError(_unreachable_message()) from e


def _unreachable_message() -> str:
	return _("The local model server isn't running. Start it with `ollama serve`, then try again.")


def status() -> dict[str, Any]:
	"""Is the local model reachable, and which model would answer?"""
	try:
		models = list_models()
	except LLMError as e:
		return {"ok": False, "model": None, "models": [], "message": str(e)}
	model = pick_model(models, frappe.conf.get("assistant_llm_model"))
	if not model:
		message = _("No local model is installed. Run `ollama pull qwen3:14b`.")
		return {"ok": False, "model": None, "models": models, "message": message}
	return {"ok": True, "model": model, "models": models, "message": ""}


def candidate_models(available: list[str], configured: str | None = None) -> list[str]:
	"""Models to try, best first. One that recently timed out goes to the back of the line."""
	if configured:
		return [configured]
	installed = {_bare(name): name for name in available}
	ordered = [installed[p] for p in PREFERRED_MODELS if p in installed]
	ordered += [name for name in available if name not in ordered]
	now = time.monotonic()
	return sorted(ordered, key=lambda name: _busy_until.get(name, 0) > now)  # stable: keeps preference order


def _ask(
	model: str, messages: list[dict[str, str]], schema: dict[str, Any], temperature: float, timeout: float
) -> dict[str, Any]:
	body = {
		"model": model,
		"messages": messages,
		"stream": False,
		"format": schema,
		"think": False,  # skip the slow "reasoning" preamble on models that have one
		"keep_alive": "30m",
		"options": {"temperature": temperature, "num_ctx": NUM_CTX},
	}
	try:
		response = requests.post(f"{_base_url()}/api/chat", json=body, timeout=timeout)
	except requests.ConnectionError as e:
		raise LLMError(_unreachable_message()) from e

	if response.status_code == 404:
		raise LLMError(_("The model {0} isn't installed. Run `ollama pull {0}`.").format(model))
	if response.status_code != 200:
		raise LLMError(_("The local model returned an error ({0}).").format(response.status_code))

	try:
		data = json.loads(response.json().get("message", {}).get("content", ""))
	except ValueError as e:
		raise LLMError(_("The model gave an unreadable answer. Try rephrasing.")) from e
	if not isinstance(data, dict):
		raise LLMError(_("The model gave an unreadable answer. Try rephrasing."))
	return data


def chat_json(
	messages: list[dict[str, str]], schema: dict[str, Any], *, temperature: float = 0.1, timeout: int = 60
) -> dict[str, Any]:
	"""Ask the local model for a JSON object that matches `schema` (enforced by the server)."""
	configured = frappe.conf.get("assistant_llm_model")
	models = candidate_models([] if configured else list_models(), configured)
	if not models:
		raise LLMError(_("No local model is installed. Run `ollama pull qwen3:14b`."))

	for index, model in enumerate(models):
		last = index == len(models) - 1
		try:
			return _ask(model, messages, schema, temperature, timeout if last else FIRST_TRY_SECONDS)
		except requests.Timeout:
			_busy_until[model] = time.monotonic() + BUSY_FOR_SECONDS
	raise LLMError(
		_("The local model took too long to answer (another app may be using it). Try again in a moment.")
	)
