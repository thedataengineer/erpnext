"""Auto-detection helpers for the ADHD month-end checklist."""

from calendar import monthrange

import frappe
from frappe.utils import getdate


@frappe.whitelist()
def is_period_closed(month_str: str, company: str) -> bool:
	"""Return whether a submitted closing voucher ends in ``YYYY-MM``."""
	if not month_str or not company:
		return False
	if not frappe.has_permission("Period Closing Voucher", "read"):
		frappe.throw(frappe._("Not permitted to read Period Closing Vouchers."), frappe.PermissionError)

	try:
		year, month = (int(part) for part in month_str.replace("_", "-").split("-", 1))
		start = getdate(f"{year:04d}-{month:02d}-01")
		end = getdate(f"{year:04d}-{month:02d}-{monthrange(year, month)[1]:02d}")
	except (TypeError, ValueError):
		frappe.throw(frappe._("Month must use YYYY-MM format."))

	return bool(
		frappe.db.exists(
			"Period Closing Voucher",
			{
				"company": company,
				"docstatus": 1,
				"period_end_date": ["between", [start, end]],
			},
		)
	)


@frappe.whitelist()
def is_bank_reconciled(month_str: str, company: str):
	"""Bank reconciliation has no reliable cross-instance completion signal."""
	return None


@frappe.whitelist()
def is_debtors_aging_reviewed(month_str: str, company: str):
	return None


@frappe.whitelist()
def are_provisions_complete(month_str: str, company: str):
	return None


@frappe.whitelist()
def is_pl_reviewed(month_str: str, company: str):
	return None
