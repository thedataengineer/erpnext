# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""The conversation engine: one message in, one short reply plus a draft card out.

The language model does only two small jobs: work out what the person wants (`classify`) and pull a few
fields out of their sentence (`extract`). Everything else is plain code, so it is fast, predictable and
checkable: date maths, matching "Acme" to a real customer, defaults, permission checks, validation and the
wording of every reply. The model never writes anything: it can only fill in a draft that the person confirms.

The engine is stateless. The client sends back the `state` it was given last time (the draft being filled
in, and any drafts parked behind it). It is untrusted input and is re-checked on every turn.
"""

import copy
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import frappe
from frappe import _
from frappe.query_builder.functions import Sum
from frappe.utils import getdate, nowdate, strip_html
from rapidfuzz import fuzz, process
from rapidfuzz import utils as fuzz_utils

from erpnext.assistant import llm as llm_module
from erpnext.assistant import mail
from erpnext.assistant.parsing import (
	clean_text,
	find_amount,
	find_date,
	find_hours,
	format_date,
	format_hours,
	parse_amount,
	parse_date,
	parse_hours,
)
from erpnext.assistant.recipes import CREATE_FOR_LINK, QUERIES, RECIPES, Field, Recipe
from erpnext.assistant.records import KINDS, fetch, make_ref, split_ref

LLM = Callable[[list[dict[str, str]], dict[str, Any]], dict[str, Any]]

MAX_STACK = 3  # drafts parked behind the current one ("create this project first, then log the time")
MAX_MESSAGE = 1000
AUTO_ACCEPT = 90  # a name match at least this good, and clearly ahead of the runner-up, is used as is
CLEAR_LEAD = 8
MIN_CANDIDATE = 60  # below this a record is not even offered as a suggestion
SAVEPOINT = "assistant_dry_run"

CANCEL_WORDS = {"cancel", "discard", "never mind", "nevermind", "forget it", "drop it", "stop", "abort"}
CONFIRM_WORDS = {"yes", "y", "yep", "yeah", "ok", "okay", "sure", "create", "create it", "confirm", "go",
	"do it", "save", "save it", "looks good", "yes please"}  # fmt: skip
HELP_WORDS = {"help", "?", "hi", "hello", "hey"}

# Phrases that are clearly a question, not an answer to whatever we just asked (works without the model)
QUERY_CUES = {
	"my_day": re.compile(
		r"\b(my (day|tasks?|plate|to-?do)|what('?s| is) on my|what (should|do) i (do|work))\b"
	),
	"hours_summary": re.compile(r"\b(how many hours|hours (this|so far)|my (hours|timesheets?))\b"),
	"pipeline": re.compile(
		r"\b(pipeline|open (deals|opportunities)|(deals|opportunities) (are )?open|the funnel)\b"
	),
	# checked in this order: "sync my email" is a request to connect, "my emails" a question about mail
	"connect_email": mail.CONNECT_CUE,
	"emails": mail.EMAIL_CUE,
}
# A message that opens like this is a new request, not a reply to our question
NEW_REQUEST = re.compile(
	r"^(log|add|new|create|remind|start|set up|spent|book|schedule|note|opportunity|lead|deal"
	r"|just (spoke|met|called)|i (spent|worked|spoke|met|called))\b"
)

# --- state ---------------------------------------------------------------------------------------


def empty_state() -> dict[str, Any]:
	return {"recipe": None, "values": {}, "stack": [], "asking": None}


def _clean_draft(key: Any, values: Any) -> tuple[str | None, dict[str, Any]]:
	if key not in RECIPES:
		return None, {}
	clean: dict[str, Any] = {}
	if isinstance(values, dict):
		for name in RECIPES[key].field_names:
			value = values.get(name)
			if isinstance(value, int | float) and not isinstance(value, bool):
				clean[name] = value
			elif (text := clean_text(value)) is not None:
				clean[name] = text
	return key, clean


def sanitize_state(raw: Any) -> dict[str, Any]:
	"""Trust nothing from the client: keep only known recipes, known fields and plain values."""
	state = empty_state()
	if not isinstance(raw, dict):
		return state
	state["recipe"], state["values"] = _clean_draft(raw.get("recipe"), raw.get("values"))
	if state["recipe"] and raw.get("asking") in RECIPES[state["recipe"]].field_names:
		state["asking"] = raw["asking"]
	if isinstance(raw.get("stack"), list):
		for item in raw["stack"][:MAX_STACK]:
			if isinstance(item, dict):
				key, values = _clean_draft(item.get("recipe"), item.get("values"))
				if key:
					state["stack"].append({"recipe": key, "values": values})
	return state


# --- what the model does -------------------------------------------------------------------------


def _classify_prompt() -> str:
	return (
		"You route a message from a consultant using their firm's ERP. Reply with JSON "
		'{"intent": ...}. Intents:\n'
		"- log_time: record time worked (hours or minutes spent on a client or project)\n"
		"- create_task: add a to-do, task or reminder about project work\n"
		"- create_project: start a new project or engagement\n"
		"- create_customer: add a new client or customer company\n"
		"- create_lead: add a new sales lead: a person or company who might buy\n"
		"- log_note: record a call, meeting or conversation that already happened with a lead or customer\n"
		"- create_opportunity: a potential deal or sale for a lead or customer, often with a value\n"
		"- follow_up: a reminder to contact or chase someone later (call, email, send something)\n"
		"- create_expense_claim: add an employee expense claim\n"
		"- create_material_request: request stock or materials\n"
		"- create_timesheet_detail: log time against a specific task or project\n"
		f"- my_day: {QUERIES['my_day']}\n"
		f"- hours_summary: {QUERIES['hours_summary']}\n"
		f"- pipeline: {QUERIES['pipeline']}\n"
		f"- emails: {QUERIES['emails']}\n"
		f"- connect_email: {QUERIES['connect_email']}\n"
		"- help: anything else, greetings, or unclear\n"
		"Examples:\n"
		'"2h on the acme rollout" -> log_time\n'
		'"remind me to send the SOW to Globex by friday" -> create_task\n'
		'"new client Initech" -> create_customer\n'
		'"set up a project for Northwind, starts monday" -> create_project\n'
		'"new lead John Smith from Acme, john@acme.com" -> create_lead\n'
		'"just spoke to Globex, they want a proposal by friday" -> log_note\n'
		'"opportunity for Initech: ERP audit, 20k, closing end of month" -> create_opportunity\n'
		'"follow up with Acme next tuesday" -> follow_up\n'
		'"log expense 850 for travel" -> create_expense_claim\n'
		'"request 50 units of item RM-001 for next week" -> create_material_request\n'
		'"log time on task TASK-0032 1.5h" -> create_timesheet_detail\n'
		'"what should I work on" -> my_day\n'
		'"how many hours this week" -> hours_summary\n'
		'"how is my pipeline" -> pipeline'
	)


_CLASSIFY_SCHEMA = {
	"type": "object",
	"properties": {"intent": {"type": "string", "enum": [*RECIPES, *QUERIES, "help"]}},
	"required": ["intent"],
	"additionalProperties": False,
}


def classify(message: str, llm: LLM) -> str:
	out = llm(
		[{"role": "system", "content": _classify_prompt()}, {"role": "user", "content": message}],
		_CLASSIFY_SCHEMA,
	)
	intent = out.get("intent")
	return intent if intent in (*RECIPES, *QUERIES) else "help"


def _schema(recipe: Recipe) -> dict[str, Any]:
	kinds = {"number": "number", "money": "number"}
	return {
		"type": "object",
		"properties": {f.name: {"type": [kinds.get(f.kind, "string"), "null"]} for f in recipe.fields},
		"required": list(recipe.field_names),
		"additionalProperties": False,
	}


def _extraction_prompt(recipe: Recipe, state: dict[str, Any], today: date) -> str:
	lines = [
		f"Extract the fields for {recipe.what} from the user's message. "
		f"Today is {today.strftime('%A')} {today.isoformat()}.",
		"Return JSON with exactly these keys, and null for anything the user did not say. "
		"Never guess or invent values.",
	]
	lines += [f"- {f.name}: {f.hint}" for f in recipe.fields]
	if state["values"]:
		lines.append(f"The draft so far is {state['values']}. The user may be adding to it or correcting it.")
	if state["asking"]:
		lines.append(
			f'You just asked the user for "{state["asking"]}". If their message is a short answer, '
			"put it in that field."
		)
	return "\n".join(lines)


def extract(recipe: Recipe, message: str, state: dict[str, Any], today: date, llm: LLM) -> dict[str, Any]:
	messages = [
		{"role": "system", "content": _extraction_prompt(recipe, state, today)},
		{"role": "user", "content": message},
	]
	out = llm(messages, _schema(recipe))
	return {name: out[name] for name in recipe.field_names if out.get(name) not in (None, "", [])}


def _backstop(
	recipe: Recipe, message: str, extracted: dict[str, Any], state: dict[str, Any], today: date
) -> dict[str, Any]:
	"""Overrule the model where code is more reliable: explicit durations, relative dates, and a bare
	answer to the question we just asked."""
	command = message.casefold().strip(" .!")
	for f in recipe.fields:  # a bare command ("new lead") is not a value; the model sometimes echoes it back
		if (
			f.kind == "text"
			and f.name != state["asking"]
			and str(extracted.get(f.name, "")).casefold() == command
		):
			del extracted[f.name]
	for f in recipe.fields:  # a language model likes to "helpfully" guess optional details: drop the guesses
		if f.grounded and f.name in extracted and str(extracted[f.name]).casefold() not in message.casefold():
			del extracted[f.name]
	for f in recipe.fields:  # fixed-shape values (email, phone): the sentence decides, not the model
		if f.pattern:
			if found := re.search(f.pattern, message):
				extracted[f.name] = found.group(0).strip()
			else:
				extracted.pop(f.name, None)
	date_fields = [f for f in recipe.fields if f.kind == "date"]
	if len(date_fields) == 1 and (found := find_date(message, today, date_fields[0].prefer)):
		extracted[date_fields[0].name] = found.isoformat()
	if (hours := find_hours(message)) is not None:
		for f in recipe.fields:
			if f.kind == "number":
				extracted[f.name] = hours

	if (amount := find_amount(message)) is not None:
		for f in recipe.fields:
			if f.kind == "money":
				extracted[f.name] = amount

	asking = state["asking"]
	if asking and not extracted and len(message) <= 80:
		f = recipe.field(asking)
		if f.kind in ("text", "link", "choice"):
			extracted[asking] = message
		elif f.kind == "number" and (hours := parse_hours(message)) is not None:
			extracted[asking] = hours
		elif f.kind == "money" and (amount := parse_amount(message)) is not None:
			extracted[asking] = amount
		elif f.kind == "date" and (day := parse_date(message, today, f.prefer)):
			extracted[asking] = day.isoformat()
	return extracted


# --- reading values ------------------------------------------------------------------------------


def normalize(recipe: Recipe, raw: dict[str, Any], today: date) -> tuple[dict[str, Any], dict[str, Any]]:
	"""Turn what was said into clean values. Returns (clean, invalid): `invalid` holds what could not be read."""
	clean: dict[str, Any] = {}
	invalid: dict[str, Any] = {}
	for f in recipe.fields:
		value = raw.get(f.name)
		if value in (None, ""):
			continue
		if f.kind == "number":
			hours = parse_hours(value)
			if hours is None:
				invalid[f.name] = value
			else:
				clean[f.name] = hours
		elif f.kind == "money":
			amount = parse_amount(value)
			if amount is None:
				invalid[f.name] = value
			else:
				clean[f.name] = amount
		elif f.kind == "date":
			day = parse_date(value, today, f.prefer)
			if day is None:
				invalid[f.name] = value
			else:
				clean[f.name] = day.isoformat()
		elif f.kind == "choice":
			match = next((c for c in f.choices if c.casefold() == str(value).strip().casefold()), None)
			if match is None:
				invalid[f.name] = value
			else:
				clean[f.name] = match
		elif (text := clean_text(value, 140 if f.kind == "link" else 500)) is not None:
			clean[f.name] = text
	return clean, invalid


@dataclass
class LinkMatch:
	status: str  # ok | empty | none | ambiguous
	query: str = ""
	name: str = ""
	label: str = ""
	candidates: list[tuple[str, str]] = field(default_factory=list)  # (record name, label)
	note: str = ""


_GENERIC = re.compile(
	r"\b(corp|corporation|inc|incorporated|llc|ltd|limited|co|company|gmbh|plc|the)\b\.?", re.I
)


def _head(label: str) -> str:
	"""A label without its kind tag: "Acme Corp · Customer" is just "Acme Corp"."""
	head, sep, tail = label.rpartition(" · ")
	return head if sep and tail in {*KINDS, *(_(doctype) for doctype in KINDS)} else label


def _core(label: str) -> str:
	"""A name without legal filler, to tell a real match from one that only shares "Corp" or "Inc"."""
	label = _head(label)
	return fuzz_utils.default_process(_GENERIC.sub(" ", label)) or fuzz_utils.default_process(label)


def match_candidate(query: str, candidates: list[tuple[str, str]]) -> LinkMatch:
	"""Match what the person typed against real records. Exact names win; otherwise fuzzy matching is
	trusted only when it is both strong and clearly ahead of the runner-up, else the person picks."""
	query = query.strip()
	folded = query.casefold()
	exact = [c for c in candidates if folded in (c[0].casefold(), _head(c[1]).casefold())]
	if len(exact) == 1:
		return LinkMatch("ok", query, exact[0][0], exact[0][1])
	if len(exact) > 1:
		return LinkMatch("ambiguous", query, candidates=exact[:4])

	hits = process.extract(
		query,
		[_head(label) for _name, label in candidates],
		scorer=fuzz.WRatio,
		processor=fuzz_utils.default_process,
		limit=8,
		score_cutoff=MIN_CANDIDATE,
	)
	core = _core(query)  # "Zeta Corp" vs "Acme Corp" only agree on "Corp": not a match
	hits = [hit for hit in hits if fuzz.WRatio(core, _core(candidates[hit[2]][1])) >= MIN_CANDIDATE][:5]
	if not hits:
		return LinkMatch("none", query)
	runner_up = hits[1][1] if len(hits) > 1 else 0
	if hits[0][1] >= AUTO_ACCEPT and hits[0][1] - runner_up >= CLEAR_LEAD:
		name, label = candidates[hits[0][2]]
		return LinkMatch("ok", query, name, label, note=_("matched “{0}”").format(_head(label)))
	return LinkMatch("ambiguous", query, candidates=[candidates[hit[2]] for hit in hits[:4]])


def _multi_candidates(f: Field) -> list[tuple[str, str]]:
	"""Records of every kind this link may point at, most recently touched first, as (Doctype::name, label)."""
	found = []
	for doctype in f.link_doctypes:
		if not (kind := KINDS.get(doctype)):
			continue
		for row in fetch(kind, limit=100):
			label = f"{kind.label_of(row)} · {_(doctype)}"
			found.append((str(row["modified"]), make_ref(doctype, row["name"]), label))
	found.sort(reverse=True)
	return [(ref, label) for _modified, ref, label in found]


def fetch_candidates(f: Field, extra_filters: dict[str, Any] | None = None) -> list[tuple[str, str]]:
	"""Records this person can see, most recently touched first, as (name, label)."""
	if f.link_doctypes:
		return _multi_candidates(f)
	filters = {**(f.link_filters or {}), **(extra_filters or {})}
	columns = ["name", f.link_label] if f.link_label else ["name"]
	try:
		rows = frappe.get_list(
			f.link_doctype, filters=filters, fields=columns, order_by="modified desc", limit_page_length=300
		)
	except frappe.PermissionError:
		return []
	return [(row.name, (row.get(f.link_label) if f.link_label else None) or row.name) for row in rows]


def _resolve_ref(f: Field, value: str) -> LinkMatch | None:
	"""A 'Doctype::name' reference (a tapped suggestion, or the record being viewed) is checked directly."""
	ref = split_ref(value)
	if not ref or ref[0] not in f.link_doctypes:
		return None
	doctype, name = ref
	rows = fetch(KINDS[doctype], filters={"name": name}, limit=1)
	if not rows:
		return LinkMatch("none", name)
	return LinkMatch("ok", value, value, f"{KINDS[doctype].label_of(rows[0])} · {_(doctype)}")


def resolve_links(recipe: Recipe, clean: dict[str, Any]) -> dict[str, LinkMatch]:
	matches: dict[str, LinkMatch] = {}
	for f in recipe.fields:
		if f.kind != "link":
			continue
		extra: dict[str, Any] = {}
		if f.narrow_by and (other := matches.get(f.narrow_by[0])) and other.status == "ok":
			extra = {f.narrow_by[1]: other.name}  # "for Acme": only offer Acme's projects
		candidates = fetch_candidates(f, extra)

		if not (query := clean.get(f.name)):
			if extra and len(candidates) == 1 and f.required:
				name, label = candidates[0]
				matches[f.name] = LinkMatch("ok", "", name, label, note=_("their only project"))
			else:
				matches[f.name] = LinkMatch("empty", candidates=candidates[:4])
			continue

		match = (_resolve_ref(f, query) if f.link_doctypes else None) or match_candidate(query, candidates)
		if match.status == "none" and extra:  # not one of this client's: look everywhere
			match = match_candidate(query, fetch_candidates(f))
		matches[f.name] = match
	return matches


# --- evaluating a draft --------------------------------------------------------------------------


@dataclass
class Evaluation:
	recipe: Recipe
	values: dict[str, Any]
	matches: dict[str, LinkMatch]
	defaulted: set[str]
	invalid: dict[str, Any]
	missing: list[str]  # required, and nothing usable yet
	unresolved: list[str]  # links the person named that did not match a record
	permitted: bool
	doc: dict[str, Any] | None = None
	problems: list[str] = field(default_factory=list)  # what validation said when we tried it

	@property
	def ready(self) -> bool:
		return self.permitted and self.doc is not None and not self.problems and not self.attention

	@property
	def attention(self) -> list[str]:
		"""Fields that need the person's input, in form order."""
		blocked = {*self.invalid, *self.missing, *self.unresolved}
		return [name for name in self.recipe.field_names if name in blocked]


