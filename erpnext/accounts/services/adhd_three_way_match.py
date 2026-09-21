# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Three-way match indicator for a draft Purchase Invoice (ADHD-028).

ERPNext links an invoice to its Purchase Order and Purchase Receipt on the *item rows* (`po_detail` and
`pr_detail`, with `purchase_order` and `purchase_receipt`), never on the invoice header, and an invoice can
span several of each. What it refuses is enforced at these places, and this module mirrors them so the
badge says the same thing submitting would:

* `BillingValidationService.validate_multiple_billing` (accounts/services/billing_validation.py) runs in
  `validate` and refuses billing a Purchase Receipt row for more than its amount plus the over-billing
  allowance, counting what other submitted invoices already billed on that row. It is skipped when Buying
  Settings has "Bill for Rejected Quantity in Purchase Invoice" on (the default), and for users with the
  Accounts Settings over-billing role.
* `StatusUpdater.validate_qty` -> `check_overflow_with_allowance` (controllers/status_updater.py) runs on
  submit and does the same for the Purchase Order row, in percent: it refuses once the overflow exceeds the
  allowance by more than 0.01 percentage points.
* `TransactionBase.validate_rate_with_reference_doc` (utilities/transaction_base.py), only when Buying
  Settings has "Maintain Same Rate Throughout the Purchase Cycle" on: a row whose rate differs from the
  Purchase Order or Receipt row by 0.01 or more is refused, or only warned about when the action is "Warn".
* `validate_with_previous_doc` (currency must equal the reference's), `check_prev_docstatus` (reference must
  be submitted), `check_for_on_hold_or_closed_status` (a Closed or On Hold Purchase Order) and
  `validate_closed_source_items` (a closed row).

Everything is compared per referenced row in the invoice's own (transaction) currency, exactly as ERPNext
does: a reference in another currency is refused by ERPNext, so it is reported as a mismatch instead of
being converted. What this invoice bills is compared with what the reference still had open (its amount less
what other submitted invoices billed), not with whole-document totals.

The result is advisory: nothing here blocks or changes a document.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass

import frappe
from frappe import _
from frappe.query_builder.functions import Sum
from frappe.utils import cint, flt

# an invoice with more item rows than this is not checked
MAX_ROWS = 300
# how many individual row problems are returned; the counts and totals still cover every row
MAX_ISSUES = 20

PURCHASE_ORDER = "Purchase Order"
PURCHASE_RECEIPT = "Purchase Receipt"

# status_updater compares the billed percentage of a Purchase Order row with this slack, in percentage points
PURCHASE_ORDER_SLACK_PERCENT = 0.01
# validate_rate_with_reference_doc refuses a rate difference of this much or more
RATE_DIFFERENCE = 0.01
# Purchase Order Item.billed_amt is a Decimal(21, 9) column: sums are exact to nine places
BILLED_AMOUNT_PLACES = 9

# a reference's status, worst last
SEVERITY = {"match": 0, "within_tolerance": 1, "over": 2}

# Problems that make ERPNext refuse the invoice
BLOCKING = frozenset({"over_billed", "rate", "currency", "not_submitted", "status", "closed_row"})
# Problems that ERPNext accepts (possibly with a warning) but that a person would want to know about
NON_BLOCKING = frozenset({"within_allowance", "over_allowed", "rate_warned"})


def _no_allowance(_item_code: str) -> float:
	return 0.0


@dataclass(frozen=True)
class MatchSettings:
	"""The site settings the match depends on, so the rules can be tested without a site."""

	currency: str | None = None
	# over-billing allowance in percent for an item (the Item's own, else Accounts Settings')
	allowance_for: Callable[[str], float] = _no_allowance
	amount_precision: int = 2
	rate_precision: int = 2
	# the user holds Accounts Settings' over-billing role
	can_overbill: bool = False
	# Buying Settings: "Bill for Rejected Quantity in Purchase Invoice"
	bill_for_rejected_quantity: bool = False
	maintain_same_rate: bool = False
	# Buying Settings: "Action if Same Rate is Not Maintained", "Stop" or "Warn"
	rate_action: str = "Stop"
	# the user holds Buying Settings' role that may override a "Stop"
	can_override_rate: bool = False
	is_internal_supplier: bool = False


