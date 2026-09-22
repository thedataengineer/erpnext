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
from erpnext.adhd import api as adhd_api
from erpnext.focus_usage_log.doctype.focus_usage_log import focus_usage_log
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
			"Focus Usage Log",
			fields=["name", "event_type", "intent", "owner", "modified_by", "doctype_name"],
			order_by="creation desc",
			limit_page_length=5,
		)

	def test_nothing_is_stored_unless_switched_on(self):
		before = frappe.db.count("Focus Usage Log")
		with self._switch(False):
			focus_usage_log.log_focus_event("form_save", doctype_name="Lead")
		self.assertEqual(frappe.db.count("Focus Usage Log"), before)

	def test_a_stored_event_does_not_name_who_caused_it(self):
		frappe.set_user("Administrator")
		with self._switch(True):
			focus_usage_log.log_focus_event("command_intent", intent="create_lead")
		row = self._rows()[0]
		self.assertEqual(row.event_type, "command_intent")
		self.assertEqual(row.intent, "create_lead")
		self.assertEqual(row.owner, focus_usage_log.ANONYMOUS_USER)
		self.assertEqual(row.modified_by, focus_usage_log.ANONYMOUS_USER)

	def test_typed_text_never_reaches_the_log(self):
		typed = json.dumps({"type": "start", "recipe": "create_lead", "values": {"email": "jo@acme.com"}})
		for intent in (typed, "log a call with Jo at jo@acme.com", "x" * 500):
			with self._switch(True):
				focus_usage_log.log_focus_event("command_intent", intent=intent)
			self.assertIsNone(self._rows()[0].intent, intent[:30])

	def test_free_text_is_cut_to_the_field_length(self):
		with self._switch(True):
			focus_usage_log.log_focus_event("form_save", doctype_name="D" * 400)
		self.assertEqual(len(self._rows()[0].doctype_name), focus_usage_log.MAX_TEXT_LENGTH)

	def test_unknown_event_types_are_refused(self):
		with self._switch(True):
			with self.assertRaises(frappe.ValidationError):
				focus_usage_log.log_focus_event("something_else")


class TestSmartInbox(AdhdServerTestCase):
	def _todo(self, description, **kwargs):
		return _dict(
			name="TD-0001",
			description=description,
			reference_type=None,
			reference_name=None,
			modified=datetime(2026, 9, 1),
			**kwargs,
		)

	def _action_titles(self, description):
		def fake_get_list(doctype, **kwargs):
			return [self._todo(description)] if doctype == "ToDo" else []

		with patch.object(adhd_api, "_get_list", side_effect=fake_get_list):
			return [item["title"] for item in adhd_api.get_action_queue()]

	def test_a_todo_description_is_shown_as_plain_text(self):
		# ToDo.description is a Text Editor field, so it holds HTML that the inbox would print as tags
		html = '<div class="ql-editor read-mode"><p>Call  <strong>Jo</strong> &amp; Sam</p><p>Bring the&nbsp;quote</p></div>'
		self.assertEqual(self._action_titles(html), ["Call Jo & Sam Bring the quote"])

	def test_a_todo_with_an_empty_editor_value_falls_back_to_its_name(self):
		self.assertEqual(self._action_titles("<p><br></p>"), ["TD-0001"])

	def test_plain_text_is_not_treated_as_markup_after_unescaping(self):
		# "&lt;b&gt;" is text the user typed, not a tag to strip
		self.assertEqual(adhd_api._plain_text("<p>Use &lt;b&gt; for bold</p>"), "Use <b> for bold")

	def _urgent_task_rows(self, assign):
		overdue = frappe.utils.add_days(frappe.utils.today(), -1)
		filters_seen = []

		def fake_get_list(doctype, **kwargs):
			if doctype != "Task":
				return []
			filters_seen.append(kwargs["filters"])
			if "_assign" in kwargs["fields"]:
				return [
					_dict(
						name="TASK-1", subject="Ship it", exp_end_date=overdue, status="Open", _assign=assign
					)
				]
			return [_dict(name="TASK-1")]

		with (
			patch.object(adhd_api, "_get_list", side_effect=fake_get_list),
			patch.object(
				adhd_api, "get_fullname", side_effect=lambda user: {"a@b.com": "Ann Lee"}.get(user, user)
			),
		):
			return adhd_api.get_urgent_items(), filters_seen

	def test_task_assignees_are_shown_as_names_not_json(self):
		rows, _filters = self._urgent_task_rows('["a@b.com", "c@d.com"]')
		self.assertEqual(rows[0]["title"], "Ship it")
		self.assertEqual(rows[0]["counterparty"], "Ann Lee, c@d.com")

	def test_a_task_nobody_is_assigned_to_has_no_counterparty(self):
		for assign in (None, "", "[]", "not json", '"a@b.com"', "[null, 5]"):
			rows, _filters = self._urgent_task_rows(assign)
			self.assertIsNone(rows[0]["counterparty"], repr(assign))

	def test_assigned_task_lookup_matches_the_whole_user_id(self):
		# _assign is a JSON list; %a@b.com% would also match "aa@b.com"
		_rows, filters_seen = self._urgent_task_rows('["a@b.com"]')
		self.assertEqual(filters_seen[0]["_assign"], ("like", f'%"{frappe.session.user}"%'))


