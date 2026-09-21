"""ADHD-mode helper: what is still open on the purchase orders a Purchase Receipt was made against."""

import frappe
from frappe import _
from frappe.utils import cint, flt

# a receipt is rarely made against more than a handful of orders; refuse to fan out further than this
MAX_ORDERS = 25
# order rows returned in total, across every order
MAX_ROWS = 400
# rows read from the receipt itself
MAX_RECEIPT_ROWS = 1000


def pending_quantity(
	ordered: float | None,
	received: float | None,
	conversion_factor: float | None = 1,
	precision: int = 3,
) -> dict:
	"""Quantity still to come on one order row, in that row's own UOM.

	``received`` is what ``Purchase Order Item.received_qty`` holds. The status updater
	(``purchase_receipt.py``, ``status_updater``) sums ``received_qty`` over every submitted receipt row
	that points at the order row, and a return receipt's rows are negative, so it is already net of
	returns: goods sent back count as pending again, exactly as the Create > Purchase Receipt mapper
	works out ``qty - received_qty``.

	Nothing is negative: an over-receipt has no pending quantity, and the excess is reported instead.
	``pending_stock_qty`` is the pending quantity in the item's stock UOM.
	"""
	ordered = flt(ordered, precision)
	received = flt(received, precision)
	difference = flt(ordered - received, precision)
	pending = max(difference, 0.0)
	return {
		"pending": pending,
		"over_received": max(-difference, 0.0),
		"pending_stock_qty": flt(pending * (flt(conversion_factor) or 1), precision),
	}


def _row_state(row, order, pending: float) -> str:
	"""open / complete / closed / open_ended, for one order row."""
	# a closed row (or an order closed as a whole) is written off: nothing more is expected on it
	if cint(row.closed) or order.status == "Closed":
		return "closed"
	# a unit-price order line has no fixed quantity, so there is nothing to subtract
	if cint(order.has_unit_price_items) and not flt(row.qty):
		return "open_ended"
	return "open" if pending > 0 else "complete"


@frappe.whitelist()
def get_receipt_diff(receipt: str) -> dict:
	"""Ordered, received and still-open quantities for every line of the orders a receipt draws on.

	Reads the receipt's own rows, then every referenced Purchase Order and its rows in one query each,
	instead of opening each order as a document. Orders the caller may not read are named but not shown.
	"""
	if not receipt or len(receipt) > 140:
		frappe.throw(_("Provide a Purchase Receipt."))

	# the panel reveals order quantities, so the caller must be able to open this receipt
	frappe.has_permission("Purchase Receipt", "read", doc=receipt, throw=True)

	result = {
		"receipt": receipt,
		"is_return": 0,
		"orders": [],
		"hidden_orders": [],
		"rows": [],
		"open_count": 0,
		"truncated": False,
	}
	header = frappe.db.get_value("Purchase Receipt", receipt, ["docstatus", "is_return"], as_dict=True)
	# only a submitted receipt has moved the orders' received quantities
	if not header or header.docstatus != 1:
		return result
	result["is_return"] = cint(header.is_return)

	receipt_rows = frappe.get_list(
		"Purchase Receipt Item",
		parent_doctype="Purchase Receipt",
		filters={"parent": receipt, "parenttype": "Purchase Receipt"},
		fields=["purchase_order", "purchase_order_item", "received_qty", "rejected_qty"],
		order_by="idx asc",
		limit=MAX_RECEIPT_ROWS + 1,
	)
	result["truncated"] = len(receipt_rows) > MAX_RECEIPT_ROWS

	# what this receipt itself brought in, per order row
	from_this_receipt: dict[str, dict] = {}
	order_names: list[str] = []
	for row in receipt_rows[:MAX_RECEIPT_ROWS]:
		if not row.purchase_order:
			continue
		if row.purchase_order not in order_names:
			order_names.append(row.purchase_order)
		if row.purchase_order_item:
			entry = from_this_receipt.setdefault(row.purchase_order_item, {"received": 0.0, "rejected": 0.0})
			entry["received"] += flt(row.received_qty)
			entry["rejected"] += flt(row.rejected_qty)

	if len(order_names) > MAX_ORDERS:
		order_names = order_names[:MAX_ORDERS]
		result["truncated"] = True
	if not order_names:
		return result

	readable = frappe.get_list(
		"Purchase Order",
		filters={"name": ["in", order_names]},
		fields=["name", "status", "has_unit_price_items"],
		limit=len(order_names),
	)
	orders = {order.name: order for order in readable}
	result["orders"] = [
		{
			"name": name,
			"status": orders[name].status,
			"has_unit_price_items": cint(orders[name].has_unit_price_items),
		}
		for name in order_names
		if name in orders
	]
	result["hidden_orders"] = [name for name in order_names if name not in orders]
	if not orders:
		return result

	order_rows = frappe.get_list(
		"Purchase Order Item",
		parent_doctype="Purchase Order",
		filters={"parent": ["in", list(orders)], "parenttype": "Purchase Order"},
		fields=[
			"name",
			"parent",
			"idx",
			"item_code",
			"item_name",
			"qty",
			"received_qty",
			"returned_qty",
			"uom",
			"stock_uom",
			"conversion_factor",
			"closed",
			"delivered_by_supplier",
		],
		order_by="parent asc, idx asc",
		limit=MAX_ROWS + 1,
	)
	if len(order_rows) > MAX_ROWS:
		order_rows = order_rows[:MAX_ROWS]
		result["truncated"] = True

	precision = frappe.get_precision("Purchase Order Item", "qty") or 3
	position = {name: index for index, name in enumerate(order_names)}
	order_rows.sort(key=lambda row: (position[row.parent], row.idx))

	for row in order_rows:
		# a drop-ship line goes from the supplier straight to the customer: it never arrives on a receipt
		if cint(row.delivered_by_supplier):
			continue
		order = orders[row.parent]
		maths = pending_quantity(row.qty, row.received_qty, row.conversion_factor, precision)
		state = _row_state(row, order, maths["pending"])
		mine = from_this_receipt.get(row.name, {})
		if state == "open":
			result["open_count"] += 1
		result["rows"].append(
			{
				"purchase_order": row.parent,
				"purchase_order_item": row.name,
				"item_code": row.item_code,
				"item_name": row.item_name,
				"uom": row.uom,
				"stock_uom": row.stock_uom,
				"conversion_factor": flt(row.conversion_factor) or 1,
				"ordered": flt(row.qty, precision),
				"this_receipt": flt(mine.get("received"), precision),
				"this_receipt_rejected": flt(mine.get("rejected"), precision),
				"received": flt(row.received_qty, precision),
				"returned": flt(row.returned_qty, precision),
				"pending": maths["pending"] if state == "open" else 0.0,
				"pending_stock_qty": maths["pending_stock_qty"] if state == "open" else 0.0,
				"over_received": maths["over_received"],
				"state": state,
			}
		)

	return result