def po_rule_over_by(ref_amount: float, billed: float, allowance: float) -> float:
	"""How far billing goes past what `check_overflow_with_allowance` accepts for a Purchase Order row.

	Zero means submit accepts it. Only rows billed for more than the ordered amount are examined, and the
	limit is the allowance plus 0.01 percentage points, so it is an overflow *percentage* that is compared.
	"""
	if ref_amount <= 0 or billed <= ref_amount:
		return 0.0
	overflow_percent = (billed - ref_amount) / ref_amount * 100
	if overflow_percent - allowance > PURCHASE_ORDER_SLACK_PERCENT:
		return billed - flt(ref_amount * (100 + allowance) / 100)
	return 0.0


def pr_rule_over_by(ref_amount: float, billed: float, allowance: float, precision: int) -> float:
	"""How far billing goes past what `validate_multiple_billing` accepts for a Purchase Receipt row.

	Zero means it accepts it. Here the slack is one unit of the amount's last decimal place, in money.
	"""
	if not ref_amount:
		# validate_multiple_billing does not check a row whose reference amount is zero
		return 0.0
	max_allowed = flt(ref_amount * (100 + allowance) / 100)
	if billed < 0 and max_allowed < 0:
		billed, max_allowed = abs(billed), abs(max_allowed)
	over_by = billed - max_allowed
	return over_by if over_by > 1 / (10**precision) else 0.0


def _issue(reason: str, row: dict, amount: float | None = None) -> dict:
	issue = {"reason": reason, "idx": row.get("idx"), "item_code": row.get("item_code")}
	if amount is not None:
		issue["amount"] = amount
	return issue


def _amount_verdict(kind: str, group: dict, settings: MatchSettings) -> tuple[str | None, float]:
	"""Compare the billed total of one reference row with the amount it may be billed up to.

	Returns the problem (or None when the row is fine) and the amount by which billing overshoots the
	reference. An overshoot that stays within the allowance is a problem ERPNext accepts.
	"""
	ref_amount, billed = group["ref_amount"], group["billed"]
	allowance = group["allowance"]

	if kind == PURCHASE_ORDER:
		over_by = po_rule_over_by(ref_amount, billed, allowance)
		# status_updater only looks at rows where the billed amount is strictly above the ordered amount
		exceeds_reference = ref_amount > 0 and billed > ref_amount
		# limits_crossed_error lets an internal supplier's invoice through
		enforced = not settings.is_internal_supplier
	else:
		over_by = pr_rule_over_by(ref_amount, billed, allowance, settings.amount_precision)
		exceeds_reference = bool(ref_amount) and billed > ref_amount
		# with "Bill for Rejected Quantity" on, validate_multiple_billing collects no over-billed rows for a
		# Purchase Invoice, so billing more than the receipt is accepted
		enforced = not settings.bill_for_rejected_quantity

	if over_by > 0:
		if enforced and not settings.can_overbill:
			return "over_billed", over_by
		return "over_allowed", over_by
	if exceeds_reference:
		return "within_allowance", billed - ref_amount
	return None, 0.0


def _rate_verdict(row: dict, ref: dict, settings: MatchSettings) -> str | None:
	if not settings.maintain_same_rate or settings.is_internal_supplier or ref.get("rate") is None:
		return None
	if abs(flt(row["rate"] - ref["rate"], settings.rate_precision)) < RATE_DIFFERENCE:
		return None
	if settings.rate_action == "Stop" and not settings.can_override_rate:
		return "rate"
	return "rate_warned"


def _worst(reasons: list[str]) -> str:
	if any(reason in BLOCKING for reason in reasons):
		return "over"
	return "within_tolerance" if reasons else "match"


