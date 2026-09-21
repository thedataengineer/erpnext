# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# Server side of the ADHD-mode aids. The Node suites only read the client source, so they cannot notice
# when an endpoint raises or returns the wrong numbers; these run the Python for real.
#
# Plain unittest, rolled back, and deliberately without erpnext.tests.utils (importing it bootstraps and
# commits test data into whatever site it runs on).

import json
import unittest
from datetime import date, datetime
from unittest.mock import patch

import frappe
from frappe import _dict

from erpnext.accounts.services import adhd_month_end, adhd_payment_digest
from erpnext.adhd_usage_log.doctype.adhd_usage_log import adhd_usage_log
from erpnext.manufacturing.services import adhd_bom_ancestry
from erpnext.stock import adhd as stock_adhd
from erpnext.stock import adhd_quality


class AdhdServerTestCase(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")


class TestStockEndpoints(AdhdServerTestCase):
	def test_package_qty_sums_delivery_note_items(self):
		# Frappe v17 rejects "sum(qty) as x" in fields, which made this raise for any real Delivery Note
		now = frappe.utils.now()
		for i, qty in enumerate((3, 4.5)):
			frappe.db.sql(
				"""insert into `tabDelivery Note Item`
				(name, parent, parenttype, parentfield, idx, qty, creation, modified, owner, modified_by)
				values (%s, 'ADHD-TEST-DN', 'Delivery Note', 'items', %s, %s, %s, %s, 'Administrator', 'Administrator')""",
				(f"adhd-test-dni-{i}", i + 1, qty, now, now),
			)
		with patch("frappe.get_list", return_value=["ADHD-TEST-DN"]):
			self.assertEqual(stock_adhd.get_delivery_note_package_qty(json.dumps(["ADHD-TEST-DN"])), 7.5)

	def test_package_qty_of_nothing_is_zero(self):
		with patch("frappe.get_list", return_value=[]):
			self.assertEqual(stock_adhd.get_delivery_note_package_qty(json.dumps(["nope"])), 0)

	def test_package_qty_refuses_a_huge_list(self):
		with self.assertRaises(frappe.ValidationError):
			stock_adhd.get_delivery_note_package_qty(json.dumps([f"DN-{i}" for i in range(101)]))

	def test_bin_query_limit_covers_every_item_warehouse_combination(self):
		# 3 requested pairs select up to 3 x 3 Bins; a limit of 2 x pairs cut some requested pairs off
		pairs = [{"item_code": f"I{i}", "warehouse": f"W{i}"} for i in range(3)]
		seen = {}

		def fake_get_all(doctype, **kwargs):
			seen.update(kwargs)
			return [
				_dict(item_code=f"I{i}", warehouse=f"W{j}", actual_qty=1) for i in range(3) for j in range(3)
			]

		with (
			patch.object(stock_adhd, "_permitted_items", return_value=["I0", "I1", "I2"]),
			patch.object(stock_adhd, "_permitted_warehouses", return_value=["W0", "W1", "W2"]),
			patch("frappe.get_all", side_effect=fake_get_all),
		):
			rows = stock_adhd.get_bin_quantities(json.dumps(pairs))

		self.assertGreaterEqual(seen["limit_page_length"], 9)
		self.assertEqual(
			[(r.item_code, r.warehouse) for r in rows], [("I0", "W0"), ("I1", "W1"), ("I2", "W2")]
		)

	def test_batches_are_first_expired_first_out_with_undated_last(self):
		batches = [
			_dict(name="NO-EXPIRY", manufacturing_date=None, expiry_date=None, creation=datetime(2026, 1, 1)),
			_dict(
				name="LATE",
				manufacturing_date=None,
				expiry_date=date(2027, 6, 1),
				creation=datetime(2026, 1, 2),
			),
			_dict(
				name="SOON",
				manufacturing_date=None,
				expiry_date=date(2026, 10, 1),
				creation=datetime(2026, 1, 3),
			),
		]
		with (
			patch.object(stock_adhd, "_permitted_items", return_value=["ITEM"]),
			patch.object(stock_adhd, "_permitted_warehouses", return_value=["WH"]),
			patch("frappe.get_list", return_value=batches),
			patch(
				"erpnext.stock.doctype.batch.batch.get_batch_qty",
				return_value=[_dict(batch_no="SOON", qty=5)],
			),
		):
			result = stock_adhd.get_available_batches("ITEM", "WH", limit=2)

		self.assertEqual([b.name for b in result], ["SOON", "LATE"])
		self.assertEqual([b.available_qty for b in result], [5, 0])
		self.assertNotIn("creation", result[0])


class TestFinanceEndpoints(AdhdServerTestCase):
	def _invoices(self, rows):
		# (name, outstanding, invoice currency, receivable account currency, rate to company currency, due)
		return [
			_dict(
				name=name,
				customer="Acme",
				outstanding_amount=amount,
				currency=currency,
				party_account_currency=account_currency,
				conversion_rate=rate,
				due_date=due,
			)
			for name, amount, currency, account_currency, rate, due in rows
		]

	def _digest(self, invoices):
		with (
			patch("frappe.get_list", return_value=invoices),
			patch("frappe.get_cached_value", return_value="USD"),
		):
			return adhd_payment_digest.get_payment_digest("Any Company")

	def test_outstanding_in_a_foreign_receivable_account_is_converted(self):
		# EUR invoice on a EUR receivable account: outstanding_amount is in EUR, the panel shows USD
		overdue = frappe.utils.add_days(frappe.utils.today(), -3)
		digest = self._digest(self._invoices([("A", 100, "EUR", "EUR", 1.1, overdue)]))
		self.assertAlmostEqual(digest["total_outstanding"], 110.0)

	def test_outstanding_in_the_company_receivable_account_is_not_converted_again(self):
		# EUR invoice on a USD receivable account: outstanding_amount is already in USD
		overdue = frappe.utils.add_days(frappe.utils.today(), -3)
		digest = self._digest(self._invoices([("A", 110, "EUR", "USD", 1.1, overdue)]))
		self.assertAlmostEqual(digest["total_outstanding"], 110.0)

	def test_payment_digest_groups_and_totals_by_customer(self):
		overdue = frappe.utils.add_days(frappe.utils.today(), -3)
		digest = self._digest(
			self._invoices([("A", 100, "USD", "USD", 1, overdue), ("B", 50, "USD", "USD", 1, overdue)])
		)
		self.assertAlmostEqual(digest["total_outstanding"], 150.0)
		self.assertAlmostEqual(digest["overdue"][0]["total"], 150.0)
		self.assertEqual(digest["overdue"][0]["invoices"], ["A", "B"])
		self.assertFalse(digest["truncated"])

	def test_payment_digest_says_when_it_did_not_see_everything(self):
		overdue = frappe.utils.add_days(frappe.utils.today(), -1)
		invoices = self._invoices(
			[(f"INV-{i}", 1, "USD", "USD", 1, overdue) for i in range(adhd_payment_digest.MAX_INVOICES + 1)]
		)
		digest = self._digest(invoices)

		self.assertTrue(digest["truncated"])
		self.assertEqual(digest["total_outstanding"], adhd_payment_digest.MAX_INVOICES)

	def test_is_period_closed_needs_permission(self):
		with patch("frappe.has_permission", return_value=False):
			with self.assertRaises(frappe.PermissionError):
				adhd_month_end.is_period_closed("2026-08", "Any Company")

	def test_is_period_closed_rejects_a_bad_month(self):
		with self.assertRaises(frappe.ValidationError):
			adhd_month_end.is_period_closed("August", "Any Company")


class TestManufacturingAndQuality(AdhdServerTestCase):
	def test_bom_ancestry_stops_at_a_parent_the_user_cannot_read(self):
		def can_read(doctype, ptype=None, doc=None, **kwargs):
			return doc == "BOM-CHILD"

		def get_value(doctype, filters, fieldname=None, **kwargs):
			if doctype == "BOM Item":
				return "BOM-PARENT"
			return _dict(name="BOM-PARENT", item="TOP", item_name="Top item")

		with (
			patch("frappe.db.exists", return_value=True),
			patch("frappe.has_permission", side_effect=can_read),
			patch("frappe.db.get_value", side_effect=get_value),
		):
			self.assertEqual(adhd_bom_ancestry.get_bom_ancestry("BOM-CHILD"), [])

	def test_bom_ancestry_returns_readable_parents(self):
		with (
			patch("frappe.db.exists", return_value=True),
			patch("frappe.has_permission", return_value=True),
			patch(
				"frappe.db.get_value",
				side_effect=lambda doctype, filters, fieldname=None, **kw: (
					"BOM-PARENT"
					if doctype == "BOM Item" and filters["bom_no"] == "BOM-CHILD"
					else None
					if doctype == "BOM Item"
					else _dict(name="BOM-PARENT", item="TOP", item_name="Top item")
				),
			),
		):
			self.assertEqual(
				adhd_bom_ancestry.get_bom_ancestry("BOM-CHILD"),
				[{"bom": "BOM-PARENT", "item": "TOP", "item_name": "Top item"}],
			)

	def test_quality_summaries_refuse_a_huge_list(self):
		names = [f"QI-{i}" for i in range(adhd_quality.MAX_NAMES + 1)]
		with self.assertRaises(frappe.ValidationError):
			adhd_quality.get_quality_inspection_summaries(json.dumps(names))


class TestUsageLog(AdhdServerTestCase):
	def _switch(self, on):
		real = frappe.db.get_single_value
		return patch(
			"frappe.db.get_single_value",
			side_effect=lambda doctype, field, *a, **kw: (
				int(on) if field == "adhd_telemetry_enabled" else real(doctype, field, *a, **kw)
			),
		)

	def _rows(self):
		return frappe.get_all(
			"ADHD Usage Log",
			fields=["name", "event_type", "intent", "owner", "modified_by", "doctype_name"],
			order_by="creation desc",
			limit_page_length=5,
		)

	def test_nothing_is_stored_unless_switched_on(self):
		before = frappe.db.count("ADHD Usage Log")
		with self._switch(False):
			adhd_usage_log.log_adhd_event("form_save", doctype_name="Lead")
		self.assertEqual(frappe.db.count("ADHD Usage Log"), before)

	def test_a_stored_event_does_not_name_who_caused_it(self):
		frappe.set_user("Administrator")
		with self._switch(True):
			adhd_usage_log.log_adhd_event("command_intent", intent="create_lead")
		row = self._rows()[0]
		self.assertEqual(row.event_type, "command_intent")
		self.assertEqual(row.intent, "create_lead")
		self.assertEqual(row.owner, adhd_usage_log.ANONYMOUS_USER)
		self.assertEqual(row.modified_by, adhd_usage_log.ANONYMOUS_USER)

	def test_typed_text_never_reaches_the_log(self):
		typed = json.dumps({"type": "start", "recipe": "create_lead", "values": {"email": "jo@acme.com"}})
		for intent in (typed, "log a call with Jo at jo@acme.com", "x" * 500):
			with self._switch(True):
				adhd_usage_log.log_adhd_event("command_intent", intent=intent)
			self.assertIsNone(self._rows()[0].intent, intent[:30])

	def test_free_text_is_cut_to_the_field_length(self):
		with self._switch(True):
			adhd_usage_log.log_adhd_event("form_save", doctype_name="D" * 400)
		self.assertEqual(len(self._rows()[0].doctype_name), adhd_usage_log.MAX_TEXT_LENGTH)

	def test_unknown_event_types_are_refused(self):
		with self._switch(True):
			with self.assertRaises(frappe.ValidationError):
				adhd_usage_log.log_adhd_event("something_else")
