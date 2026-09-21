# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Email in the conversation: ask what someone wrote, and connect a mailbox without a page of settings.

Frappe already does the syncing. An Email Account with IMAP is pulled into Communications every ten minutes
by the scheduler (`email_account.pull`), and each mail is shown on the lead, contact or customer it belongs
to. This adds the two things that were missing:

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

# --- what people say -----------------------------------------------------------------------------

# "email" alone is not a question about mail ("what is Jo's email?"), so the singular needs a "from/about"
_MAIL_WORDS = re.compile(
	r"\b(?:e-?mails|mail|inbox|messages|repl(?:y|ied|ies)|wrote|written back|write back|responded)\b"
	r"|\be-?mail\b(?=\s+(?:from|by|about|regarding)\b)"
)
_QUESTION_START = re.compile(
	r"^(?:show|list|check|find|see|any|anything|latest|recent|unread|inbox|what|which|who|did|has|have"
	r"|do i have|are there|is there)\b"
)
_MY_MAIL = re.compile(r"^(?:my\s+(?:e-?mails?|mail|inbox)|(?:any\s+)?new\s+(?:e-?mails?|mail|messages?))\b")
_WHO_DID = re.compile(
	r"^(?:what|which)\s+did\s+.{1,60}?\b(?:e-?mail|write|wrote|send|sent|say|said|repl(?:y|ied)|respond)"
)
_DID_THEY = re.compile(
	r"^(?:did|has|have)\s+.{1,60}?\b(?:e-?mail(?:ed)?|written|write|repl(?:y|ied)|respond(?:ed)?)\b"
)
_CONNECT = re.compile(
	r"\b(?:connect|link|hook\s*up|sync)\s+(?:my\s+|an?\s+|the\s+|our\s+)?(?:e-?mails?|inbox|mailbox|gmail|outlook|mail)\b"
	r"|\b(?:set\s*up|setup|add)\s+(?:my\s+|an?\s+|the\s+|our\s+)?(?:e-?mail\s+(?:account|sync)|inbox|mailbox|gmail|outlook)\b"
	r"|\be-?mail\s+sync\b"
	# "connect jo@gmail.com": the address itself says what is being connected
	r"|\b(?:connect|link|sync)\s+[\w.+-]+@[\w-]+(?:\.[\w-]+)+"
)

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


def is_email_question(text: str) -> bool:
	t = " ".join((text or "").casefold().split())
	if _MY_MAIL.match(t) or _WHO_DID.match(t) or _DID_THEY.match(t):
		return True
	return bool(_QUESTION_START.match(t) and _MAIL_WORDS.search(t))


def is_connect_request(text: str) -> bool:
	return bool(_CONNECT.search(" ".join((text or "").casefold().split())))


class Cue:
	"""Quacks like the compiled patterns in engine.QUERY_CUES, for questions a single regex would get wrong."""

	def __init__(self, test):
		self._test = test

	def search(self, text: str):
		return True if self._test(text) else None


EMAIL_CUE = Cue(is_email_question)
CONNECT_CUE = Cue(is_connect_request)


def term_of(text: str) -> str:
	"""Who or what the question is about ("what did Acme email me?" -> "Acme"); "" means any mail."""
	for pattern in _TERMS:
		if match := pattern.search(text or ""):
			term = match.group(1).strip(" '\"“”.,?!")
			term = re.sub(r"^(?:the|my|our)\s+", "", term, flags=re.I)
			term = re.sub(r"[’']s$", "", term)
			term = re.sub(r"[%_\\]", "", term)  # LIKE wildcards are not part of a name
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
	if not term:
		return frappe.get_list(
			"Communication",
			filters=_BASE,
			fields=_FIELDS,
			order_by="communication_date desc",
			limit_page_length=limit,
		)

	like = f"%{term}%"
	linked = _matching_records(term)
	pairs = {(doctype, name) for doctype, names in linked.items() for name in names}
	on_timeline: set[str] = set()
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

	or_filters = [["sender", "like", like], ["sender_full_name", "like", like], ["subject", "like", like]]
	if pairs:
		or_filters.append(["reference_name", "in", sorted({name for _doctype, name in pairs})])
	if on_timeline:
		or_filters.append(["name", "in", sorted(on_timeline)])

	wanted = term.casefold()
	rows = frappe.get_list(
		"Communication",
		filters=_BASE,
		or_filters=or_filters,
		fields=_FIELDS,
		order_by="communication_date desc",
		limit_page_length=limit * 3,
	)

	def belongs(row: dict[str, Any]) -> bool:
		# a name that merely equals another doctype's name must not pull in that record's mail
		text = " ".join(str(row.get(f) or "") for f in ("sender", "sender_full_name", "subject")).casefold()
		return (
			wanted in text
			or (row.get("reference_doctype"), row.get("reference_name")) in pairs
			or row["name"] in on_timeline
		)

	return [row for row in rows if belongs(row)][:limit]


