# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Supplier Quotation comparison for a Request for Quotation (ADHD-025).

A Supplier Quotation does not name its Request for Quotation on the header. The link is on the item rows:
`Supplier Quotation Item.request_for_quotation` (the RFQ) and `request_for_quotation_item` (the RFQ item row that
was answered), because one quotation can answer several RFQs. So quotations are found through their item rows and
every rate is matched to the RFQ item it answers.
"""

from collections import Counter

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate

# a comparison that needs more columns than this is not a comparison anyone can read at a glance
MAX_QUOTATIONS = 20
MAX_RFQ_ITEMS = 100
# how many distinct Supplier Quotation names are read from the item rows before permissions trim them
MAX_QUOTATION_LOOKUP = 500
# a frappe name is at most 140 characters
MAX_NAME_LENGTH = 140


def _unit_base_rate(row) -> float:
	"""Company-currency rate per stock UOM, so quotes in other currencies and UOMs can be ranked fairly."""
	return flt(flt(row.get("base_rate")) / (flt(row.get("conversion_factor")) or 1), 6)


def _match_rfq_item(row, items_by_name: dict, items_by_unique_code: dict):
	"""Return the RFQ item row that a Supplier Quotation Item answers, or None.

	The item row name is exact: an RFQ may list the same item twice with different dates. The item code is
	only a fallback, and only when it is unambiguous within the RFQ.
	"""
	rfq_item = row.get("request_for_quotation_item")
	if rfq_item in items_by_name:
		return rfq_item
	return items_by_unique_code.get(row.get("item_code"))


def build_comparison(
	rfq_items: list,
	quotations: list,
	quotation_rows: list,
	supplier_terms: dict | None = None,
	today=None,
) -> list[dict]:
	"""Return one summary per quotation with its rate for each RFQ item it answered.

	Pure: everything it needs is passed in, so it can be tested without a database.
	"""
	supplier_terms = supplier_terms or {}
	today = getdate(today or nowdate())

	items_by_name = {item.name: item for item in rfq_items}
	code_counts = Counter(item.item_code for item in rfq_items)
	items_by_unique_code = {
		item.item_code: item.name for item in rfq_items if code_counts[item.item_code] == 1
	}

	rows_by_quotation: dict[str, list] = {}
	for row in quotation_rows:
		rows_by_quotation.setdefault(row.parent, []).append(row)

	result = []
	for quotation in quotations:
		rates = {}
		for row in sorted(rows_by_quotation.get(quotation.name, []), key=lambda r: r.idx or 0):
			target = _match_rfq_item(row, items_by_name, items_by_unique_code)
			# a quotation that lists an RFQ item twice is compared on its first row
			if target is None or target in rates:
				continue
			rates[target] = {
				"rate": flt(row.rate),
				"base_rate": flt(row.base_rate),
				"unit_base_rate": _unit_base_rate(row),
				"uom": row.uom,
				"qty": flt(row.qty),
			}

		valid_till = getdate(quotation.valid_till) if quotation.valid_till else None
		result.append(
			{
				"name": quotation.name,
				"supplier": quotation.supplier,
				"supplier_name": quotation.supplier_name or quotation.supplier,
				"status": quotation.status,
				"docstatus": quotation.docstatus,
				"transaction_date": str(quotation.transaction_date) if quotation.transaction_date else None,
				"valid_till": str(valid_till) if valid_till else None,
				"expired": quotation.status == "Expired" or bool(valid_till and valid_till < today),
				"currency": quotation.currency,
				"grand_total": flt(quotation.grand_total),
				"base_grand_total": flt(quotation.base_grand_total),
				"payment_terms": supplier_terms.get(quotation.supplier),
				"quoted": len(rates),
				"rates": rates,
			}
		)

	# Quotes that cover every RFQ item come first, cheapest first: a partial quote looks cheap only because it
	# leaves things out. A total of zero means "not priced", so it goes last of its group.
	result.sort(
		key=lambda q: (
			q["quoted"] < len(rfq_items),
			q["base_grand_total"] <= 0,
			q["base_grand_total"],
			q["name"],
		)
	)
	return result


def _report_filters(rfq, quotations: list[dict], today) -> dict:
	"""Filters that make the standard Supplier Quotation Comparison report show exactly this RFQ.

	The report insists on a date range and filters on the quotation date, so the range has to cover the RFQ's
	own date, today, and every quotation shown.
	"""
	dates = [getdate(rfq.transaction_date)] if rfq.transaction_date else []
	dates += [getdate(q["transaction_date"]) for q in quotations if q["transaction_date"]]
	return {
		"company": rfq.company,
		"request_for_quotation": rfq.name,
		"from_date": str(min([*dates, today])),
		"to_date": str(max([*dates, today])),
	}


@frappe.whitelist()
def get_rfq_supplier_comparison(rfq_name: str) -> dict:
	"""Return the Supplier Quotations answering a Request for Quotation, item by item.

	Quotations are read through `frappe.get_list`, so a user only sees the quotations their permissions allow.
	Cancelled quotations are left out; drafts are kept, because a quotation keyed in from a supplier's reply is
	often not submitted yet.
	"""
	if not isinstance(rfq_name, str) or not rfq_name or len(rfq_name) > MAX_NAME_LENGTH:
		frappe.throw(_("Provide the name of a Request for Quotation."))

	frappe.has_permission("Request for Quotation", "read", doc=rfq_name, throw=True)

	rfq = frappe.db.get_value(
		"Request for Quotation", rfq_name, ["name", "company", "transaction_date"], as_dict=True
	)
	# Administrator passes the permission check without the document being loaded
	if not rfq:
		frappe.throw(_("Request for Quotation {0} was not found.").format(rfq_name), frappe.DoesNotExistError)
	today = getdate(nowdate())

	rfq_items = frappe.get_all(
		"Request for Quotation Item",
		filters={"parent": rfq_name, "parenttype": "Request for Quotation"},
		fields=["name", "item_code", "item_name", "qty", "uom"],
		order_by="idx asc",
		limit=MAX_RFQ_ITEMS + 1,
	)
	items_truncated = len(rfq_items) > MAX_RFQ_ITEMS
	rfq_items = rfq_items[:MAX_RFQ_ITEMS]

	quotation_names = frappe.get_all(
		"Supplier Quotation Item",
		filters={"request_for_quotation": rfq_name},
		pluck="parent",
		distinct=True,
		limit=MAX_QUOTATION_LOOKUP,
	)

	quotations = []
	if quotation_names:
		quotations = frappe.get_list(
			"Supplier Quotation",
			filters={"name": ["in", quotation_names], "docstatus": ["<", 2]},
			fields=[
				"name",
				"supplier",
				"supplier_name",
				"status",
				"docstatus",
				"transaction_date",
				"valid_till",
				"currency",
				"grand_total",
				"base_grand_total",
			],
			order_by="creation desc",
			limit=MAX_QUOTATIONS + 1,
		)
	quotations_truncated = len(quotations) > MAX_QUOTATIONS
	quotations = quotations[:MAX_QUOTATIONS]

	quotation_rows = []
	supplier_terms = {}
	if quotations:
		quotation_rows = frappe.get_all(
			"Supplier Quotation Item",
			filters={"parent": ["in", [q.name for q in quotations]], "request_for_quotation": rfq_name},
			fields=[
				"parent",
				"idx",
				"item_code",
				"request_for_quotation_item",
				"qty",
				"uom",
				"conversion_factor",
				"rate",
				"base_rate",
			],
			order_by="parent asc, idx asc",
			limit=len(quotations) * MAX_RFQ_ITEMS,
		)
		# Supplier Quotation has no payment terms of its own. A Purchase Order made from it takes the
		# supplier's default terms, so those are what is shown, and only if the user may read Suppliers.
		if frappe.has_permission("Supplier", "read"):
			suppliers = sorted({q.supplier for q in quotations if q.supplier})
			supplier_terms = {
				row.name: row.payment_terms
				for row in frappe.get_list(
					"Supplier",
					filters={"name": ["in", suppliers]},
					fields=["name", "payment_terms"],
					limit=len(suppliers),
				)
			}

	summaries = build_comparison(rfq_items, quotations, quotation_rows, supplier_terms, today)

	awaiting = []
	# with permissions or the cap hiding quotations, "has not answered" could be wrong, so say nothing
	if not quotations_truncated:
		answered = {q["supplier"] for q in summaries}
		awaiting = [
			{"supplier": row.supplier, "supplier_name": row.supplier_name or row.supplier}
			for row in frappe.get_all(
				"Request for Quotation Supplier",
				filters={"parent": rfq_name, "parenttype": "Request for Quotation"},
				fields=["supplier", "supplier_name"],
				order_by="idx asc",
				limit=MAX_QUOTATIONS * 5,
			)
			if row.supplier not in answered
		]

	return {
		"rfq": rfq.name,
		"company": rfq.company,
		"company_currency": frappe.get_cached_value("Company", rfq.company, "default_currency"),
		"items": [dict(item) for item in rfq_items],
		"quotations": summaries,
		"awaiting_suppliers": awaiting,
		"truncated": {"quotations": quotations_truncated, "items": items_truncated},
		"report_filters": _report_filters(rfq, summaries, today),
	}