def _prune(value: Any) -> Any:
	"""Drop empty values from a document dict, including inside child rows."""
	if isinstance(value, dict):
		return {k: _prune(v) for k, v in value.items() if v not in (None, "", [])}
	if isinstance(value, list):
		return [_prune(v) for v in value]
	return value


def dry_run(doc: dict[str, Any]) -> list[str]:
	"""Try saving the document exactly as it would be, then roll everything back. Returns what went wrong."""
	frappe.db.savepoint(SAVEPOINT)
	try:
		frappe.get_doc(copy.deepcopy(doc)).insert()
		return []
	except frappe.PermissionError:
		return [_("You don't have permission to create this.")]
	except frappe.ValidationError as e:
		return [strip_html(str(e)).strip() or _("It could not be saved.")]
	except Exception:
		frappe.log_error(title="Assistant dry run failed")
		return [_("Something went wrong while checking this. Try opening the full form.")]
	finally:
		frappe.db.rollback(save_point=SAVEPOINT)
		frappe.clear_messages()


def evaluate(state: dict[str, Any], today: date) -> Evaluation:
	recipe = RECIPES[state["recipe"]]
	permitted = bool(frappe.has_permission(recipe.doctype, "create"))
	clean, invalid = normalize(recipe, state["values"], today)

	defaults = {k: v for k, v in recipe.defaults(today).items() if k not in invalid}
	defaulted = {k for k in defaults if k not in clean}
	for key, value in defaults.items():
		clean.setdefault(key, value)

	matches = resolve_links(recipe, clean)
	resolved = dict(clean)
	for name, match in matches.items():
		if match.status == "ok":
			resolved[name] = match.name
		else:
			resolved.pop(name, None)

	missing: list[str] = []
	unresolved: list[str] = []
	for f in recipe.fields:
		if f.name in invalid or f.only_hint:
			continue
		if f.kind == "link" and matches[f.name].status in ("none", "ambiguous"):
			unresolved.append(f.name)  # they named something we could not place
		elif f.required and f.name not in resolved:
			missing.append(f.name)

	if recipe.any_of and not any(name in resolved for name in recipe.any_of):
		missing.append(recipe.any_of[0])  # a lead needs a person, a company or an email: ask for the first

	evaluation = Evaluation(recipe, clean, matches, defaulted, invalid, missing, unresolved, permitted)
	evaluation.doc = _prune(recipe.build(resolved)) if permitted else None
	if permitted and not evaluation.attention:
		evaluation.problems = dry_run(evaluation.doc)
	return evaluation


