"""Batch quality-inspection summaries for ADHD-mode source-document banners."""

import json

import frappe
from frappe import _


@frappe.whitelist()
def get_quality_inspection_summaries(names: str | list[str]) -> list[dict]:
	"""Return top-level status and rejected-reading counts in one request."""
	if isinstance(names, str):
		names = json.loads(names)
	names = list(dict.fromkeys(name for name in (names or []) if name))
	if not names:
		return []

	for name in names:
		if not frappe.has_permission("Quality Inspection", "read", doc=name):
			frappe.throw(
				_("Not permitted to read Quality Inspection {0}").format(name),
				frappe.PermissionError,
			)

	inspections = frappe.get_all(
		"Quality Inspection",
		filters={"name": ["in", names]},
		fields=["name", "status", "item_code", "docstatus"],
		limit_page_length=len(names),
	)
	rejected_counts: dict[str, int] = {}
	for row in frappe.get_all(
		"Quality Inspection Reading",
		filters={"parent": ["in", names], "status": "Rejected"},
		fields=["parent"],
		limit_page_length=10000,
	):
		rejected_counts[row.parent] = rejected_counts.get(row.parent, 0) + 1

	for inspection in inspections:
		inspection["rejected_readings"] = rejected_counts.get(inspection.name, 0)
	return inspections
