"""ADHD-mode helpers for locating a BOM in its submitted parent hierarchy."""

import frappe
from frappe import _
from frappe.utils import cint


@frappe.whitelist()
def get_bom_ancestry(bom_name: str, max_depth: int = 3) -> list[dict]:
	"""Return submitted parent BOMs, ordered from the root toward ``bom_name``."""
	if not bom_name or not frappe.db.exists("BOM", bom_name):
		return []
	if not frappe.has_permission("BOM", "read", doc=bom_name):
		frappe.throw(_("Not permitted to read BOM {0}").format(bom_name), frappe.PermissionError)

	depth_limit = min(max(cint(max_depth), 0), 10)
	ancestry: list[dict] = []
	current_bom = bom_name
	visited = {bom_name}

	for _depth in range(depth_limit):
		parent = frappe.db.get_value(
			"BOM Item",
			{"bom_no": current_bom, "docstatus": 1, "parenttype": "BOM"},
			"parent",
			order_by="modified desc",
		)
		if not parent or parent in visited:
			break

		parent_bom = frappe.db.get_value(
			"BOM",
			{"name": parent, "docstatus": 1, "is_active": 1},
			["name", "item", "item_name"],
			as_dict=True,
		)
		# the caller may read the BOM they opened, but not necessarily every BOM above it
		if not parent_bom or not frappe.has_permission("BOM", "read", doc=parent):
			break

		visited.add(parent)
		ancestry.insert(
			0,
			{
				"bom": parent_bom.name,
				"item": parent_bom.item,
				"item_name": parent_bom.item_name,
			},
		)
		current_bom = parent

	return ancestry
