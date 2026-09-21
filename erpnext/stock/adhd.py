"""Batched stock queries used by ADHD-mode client features."""

import frappe
from frappe import _
from frappe.query_builder.functions import Sum
from frappe.utils import cint, flt

# how many of an item's batches are read before ordering them first-expired-first-out
MAX_BATCHES_SCANNED = 500


def _permitted_items(item_codes: list[str]) -> list[str]:
	if not frappe.has_permission("Item", "read"):
		frappe.throw(_("Not permitted to read Items."), frappe.PermissionError)
	return frappe.get_list(
		"Item",
		filters={"name": ["in", item_codes]},
		pluck="name",
		limit_page_length=len(item_codes),
	)


def _permitted_warehouses(warehouses: list[str]) -> list[str]:
	if not frappe.has_permission("Warehouse", "read"):
		frappe.throw(_("Not permitted to read Warehouses."), frappe.PermissionError)
	return frappe.get_list(
		"Warehouse",
		filters={"name": ["in", warehouses]},
		pluck="name",
		limit_page_length=len(warehouses),
	)


@frappe.whitelist()
def get_bin_quantities(pairs: list[dict] | str) -> list[dict]:
	"""Return quantities for at most 400 explicit item/warehouse pairs."""
	pairs = frappe.parse_json(pairs)
	if not isinstance(pairs, list) or len(pairs) > 400:
		frappe.throw(_("Provide no more than 400 item and warehouse pairs."))

	requested = {
		(str(pair.get("item_code") or ""), str(pair.get("warehouse") or ""))
		for pair in pairs
		if pair.get("item_code") and pair.get("warehouse")
	}
	if not requested:
		return []

	item_codes = _permitted_items(sorted({item_code for item_code, _warehouse in requested}))
	warehouses = _permitted_warehouses(sorted({warehouse for _item_code, warehouse in requested}))
	if not item_codes or not warehouses:
		return []

	# The two IN filters select every item/warehouse combination, not only the requested pairs, and there is
	# at most one Bin per combination. The limit has to cover all of them or requested pairs get cut off.
	rows = frappe.get_all(
		"Bin",
		filters={"item_code": ["in", item_codes], "warehouse": ["in", warehouses]},
		fields=["item_code", "warehouse", "actual_qty"],
		limit_page_length=len(item_codes) * len(warehouses),
	)
	return [row for row in rows if (row.item_code, row.warehouse) in requested]


@frappe.whitelist()
def get_item_stock_health(item_codes: list[str] | str, warehouse: str) -> list[dict]:
	"""Return actual quantity and configured reorder level for visible Items."""
	item_codes = frappe.parse_json(item_codes)
	if not isinstance(item_codes, list) or not warehouse or len(item_codes) > 200:
		frappe.throw(_("Provide a warehouse and no more than 200 Items."))

	item_codes = _permitted_items(list(dict.fromkeys(item_codes)))
	warehouses = _permitted_warehouses([warehouse])
	if not item_codes or not warehouses:
		return []

	bins = frappe.get_all(
		"Bin",
		filters={"item_code": ["in", item_codes], "warehouse": warehouse},
		fields=["item_code", "actual_qty"],
		limit_page_length=len(item_codes),
	)
	# only this warehouse's rows: an item can have reorder levels for many warehouses, and a flat limit
	# over all of them could cut off the one that matters
	reorder_rows = frappe.get_all(
		"Item Reorder",
		filters={"parent": ["in", item_codes]},
		or_filters=[["warehouse", "=", warehouse], ["warehouse_group", "=", warehouse]],
		fields=["parent", "warehouse", "warehouse_group", "warehouse_reorder_level"],
		limit_page_length=len(item_codes) * 4,
	)
	reorder_by_item = {}
	for row in reorder_rows:
		if row.warehouse_group == warehouse or (not row.warehouse_group and row.warehouse == warehouse):
			reorder_by_item[row.parent] = row.warehouse_reorder_level or 0

	bin_by_item = {row.item_code: row.actual_qty for row in bins}
	return [
		{
			"item_code": item_code,
			"actual_qty": bin_by_item.get(item_code),
			"reorder_level": reorder_by_item.get(item_code),
		}
		for item_code in item_codes
	]


@frappe.whitelist()
def get_available_batches(item_code: str, warehouse: str | None = None, limit: int = 50) -> list[dict]:
	"""Return FEFO batch metadata with quantities in the selected warehouse."""
	from erpnext.stock.doctype.batch.batch import get_batch_qty

	limit = min(max(cint(limit), 1), 100)
	if item_code not in _permitted_items([item_code]):
		return []

	if warehouse and warehouse not in _permitted_warehouses([warehouse]):
		frappe.throw(_("Not permitted to read Warehouse {0}.").format(warehouse), frappe.PermissionError)

	batches = frappe.get_list(
		"Batch",
		filters={"item": item_code, "disabled": 0},
		fields=["name", "manufacturing_date", "expiry_date", "creation"],
		order_by="expiry_date asc, creation asc",
		limit_page_length=MAX_BATCHES_SCANNED,
	)
	# First-expired-first-out: batches with no expiry date go last. MariaDB sorts NULLs first, so order here,
	# before applying the limit.
	batches.sort(key=lambda batch: (batch.expiry_date is None, batch.expiry_date or "", batch.creation))
	batches = batches[:limit]

	qty_rows = (
		get_batch_qty(item_code=item_code, warehouse=warehouse, for_stock_levels=True) if warehouse else []
	)
	qty_by_batch = {row.batch_no: row.qty for row in qty_rows}
	for batch in batches:
		batch["available_qty"] = qty_by_batch.get(batch.name, 0)
		del batch["creation"]
	return batches


@frappe.whitelist()
def get_delivery_note_package_qty(delivery_notes: list[str] | str) -> float:
	"""Return item quantity across at most 100 readable Delivery Notes."""
	delivery_notes = frappe.parse_json(delivery_notes)
	if not isinstance(delivery_notes, list) or len(delivery_notes) > 100:
		frappe.throw(_("Provide no more than 100 Delivery Notes."))
	allowed = frappe.get_list(
		"Delivery Note",
		filters={"name": ["in", list(dict.fromkeys(delivery_notes))]},
		pluck="name",
		limit_page_length=len(delivery_notes),
	)
	if not allowed:
		return 0

	# Frappe v17 rejects SQL functions written as strings in `fields` ("sum(qty) as total_qty"), which made
	# this endpoint raise for any real Delivery Note, so aggregate with the query builder instead.
	item = frappe.qb.DocType("Delivery Note Item")
	total = frappe.qb.from_(item).select(Sum(item.qty)).where(item.parent.isin(allowed)).run()
	return flt(total[0][0]) if total else 0
