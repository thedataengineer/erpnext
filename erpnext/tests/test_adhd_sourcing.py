# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# Server side of the ADHD sourcing aids (ADHD-025, the RFQ comparison). The Node suite only reads the client
# source, so it cannot notice when the endpoint raises or matches the wrong rows; these run the Python for real.
#
# Plain unittest, rolled back, and deliberately without erpnext.tests.utils (importing it bootstraps and
# commits test data into whatever site it runs on). The RFQ and quotations are inserted as raw rows, because a
# real Request for Quotation needs items, suppliers, contacts and portal settings that have nothing to do with
# what is tested here.
#
# What this cannot cover: the per-user filtering of Supplier Quotations is done by Frappe's permission engine
# inside `frappe.get_list`; it is checked here by proving the endpoint takes its list from `get_list`, not by
# logging in as a restricted user.

import inspect
import unittest
from unittest.mock import patch

import frappe
from frappe import _dict
from frappe.utils import add_days, getdate, nowdate

from erpnext.buying.services import adhd_rfq_compare as compare

PREFIX = "ADHD-TEST"
RFQ = f"{PREFIX}-RFQ-1"
TABLES_TOUCHED = (
	"Request for Quotation",
	"Request for Quotation Item",
	"Request for Quotation Supplier",
	"Supplier Quotation",
	"Supplier Quotation Item",
	"Supplier",
)


def _insert(doctype, **values):
	"""Insert one raw row (child rows need parent/parenttype/parentfield/idx in `values`)."""
	now = frappe.utils.now()
	values = {
		"creation": now,
		"modified": now,
		"owner": "Administrator",
		"modified_by": "Administrator",
		**values,
	}
	columns = ", ".join(f"`{column}`" for column in values)
	placeholders = ", ".join(["%s"] * len(values))
	frappe.db.sql(
		f"insert into `tab{doctype}` ({columns}) values ({placeholders})",  # nosemgrep
		tuple(values.values()),
	)


def _rfq_item(name, code):
	return _dict(name=name, item_code=code, item_name=code, qty=10, uom="Nos")


def _quotation(name, supplier="SUP-A", **overrides):
	return _dict(
		{
			"name": name,
			"supplier": supplier,
			"supplier_name": f"{supplier} Ltd",
			"status": "Submitted",
			"docstatus": 1,
			"transaction_date": "2026-09-01",
			"valid_till": "2026-12-31",
			"currency": "USD",
			"grand_total": 100,
			"base_grand_total": 100,
			**overrides,
		}
	)


def _row(parent, rfq_item, code, rate, idx=1, base_rate=None, conversion_factor=1, uom="Nos", qty=10):
	return _dict(
		parent=parent,
		idx=idx,
		item_code=code,
		request_for_quotation_item=rfq_item,
		qty=qty,
		uom=uom,
		conversion_factor=conversion_factor,
		rate=rate,
		base_rate=rate if base_rate is None else base_rate,
	)