# --- what another app can add to the inbox (the `focus_urgent_items` hook) ---------------------------------


def _hr_source(user, current_day):
	"""A source the way Hubble writes one: rows waiting on `user`, due today or before."""
	return [
		{
			"doctype": "ToDo",
			"name": "HR-LEAVE-1",
			"title": "Casual Leave: Ash",
			"counterparty": "Ash",
			"due_date": frappe.utils.add_days(current_day, -3),
		},
		{"doctype": "ToDo", "name": "HR-CLAIM-1", "due_date": current_day},
		# not due yet: left out, like every built-in source only lists what is due today or overdue
		{"doctype": "ToDo", "name": "HR-LATER", "due_date": frappe.utils.add_days(current_day, 2)},
		# malformed rows are dropped, never shown half-built
		{"doctype": "Not A DocType", "name": "X", "due_date": current_day},
		{"name": "no-doctype", "due_date": current_day},
		{"doctype": "ToDo", "name": "HR-NO-DATE"},
		{"doctype": "ToDo", "name": "HR-BAD-DATE", "due_date": "yesterday-ish"},
		{"doctype": "ToDo", "name": 42, "due_date": current_day},
		"not a row",
	]


def _broken_source(user, current_day):
	raise RuntimeError("boom")


def _flood_source(user, current_day):
	return [{"doctype": "ToDo", "name": f"HR-FLOOD-{i}", "due_date": current_day} for i in range(60)]


class TestHookedUrgentItems(AdhdServerTestCase):
	"""Hubble (the HR app) adds leave, claims and interviews waiting on the person through a hook; the
	inbox trusts a source for its permission checks and nothing else."""

	def _urgent(self, sources):
		real_get_hooks = frappe.get_hooks

		def fake_get_hooks(hook=None, *args, **kwargs):
			if hook == "focus_urgent_items":
				return [f"{__name__}.{source}" for source in sources]
			return real_get_hooks(hook, *args, **kwargs)

		with (
			patch.object(adhd_api, "_get_list", return_value=[]),
			patch("frappe.get_hooks", side_effect=fake_get_hooks),
			patch("frappe.log_error") as log_error,
		):
			return adhd_api.get_urgent_items(), log_error

	def test_rows_from_a_hooked_source_are_ranked_with_the_rest(self):
		rows, _log = self._urgent(["_hr_source"])
		self.assertEqual([row["name"] for row in rows], ["HR-LEAVE-1", "HR-CLAIM-1"])
		leave, claim = rows
		self.assertEqual(leave["doctype"], "ToDo")
		self.assertEqual(leave["title"], "Casual Leave: Ash")
		self.assertEqual(leave["counterparty"], "Ash")
		self.assertEqual(leave["urgency"], "overdue")
		self.assertEqual(leave["urgency_score"], 13)
		# no title given: the name stands in, and nothing is invented for the counterparty
		self.assertEqual(claim["title"], "HR-CLAIM-1")
		self.assertIsNone(claim["counterparty"])
		self.assertEqual(claim["urgency"], "today")

	def test_a_source_that_raises_is_logged_and_skipped(self):
		rows, log_error = self._urgent(["_broken_source", "_hr_source"])
		self.assertEqual([row["name"] for row in rows], ["HR-LEAVE-1", "HR-CLAIM-1"])
		self.assertEqual(log_error.call_count, 1)
		self.assertIn("_broken_source", log_error.call_args.kwargs["title"])

	def test_a_flood_from_one_source_is_bounded(self):
		rows, _log = self._urgent(["_flood_source", "_hr_source"])
		self.assertEqual(len(rows), adhd_api.MAX_URGENT_ITEMS)
		# the overdue leave outranks the flood of due-today rows
		self.assertEqual(rows[0]["name"], "HR-LEAVE-1")

	def test_without_a_hook_nothing_changes(self):
		rows, _log = self._urgent([])
		self.assertEqual(rows, [])
