# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

import frappe
from frappe import _
from frappe.utils import add_days, flt, getdate, today

MAX_INVOICES = 2000


@frappe.whitelist()
def get_payment_digest(company=None):
	"""Return outstanding receivables grouped for the ADHD Focus Panel."""
	company = company or frappe.defaults.get_user_default("Company")
	if not company:
		frappe.throw(_("Set a default Company to load the payment summary."))

	invoices = frappe.get_list(
		"Sales Invoice",
		filters={"company": company, "docstatus": 1, "outstanding_amount": (">", 0)},
		fields=["name", "customer", "outstanding_amount", "conversion_rate", "due_date"],
		order_by="due_date asc",
		limit_page_length=MAX_INVOICES + 1,
	)
	truncated = len(invoices) > MAX_INVOICES
	invoices = invoices[:MAX_INVOICES]
	start = getdate(today())
	week_end = getdate(add_days(start, 7))

	def outstanding(invoice):
		# outstanding_amount is in the invoice's own currency; the panel shows one company currency,
		# so convert, otherwise USD and EUR invoices would simply be added together
		return flt(invoice.outstanding_amount) * (flt(invoice.conversion_rate) or 1)

	def group_by_customer(rows):
		grouped = {}
		for invoice in rows:
			entry = grouped.setdefault(
				invoice.customer,
				{"customer": invoice.customer, "total": 0.0, "invoices": []},
			)
			entry["total"] = flt(entry["total"]) + outstanding(invoice)
			entry["invoices"].append(invoice.name)
		return sorted(grouped.values(), key=lambda item: item["total"], reverse=True)

	overdue = []
	due_this_week = []
	for invoice in invoices:
		if not invoice.due_date:
			continue
		due_date = getdate(invoice.due_date)
		if due_date < start:
			overdue.append(invoice)
		elif due_date <= week_end:
			due_this_week.append(invoice)

	return {
		"company": company,
		"currency": frappe.get_cached_value("Company", company, "default_currency"),
		"total_outstanding": sum(outstanding(invoice) for invoice in invoices),
		"overdue": group_by_customer(overdue),
		"due_this_week": group_by_customer(due_this_week),
		# the oldest MAX_INVOICES were used; say so instead of quietly understating the total
		"truncated": truncated,
	}
