# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""The kinds of record people look for and refer to, CRM first.

One place says how each kind is titled, described and searched, so "which Acme did you mean?" (matching a
name inside a conversation) and "search anything" (the command bar) always agree.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import frappe
from frappe import _

Row = dict[str, Any]


@dataclass(frozen=True)
class Kind:
	doctype: str
	plural: str
	columns: tuple[str, ...]  # fetched besides `name`
	search: tuple[str, ...]  # matched with LIKE when searching
	title: Callable[[Row], str]
	subtitle: Callable[[Row], str] = lambda row: ""
	filters: dict[str, Any] | None = None
	label: Callable[[Row], str] | None = (
		None  # how a name-matching conversation refers to it (defaults to title)
	)
	min_chars: int = 0  # search-as-you-type skips this kind until that many characters are typed

	def label_of(self, row: Row) -> str:
		return (self.label or self.title)(row)


def _join(*parts: Any) -> str:
	return " · ".join(str(p) for p in parts if p not in (None, "", 0))


def _short(text: Any, limit: int = 120) -> str:
	"""Text somebody else wrote, on one line and cut short: control characters (which can hide or reorder
	what a line says) are dropped along with the line breaks."""
	cleaned = "".join(ch if ch.isprintable() else " " for ch in str(text or ""))
	cleaned = " ".join(cleaned.split())
	return cleaned if len(cleaned) <= limit else cleaned[: limit - 1].rstrip() + "…"


def _amount(row: Row, field: str = "opportunity_amount") -> str:
	value = row.get(field)
	return f"{frappe.utils.fmt_money(value, currency=row.get('currency'))}" if value else ""


KINDS: dict[str, Kind] = {
	kind.doctype: kind
	for kind in (
		Kind(
			"Lead",
			"Leads",
			("lead_name", "company_name", "status", "email_id"),
			("lead_name", "company_name", "email_id", "mobile_no", "name"),
			title=lambda r: r.get("lead_name") or r.get("company_name") or r["name"],
			subtitle=lambda r: _join(
				r.get("company_name") if r.get("lead_name") else None, r.get("status"), r.get("email_id")
			),
			label=lambda r: _join(r.get("lead_name"), r.get("company_name")) or r["name"],
		),
		Kind(
			"Opportunity",
			"Opportunities",
			("title", "party_name", "status", "opportunity_amount", "currency"),
			("title", "party_name", "name"),
			title=lambda r: r.get("title") or r.get("party_name") or r["name"],
			subtitle=lambda r: _join(r.get("party_name"), r.get("status"), _amount(r)),
		),
		Kind(
			"Prospect",
			"Prospects",
			("company_name",),
			("company_name", "name"),
			title=lambda r: r.get("company_name") or r["name"],
		),
		Kind(
			"Customer",
			"Customers",
			("customer_name", "customer_type"),
			("customer_name", "name"),
			title=lambda r: r.get("customer_name") or r["name"],
			subtitle=lambda r: r.get("customer_type") or "",
		),
		Kind(
			"Contact",
			"Contacts",
			("full_name", "company_name", "email_id"),
			("full_name", "company_name", "email_id", "name"),
			title=lambda r: r.get("full_name") or r["name"],
			subtitle=lambda r: _join(r.get("company_name"), r.get("email_id")),
		),
		# What an email says is written by whoever sent it, so only its subject and sender are shown, cut short
		# (the client escapes them), and they are never handed to the language model.
		Kind(
			"Communication",
			"Emails",
			("subject", "sender", "sender_full_name", "communication_date"),
			("subject", "sender", "sender_full_name"),
			title=lambda r: _short(r.get("subject")) or _("(no subject)"),
			subtitle=lambda r: _join(
				# a sender's name is whatever they chose to call themselves, so the address goes with it
				f"{_short(r.get('sender_full_name'), 40)} <{_short(r.get('sender'), 50)}>"
				if r.get("sender_full_name") and r.get("sender")
				else _short(r.get("sender_full_name") or r.get("sender"), 60),
				frappe.utils.formatdate(r["communication_date"]) if r.get("communication_date") else None,
			),
			filters={"communication_type": "Communication", "communication_medium": "Email"},
			# a LIKE over subject and sender on a big mail table, on every keystroke: wait for a real word
			min_chars=4,
		),
		Kind(
			"Quotation",
			"Quotations",
			("party_name", "customer_name", "status", "grand_total", "currency"),
			("name", "party_name", "customer_name", "title"),
			title=lambda r: r["name"],
			subtitle=lambda r: _join(
				r.get("customer_name") or r.get("party_name"), r.get("status"), _amount(r, "grand_total")
			),
		),
		Kind(
			"Project",
			"Projects",
			("project_name", "status", "customer"),
			("project_name", "name", "customer"),
			title=lambda r: r.get("project_name") or r["name"],
			subtitle=lambda r: _join(r.get("customer"), r.get("status")),
		),
		Kind(
			"Task",
			"Tasks",
			("subject", "status", "project", "exp_end_date"),
			("subject", "name", "project"),
			title=lambda r: r.get("subject") or r["name"],
			subtitle=lambda r: _join(r.get("project"), r.get("status")),
		),
		Kind(
			"Sales Invoice",
			"Invoices",
			("customer", "status", "grand_total", "currency"),
			("name", "customer"),
			title=lambda r: r["name"],
			subtitle=lambda r: _join(r.get("customer"), r.get("status"), _amount(r, "grand_total")),
		),
	)
}

CRM_KINDS = ("Lead", "Opportunity", "Prospect", "Customer", "Contact")


def readable_kinds() -> list[Kind]:
	return [kind for kind in KINDS.values() if frappe.has_permission(kind.doctype, "read")]


def fetch(
	kind: Kind, text: str | None = None, *, filters: dict[str, Any] | None = None, limit: int = 100
) -> list[Row]:
	"""Rows of one kind that the current user can read, matching `text` in any search column, newest first."""
	or_filters = [[kind.doctype, column, "like", f"%{text}%"] for column in kind.search] if text else None
	try:
		return frappe.get_list(
			kind.doctype,
			filters={**(kind.filters or {}), **(filters or {})},
			or_filters=or_filters,
			fields=["name", "modified", *kind.columns],
			order_by="modified desc",
			limit_page_length=limit,
		)
	except frappe.PermissionError:
		return []


def split_ref(value: str) -> tuple[str, str] | None:
	"""A reference to any record is written 'Doctype::name'. None if it is not one."""
	doctype, sep, name = (value or "").partition("::")
	return (doctype, name) if sep and doctype in KINDS and name else None


def make_ref(doctype: str, name: str) -> str:
	return f"{doctype}::{name}"


def describe(kind: Kind) -> str:
	return _(kind.doctype)