def email_items(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
	items = []
	for row in rows:
		reference = (row.get("reference_doctype"), row.get("reference_name"))
		opens = (
			reference
			if all(reference) and frappe.has_permission(reference[0], "read", doc=reference[1])
			else None
		)
		who = _short(row.get("sender_full_name") or row.get("sender"), 60)
		when = formatdate(row["communication_date"]) if row.get("communication_date") else ""
		items.append(
			{
				"label": _short(row.get("subject")) or _("(no subject)"),
				"meta": " · ".join(p for p in (who, when, _(reference[0]) if opens else None) if p),
				"route": ["Form", opens[0], opens[1]] if opens else ["Form", "Communication", row["name"]],
				"tone": "",
			}
		)
	return items


def _count(n: int, one: str, many: str) -> str:
	return _(one) if n == 1 else _(many).format(n)


def emails_answer(term: str = "") -> dict[str, Any]:
	"""{reply, items, connect}: the sentence, the rows to show, and whether to offer connecting a mailbox.
	The reply is built from counts and dates only, never from what an email says."""
	rows = received_emails(term)
	if rows is None:
		return {"reply": _("You don't have access to email."), "items": [], "connect": False}

	connected = bool(frappe.db.count("Email Account", {"enable_incoming": 1}))
	if not rows:
		if not connected:
			return {
				"reply": _("No email is connected yet, so there is nothing to show."),
				"items": [],
				"connect": True,
			}
		reply = _("Nothing from {0} yet.").format(term) if term else _("No emails yet.")
		reply += " " + _("New mail is checked for every {0} minutes.").format(PULL_MINUTES)
		return {"reply": reply, "items": [], "connect": False}

	newest = formatdate(rows[0]["communication_date"]) if rows[0].get("communication_date") else ""
	count = _count(len(rows), "1 email", "{0} emails")
	reply = (
		_("{0} from {1}, newest {2}.").format(count, term, newest)
		if term
		else _("{0}, newest {1}.").format(count, newest)
	)
	return {"reply": reply, "items": email_items(rows), "connect": False}


# --- connecting a mailbox ------------------------------------------------------------------------

_ADDRESS = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

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


def address_in(text: str) -> str:
	match = _ADDRESS.search(text or "")
	return match.group(0).lower() if match else ""


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
	problems = [_password_help(provider)]
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


def connect_answer(message: str = "") -> dict[str, Any]:
	"""{reply, card, items}. Names the mailbox already connected, or offers the card for the address given."""
	address = address_in(message)
	accounts = frappe.get_all(
		"Email Account",
		filters={"enable_incoming": 1},
		fields=["name", "email_id"],
		limit_page_length=5,
	)
	if accounts and not address:
		return {
			"reply": _("Email is connected. New mail is checked for every {0} minutes.").format(PULL_MINUTES),
			"card": None,
			"items": [
				{
					"label": account.email_id or account.name,
					"meta": _("Email account"),
					"route": ["Form", "Email Account", account.name],
					"tone": "",
				}
				for account in accounts
				if frappe.has_permission("Email Account", "read", doc=account.name)
			],
		}
	reply = (
		_("Here is what I'll set up for {0}. Open the form to add the password and save.").format(address)
		if address
		else _("I'll set up reading your email. Open the form to add your address and password, then save.")
	)
	return {"reply": reply, "card": connect_card(address), "items": []}