# --- replying ------------------------------------------------------------------------------------


def _display(ev: Evaluation) -> dict[str, str]:
	"""Human-readable values for the card and the confirmation sentence."""
	shown: dict[str, str] = {}
	for f in ev.recipe.fields:
		if f.kind == "link":
			match = ev.matches[f.name]
			if match.status == "ok":
				shown[f.name] = match.label
		elif f.name in ev.values:
			value = ev.values[f.name]
			shown[f.name] = (
				format_hours(value)
				if f.kind == "number"
				else frappe.utils.fmt_money(value, currency=frappe.db.get_default("currency"))
				if f.kind == "money"
				else format_date(value)
				if f.kind == "date"
				else str(value)
			)
	for name in ev.recipe.subject_fields:
		if shown.get(name):
			shown["subject"] = shown[name]
			break
	return shown


def build_card(ev: Evaluation) -> dict[str, Any]:
	shown = _display(ev)
	rows = []
	for f in ev.recipe.fields:
		row: dict[str, Any] | None = None
		if f.kind == "link":
			match = ev.matches[f.name]
			if match.status == "ok":
				row = {"value": match.label, "status": "ok", "note": match.note}
			elif match.status in ("none", "ambiguous"):
				row = {"value": match.query, "status": match.status, "note": ""}
			elif f.required or f.name in ev.missing:
				row = {"value": "", "status": "missing", "note": ""}
		elif f.name in ev.invalid:
			row = {"value": str(ev.invalid[f.name]), "status": "invalid", "note": ""}
		elif f.name in shown:
			row = {
				"value": shown[f.name],
				"status": "ok",
				"note": _("default") if f.name in ev.defaulted else "",
			}
		elif f.required or f.name in ev.missing:
			row = {"value": "", "status": "missing", "note": ""}
		if row and not (f.only_hint and row["status"] in ("missing", "none", "ambiguous")):
			rows.append({"field": f.name, "label": _(f.label), **row})
	prefill = {k: v for k, v in (ev.doc or {}).items() if k != "doctype"}
	return {
		"recipe": ev.recipe.key,
		"title": _(ev.recipe.label),
		"doctype": ev.recipe.doctype,
		"rows": rows,
		"ready": ev.ready,
		"problems": ev.problems,
		"prefill": prefill or None,
	}