def evaluate_match(rows: list[dict], references: dict, settings: MatchSettings) -> dict:
	"""Compare invoice rows with the reference rows they point at. Pure: no site access.

	`rows` are the invoice's item rows (`idx`, `item_code`, `purchase_order`, `po_detail`,
	`purchase_receipt`, `pr_detail`, `rate`, `amount`).

	`references` holds, for each of "Purchase Order" and "Purchase Receipt":
	    "rows": {row name: {"parent", "item_code", "amount", "rate", "closed", "billed_by_others"}}
	    "docs": {document name: {"docstatus", "status", "currency"}}
	where `billed_by_others` is what other submitted invoices billed on that row. A row missing from
	"rows" is one the user may not read (or that does not exist) and is only counted.
	"""
	precision = settings.amount_precision
	groups: dict[tuple[str, str], dict] = {}
	skipped = {"unreadable": 0}

	for row in rows:
		for kind, detail_field in ((PURCHASE_ORDER, "po_detail"), (PURCHASE_RECEIPT, "pr_detail")):
			detail = row.get(detail_field)
			if not detail:
				continue
			source = references.get(kind, {})
			ref = source.get("rows", {}).get(detail)
			if not ref or ref["parent"] not in source.get("docs", {}):
				skipped["unreadable"] += 1
				continue

			key = (kind, detail)
			group = groups.get(key)
			if group is None:
				group = groups[key] = {
					"kind": kind,
					"parent": ref["parent"],
					"ref": ref,
					"ref_amount": flt(ref["amount"], precision),
					"already": flt(ref["billed_by_others"], precision),
					"allowance": flt(settings.allowance_for(ref["item_code"])),
					"this": 0.0,
					"billed": 0.0,
					"rows": [],
				}
				first = True
			else:
				first = False

			current = flt(row["amount"], precision)
			group["rows"].append(row)
			group["this"] += current
			# The same float additions, in the same order, as get_reference_wise_billed_amt, so a total that
			# sits exactly on a limit lands on the same side of it here as it does when ERPNext checks it.
			group["billed"] += current
			if first:
				group["billed"] += group["already"]

	if not groups:
		return _result(settings, [], skipped, 0)

	entries: dict[tuple[str, str], dict] = {}
	for (kind, _detail), group in groups.items():
		parent = group["parent"]
		doc = references[kind]["docs"][parent]
		entry = entries.get((kind, parent))
		if entry is None:
			entry = entries[(kind, parent)] = {
				"doctype": kind,
				"name": parent,
				"currency": doc.get("currency"),
				"rows": 0,
				"reference_amount": 0.0,
				"already_billed": 0.0,
				"this_invoice": 0.0,
				"max_allowed": 0.0,
				"over_by": 0.0,
				"issues": [],
				"reasons": [],
			}
			_add_document_issues(entry, doc, settings)

		if kind == PURCHASE_ORDER:
			# status_updater sums exact decimals in the database, so do not carry float noise into the limit
			group["billed"] = flt(group["already"] + group["this"], BILLED_AMOUNT_PLACES)
			# check_for_on_hold_or_closed_status leaves out rows that also point at a Purchase Receipt
			if (
				doc.get("status") in ("Closed", "On Hold")
				and "status" not in entry["reasons"]
				and any(not row["purchase_receipt"] for row in group["rows"])
			):
				entry["reasons"].append("status")
				entry["issues"].append({"reason": "status", "idx": None, "item_code": None})

		reason, over_by = _amount_verdict(kind, group, settings)
		first_row = group["rows"][0]
		if reason:
			entry["reasons"].append(reason)
			entry["issues"].append(_issue(reason, first_row, over_by))
		if reason in ("over_billed", "over_allowed"):
			entry["over_by"] += over_by
		if group["ref"].get("closed"):
			entry["reasons"].append("closed_row")
			entry["issues"].append(_issue("closed_row", first_row))
		for row in group["rows"]:
			rate_reason = _rate_verdict(row, group["ref"], settings)
			if rate_reason:
				entry["reasons"].append(rate_reason)
				entry["issues"].append(_issue(rate_reason, row))

		entry["rows"] += len(group["rows"])
		entry["reference_amount"] += group["ref_amount"]
		entry["already_billed"] += group["already"]
		entry["this_invoice"] += group["this"]
		entry["max_allowed"] += flt(group["ref_amount"] * (100 + group["allowance"]) / 100)

	return _result(settings, list(entries.values()), skipped, len(groups))