class SourcingTestCase(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()
		# the raw rows must be gone, or this run has leaked into the site
		for doctype in TABLES_TOUCHED:
			self.assertEqual(
				frappe.db.count(doctype, {"name": ["like", f"{PREFIX}%"]}), 0, f"{doctype} rows leaked"
			)


class TestBuildComparison(SourcingTestCase):
	today = "2026-09-21"

	def build(self, rfq_items, quotations, rows, terms=None):
		return compare.build_comparison(rfq_items, quotations, rows, terms, self.today)

	def test_a_rate_goes_to_the_rfq_item_it_answered(self):
		items = [_rfq_item("R1", "PEN"), _rfq_item("R2", "INK")]
		result = self.build(
			items,
			[_quotation("SQ-1")],
			[_row("SQ-1", "R2", "INK", 7, idx=1), _row("SQ-1", "R1", "PEN", 3, idx=2)],
		)
		self.assertEqual(
			{key: value["rate"] for key, value in result[0]["rates"].items()}, {"R1": 3, "R2": 7}
		)
		self.assertEqual(result[0]["quoted"], 2)

	def test_the_same_item_listed_twice_is_matched_by_row_name_not_code(self):
		# the RFQ asks for PEN for two delivery dates: the item code alone cannot tell the rows apart
		items = [_rfq_item("R1", "PEN"), _rfq_item("R2", "PEN")]
		result = self.build(
			items,
			[_quotation("SQ-1")],
			[_row("SQ-1", "R2", "PEN", 9, idx=1), _row("SQ-1", "R1", "PEN", 8, idx=2)],
		)
		rates = result[0]["rates"]
		self.assertEqual((rates["R1"]["rate"], rates["R2"]["rate"]), (8, 9))

	def test_item_code_is_only_a_fallback_and_only_when_unambiguous(self):
		unique = [_rfq_item("R1", "PEN"), _rfq_item("R2", "INK")]
		result = self.build(unique, [_quotation("SQ-1")], [_row("SQ-1", None, "INK", 7)])
		self.assertEqual(list(result[0]["rates"]), ["R2"])

		ambiguous = [_rfq_item("R1", "PEN"), _rfq_item("R2", "PEN")]
		result = self.build(ambiguous, [_quotation("SQ-1")], [_row("SQ-1", None, "PEN", 7)])
		self.assertEqual(result[0]["rates"], {})

	def test_rows_for_items_the_rfq_never_asked_for_are_ignored(self):
		result = self.build(
			[_rfq_item("R1", "PEN")], [_quotation("SQ-1")], [_row("SQ-1", "OTHER", "PAPER", 5)]
		)
		self.assertEqual(result[0]["rates"], {})
		self.assertEqual(result[0]["quoted"], 0)

	def test_a_repeated_row_keeps_the_first_rate(self):
		result = self.build(
			[_rfq_item("R1", "PEN")],
			[_quotation("SQ-1")],
			[_row("SQ-1", "R1", "PEN", 4, idx=2), _row("SQ-1", "R1", "PEN", 3, idx=1)],
		)
		self.assertEqual(result[0]["rates"]["R1"]["rate"], 3)

	def test_unit_rate_is_in_company_currency_per_stock_unit(self):
		# 12 EUR a dozen at 1.1 USD/EUR is 13.2 USD a dozen, 1.1 USD a piece
		result = self.build(
			[_rfq_item("R1", "PEN")],
			[_quotation("SQ-1", currency="EUR")],
			[_row("SQ-1", "R1", "PEN", 12, base_rate=13.2, conversion_factor=12, uom="Dozen")],
		)
		rate = result[0]["rates"]["R1"]
		self.assertEqual((rate["rate"], rate["base_rate"], rate["uom"]), (12, 13.2, "Dozen"))
		self.assertEqual(rate["unit_base_rate"], 1.1)

	def test_a_missing_conversion_factor_does_not_divide_by_zero(self):
		result = self.build(
			[_rfq_item("R1", "PEN")],
			[_quotation("SQ-1")],
			[_row("SQ-1", "R1", "PEN", 5, conversion_factor=0)],
		)
		self.assertEqual(result[0]["rates"]["R1"]["unit_base_rate"], 5)

	def test_expiry_follows_the_status_or_the_valid_till_date(self):
		items = [_rfq_item("R1", "PEN")]
		result = {
			q["name"]: q["expired"]
			for q in self.build(
				items,
				[
					_quotation("LAPSED", valid_till="2026-09-20"),
					_quotation("TODAY", valid_till="2026-09-21"),
					_quotation("FLAGGED", status="Expired", valid_till=None),
					_quotation("OPEN", valid_till="2026-12-31"),
					_quotation("UNDATED", valid_till=None),
				],
				[],
			)
		}
		self.assertEqual(
			result, {"LAPSED": True, "TODAY": False, "FLAGGED": True, "OPEN": False, "UNDATED": False}
		)

	def test_complete_quotes_come_first_and_cheapest_first(self):
		items = [_rfq_item("R1", "PEN"), _rfq_item("R2", "INK")]
		result = self.build(
			items,
			[
				_quotation("PARTIAL-CHEAP", base_grand_total=10),
				_quotation("FULL-DEAR", base_grand_total=90),
				_quotation("FULL-CHEAP", base_grand_total=50),
				_quotation("UNPRICED", base_grand_total=0),
			],
			[
				_row("PARTIAL-CHEAP", "R1", "PEN", 1),
				_row("FULL-DEAR", "R1", "PEN", 9, idx=1),
				_row("FULL-DEAR", "R2", "INK", 9, idx=2),
				_row("FULL-CHEAP", "R1", "PEN", 5, idx=1),
				_row("FULL-CHEAP", "R2", "INK", 5, idx=2),
				_row("UNPRICED", "R1", "PEN", 0, idx=1),
				_row("UNPRICED", "R2", "INK", 0, idx=2),
			],
		)
		self.assertEqual(
			[q["name"] for q in result], ["FULL-CHEAP", "FULL-DEAR", "UNPRICED", "PARTIAL-CHEAP"]
		)

	def test_payment_terms_come_from_the_supplier_and_are_none_when_unknown(self):
		result = self.build(
			[_rfq_item("R1", "PEN")],
			[_quotation("SQ-1", supplier="SUP-A"), _quotation("SQ-2", supplier="SUP-B")],
			[],
			{"SUP-A": "Net 30"},
		)
		self.assertEqual(
			{q["supplier"]: q["payment_terms"] for q in result}, {"SUP-A": "Net 30", "SUP-B": None}
		)

	def test_a_quotation_without_item_rows_is_still_listed(self):
		result = self.build([_rfq_item("R1", "PEN")], [_quotation("SQ-1")], [])
		self.assertEqual((result[0]["quoted"], result[0]["rates"]), (0, {}))

	def test_report_filters_span_the_rfq_date_today_and_every_quotation(self):
		rfq = _dict(name="RFQ-1", company="Acme", transaction_date=getdate("2026-09-10"))
		filters = compare._report_filters(
			rfq,
			[
				{"transaction_date": "2026-09-05"},
				{"transaction_date": "2026-10-02"},
				{"transaction_date": None},
			],
			getdate("2026-09-21"),
		)
		self.assertEqual(
			filters,
			{
				"company": "Acme",
				"request_for_quotation": "RFQ-1",
				"from_date": "2026-09-05",
				"to_date": "2026-10-02",
			},
		)


class TestEndpointContract(SourcingTestCase):
	def test_endpoint_is_whitelisted_and_type_hinted(self):
		func = compare.get_rfq_supplier_comparison
		self.assertIn(func, frappe.whitelisted)
		signature = inspect.signature(func)
		self.assertIs(signature.parameters["rfq_name"].annotation, str)
		self.assertIsNot(signature.return_annotation, inspect.Signature.empty)

	def test_a_missing_or_absurd_name_is_refused_before_any_query(self):
		for bad in ("", None, ["RFQ"], "X" * 141):
			with patch("frappe.has_permission") as permission, patch("frappe.get_all") as get_all:
				with self.assertRaises(frappe.ValidationError):
					compare.get_rfq_supplier_comparison(bad)
			permission.assert_not_called()
			get_all.assert_not_called()

	def test_read_permission_on_the_rfq_is_checked_and_nothing_is_read_without_it(self):
		with (
			patch("frappe.has_permission", side_effect=frappe.PermissionError) as permission,
			patch("frappe.get_all") as get_all,
			patch("frappe.get_list") as get_list,
		):
			with self.assertRaises(frappe.PermissionError):
				compare.get_rfq_supplier_comparison(RFQ)
		self.assertEqual(permission.call_args.args[:2], ("Request for Quotation", "read"))
		self.assertEqual(permission.call_args.kwargs["doc"], RFQ)
		self.assertIs(permission.call_args.kwargs["throw"], True)
		get_all.assert_not_called()
		get_list.assert_not_called()

	def test_a_user_without_access_is_turned_away(self):
		_insert(
			"Request for Quotation",
			name=RFQ,
			docstatus=1,
			company=self._company(),
			transaction_date=nowdate(),
		)
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			compare.get_rfq_supplier_comparison(RFQ)

	@staticmethod
	def _company():
		return frappe.db.get_value("Company", {}, "name") or "ADHD-TEST-CO"


class TestEndpointAgainstTheDatabase(SourcingTestCase):
	"""Runs the real queries (child-table reads, IN filters, DISTINCT, ordering) on rolled-back rows."""

	def setUp(self):
		super().setUp()
		company = frappe.db.get_value("Company", {}, "name")
		if not company:
			self.skipTest("no Company on this site")
		self.company = company
		self.today = getdate(nowdate())

		_insert(
			"Request for Quotation",
			name=RFQ,
			docstatus=1,
			company=company,
			transaction_date=self.today,
			status="Submitted",
		)
		for idx, (row, code) in enumerate((("R1", "PEN"), ("R2", "INK")), start=1):
			_insert(
				"Request for Quotation Item",
				name=f"{PREFIX}-{row}",
				parent=RFQ,
				parenttype="Request for Quotation",
				parentfield="items",
				idx=idx,
				item_code=code,
				item_name=code,
				qty=10,
				uom="Nos",
			)
		for idx, supplier in enumerate(("A", "B", "C"), start=1):
			_insert(
				"Request for Quotation Supplier",
				name=f"{PREFIX}-RS-{supplier}",
				parent=RFQ,
				parenttype="Request for Quotation",
				parentfield="suppliers",
				idx=idx,
				supplier=f"{PREFIX}-SUP-{supplier}",
				supplier_name=f"Supplier {supplier}",
			)
		_insert("Supplier", name=f"{PREFIX}-SUP-A", supplier_name="Supplier A", payment_terms="Net 30")

		# A: complete, in the company currency. B: partial, another currency, draft, expired.
		# C never answered. The last quotation belongs to another RFQ and must not appear.
		self._quotation(
			"SQ-A", "A", docstatus=1, status="Submitted", valid_till=add_days(self.today, 30), total=50
		)
		self._sq_row("SQ-A", "R1", "PEN", 3)
		self._sq_row("SQ-A", "R2", "INK", 2, idx=2)
		self._quotation(
			"SQ-B",
			"B",
			docstatus=0,
			status="Draft",
			valid_till=add_days(self.today, -1),
			total=8,
			currency="EUR",
		)
		self._sq_row("SQ-B", "R2", "INK", 1.5, idx=1, base_rate=1.65)
		self._quotation("SQ-CANCELLED", "C", docstatus=2, status="Cancelled", total=1)
		self._sq_row("SQ-CANCELLED", "R1", "PEN", 1)
		self._quotation("SQ-ELSEWHERE", "C", docstatus=1, status="Submitted", total=1)
		self._sq_row("SQ-ELSEWHERE", "R1", "PEN", 1, rfq=f"{PREFIX}-OTHER-RFQ")

	def _quotation(self, name, supplier, docstatus, status, valid_till=None, total=0, currency="USD"):
		_insert(
			"Supplier Quotation",
			name=f"{PREFIX}-{name}",
			docstatus=docstatus,
			status=status,
			supplier=f"{PREFIX}-SUP-{supplier}",
			supplier_name=f"Supplier {supplier}",
			company=self.company,
			transaction_date=self.today,
			valid_till=valid_till,
			currency=currency,
			grand_total=total,
			base_grand_total=total,
		)

	def _sq_row(self, quotation, rfq_item, code, rate, idx=1, base_rate=None, rfq=RFQ):
		_insert(
			"Supplier Quotation Item",
			name=f"{PREFIX}-{quotation}-{rfq_item}",
			parent=f"{PREFIX}-{quotation}",
			parenttype="Supplier Quotation",
			parentfield="items",
			idx=idx,
			item_code=code,
			request_for_quotation=rfq,
			request_for_quotation_item=f"{PREFIX}-{rfq_item}",
			qty=10,
			uom="Nos",
			conversion_factor=1,
			rate=rate,
			base_rate=rate if base_rate is None else base_rate,
		)

	def test_the_quotations_are_found_through_their_item_rows(self):
		result = compare.get_rfq_supplier_comparison(RFQ)

		# cancelled and other-RFQ quotations are out; the draft stays; the complete quote is first
		self.assertEqual([q["name"] for q in result["quotations"]], [f"{PREFIX}-SQ-A", f"{PREFIX}-SQ-B"])
		self.assertEqual([item["name"] for item in result["items"]], [f"{PREFIX}-R1", f"{PREFIX}-R2"])
		self.assertEqual(result["rfq"], RFQ)
		self.assertEqual(
			result["company_currency"], frappe.get_cached_value("Company", self.company, "default_currency")
		)
		self.assertEqual(result["truncated"], {"quotations": False, "items": False})
		# what the browser receives must survive JSON, dates and all
		self.assertEqual(
			frappe.parse_json(frappe.as_json(result))["quotations"][0]["valid_till"],
			str(add_days(self.today, 30)),
		)

	def test_rates_currency_expiry_and_terms_are_reported_per_quotation(self):
		by_name = {q["name"]: q for q in compare.get_rfq_supplier_comparison(RFQ)["quotations"]}
		full, partial = by_name[f"{PREFIX}-SQ-A"], by_name[f"{PREFIX}-SQ-B"]

		self.assertEqual(
			{key: value["rate"] for key, value in full["rates"].items()},
			{f"{PREFIX}-R1": 3, f"{PREFIX}-R2": 2},
		)
		self.assertEqual((full["quoted"], full["expired"], full["payment_terms"]), (2, False, "Net 30"))
		self.assertEqual((full["currency"], full["grand_total"]), ("USD", 50))

		self.assertEqual(list(partial["rates"]), [f"{PREFIX}-R2"])
		self.assertEqual(partial["rates"][f"{PREFIX}-R2"]["rate"], 1.5)
		self.assertEqual(partial["rates"][f"{PREFIX}-R2"]["unit_base_rate"], 1.65)
		self.assertEqual((partial["currency"], partial["expired"], partial["docstatus"]), ("EUR", True, 0))
		self.assertIsNone(partial["payment_terms"])

	def test_suppliers_who_have_not_answered_are_listed(self):
		awaiting = compare.get_rfq_supplier_comparison(RFQ)["awaiting_suppliers"]
		# C only has a cancelled quotation and one for another RFQ: it has not answered this one
		self.assertEqual([row["supplier"] for row in awaiting], [f"{PREFIX}-SUP-C"])

	def test_the_report_link_filters_cover_this_rfq(self):
		filters = compare.get_rfq_supplier_comparison(RFQ)["report_filters"]
		self.assertEqual(filters["request_for_quotation"], RFQ)
		self.assertEqual(filters["company"], self.company)
		self.assertEqual(filters["from_date"], str(self.today))
		self.assertEqual(filters["to_date"], str(self.today))

	def test_quotations_come_from_get_list_so_permissions_decide_what_is_shown(self):
		real_get_list = frappe.get_list
		seen = []

		def only_supplier_a(doctype, *args, **kwargs):
			rows = real_get_list(doctype, *args, **kwargs)
			# frappe.get_all is get_list with permissions switched off, so this tells the two apart
			seen.append((doctype, bool(kwargs.get("ignore_permissions"))))
			if doctype == "Supplier Quotation":
				return [row for row in rows if row.name == f"{PREFIX}-SQ-A"]
			return rows

		with patch("frappe.get_list", side_effect=only_supplier_a):
			result = compare.get_rfq_supplier_comparison(RFQ)

		self.assertIn(("Supplier Quotation", False), seen)
		self.assertNotIn(("Supplier Quotation", True), seen)
		self.assertEqual([q["name"] for q in result["quotations"]], [f"{PREFIX}-SQ-A"])
		# with quotations hidden the endpoint cannot say who has not answered from what it can see, but here
		# nothing was truncated, so B and C are both reported as not answered
		self.assertEqual(
			{row["supplier"] for row in result["awaiting_suppliers"]},
			{f"{PREFIX}-SUP-B", f"{PREFIX}-SUP-C"},
		)

	def test_the_number_of_quotations_and_items_is_capped(self):
		with patch.object(compare, "MAX_QUOTATIONS", 1), patch.object(compare, "MAX_RFQ_ITEMS", 1):
			result = compare.get_rfq_supplier_comparison(RFQ)
		self.assertEqual(len(result["quotations"]), 1)
		self.assertEqual(len(result["items"]), 1)
		self.assertEqual(result["truncated"], {"quotations": True, "items": True})
		# who has not answered is not guessed at when some quotations were left out
		self.assertEqual(result["awaiting_suppliers"], [])

	def test_an_rfq_with_no_quotations_returns_empty_lists(self):
		frappe.db.sql("delete from `tabSupplier Quotation Item` where request_for_quotation = %s", RFQ)
		result = compare.get_rfq_supplier_comparison(RFQ)
		self.assertEqual(result["quotations"], [])
		self.assertEqual(len(result["awaiting_suppliers"]), 3)

	def test_an_rfq_that_does_not_exist_raises_instead_of_returning_nothing(self):
		with self.assertRaises(frappe.DoesNotExistError):
			compare.get_rfq_supplier_comparison(f"{PREFIX}-NO-SUCH-RFQ")


if __name__ == "__main__":
	unittest.main()