def _chip(label: str, **action: Any) -> dict[str, Any]:
	return {"label": label, "action": action}


def _set_chips(name: str, candidates: list[tuple[str, str]], limit: int = 4) -> list[dict[str, Any]]:
	return [_chip(label, type="set_field", field=name, value=record) for record, label in candidates[:limit]]


_COMPANY_WORDS = re.compile(
	r"\b(inc|llc|ltd|corp|co|gmbh|group|labs|systems|partners|holdings|solutions)\b\.?", re.I
)


def _looks_like_person(name: str) -> bool:
	words = name.split()
	return 2 <= len(words) <= 3 and not _COMPANY_WORDS.search(name) and all(w[:1].isupper() for w in words)


def _create_chips(f: Field, query: str, ev: Evaluation) -> list[dict[str, Any]]:
	"""Offer to create the record the person named but that does not exist yet."""
	chips = []
	for doctype in f.link_doctypes or (f.link_doctype,):
		target = CREATE_FOR_LINK.get(doctype or "")
		if not target or not query or not frappe.has_permission(doctype, "create"):
			continue
		recipe_key, name_field, noun = target
		values = {name_field: query}
		if recipe_key == "create_lead" and not _looks_like_person(query):
			values = {"company": query}  # "Acme" is a company, "Jane Doe" is a person
		if recipe_key == "create_project" and ev.values.get("client"):
			values["customer"] = ev.values["client"]  # "log time for Acme on X": X is Acme's project
		chips.append(
			_chip(
				_("Create {0} “{1}”").format(_(noun), query),
				type="start",
				recipe=recipe_key,
				values=values,
				push=True,
			)
		)
	return chips


