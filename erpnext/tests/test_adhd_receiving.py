# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# Server side of the Purchase Receipt "what's still open?" panel (ADHD-027).
#
# Plain unittest, rolled back, and deliberately without erpnext.tests.utils (importing it bootstraps and
# commits test data into whatever site it runs on). The receipts and orders are written straight to their
# tables with db_insert(): a full submit would post stock and ledger entries, which is far more than the
# endpoint reads. The numbers in the order rows are the ones the status updater would have written.

import unittest
from unittest.mock import patch

import frappe
from frappe.utils import now

from erpnext.buying.services import adhd_receipt_diff

REAL_GET_LIST = frappe.get_list


def _stamp(doc):
	doc.creation = doc.modified = now()
	doc.owner = doc.modified_by = "Administrator"
	return doc


def make_order(name, rows, status="To Receive and Bill", has_unit_price_items=0):
	_stamp(
		frappe.get_doc(
			{
				"doctype": "Purchase Order",
				"name": name,
				"docstatus": 1,
				"status": status,
				"has_unit_price_items": has_unit_price_items,
			}
		)
	).db_insert()
	for idx, row in enumerate(rows, 1):
		_stamp(
			frappe.get_doc(
				{
					"doctype": "Purchase Order Item",
					"parent": name,
					"parenttype": "Purchase Order",
					"parentfield": "items",
					"idx": idx,
					"name": f"{name}-row-{idx}",
					"uom": "Nos",
					"stock_uom": "Nos",
					"conversion_factor": 1,
					**row,
				}
			)
		).db_insert()


def make_receipt(name, rows, docstatus=1, is_return=0):
	_stamp(
		frappe.get_doc(
			{"doctype": "Purchase Receipt", "name": name, "docstatus": docstatus, "is_return": is_return}
		)
	).db_insert()
	for idx, row in enumerate(rows, 1):
		_stamp(
			frappe.get_doc(
				{
					"doctype": "Purchase Receipt Item",
					"parent": name,
					"parenttype": "Purchase Receipt",
					"parentfield": "items",
					"idx": idx,
					"name": f"{name}-row-{idx}",
					**row,
				}
			)
		).db_insert()


