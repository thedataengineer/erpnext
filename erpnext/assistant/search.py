# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Search anything, and do anything: what the command bar shows as you type.

Three kinds of answer share one box: records (CRM first, only what the person may read), things they can
do ("New lead", "Log a call"), and, when the text reads like a request, an option to hand the whole
sentence to the assistant. Records come from `records.py`, the same source the conversation uses to match
names, so "Acme" means the same thing in both.
"""

from dataclasses import dataclass
from typing import Any

import frappe
from frappe import _
from rapidfuzz import fuzz

from erpnext.assistant import engine
from erpnext.assistant.parsing import clean_text
from erpnext.assistant.records import CRM_KINDS, Kind, fetch, readable_kinds

PER_KIND = 4
RECENT = 6
RECENT_KINDS = (
	"Lead",
	"Opportunity",
	"Prospect",
	"Customer",
)  # a lead's auto-made Contact would just repeat it
MIN_ACTION_SCORE = 70


@dataclass(frozen=True)
class Do:
	label: str
	hint: str
	words: tuple[str, ...]  # what people type on the way to it
	action: dict[str, Any]
	needs: tuple[str, str]  # (doctype, permission) the person must have
	crm: bool = True


def catalogue() -> list[Do]:
	"""Everything the bar can start, CRM first. Built per call so labels follow the user's language."""

	def start(recipe: str, **values: Any) -> dict[str, Any]:
		return {"type": "start", "recipe": recipe, "values": values}

	return [
		Do(
			_("New lead"),
			_("A person or company who might buy"),
			("new lead", "lead", "add lead", "prospect"),
			start("create_lead"),
			("Lead", "create"),
		),
		Do(
			_("Log a call"),
			_("Note what was said in a call or meeting"),
			("log call", "call", "note", "meeting", "spoke", "log note"),
			start("log_note", kind="Call"),
			("Comment", "create"),
		),
		Do(
			_("Follow up"),
			_("Remind yourself to chase someone"),
			("follow up", "remind", "chase", "reminder", "callback"),
			start("follow_up"),
			("ToDo", "create"),
		),
		Do(
			_("New opportunity"),
			_("A potential deal, with a value"),
			("opportunity", "deal", "new deal", "sale"),
			start("create_opportunity"),
			("Opportunity", "create"),
		),
		Do(
			_("Pipeline"),
			_("Open deals and what they are worth"),
			("pipeline", "deals", "funnel", "opportunities"),
			{"type": "query", "name": "pipeline"},
			("Opportunity", "read"),
		),
		Do(
			_("My day"),
			_("What is open and what is overdue"),
			("my day", "tasks", "plate", "today", "to do"),
			{"type": "query", "name": "my_day"},
			("Task", "read"),
		),
		Do(
			_("My emails"),
			_("What people have written to you"),
			("emails", "email", "inbox", "mail", "replies", "messages"),
			{"type": "query", "name": "emails"},
			("Communication", "read"),
		),
		Do(
			_("Connect my email"),
			_("Sync a mailbox so its mail shows on your leads"),
			("connect email", "sync email", "email sync", "mailbox", "gmail", "outlook", "imap"),
			{"type": "query", "name": "connect_email"},
			("Email Account", "create"),
		),
		Do(
			_("Log time"),
			_("Hours worked on a project"),
			("log time", "time", "hours", "timesheet"),
			start("log_time"),
			("Timesheet", "create"),
			crm=False,
		),
		Do(
			_("Add task"),
			_("Something to do on a project"),
			("task", "add task", "new task", "todo"),
			start("create_task"),
			("Task", "create"),
			crm=False,
		),
		Do(
			_("New project"),
			_("Start an engagement"),
			("project", "new project", "engagement"),
			start("create_project"),
			("Project", "create"),
			crm=False,
		),
		Do(
			_("New client"),
			_("Add a customer"),
			("client", "customer", "new client", "new customer"),
			start("create_customer"),
			("Customer", "create"),
			crm=False,
		),
		Do(
			_("This week"),
			_("Hours you have logged"),
			("hours this week", "week", "my hours"),
			{"type": "query", "name": "hours_summary"},
			("Timesheet", "read"),
			crm=False,
		),
	]