def _add_document_issues(entry: dict, doc: dict, settings: MatchSettings) -> None:
	def add(reason: str) -> None:
		entry["reasons"].append(reason)
		entry["issues"].append({"reason": reason, "idx": None, "item_code": None})

	if cint(doc.get("docstatus")) != 1:
		add("not_submitted")
	if settings.currency and doc.get("currency") and doc["currency"] != settings.currency:
		add("currency")


def _result(settings: MatchSettings, entries: list[dict], skipped: dict, checked: int) -> dict:
	precision = settings.amount_precision
	totals = {
		key: 0.0 for key in ("reference_amount", "already_billed", "this_invoice", "max_allowed", "over_by")
	}
	references = []
	status = None

	for entry in entries:
		reasons = entry.pop("reasons")
		entry["status"] = _worst(reasons)
		entry["open_amount"] = entry["reference_amount"] - entry["already_billed"]
		entry["remaining_after"] = entry["open_amount"] - entry["this_invoice"]
		entry["issues"] = entry["issues"][:MAX_ISSUES]

		# a reference in another currency cannot be added to the rest
		if not (settings.currency and entry["currency"] and entry["currency"] != settings.currency):
			for key in totals:
				totals[key] += entry[key]

		for key in (
			"reference_amount",
			"already_billed",
			"this_invoice",
			"max_allowed",
			"over_by",
			"open_amount",
			"remaining_after",
		):
			entry[key] = flt(entry[key], precision)
		references.append(entry)
		if status is None or SEVERITY[entry["status"]] > SEVERITY[status]:
			status = entry["status"]

	totals["open_amount"] = totals["reference_amount"] - totals["already_billed"]
	totals["remaining_after"] = totals["open_amount"] - totals["this_invoice"]
	references.sort(key=lambda entry: (-SEVERITY[entry["status"]], entry["doctype"], entry["name"]))

	return {
		"status": status or "no_reference",
		"currency": settings.currency,
		"totals": {key: flt(value, precision) for key, value in totals.items()},
		"references": references,
		"checked_rows": checked,
		"unreadable_rows": skipped["unreadable"],
	}


def _text(value: object) -> str:
	return value.strip()[:140] if isinstance(value, str) else ""


def _number(value: object) -> float:
	number = flt(value)
	return number if math.isfinite(number) and abs(number) < 1e15 else 0.0


def clean_rows(items: object) -> list[dict]:
	"""Keep only the fields the match needs, coerced to plain types, from whatever the client sent."""
	try:
		items = frappe.parse_json(items) if items else []
	except ValueError:
		items = None
	if not isinstance(items, list) or len(items) > MAX_ROWS:
		frappe.throw(_("Provide the invoice rows as a list of no more than {0}.").format(MAX_ROWS))

	rows = []
	for position, item in enumerate(items, start=1):
		if not isinstance(item, dict):
			continue
		rows.append(
			{
				"idx": cint(item.get("idx")) or position,
				"item_code": _text(item.get("item_code")),
				"purchase_order": _text(item.get("purchase_order")),
				"po_detail": _text(item.get("po_detail")),
				"purchase_receipt": _text(item.get("purchase_receipt")),
				"pr_detail": _text(item.get("pr_detail")),
				"rate": _number(item.get("rate")),
				"amount": _number(item.get("amount")),
			}
		)
	return rows


def _read_reference(parent_doctype: str, details: list[str]) -> dict:
	"""Read the referenced rows and their documents, only those the user may read."""
	empty = {"rows": {}, "docs": {}}
	if not details:
		return empty

	item_doctype = f"{parent_doctype} Item"
	fields = ["name", "parent", "item_code", "amount", "rate"]
	if frappe.get_meta(item_doctype).has_field("closed"):
		fields.append("closed")

	# Reading a child table checks the parent doctype's read permission; the parents are read below with
	# their own document-level permissions, and a row whose parent is not returned there is dropped.
	rows = frappe.get_list(
		item_doctype,
		filters={"name": ["in", details]},
		fields=fields,
		parent_doctype=parent_doctype,
		limit_page_length=len(details),
	)
	parents = sorted({row.parent for row in rows})
	if not parents:
		return empty

	docs = frappe.get_list(
		parent_doctype,
		filters={"name": ["in", parents]},
		fields=["name", "docstatus", "status", "currency"],
		limit_page_length=len(parents),
	)
	docs = {doc.name: doc for doc in docs}
	return {"rows": {row.name: row for row in rows if row.parent in docs}, "docs": docs}