def _day_chips(f: Field) -> list[dict[str, Any]]:
	words = ("today", "yesterday") if f.prefer == "past" else ("today", "tomorrow")
	return [_chip(_(word.capitalize()), type="set_field", field=f.name, value=word) for word in words]


def compose(ev: Evaluation) -> tuple[str, list[dict[str, Any]], str | None]:
	"""One short reply, some tap-to-answer chips, and the field we are now asking about."""
	if not ev.permitted:
		return _("You don't have permission to create {0}.").format(_(ev.recipe.doctype)), [], None

	if ev.attention:
		name = ev.attention[0]
		f = ev.recipe.field(name)
		label = _("one") if f.link_doctypes else _(f.label).lower()
		match = ev.matches.get(name)

		if name in ev.invalid:
			reply = _("I couldn't read the {0} “{1}”. What did you mean?").format(label, ev.invalid[name])
			return reply, _day_chips(f) if f.kind == "date" else [], name
		if match and match.status == "ambiguous":
			chips = _set_chips(name, match.candidates)
			if not any(c[1].casefold() == match.query.casefold() for c in match.candidates):
				chips += _create_chips(f, match.query, ev)  # or it may be a new one
			return _("Which {0} did you mean?").format(label), chips, name
		if match and match.status == "none":
			reply = (
				_("I couldn't find “{0}”.").format(match.query)
				if f.link_doctypes
				else _("I couldn't find a {0} called “{1}”.").format(label, match.query)
			)
			chips = _create_chips(f, match.query, ev)
			return reply, chips + _set_chips(name, fetch_candidates(f)[:3], 3), name
		if f.ask and f.kind != "link":
			return f.ask, [], name
		if f.kind == "link":
			candidates = match.candidates if match else []
			reply = f.ask or (
				_("Which {0} is this for?").format(label)
				if candidates
				else _("What's the {0} called?").format(label)
			)
			client = ev.matches.get("client")
			if client and client.status in ("none", "ambiguous") and client.query:
				reply = _("I don't have a client called “{0}”.").format(client.query) + " " + reply
			return reply, _set_chips(name, candidates), name
		if f.kind == "number":
			chips = [_chip(format_hours(h), type="set_field", field=name, value=h) for h in (0.5, 1, 2, 4)]
			return _("How many hours?"), chips, name
		return _("What's the {0}?").format(label), [], name

	if ev.problems:
		return _("I can't save this yet: {0}").format(ev.problems[0]), [], None
	return _("Ready when you are. Say “yes” or tap Create."), [], None


