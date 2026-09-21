# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Email in the conversation: ask what someone wrote, and connect a mailbox without a page of settings.

Frappe already does the syncing. An Email Account with IMAP is pulled into Communications every ten minutes
by the scheduler (`email_account.pull`), and each mail is linked (Communication Link) to the Contact, Lead and
Prospect of whoever sent it. This adds the two things that were missing:

- "what did Acme email me?": recent received email, optionally about one name, that the person may read;
- "connect my email": a card that opens the Email Account form with the tedious settings already filled in.

Two rules run through it.

- What an email says is written by whoever sent it, so anyone on the internet can put words in it. It is only
  ever shown (the client escapes it, and it is cut to one short line here), never given to the language model
  and never acted on. The model only ever sees what the signed-in person typed.
- A mailbox password is never asked for in the conversation, so it never passes through the chat, the model
  or the saved conversation state. The card opens the form, and the person types it there.

New mail is only read, never sent: the connect card leaves outgoing mail off.
"""

import re
from typing import Any

import frappe
from frappe import _
from frappe.utils import formatdate

from erpnext.assistant.records import KINDS, _short, fetch

PULL_MINUTES = 10  # how often Frappe's scheduler checks a mailbox (email_account.pull)
MAX_EMAILS = 8
SYNC_NEW_ONLY = "UNSEEN"
INITIAL_SYNC = "100"  # how many old messages the first sync looks at (Frappe offers 100, 250 or 500)

# Where a mail is opened from, best first: the deal or person it is about, then the company or contact.
OPEN_ON = ("Lead", "Opportunity", "Prospect", "Customer", "Contact")

_ADDRESS_RE = r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"
_ADDRESS = re.compile(_ADDRESS_RE)

# --- what people say -----------------------------------------------------------------------------
# These run before the language model, and also while a draft is open, where a match answers the question and
# leaves the person's sentence unused. So they only match whole questions and commands, never a bare mention of
# email inside a note ("new email campaign for Acme", "Have Sam email the client", "Inbox Zero").

_LISTING = re.compile(
	r"^(?:(?:show|list|check|find|see)\s+(?:me\s+)?(?:(?:my|the|any|all)\s+)?"
	r"(?:(?:new|latest|recent|unread|last)\s+)?(?:e-?mails?|mail|inbox|messages)\b"
	r"|(?:any|anything|are there|is there|do i have)\s+(?:(?:new|unread)\s+)?"
	r"(?:e-?mails?|mail|messages|repl(?:y|ies))\b"
	r"|(?:latest|recent|unread|new)\s+(?:e-?mails?|mail|messages)(?:\s+(?:from|about|by)\b|\s*[?.!]*$)"
	r"|my\s+(?:e-?mails?|mail|inbox)\s*[?.!]*$"
	r"|inbox\s*[?.!]*$)"
)
_WHO_DID = re.compile(
	r"^(?:what|which)\s+did\s+.{1,60}?\b(?:e-?mail|write|wrote|send|sent|say|said|repl(?:y|ied)|respond)"
)
_WHO_WROTE = re.compile(r"^who\s+(?:e-?mailed|replied|wrote\s+(?:to|back)|sent\s+(?:me|us))\b")
_DID_THEY = re.compile(
	r"^did\s+.{1,60}?\b(?:e-?mail|write\s+back|write\s+to\s+(?:me|us)|repl(?:y|ied)|respond)\b"
	r"|^(?:has|have)\s+.{1,60}?\b(?:e-?mailed|written\s+back|replied|responded)\b"
)
# Anchored at both ends: "what did Acme Sync email me" and "link the email from Jo to the lead" are not requests
_CONNECT = re.compile(
	r"^(?:(?:please|can you|could you|i want to|i'd like to|i would like to|let's)\s+)*"
	r"(?:connect|link|hook\s*up|sync|set\s*up|setup|add)\s+(?:(?:my|our)\s+)?"
	r"(?:e-?mails?(?:\s+account)?|inbox|mailbox|gmail|outlook)"
	rf"(?:\s+to\s+(?:erpnext|the\s+crm|crm|here|this))?(?:\s+please)?(?:\s+{_ADDRESS_RE})?"
	r"(?:\s+(?:with\s+)?(?:password|passwd|pwd|pw|pass)\b.*)?\s*[.!?]*$"
	rf"|^(?:please\s+)?(?:connect|link|sync)\s+{_ADDRESS_RE}(?:\s+(?:with\s+)?(?:password|passwd|pwd|pw|pass)\b.*)?"
	r"\s*[.!?]*$"
	r"|^e-?mail\s+sync\s*[.!?]*$"
)
_SECRET = re.compile(
	r"\b(?:password|passwd|pwd|passcode|pw|pass|api[ _-]?key|secret|token)\b\s*(?:is|are|=|:)\s*\S+",
	re.IGNORECASE,
)
_PASSWORD_WORD = re.compile(r"\b(?:password|passwd|pwd|passcode|pw|pass)\b", re.IGNORECASE)

_TERMS = (
	re.compile(
		r"\b(?:from|by)\s+(.+?)\s*(?=$|[?.!,]|\s(?:this|last|today|yesterday|recently|lately|please|about|regarding|that|who)\b)",
		re.I,
	),
	re.compile(
		r"^(?:what|which)\s+did\s+(.+?)\s+(?:e-?mail|write|wrote|send|sent|say|said|repl(?:y|ied)|respond)",
		re.I,
	),
	re.compile(
		r"^(?:did|has|have)\s+(.+?)\s+(?:e-?mail(?:ed)?|written|write|repl(?:y|ied)|respond(?:ed)?)", re.I
	),
	re.compile(r"\b(?:about|regarding)\s+(.+?)\s*(?=$|[?.!,])", re.I),
)
_NO_ONE = {
	"me",
	"us",
	"you",
	"them",
	"him",
	"her",
	"it",
	"anyone",
	"anybody",
	"someone",
	"somebody",
	"everyone",
	"everybody",
	"anything",
	"client",
	"clients",
	"customer",
	"customers",
	# "what did the client say by email": the "by" is followed by how, not who
	"email",
	"e-mail",
	"emails",
	"mail",
	"phone",
	"text",
}


def _normal(text: str) -> str:
	return " ".join((text or "").casefold().split())


def is_email_question(text: str) -> bool:
	t = _normal(text)
	return bool(_LISTING.match(t) or _WHO_DID.match(t) or _WHO_WROTE.match(t) or _DID_THEY.match(t))


def is_connect_request(text: str) -> bool:
	return bool(_CONNECT.match(_normal(text)))


def mentions_a_secret(text: str) -> bool:
	"""'the password is hunter2', 'pw: ...', 'token = ...': never worth sending to a model or keeping."""
	return bool(_SECRET.search(text or ""))


class Cue:
	"""Quacks like the compiled patterns in engine.QUERY_CUES, for questions a single regex would get wrong."""

	def __init__(self, test):
		self._test = test

	def search(self, text: str):
		return True if self._test(text) else None


EMAIL_CUE = Cue(is_email_question)
CONNECT_CUE = Cue(is_connect_request)


def address_in(text: str) -> str:
	match = _ADDRESS.search(text or "")
	return match.group(0).lower() if match else ""


def term_of(text: str) -> str:
	"""Who or what the question is about ("what did Acme email me?" -> "Acme"); "" means any mail."""
	if address := address_in(text):
		return address  # a whole address is the term: cutting it at a dot or underscore would match half the world
	for pattern in _TERMS:
		if match := pattern.search(text or ""):
			term = match.group(1).strip(" '\"“”.,?!")
			term = re.sub(r"^(?:the|my|our)\s+", "", term, flags=re.I)
			term = re.sub(r"[’']s$", "", term)
			term = term.replace("%", "")  # a LIKE wildcard is not part of a name
			if term and term.casefold() not in _NO_ONE:
				return _short(term, 60)
	return ""


# --- reading received mail -----------------------------------------------------------------------

_BASE = {
	"communication_type": "Communication",
	"communication_medium": "Email",
	"sent_or_received": "Received",
}
_FIELDS = [
	"name",
	"subject",
	"sender",
	"sender_full_name",
	"communication_date",
	"reference_doctype",
	"reference_name",
	"seen",
]


def _own_addresses() -> list[str]:
	"""The connected mailboxes' own addresses. A reply the owner sent is stored as received mail (it carries
	In-Reply-To), and must not be listed as something a customer wrote."""
	return [
		address.casefold()
		for address in frappe.get_all("Email Account", pluck="email_id", limit_page_length=50)
		if address
	]


def _may_read(name: str) -> bool:
	# get_list applies roles and permission query conditions but not a document's own permission hook
	try:
		return bool(frappe.has_permission("Communication", "read", doc=name))
	except frappe.DoesNotExistError:
		return False


def _matching_records(term: str) -> dict[str, list[str]]:
	"""Leads, customers, opportunities and prospects the person may read whose name matches, by doctype."""
	found: dict[str, list[str]] = {}
	for doctype in ("Lead", "Customer", "Opportunity", "Prospect"):
		if frappe.has_permission(doctype, "read") and (rows := fetch(KINDS[doctype], term, limit=20)):
			found[doctype] = [row["name"] for row in rows]
	return found


def received_emails(term: str = "", limit: int = MAX_EMAILS) -> list[dict[str, Any]] | None:
	"""Newest received emails, only those the person may read. With a term: sent by, or about, or attached
	to a lead, customer, opportunity or prospect that matches it. None when they may not read email."""
	if not frappe.has_permission("Communication", "read"):
		return None
	filters: dict[str, Any] = dict(_BASE)
	if own := _own_addresses():
		filters["sender"] = ["not in", own]

	or_filters = None
	pairs: set[tuple[str, str]] = set()
	on_timeline: set[str] = set()
	if term:
		linked = _matching_records(term)
		pairs = {(doctype, name) for doctype, names in linked.items() for name in names}
		if pairs:
			on_timeline = set(
				frappe.get_all(
					"Communication Link",
					filters={
						"parenttype": "Communication",
						"link_doctype": ["in", list(linked)],
						"link_name": ["in", sorted({name for _doctype, name in pairs})],
					},
					pluck="parent",
					limit_page_length=200,
				)
			)
		like = f"%{term}%"
		or_filters = [["sender", "like", like], ["sender_full_name", "like", like], ["subject", "like", like]]
		if pairs:
			or_filters.append(["reference_name", "in", sorted({name for _doctype, name in pairs})])
		if on_timeline:
			or_filters.append(["name", "in", sorted(on_timeline)])

	rows = frappe.get_list(
		"Communication",
		filters=filters,
		or_filters=or_filters,
		fields=_FIELDS,
		order_by="communication_date desc",
		limit_page_length=limit * 3,
	)

	wanted = term.casefold()

	def belongs(row: dict[str, Any]) -> bool:
		if not term:
			return True
		# a name that merely equals another doctype's name must not pull in that record's mail
		text = " ".join(str(row.get(f) or "") for f in ("sender", "sender_full_name", "subject")).casefold()
		return (
			wanted in text
			or (row.get("reference_doctype"), row.get("reference_name")) in pairs
			or row["name"] in on_timeline
		)

	return [row for row in rows if belongs(row) and _may_read(row["name"])][:limit]


def _links_by_mail(names: list[str]) -> dict[str, list[tuple[str, str]]]:
	"""The records each mail is linked to (Frappe links a mail to the sender's Contact, Lead and Prospect)."""
	if not names:
		return {}
	links: dict[str, list[tuple[str, str]]] = {}
	for row in frappe.get_all(
		"Communication Link",
		filters={"parenttype": "Communication", "parent": ["in", names]},
		fields=["parent", "link_doctype", "link_name"],
		limit_page_length=500,
	):
		links.setdefault(row.parent, []).append((row.link_doctype, row.link_name))
	return links


def _can_open(doctype: str | None, name: str | None) -> bool:
	try:
		return bool(doctype and name and frappe.has_permission(doctype, "read", doc=name))
	except frappe.DoesNotExistError:
		return False


def _open_target(row: dict[str, Any], links: list[tuple[str, str]]) -> list[str]:
	"""Open the record the mail is about if it can be read (the lead, deal, company), else the mail itself."""
	candidates = [(row.get("reference_doctype"), row.get("reference_name")), *links]
	candidates.sort(key=lambda c: OPEN_ON.index(c[0]) if c[0] in OPEN_ON else len(OPEN_ON))
	for doctype, name in candidates:
		if doctype in OPEN_ON and _can_open(doctype, name):
			return ["Form", doctype, name]
	if _can_open(row.get("reference_doctype"), row.get("reference_name")):
		return ["Form", row["reference_doctype"], row["reference_name"]]
	return ["Form", "Communication", row["name"]]


def _who(row: dict[str, Any]) -> str:
	"""The sender's name is whatever they chose to call themselves ("Jane (CFO)"), so the address goes with it."""
	name = _short(row.get("sender_full_name"), 50)
	address = _short(row.get("sender"), 60)
	if name and address and name.casefold() != address.casefold():
		return f"{name} <{address}>"
	return name or address


def email_items(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
	links = _links_by_mail([row["name"] for row in rows])
	items = []
	for row in rows:
		route = _open_target(row, links.get(row["name"], []))
		when = formatdate(row["communication_date"]) if row.get("communication_date") else ""
		about = _(route[1]) if route[1] != "Communication" else None
		items.append(
			{
				"label": _short(row.get("subject")) or _("(no subject)"),
				"meta": " · ".join(p for p in (_who(row), when, about) if p),
				"route": route,
				"tone": "",
			}
		)
	return items


def _count(n: int) -> str:
	return _("1 email") if n == 1 else _("{0} emails").format(n)


def _mailbox_state() -> str:
	"""'live' (a mailbox is being pulled), 'waiting' (set up but its password is not entered yet, so Frappe
	does not pull it) or 'none'."""
	if not frappe.has_permission("Email Account", "read"):
		return "live"  # they cannot tell, and connecting is not theirs to do: do not offer it
	if frappe.db.count("Email Account", {"enable_incoming": 1, "awaiting_password": 0}):
		return "live"
	waiting = frappe.db.count("Email Account", {"enable_incoming": 1, "awaiting_password": 1})
	return "waiting" if waiting else "none"


def emails_answer(term: str = "") -> dict[str, Any]:
	"""{reply, items, connect}: the sentence, the rows to show, and whether to offer connecting a mailbox.
	The reply is built from counts and dates only, never from what an email says."""
	rows = received_emails(term)
	if rows is None:
		return {"reply": _("You don't have access to email."), "items": [], "connect": False}

	if not rows:
		state = _mailbox_state()
		if state == "waiting":
			return {
				"reply": _(
					"Your mailbox is set up but still waiting for its password, so no mail is coming in yet."
				),
				"items": [],
				"connect": True,
			}
		if state == "none":
			return {
				"reply": _("No email is connected yet, so there is nothing to show."),
				"items": [],
				"connect": bool(frappe.has_permission("Email Account", "create")),
			}
		reply = _("Nothing from {0} to show.").format(term) if term else _("No emails to show.")
		reply += " " + _("New mail is checked every {0} minutes.").format(PULL_MINUTES)
		return {"reply": reply, "items": [], "connect": False}

	newest = formatdate(rows[0]["communication_date"]) if rows[0].get("communication_date") else ""
	reply = (
		_("The latest {0} from {1}, newest {2}.").format(_count(len(rows)), term, newest)
		if term
		else _("The latest {0}, newest {1}.").format(_count(len(rows)), newest)
	)
	return {"reply": reply, "items": email_items(rows), "connect": False}


# --- connecting a mailbox ------------------------------------------------------------------------

# the provider names Frappe's Email Account form offers
PROVIDERS = {
	"gmail.com": "GMail",
	"googlemail.com": "GMail",
	"outlook.com": "Outlook.com",
	"hotmail.com": "Outlook.com",
	"live.com": "Outlook.com",
	"msn.com": "Outlook.com",
	"yahoo.com": "Yahoo Mail",
	"ymail.com": "Yahoo Mail",
	"yandex.com": "Yandex.Mail",
	"yandex.ru": "Yandex.Mail",
}
# what Frappe's own Email Account form fills in when the provider is picked (email_account.js); setting a
# value from outside does not run those form handlers, so the card has to bring them
SERVERS = {
	"GMail": "imap.gmail.com",
	"Outlook.com": "imap-mail.outlook.com",
	"Yahoo Mail": "imap.mail.yahoo.com",
	"Yandex.Mail": "imap.yandex.com",
}


def _password_help(provider: str) -> str:
	if provider == "GMail":
		return _(
			"Google needs an app password, not your usual one: turn on 2-step verification, then create one at "
			"myaccount.google.com/apppasswords."
		)
	if provider == "Outlook.com":
		return _(
			"Microsoft accounts usually need OAuth sign-in instead of a password. That is set up once by an "
			"administrator as a Connected App, then chosen on the account."
		)
	return _("Use the password or app password your provider gives for IMAP.")


def connect_card(address: str = "") -> dict[str, Any]:
	"""A card that opens the Email Account form, receive-only, with everything but the password (and, if it was
	not given, the address) filled in."""
	domain = address.rpartition("@")[2]
	provider = PROVIDERS.get(domain, "")
	prefill: dict[str, Any] = {
		"enable_incoming": 1,
		"use_imap": 1,
		"incoming_port": "993",
		"use_ssl": 1,
		"email_sync_option": SYNC_NEW_ONLY,
		"initial_sync_count": INITIAL_SYNC,
		"create_contact": 0,  # do not turn every sender into a Contact
		"enable_outgoing": 0,  # read only: nothing here sends mail
	}
	problems = [
		_password_help(provider),
		# picking a provider in the form runs Frappe's own defaults, which switch outgoing mail on
		_("Leave “Enable Outgoing” off: this only reads mail."),
	]
	if address:
		server = SERVERS.get(provider) or f"imap.{domain}"
		prefill.update(
			email_account_name=address, email_id=address, service=provider or None, email_server=server
		)
		if not provider:
			problems.append(
				_("The mail server is a guess ({0}). Check it with your provider.").format(server)
			)

	rows = [
		{
			"field": "email_id",
			"label": _("Email address"),
			"value": address,
			"status": "ok" if address else "missing",
			"note": "" if address else _("typed in the form"),
		},
		{
			"field": "service",
			"label": _("Provider"),
			"value": provider or (_("Other") if address else _("pick in the form")),
			"status": "ok",
			"note": "",
		},
		{
			"field": "sync",
			"label": _("Sync"),
			"value": _("New mail only, checked every {0} minutes, read only").format(PULL_MINUTES),
			"status": "ok",
			"note": "",
		},
		{
			"field": "password",
			"label": _("Password"),
			"value": "",
			"status": "missing",
			"note": _("typed in the form, never in this chat"),
		},
	]
	return {
		"recipe": "connect_email",
		"title": _("Connect your email"),
		"doctype": "Email Account",
		"form_only": True,
		"rows": rows,
		"ready": False,
		"problems": problems,
		"prefill": prefill,
	}


def _accounts(filters: dict[str, Any]) -> list[Any]:
	return [
		account
		for account in frappe.get_all(
			"Email Account",
			filters=filters,
			fields=["name", "email_id", "awaiting_password"],
			limit_page_length=5,
		)
		if frappe.has_permission("Email Account", "read", doc=account.name)
	]


def _account_items(accounts: list[Any]) -> list[dict[str, Any]]:
	return [
		{
			"label": account.email_id or account.name,
			"meta": _("Waiting for its password") if account.get("awaiting_password") else _("Email account"),
			"route": ["Form", "Email Account", account.name],
			"tone": "",
		}
		for account in accounts
	]


def connect_answer(message: str = "") -> dict[str, Any]:
	"""{reply, card, items}. Names the mailbox already connected, or offers the card for the address given."""
	if not frappe.has_permission("Email Account", "create"):
		return {
			"reply": _(
				"Connecting a mailbox needs an administrator. Ask one to set it up, and its mail will show here."
			),
			"card": None,
			"items": [],
		}

	address = address_in(message)
	warning = ""
	if _PASSWORD_WORD.search(message or ""):
		warning = _("Please don't type a password in the chat: I ignored it. You add it in the form.") + " "

	accounts = _accounts({"email_id": address} if address else {"enable_incoming": 1})
	if waiting := [account for account in accounts if account.get("awaiting_password")]:
		name = waiting[0].email_id or waiting[0].name
		return {
			"reply": warning
			+ _(
				"{0} is set up but waiting for its password, so no mail is coming in yet. Open it, untick "
				"“Awaiting Password”, add the password and save."
			).format(name),
			"card": None,
			"items": _account_items(accounts),
		}
	if accounts:
		reply = (
			_("{0} is already connected. New mail is checked every {1} minutes.").format(
				address, PULL_MINUTES
			)
			if address
			else _("Email is connected. New mail is checked every {0} minutes.").format(PULL_MINUTES)
		)
		return {"reply": warning + reply, "card": None, "items": _account_items(accounts)}

	reply = (
		_("Here is what I'll set up for {0}. Open the form to add the password and save.").format(address)
		if address
		else _("I'll set up reading your email. Open the form to add your address and password, then save.")
	)
	return {"reply": warning + reply, "card": connect_card(address), "items": []}
