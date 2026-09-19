# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Endpoints for the desk chat panel. Every call runs as the logged-in user, so the person can only
see and create what their roles already allow."""

from typing import Any

import frappe

from erpnext.assistant import engine, llm
from erpnext.assistant import search as search_module


def _parse(value: str | dict | None) -> Any:
	return frappe.parse_json(value) if isinstance(value, str) else value


@frappe.whitelist()
def status() -> dict[str, Any]:
	"""Is the local model reachable, and which one would answer?"""
	return llm.status()


@frappe.whitelist()
def search(query: str | None = "", context: str | dict | None = None) -> dict[str, Any]:
	"""Records and actions matching what has been typed so far. Cheap: it never calls the language model."""
	return search_module.search(query, _parse(context))


@frappe.whitelist(methods=["POST"])
def chat(
	message: str | None = None,
	action: str | dict | None = None,
	state: str | dict | None = None,
	context: str | dict | None = None,
) -> dict[str, Any]:
	"""One turn of the conversation. Send either free text (`message`) or a tapped suggestion (`action`),
	plus the `state` returned by the previous turn."""
	try:
		return engine.respond(
			message=message, action=_parse(action), state=_parse(state), context=_parse(context)
		)
	except llm.LLMError as e:
		result = engine._response(engine.sanitize_state(_parse(state)), str(e))
		result["error"] = True
		return result


@frappe.whitelist(methods=["POST"])
def create(state: str | dict) -> dict[str, Any]:
	"""Save the current draft as a real document. Nothing is created unless it is complete and valid."""
	return engine.create(_parse(state))