def _billed_by_others(join_field: str, details: list[str]) -> dict[str, float]:
	"""Sum of `amount` on submitted Purchase Invoice rows for each referenced row.

	The invoice being checked is a draft, so it is never part of this. It is a plain aggregate: only rows the
	user was already allowed to read are asked about.
	"""
	if not details:
		return {}
	item = frappe.qb.DocType("Purchase Invoice Item")
	column = item[join_field]
	rows = (
		frappe.qb.from_(item)
		.select(column, Sum(item.amount))
		.where(column.isin(details))
		.where(item.docstatus == 1)
		.groupby(column)
	).run()
	return {name: flt(total) for name, total in rows}


def _allowance_lookup() -> Callable[[str], float]:
	"""The over-billing allowance in percent: the Item's own, else Accounts Settings', as ERPNext reads it."""
	from erpnext.controllers.status_updater import get_allowance_for

	state = {"item": {}, "global": None}

	def lookup(item_code: str) -> float:
		try:
			allowance, state["item"], _qty, state["global"] = get_allowance_for(
				item_code, state["item"], None, state["global"], "amount"
			)
		except (frappe.DoesNotExistError, TypeError):
			# an item that no longer exists falls back to the site-wide allowance
			allowance = flt(frappe.get_cached_value("Accounts Settings", None, "over_billing_allowance"))
		return flt(allowance)

	return lookup


def _load_settings(currency: str | None, is_internal_supplier: bool) -> MatchSettings:
	roles = frappe.get_roles()

	def has_role(role: str | None) -> bool:
		return bool(role) and role in roles

	return MatchSettings(
		currency=currency,
		allowance_for=_allowance_lookup(),
		amount_precision=frappe.get_precision("Purchase Invoice Item", "amount", currency=currency),
		rate_precision=frappe.get_precision("Purchase Invoice Item", "rate", currency=currency),
		can_overbill=has_role(frappe.get_single_value("Accounts Settings", "role_allowed_to_over_bill")),
		bill_for_rejected_quantity=bool(
			cint(frappe.get_single_value("Buying Settings", "bill_for_rejected_quantity_in_purchase_invoice"))
		),
		maintain_same_rate=bool(cint(frappe.get_single_value("Buying Settings", "maintain_same_rate"))),
		rate_action=frappe.get_single_value("Buying Settings", "maintain_same_rate_action") or "Stop",
		can_override_rate=has_role(
			frappe.get_single_value("Buying Settings", "role_to_override_stop_action")
		),
		is_internal_supplier=is_internal_supplier,
	)


@frappe.whitelist()
def get_three_way_match(
	items: list[dict] | str, currency: str | None = None, is_internal_supplier: int | str = 0
) -> dict:
	"""Compare a draft Purchase Invoice's rows with the Purchase Orders and Receipts they reference.

	`items` is the form's current item rows, saved or not (at most 300). Returns the overall `status`
	("match", "within_tolerance", "over" or "no_reference") and, for each referenced document, what this
	invoice bills against what the reference still had open. Nothing is changed.
	"""
	frappe.has_permission("Purchase Invoice", "read", throw=True)

	rows = clean_rows(items)
	currency = _text(currency) or None
	settings = _load_settings(currency, bool(cint(is_internal_supplier)))

	po_details = sorted({row["po_detail"] for row in rows if row["po_detail"]})
	pr_details = sorted({row["pr_detail"] for row in rows if row["pr_detail"]})
	if not po_details and not pr_details:
		return evaluate_match([], {}, settings)

	references = {
		PURCHASE_ORDER: _read_reference(PURCHASE_ORDER, po_details),
		PURCHASE_RECEIPT: _read_reference(PURCHASE_RECEIPT, pr_details),
	}
	for kind, join_field in ((PURCHASE_ORDER, "po_detail"), (PURCHASE_RECEIPT, "pr_detail")):
		billed = _billed_by_others(join_field, list(references[kind]["rows"]))
		for name, ref in references[kind]["rows"].items():
			ref["billed_by_others"] = billed.get(name, 0.0)

	return evaluate_match(rows, references, settings)
