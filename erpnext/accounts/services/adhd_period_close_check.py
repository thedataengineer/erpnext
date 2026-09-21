"""Period-close readiness checks for the ADHD month-end checklist."""

from urllib.parse import urlencode

import frappe
from frappe import _
from frappe.utils import getdate


def _list_link(route: str, filters: dict) -> str:
	query = {
		key: frappe.as_json(value) if isinstance(value, (list, tuple)) else value
		for key, value in filters.items()
	}
	return f"/app/{route}?{urlencode(query)}"


def _count_issue(
	doctype: str,
	filters: dict,
	issue_type: str,
	label: str,
	route: str,
	severity: str,
) -> dict | None:
	count = frappe.db.count(doctype, filters)
	if not count:
		return None

	return {
		"type": issue_type,
		"count": count,
		"label": _(label).format(count=count),
		"link": _list_link(route, filters),
		"severity": severity,
	}


@frappe.whitelist()
def get_period_close_readiness(company: str, from_date: str, to_date: str) -> dict:
	"""Return period-close blockers scoped to one company and date range."""
	if not company or not from_date or not to_date:
		frappe.throw(_("Company, From Date, and To Date are required."))

	start = getdate(from_date)
	end = getdate(to_date)
	if start > end:
		frappe.throw(_("From Date cannot be after To Date."))

	if not frappe.has_permission("Company", "read", company):
		frappe.throw(
			_("Not permitted to read Company {0}.").format(frappe.bold(company)), frappe.PermissionError
		)

	checks = [
		(
			"Journal Entry",
			{"company": company, "posting_date": ["between", [start, end]], "docstatus": 0},
			"draft_journal_entries",
			"{count} Draft Journal Entries",
			"journal-entry",
			"error",
		),
		(
			"Bank Transaction",
			{
				"company": company,
				"date": ["between", [start, end]],
				"status": ["!=", "Reconciled"],
				"docstatus": 1,
			},
			"unreconciled_bank_transactions",
			"{count} Unreconciled Bank Transactions",
			"bank-transaction",
			"warning",
		),
		(
			"Purchase Invoice",
			{"company": company, "posting_date": ["between", [start, end]], "docstatus": 0},
			"unsubmitted_purchase_invoices",
			"{count} Draft Purchase Invoices",
			"purchase-invoice",
			"warning",
		),
		(
			"Sales Invoice",
			{"company": company, "posting_date": ["between", [start, end]], "docstatus": 0},
			"unsubmitted_sales_invoices",
			"{count} Draft Sales Invoices",
			"sales-invoice",
			"warning",
		),
	]

	issues = []
	for doctype, filters, issue_type, label, route, severity in checks:
		if not frappe.has_permission(doctype, "read"):
			frappe.throw(_("Not permitted to check {0}.").format(doctype), frappe.PermissionError)
		issue = _count_issue(doctype, filters, issue_type, label, route, severity)
		if issue:
			if issue["count"] == 1:
				issue["label"] = issue["label"].replace(" Entries", " Entry")
				issue["label"] = issue["label"].replace(" Transactions", " Transaction")
				issue["label"] = issue["label"].replace(" Invoices", " Invoice")
			issues.append(issue)

	total = len(issues)
	return {
		"issues": issues,
		"total": total,
		"ready": total == 0,
		"summary": _("Ready to close.")
		if total == 0
		else (
			_("{0} issue to resolve before closing.").format(total)
			if total == 1
			else _("{0} issues to resolve before closing.").format(total)
		),
	}