def _typed_score(query: str, do: Do) -> float:
	"""How well what the person has typed so far leads to this action (prefix > contains > fuzzy)."""
	best = 0.0
	for word in (*do.words, do.label.casefold()):
		if word.startswith(query):
			best = max(best, 100)
		elif query in word:
			best = max(best, 90)
		else:
			best = max(best, fuzz.partial_ratio(query, word) * 0.8)
	return best


def _actions(query: str, context: dict[str, str] | None) -> list[dict[str, Any]]:
	allowed = [do for do in catalogue() if frappe.has_permission(*do.needs)]
	if query:
		folded = query.casefold()
		scored = [(do, _typed_score(folded, do)) for do in allowed]
		chosen = [do for do, score in sorted(scored, key=lambda pair: -pair[1]) if score >= MIN_ACTION_SCORE][
			:3
		]
	else:
		viewing_crm = bool(context and context["doctype"] in CRM_KINDS)
		# looking at a lead or customer: what you do next is log a call or follow up, not add another lead
		chosen = [do for do in allowed if do.crm][:6]
		if viewing_crm:
			chosen = sorted(chosen, key=lambda do: do.action.get("recipe") not in ("log_note", "follow_up"))
	return [{"label": do.label, "hint": do.hint, "action": do.action} for do in chosen]


def _item(kind: Kind, row: dict[str, Any]) -> dict[str, Any]:
	return {
		"doctype": kind.doctype,
		"name": row["name"],
		"title": kind.title(row),
		"subtitle": kind.subtitle(row),
		"route": ["Form", kind.doctype, row["name"]],
	}


def _rank(query: str, kind: Kind, row: dict[str, Any]) -> float:
	title = kind.title(row).casefold()
	folded = query.casefold()
	bonus = 30 if title.startswith(folded) else 15 if folded in title else 0
	return fuzz.WRatio(folded, title) + bonus


def _pages(query: str, kinds: list[Kind]) -> list[dict[str, Any]]:
	"""Typing "leads" should offer the list of leads."""
	folded = query.casefold()
	pages = []
	for kind in kinds:
		names = (kind.plural.casefold(), kind.doctype.casefold())
		if any(name.startswith(folded) for name in names) and len(folded) >= 3:
			pages.append(
				{
					"doctype": kind.doctype,
					"name": kind.plural,
					"title": _("All {0}").format(_(kind.plural)),
					"subtitle": _("List"),
					"route": ["List", kind.doctype],
				}
			)
	return pages


def looks_like_request(text: str) -> bool:
	"""A sentence to hand to the assistant, not a name to look up."""
	folded = text.casefold()
	return (
		bool(engine.NEW_REQUEST.match(folded))
		or any(cue.search(folded) for cue in engine.QUERY_CUES.values())
		or len(text.split()) >= 4
	)


def search(query: str | None = "", context: Any = None) -> dict[str, Any]:
	"""What to show for `query`. Empty means the bar was just opened: recent records and what to do next."""
	text = clean_text(query, 100) or ""
	ctx = engine.clean_context(context)
	kinds = readable_kinds()
	if ctx:  # the kind being looked at goes first
		kinds.sort(key=lambda kind: kind.doctype != ctx["doctype"])

	groups: list[dict[str, Any]] = []
	if text:
		if pages := _pages(text, kinds):
			groups.append({"doctype": None, "label": _("Go to"), "items": pages[:2]})
		for kind in kinds:
			if len(text) < kind.min_chars:
				continue
			rows = fetch(kind, text, limit=15)
			rows.sort(key=lambda row: -_rank(text, kind, row))
			if rows:
				items = [_item(kind, row) for row in rows[:PER_KIND]]
				groups.append({"doctype": kind.doctype, "label": _(kind.plural), "items": items})
	else:
		recent = []
		for kind in kinds:
			if kind.doctype in RECENT_KINDS:
				recent += [(str(row["modified"]), kind, row) for row in fetch(kind, limit=RECENT)]
		recent.sort(key=lambda entry: entry[0], reverse=True)
		if recent:
			groups.append(
				{
					"doctype": None,
					"label": _("Recent"),
					"items": [_item(kind, row) for _m, kind, row in recent[:RECENT]],
				}
			)

	return {
		"query": text,
		"actions": _actions(text, ctx),
		"groups": groups,
		"ask": {"text": text, "primary": looks_like_request(text)} if text else None,
	}