class ReceivingTestCase(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	def rows_by_item(self, result):
		return {row["item_code"]: row for row in result["rows"]}


class TestPendingQuantity(ReceivingTestCase):
	def test_a_partial_receipt_leaves_the_rest_pending(self):
		maths = adhd_receipt_diff.pending_quantity(10, 6)
		self.assertEqual((maths["pending"], maths["over_received"]), (4, 0))

	def test_a_fully_received_row_has_nothing_pending(self):
		maths = adhd_receipt_diff.pending_quantity(5, 5)
		self.assertEqual((maths["pending"], maths["over_received"]), (0, 0))

	def test_an_over_receipt_is_never_a_negative_pending_quantity(self):
		maths = adhd_receipt_diff.pending_quantity(8, 10)
		self.assertEqual((maths["pending"], maths["over_received"]), (0, 2))

	def test_returned_goods_are_pending_again_and_not_taken_off_twice(self):
		# 10 arrived, 4 went back: received_qty is already the net 6, so 4 are pending, not 0 and not 8
		maths = adhd_receipt_diff.pending_quantity(10, 6)
		self.assertEqual(maths["pending"], 4)

	def test_pending_is_also_reported_in_the_stock_uom(self):
		# 4 boxes of 12 are 48 pieces
		maths = adhd_receipt_diff.pending_quantity(10, 6, 12)
		self.assertEqual((maths["pending"], maths["pending_stock_qty"]), (4, 48))

	def test_a_missing_or_zero_factor_counts_as_one(self):
		for factor in (None, 0, ""):
			self.assertEqual(adhd_receipt_diff.pending_quantity(3, 1, factor)["pending_stock_qty"], 2)

	def test_missing_quantities_count_as_zero(self):
		maths = adhd_receipt_diff.pending_quantity(None, None)
		self.assertEqual((maths["pending"], maths["over_received"]), (0, 0))
		self.assertEqual(adhd_receipt_diff.pending_quantity(7, None)["pending"], 7)

	def test_float_noise_does_not_leave_a_phantom_pending_quantity(self):
		self.assertEqual(adhd_receipt_diff.pending_quantity(0.3, 0.1 + 0.2)["pending"], 0)


class TestReceiptDiff(ReceivingTestCase):
	def setUp(self):
		super().setUp()
		# the ticket's example: A 10, B 5, C 8 ordered
		make_order(
			"ADHD-RCV-PO-1",
			[
				{"item_code": "ITEM-A", "item_name": "Item A", "qty": 10, "received_qty": 6},
				{"item_code": "ITEM-B", "item_name": "Item B", "qty": 5, "received_qty": 5},
				{"item_code": "ITEM-C", "item_name": "Item C", "qty": 8, "received_qty": 3},
			],
		)
		make_receipt(
			"ADHD-RCV-PR-1",
			[
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-1",
					"qty": 6,
					"received_qty": 6,
				},
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-2",
					"qty": 5,
					"received_qty": 5,
				},
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-3",
					"qty": 3,
					"received_qty": 3,
				},
			],
		)

	def test_the_first_partial_receipt_shows_what_is_still_open(self):
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1")
		rows = self.rows_by_item(result)

		self.assertEqual([order["name"] for order in result["orders"]], ["ADHD-RCV-PO-1"])
		self.assertEqual(result["hidden_orders"], [])
		self.assertEqual(result["open_count"], 2)
		self.assertEqual(
			(rows["ITEM-A"]["ordered"], rows["ITEM-A"]["this_receipt"], rows["ITEM-A"]["received"]),
			(10, 6, 6),
		)
		self.assertEqual((rows["ITEM-A"]["pending"], rows["ITEM-A"]["state"]), (4, "open"))
		self.assertEqual((rows["ITEM-B"]["pending"], rows["ITEM-B"]["state"]), (0, "complete"))
		self.assertEqual((rows["ITEM-C"]["pending"], rows["ITEM-C"]["state"]), (5, "open"))

	def test_a_second_receipt_for_the_rest_closes_the_order(self):
		# the status updater would now have written A 10 and C 8 into the order rows
		frappe.db.set_value("Purchase Order Item", "ADHD-RCV-PO-1-row-1", "received_qty", 10)
		frappe.db.set_value("Purchase Order Item", "ADHD-RCV-PO-1-row-3", "received_qty", 8)
		make_receipt(
			"ADHD-RCV-PR-2",
			[
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-1",
					"qty": 4,
					"received_qty": 4,
				},
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-3",
					"qty": 5,
					"received_qty": 5,
				},
			],
		)
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-2")
		rows = self.rows_by_item(result)

		self.assertEqual(result["open_count"], 0)
		self.assertEqual({row["state"] for row in result["rows"]}, {"complete"})
		# this receipt's own share, and nothing for the line it did not touch
		self.assertEqual(
			(rows["ITEM-A"]["this_receipt"], rows["ITEM-B"]["this_receipt"], rows["ITEM-C"]["this_receipt"]),
			(4, 0, 5),
		)

	def test_a_line_over_received_is_complete_and_says_by_how_much(self):
		frappe.db.set_value("Purchase Order Item", "ADHD-RCV-PO-1-row-2", "received_qty", 7)
		row = self.rows_by_item(adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1"))["ITEM-B"]
		self.assertEqual((row["state"], row["pending"], row["over_received"]), ("complete", 0, 2))

	def test_rejected_quantity_counts_towards_this_receipt_and_is_reported(self):
		# received_qty is accepted + rejected, which is what the order's received_qty is fed from
		frappe.db.set_value("Purchase Receipt Item", "ADHD-RCV-PR-1-row-1", {"qty": 5, "rejected_qty": 1})
		row = self.rows_by_item(adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1"))["ITEM-A"]
		self.assertEqual((row["this_receipt"], row["this_receipt_rejected"]), (6, 1))

	def test_a_line_with_a_unit_of_measure_is_reported_in_that_uom_and_in_stock_units(self):
		frappe.db.set_value(
			"Purchase Order Item",
			"ADHD-RCV-PO-1-row-1",
			{"uom": "Box", "stock_uom": "Nos", "conversion_factor": 12},
		)
		row = self.rows_by_item(adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1"))["ITEM-A"]
		self.assertEqual(
			(row["uom"], row["stock_uom"], row["pending"], row["pending_stock_qty"]), ("Box", "Nos", 4, 48)
		)

	def test_closed_lines_and_closed_orders_are_written_off_not_pending(self):
		frappe.db.set_value("Purchase Order Item", "ADHD-RCV-PO-1-row-3", "closed", 1)
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1")
		rows = self.rows_by_item(result)
		self.assertEqual((rows["ITEM-C"]["state"], rows["ITEM-C"]["pending"]), ("closed", 0))
		self.assertEqual(result["open_count"], 1)

		frappe.db.set_value("Purchase Order", "ADHD-RCV-PO-1", "status", "Closed")
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1")
		self.assertEqual(result["open_count"], 0)
		self.assertEqual({row["state"] for row in result["rows"]}, {"closed"})

	def test_a_drop_shipped_line_is_left_out(self):
		frappe.db.set_value("Purchase Order Item", "ADHD-RCV-PO-1-row-3", "delivered_by_supplier", 1)
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1")
		self.assertEqual([row["item_code"] for row in result["rows"]], ["ITEM-A", "ITEM-B"])

	def test_a_unit_price_line_has_no_fixed_quantity_to_subtract(self):
		frappe.db.set_value("Purchase Order", "ADHD-RCV-PO-1", "has_unit_price_items", 1)
		frappe.db.set_value("Purchase Order Item", "ADHD-RCV-PO-1-row-3", {"qty": 0, "received_qty": 0})
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1")
		row = self.rows_by_item(result)["ITEM-C"]
		self.assertEqual((row["state"], row["pending"]), ("open_ended", 0))
		self.assertEqual(result["open_count"], 1)

	def test_a_return_receipt_reports_negative_quantities_and_the_reopened_order(self):
		# 10 of A arrived and 4 were sent back: the order row now holds the net 6
		make_receipt(
			"ADHD-RCV-PR-RET",
			[
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-1",
					"qty": -4,
					"received_qty": -4,
				}
			],
			is_return=1,
		)
		frappe.db.set_value(
			"Purchase Order Item", "ADHD-RCV-PO-1-row-1", {"received_qty": 6, "returned_qty": 4}
		)
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-RET")
		row = self.rows_by_item(result)["ITEM-A"]

		self.assertEqual(result["is_return"], 1)
		self.assertEqual(
			(row["this_receipt"], row["returned"], row["received"], row["pending"]), (-4, 4, 6, 4)
		)

	def test_lines_of_several_orders_come_in_the_receipts_order_and_are_read_in_bulk(self):
		make_order(
			"ADHD-RCV-PO-0", [{"item_code": "ITEM-Z", "item_name": "Item Z", "qty": 2, "received_qty": 1}]
		)
		make_receipt(
			"ADHD-RCV-PR-MIX",
			[
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-1",
					"qty": 6,
					"received_qty": 6,
				},
				{
					"purchase_order": "ADHD-RCV-PO-0",
					"purchase_order_item": "ADHD-RCV-PO-0-row-1",
					"qty": 1,
					"received_qty": 1,
				},
			],
		)
		asked = []

		def counting(doctype, *args, **kwargs):
			asked.append(doctype)
			return REAL_GET_LIST(doctype, *args, **kwargs)

		with patch("frappe.get_list", side_effect=counting):
			result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-MIX")

		# the receipt's own rows first, then every order in one query, then every order's rows in one query
		self.assertEqual(asked, ["Purchase Receipt Item", "Purchase Order", "Purchase Order Item"])
		self.assertEqual([order["name"] for order in result["orders"]], ["ADHD-RCV-PO-1", "ADHD-RCV-PO-0"])
		self.assertEqual(
			[row["purchase_order"] for row in result["rows"]], ["ADHD-RCV-PO-1"] * 3 + ["ADHD-RCV-PO-0"]
		)

	def test_an_order_the_caller_cannot_read_is_named_but_its_quantities_are_not_returned(self):
		make_order("ADHD-RCV-PO-SECRET", [{"item_code": "ITEM-S", "qty": 9, "received_qty": 1}])
		make_receipt(
			"ADHD-RCV-PR-SEC",
			[
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-1",
					"qty": 6,
					"received_qty": 6,
				},
				{
					"purchase_order": "ADHD-RCV-PO-SECRET",
					"purchase_order_item": "ADHD-RCV-PO-SECRET-row-1",
					"qty": 1,
					"received_qty": 1,
				},
			],
		)

		def visible_orders_only(doctype, *args, **kwargs):
			rows = REAL_GET_LIST(doctype, *args, **kwargs)
			if doctype == "Purchase Order":
				return [row for row in rows if row.name != "ADHD-RCV-PO-SECRET"]
			return rows

		with patch("frappe.get_list", side_effect=visible_orders_only):
			result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-SEC")

		self.assertEqual(result["hidden_orders"], ["ADHD-RCV-PO-SECRET"])
		self.assertEqual({row["purchase_order"] for row in result["rows"]}, {"ADHD-RCV-PO-1"})
		self.assertNotIn("ITEM-S", str(result))

	def test_a_draft_receipt_has_nothing_to_report_yet(self):
		make_receipt(
			"ADHD-RCV-PR-DRAFT",
			[{"purchase_order": "ADHD-RCV-PO-1", "purchase_order_item": "ADHD-RCV-PO-1-row-1", "qty": 1}],
			docstatus=0,
		)
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-DRAFT")
		self.assertEqual((result["orders"], result["rows"], result["open_count"]), ([], [], 0))

	def test_a_receipt_not_made_against_an_order_has_nothing_to_report(self):
		make_receipt("ADHD-RCV-PR-DIRECT", [{"item_code": "ITEM-A", "qty": 1, "received_qty": 1}])
		result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-DIRECT")
		self.assertEqual((result["orders"], result["rows"]), ([], []))

	def test_the_number_of_lines_returned_is_capped_and_says_so(self):
		with patch.object(adhd_receipt_diff, "MAX_ROWS", 2):
			result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-1")
		self.assertEqual(len(result["rows"]), 2)
		self.assertTrue(result["truncated"])

	def test_the_number_of_orders_read_is_capped_and_says_so(self):
		make_order("ADHD-RCV-PO-2", [{"item_code": "ITEM-Y", "qty": 1, "received_qty": 0}])
		make_receipt(
			"ADHD-RCV-PR-TWO",
			[
				{
					"purchase_order": "ADHD-RCV-PO-1",
					"purchase_order_item": "ADHD-RCV-PO-1-row-1",
					"qty": 1,
					"received_qty": 1,
				},
				{
					"purchase_order": "ADHD-RCV-PO-2",
					"purchase_order_item": "ADHD-RCV-PO-2-row-1",
					"qty": 1,
					"received_qty": 1,
				},
			],
		)
		with patch.object(adhd_receipt_diff, "MAX_ORDERS", 1):
			result = adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-TWO")
		self.assertEqual([order["name"] for order in result["orders"]], ["ADHD-RCV-PO-1"])
		self.assertTrue(result["truncated"])