def _response(
	state: dict[str, Any],
	reply: str,
	*,
	card: dict[str, Any] | None = None,
	chips: list[dict[str, Any]] | None = None,
	items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
	return {"reply": reply, "card": card, "chips": chips or [], "items": items or [], "state": state}


def _present(state: dict[str, Any], today: date) -> dict[str, Any]:
	ev = evaluate(state, today)
	reply, chips, asking = compose(ev)
	state["asking"] = asking
	return _response(state, reply, card=build_card(ev), chips=chips)


def _menu_chips() -> list[dict[str, Any]]:
	return [
		_chip(_("New lead"), type="start", recipe="create_lead", values={}),
		_chip(_("Log a call"), type="start", recipe="log_note", values={"kind": "Call"}),
		_chip(_("Follow up"), type="start", recipe="follow_up", values={}),
		_chip(_("New opportunity"), type="start", recipe="create_opportunity", values={}),
		_chip(_("Pipeline"), type="query", name="pipeline"),
		_chip(_("My day"), type="query", name="my_day"),
	]


def _help(state: dict[str, Any], *, confused: bool = False) -> dict[str, Any]:
	opener = _("I didn't quite get that.") if confused else _("Hi!")
	reply = (
		opener
		+ " "
		+ _(
			"I can add leads and opportunities, log calls, set follow-ups, log time and show your "
			"pipeline or your day. Tap one, or just tell me."
		)
	)
	return _response(state, reply, chips=_menu_chips())


# --- questions -----------------------------------------------------------------------------------

_PRIORITY_RANK = {"Urgent": 0, "High": 1, "Medium": 2, "Low": 3}


def my_day(state: dict[str, Any], today: date, message: str = "") -> dict[str, Any]:
	user = frappe.session.user
	try:
		tasks = frappe.get_list(
			"Task",
			filters={"status": ["in", ["Open", "Working", "Overdue"]]},
			or_filters=[["Task", "_assign", "like", f"%{user}%"], ["Task", "owner", "=", user]],
			fields=["name", "subject", "priority", "status", "exp_end_date", "project"],
			limit_page_length=50,
		)
	except frappe.PermissionError:
		return _response(state, _("You don't have access to tasks."))

	if not tasks:
		chips = [_chip(_("Add task"), type="start", recipe="create_task", values={})]
		return _response(state, _("Nothing open. A clear day. Want to add a task?"), chips=chips)

	def due(task) -> date | None:
		return getdate(task.exp_end_date) if task.exp_end_date else None

	def overdue(task) -> bool:
		return task.status == "Overdue" or bool(due(task) and due(task) < today)

	tasks.sort(
		key=lambda t: (not overdue(t), due(t) is None, due(t) or today, _PRIORITY_RANK.get(t.priority, 4))
	)
	late = sum(1 for t in tasks if overdue(t))
	items = []
	for task in tasks[:5]:
		meta = [
			_("Overdue") if overdue(task) else None,
			format_date(due(task)) if due(task) else None,
			task.priority,
		]
		items.append(
			{
				"label": task.subject,
				"meta": " · ".join(m for m in meta if m),
				"route": ["Form", "Task", task.name],
				"tone": "danger" if overdue(task) else "",
			}
		)
	reply = _("{0} open. Start with “{1}”.").format(len(tasks), tasks[0].subject)
	if late:
		reply = _("{0} open, {1} overdue. Start with “{2}”.").format(len(tasks), late, tasks[0].subject)
	return _response(state, reply, items=items)


def hours_summary(state: dict[str, Any], today: date, message: str = "") -> dict[str, Any]:
	if not frappe.has_permission("Timesheet", "read"):
		return _response(state, _("You don't have access to timesheets."))

	week_start = today - timedelta(days=today.weekday())
	Timesheet = frappe.qb.DocType("Timesheet")
	Detail = frappe.qb.DocType("Timesheet Detail")
	rows = (
		frappe.qb.from_(Detail)
		.join(Timesheet)
		.on(Detail.parent == Timesheet.name)
		.select(Detail.project, Sum(Detail.hours))
		.where(
			(Timesheet.owner == frappe.session.user)
			& (Timesheet.docstatus < 2)
			& (Detail.from_time >= week_start)
			& (Detail.from_time < week_start + timedelta(days=7))
		)
		.groupby(Detail.project)
	).run()
	rows = sorted(rows, key=lambda row: float(row[1] or 0), reverse=True)

	if not rows:
		chips = [_chip(_("Log time"), type="start", recipe="log_time", values={})]
		return _response(state, _("Nothing logged this week yet."), chips=chips)

	total = sum(float(hours or 0) for _p, hours in rows)
	items = [
		{
			"label": (frappe.db.get_value("Project", project, "project_name") if project else None)
			or _("No project"),
			"meta": format_hours(round(float(hours or 0), 2)),
			"route": ["Form", "Project", project] if project else None,
			"tone": "",
		}
		for project, hours in rows[:6]
	]
	reply = _("This week: {0} across {1}.").format(
		format_hours(round(total, 2)), _("{0} project(s)").format(len(rows))
	)
	return _response(state, reply, items=items)


def pipeline(state: dict[str, Any], today: date, message: str = "") -> dict[str, Any]:
	if not frappe.has_permission("Opportunity", "read"):
		return _response(state, _("You don't have access to opportunities."))
	try:
		deals = frappe.get_list(
			"Opportunity",
			filters={"status": ["in", ["Open", "Replied", "Quotation"]]},
			fields=[
				"name",
				"title",
				"party_name",
				"status",
				"opportunity_amount",
				"currency",
				"expected_closing",
			],
			limit_page_length=100,
		)
	except frappe.PermissionError:
		return _response(state, _("You don't have access to opportunities."))

	if not deals:
		chips = [_chip(_("New opportunity"), type="start", recipe="create_opportunity", values={})]
		return _response(state, _("No open deals yet. Want to add one?"), chips=chips)

	def money(value) -> str:
		return frappe.utils.fmt_money(value, currency=frappe.db.get_default("currency"))

	deals.sort(key=lambda d: float(d.opportunity_amount or 0), reverse=True)
	total = sum(float(d.opportunity_amount or 0) for d in deals)
	items = []
	for deal in deals[:5]:
		meta = [
			deal.party_name if deal.title else None,
			deal.status,
			money(deal.opportunity_amount) if deal.opportunity_amount else None,
			_("closes {0}").format(format_date(deal.expected_closing)) if deal.expected_closing else None,
		]
		items.append(
			{
				"label": deal.title or deal.party_name or deal.name,
				"meta": " · ".join(m for m in meta if m),
				"route": ["Form", "Opportunity", deal.name],
				"tone": "",
			}
		)
	reply = (
		_("{0} open deals worth {1}.").format(len(deals), money(total))
		if total
		else _("{0} open deals.").format(len(deals))
	)
	return _response(state, reply, items=items)


def emails(state: dict[str, Any], today: date, message: str = "") -> dict[str, Any]:
	"""Recent received email, or what one name sent. What an email says is only ever shown, never sent to the
	model (see mail.py)."""
	answer = mail.emails_answer(mail.term_of(message))
	chips = [_chip(_("Connect my email"), type="query", name="connect_email")] if answer["connect"] else []
	return _response(state, answer["reply"], items=answer["items"], chips=chips)


def connect_email(state: dict[str, Any], today: date, message: str = "") -> dict[str, Any]:
	"""A card that opens the Email Account form, filled in but for the password, which is typed there."""
	answer = mail.connect_answer(message)
	return _response(state, answer["reply"], card=answer["card"], items=answer["items"])


QUERY_HANDLERS = {
	"my_day": my_day,
	"hours_summary": hours_summary,
	"pipeline": pipeline,
	"emails": emails,
	"connect_email": connect_email,
}


# --- the turn ------------------------------------------------------------------------------------


def clean_context(raw: Any) -> dict[str, str] | None:
	"""Which record is the person looking at? Only a known kind of record with a plain name counts."""
	if isinstance(raw, dict) and raw.get("doctype") in KINDS and (name := clean_text(raw.get("name"), 140)):
		return {"doctype": raw["doctype"], "name": name}
	return None


def _seed_context(state: dict[str, Any], context: dict[str, str] | None) -> None:
	"""A new draft about "them" starts on the record in view: "log a call" on Acme's page means Acme."""
	if not context or not state["recipe"]:
		return
	for f in RECIPES[state["recipe"]].fields:
		if f.context and context["doctype"] in f.link_doctypes and f.name not in state["values"]:
			state["values"][f.name] = make_ref(context["doctype"], context["name"])
			return


def _mid_draft(
	message: str, state: dict[str, Any], today: date, llm: LLM, context: dict[str, str] | None = None
) -> dict[str, Any] | None:
	"""While a draft is open, tell answers ("Website Redesign") from a change of subject.

	A question is answered and the draft stays open. A clearly new request parks the draft (it comes back
	when the new one is done). Anything else is an answer for the draft. Short replies never reach the model.
	"""
	lowered = message.casefold()
	intent = next((name for name, cue in QUERY_CUES.items() if cue.search(lowered)), None)
	if intent is None and len(message.split()) >= 3:
		intent = classify(message, llm)

	if intent in QUERY_HANDLERS:
		result = QUERY_HANDLERS[intent](state, today, message)
		ev = evaluate(state, today)
		question, chips, asking = compose(ev)
		state["asking"] = asking
		result["card"] = build_card(ev)
		result["chips"] = chips or result["chips"]
		result["reply"] += " " + _("Your {0} is still open: {1}").format(_(ev.recipe.noun), question)
		return result

	if intent in RECIPES and intent != state["recipe"] and NEW_REQUEST.match(lowered):
		if len(state["stack"]) < MAX_STACK:
			state["stack"].append({"recipe": state["recipe"], "values": state["values"]})
		state.update(recipe=intent, values={}, asking=None)
		_seed_context(state, context)
	return None


def _discard(state: dict[str, Any], today: date) -> dict[str, Any]:
	if state["stack"]:
		parent = state["stack"].pop()
		state.update(recipe=parent["recipe"], values=parent["values"], asking=None)
		result = _present(state, today)
		result["reply"] = _("Dropped. Back to where you were.") + " " + result["reply"]
		return result
	return _response(empty_state(), _("Okay, dropped it."), chips=_menu_chips())


def _apply_action(
	state: dict[str, Any], action: dict[str, Any], today: date, context: dict[str, str] | None = None
) -> dict[str, Any] | None:
	"""Chips send structured actions instead of text, so tapping one never depends on the model."""
	kind = action.get("type")
	if (
		kind == "set_field"
		and state["recipe"]
		and action.get("field") in RECIPES[state["recipe"]].field_names
	):
		_key, values = _clean_draft(state["recipe"], {action["field"]: action.get("value")})
		state["values"].update(values)
		state["asking"] = None
	elif kind == "start" and action.get("recipe") in RECIPES:
		if action.get("push") and state["recipe"] and len(state["stack"]) < MAX_STACK:
			state["stack"].append({"recipe": state["recipe"], "values": state["values"]})
		state["recipe"], state["values"] = _clean_draft(action["recipe"], action.get("values"))
		state["asking"] = None
		_seed_context(state, context)
	elif kind == "discard":
		return _discard(state, today)
	elif kind == "query" and action.get("name") in QUERY_HANDLERS:
		return QUERY_HANDLERS[action["name"]](state, today, clean_text(action.get("q"), MAX_MESSAGE))
	return None


def respond(
	message: str | None = None,
	action: dict[str, Any] | None = None,
	state: Any = None,
	*,
	llm: LLM | None = None,
	today: date | None = None,
	context: Any = None,
) -> dict[str, Any]:
	"""Handle one turn. Returns {reply, card, chips, items, state}.

	`context` says which record the person is looking at, so "log a call" can mean "on this one".
	"""
	llm = llm or llm_module.chat_json
	today = today or getdate(nowdate())
	state = sanitize_state(state)
	message = clean_text(message, MAX_MESSAGE)
	context = clean_context(context)

	if isinstance(action, dict):
		if early := _apply_action(state, action, today, context):
			return early
	elif message:
		spoken = message.casefold().strip(" .!")
		if state["recipe"] and spoken in CANCEL_WORDS:
			return _discard(state, today)
		if state["recipe"] and spoken in CONFIRM_WORDS and evaluate(state, today).ready:
			return create(state, today=today)
		if not state["recipe"] and spoken in HELP_WORDS:
			return _help(state)

		if state["recipe"] and (early := _mid_draft(message, state, today, llm, context)):
			return early

		if not state["recipe"]:
			# well-known questions ("how's my pipeline") are recognised without the model: instant, and they
			# keep working while the model is busy
			intent = next((name for name, cue in QUERY_CUES.items() if cue.search(message.casefold())), None)
			intent = intent or classify(message, llm)
			if intent in QUERY_HANDLERS:
				return QUERY_HANDLERS[intent](state, today, message)
			if intent not in RECIPES:
				return _help(state, confused=True)
			state.update(recipe=intent, values={}, asking=None)
			_seed_context(state, context)

		recipe = RECIPES[state["recipe"]]
		extracted = _backstop(recipe, message, extract(recipe, message, state, today, llm), state, today)
		state["values"].update(_clean_draft(recipe.key, extracted)[1])

	if not state["recipe"]:
		return _help(state)
	return _present(state, today)


class _SafeDict(dict):
	def __missing__(self, key: str) -> str:
		return ""


def create(state: Any, *, today: date | None = None) -> dict[str, Any]:
	"""Save the draft as a real (draft-status) document, as the current user, if it is ready."""
	today = today or getdate(nowdate())
	state = sanitize_state(state)
	if not state["recipe"]:
		return _help(state)

	ev = evaluate(state, today)
	if not ev.ready:
		result = _present(state, today)
		result["created"] = None
		return result

	doc = frappe.get_doc(copy.deepcopy(ev.doc))  # get_doc edits what it is given
	doc.insert()  # permission checks and all validations run here, exactly as in the full form
	sentence = ev.recipe.done.format_map(_SafeDict(_display(ev)))
	shown = doc
	if doc.doctype == "Comment":  # a note is read on the record it is about, not as a record of its own
		shown = frappe._dict(doctype=doc.reference_doctype, name=doc.reference_name)
	created = {"doctype": shown.doctype, "name": shown.name, "route": ["Form", shown.doctype, shown.name]}

	if state["stack"]:
		parent = state["stack"].pop()
		parent_recipe = RECIPES[parent["recipe"]]
		for f in parent_recipe.fields:  # point the parked draft at the record we just made
			if f.kind != "link" or not parent["values"].get(f.name):
				continue
			if f.link_doctype == doc.doctype:
				parent["values"][f.name] = doc.name
			elif doc.doctype in f.link_doctypes:
				parent["values"][f.name] = make_ref(doc.doctype, doc.name)
		state.update(recipe=parent["recipe"], values=parent["values"], asking=None)
		result = _present(state, today)
		result["reply"] = f"{sentence} {result['reply']}"
	else:
		state = empty_state()
		again = _chip(_("Another {0}").format(ev.recipe.noun), type="start", recipe=ev.recipe.key, values={})
		result = _response(state, sentence, chips=[again, *_menu_chips()[-2:]])
	result["created"] = created
	return result