class TestReceiptDiffPermissions(ReceivingTestCase):
	def test_a_user_who_cannot_read_the_receipt_is_refused_before_any_order_is_read(self):
		make_receipt(
			"ADHD-RCV-PR-P",
			[{"purchase_order": "ADHD-RCV-PO-P", "purchase_order_item": "x", "received_qty": 1}],
		)
		asked = []

		def counting(doctype, *args, **kwargs):
			asked.append(doctype)
			return REAL_GET_LIST(doctype, *args, **kwargs)

		frappe.set_user("Guest")
		with patch("frappe.get_list", side_effect=counting):
			with self.assertRaises(frappe.PermissionError):
				adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-P")

		# Frappe's own share lookup may read DocShare; nothing of the receipt or the orders may be read
		self.assertFalse({"Purchase Receipt Item", "Purchase Order", "Purchase Order Item"} & set(asked))

	def test_the_receipt_permission_check_is_a_document_level_read_that_throws(self):
		make_receipt("ADHD-RCV-PR-P", [])
		with patch("frappe.has_permission", side_effect=frappe.PermissionError) as has_permission:
			with self.assertRaises(frappe.PermissionError):
				adhd_receipt_diff.get_receipt_diff("ADHD-RCV-PR-P")
		# refused on the very first check, before the receipt's rows are read
		has_permission.assert_called_once()
		self.assertEqual(has_permission.call_args.args[:2], ("Purchase Receipt", "read"))
		self.assertEqual(has_permission.call_args.kwargs["doc"], "ADHD-RCV-PR-P")
		self.assertIs(has_permission.call_args.kwargs["throw"], True)

	def test_a_missing_or_absurd_receipt_name_is_refused(self):
		for name in ("", None, "x" * 141):
			with self.assertRaises(frappe.ValidationError):
				adhd_receipt_diff.get_receipt_diff(name)

	def test_the_endpoint_is_whitelisted(self):
		self.assertIn(adhd_receipt_diff.get_receipt_diff, frappe.whitelisted)
