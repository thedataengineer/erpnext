# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# ADHD-028, the Purchase Invoice three-way match. The status rules are a pure function, tested at their
# boundaries and, because the point is to say what ERPNext itself would say, against ERPNext's own checks
# (BillingValidationService and StatusUpdater.check_overflow_with_allowance) over a sweep of amounts. The
# endpoint is run for real against rows written inside the test and rolled back.
#
# Plain unittest, and deliberately without erpnext.tests.utils (importing it bootstraps and commits test data
# into whatever site it runs on).

import inspect
import json
import re
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import frappe
from frappe import _dict

from erpnext.accounts.services import adhd_three_way_match as match
from erpnext.accounts.services.adhd_three_way_match import (
	MatchSettings,
	evaluate_match,
	po_rule_over_by,
	pr_rule_over_by,
)

# tables the endpoint tests write to; they must be back to what they were when the module is done
TOUCHED = (
	"Purchase Order",
	"Purchase Order Item",
	"Purchase Receipt",
	"Purchase Receipt Item",
	"Purchase Invoice Item",
)
_counts = {}


def setUpModule():
	frappe.set_user("Administrator")
	for doctype in TOUCHED:
		_counts[doctype] = frappe.db.count(doctype)


def tearDownModule():
	frappe.db.rollback()
	for doctype in TOUCHED:
		assert frappe.db.count(doctype) == _counts[doctype], f"{doctype} was left changed"


# ---- builders for the pure function ----------------------------------------------------------------------------


def invoice_row(idx=1, amount=700, rate=100, po_detail="po-row", pr_detail="", **extra):
	return {
		"idx": idx,
		"item_code": "WIDGET",
		"purchase_order": "PO-1" if po_detail else "",
		"po_detail": po_detail,
		"purchase_receipt": "PR-1" if pr_detail else "",
		"pr_detail": pr_detail,
		"rate": rate,
		"amount": amount,
		**extra,
	}


def ref_row(parent, amount=1000, rate=100, billed_by_others=0, closed=0, item_code="WIDGET"):
	return _dict(
		parent=parent,
		item_code=item_code,
		amount=amount,
		rate=rate,
		billed_by_others=billed_by_others,
		closed=closed,
	)


def doc_row(docstatus=1, status="To Bill", currency="USD"):
	return _dict(docstatus=docstatus, status=status, currency=currency)


def references(po=None, pr=None, po_docs=None, pr_docs=None):
	"""po / pr: {row name: ref_row}; the documents default to a submitted one in USD per parent."""
	po, pr = po or {}, pr or {}
	return {
		"Purchase Order": {
			"rows": po,
			"docs": po_docs if po_docs is not None else {row.parent: doc_row() for row in po.values()},
		},
		"Purchase Receipt": {
			"rows": pr,
			"docs": pr_docs if pr_docs is not None else {row.parent: doc_row() for row in pr.values()},
		},
	}


def settings(**overrides):
	return MatchSettings(currency="USD", **overrides)


def only_po(this, amount=1000, others=0, allowance=0.0, **more):
	"""One invoice row against one Purchase Order row."""
	return evaluate_match(
		[invoice_row(amount=this)],
		references(po={"po-row": ref_row("PO-1", amount=amount, billed_by_others=others)}),
		settings(allowance_for=lambda _item: allowance, **more),
	)


def only_pr(this, amount=1000, others=0, allowance=0.0, **more):
	"""One invoice row against one Purchase Receipt row (no Purchase Order link on the row)."""
	return evaluate_match(
		[invoice_row(amount=this, po_detail="", pr_detail="pr-row")],
		references(pr={"pr-row": ref_row("PR-1", amount=amount, billed_by_others=others)}),
		settings(allowance_for=lambda _item: allowance, **more),
	)


def reasons(result):
	return [issue["reason"] for reference in result["references"] for issue in reference["issues"]]


class TestBillingRulesAtTheirBoundaries(unittest.TestCase):
	"""What is billed against what the reference still had open."""

	def test_billing_exactly_what_is_open_matches(self):
		result = only_po(this=700, amount=1000, others=300)
		self.assertEqual(result["status"], "match")
		reference = result["references"][0]
		self.assertEqual(
			(reference["reference_amount"], reference["already_billed"], reference["this_invoice"]),
			(1000, 300, 700),
		)
		self.assertEqual((reference["open_amount"], reference["remaining_after"]), (700, 0))
		self.assertEqual(result["totals"]["remaining_after"], 0)
		self.assertEqual(result["checked_rows"], 1)

	def test_billing_less_than_is_open_is_a_match_that_says_how_much_is_left(self):
		# partial billing is normal and ERPNext accepts it, so it is never a mismatch
		result = only_po(this=500, amount=1000, others=300)
		self.assertEqual(result["status"], "match")
		self.assertEqual(result["references"][0]["remaining_after"], 200)
		self.assertEqual(result["totals"]["remaining_after"], 200)
		self.assertEqual(reasons(result), [])

	def test_a_full_document_total_is_not_what_it_is_compared_with(self):
		# 1000 ordered, 900 already billed elsewhere: billing 200 is over what is open although 200 < 1000
		result = only_po(this=200, amount=1000, others=900)
		self.assertEqual(result["status"], "over")
		self.assertEqual(reasons(result), ["over_billed"])
		self.assertAlmostEqual(result["references"][0]["over_by"], 100)

	def test_exactly_at_the_allowance_is_accepted_but_not_a_plain_match(self):
		result = only_po(this=1050, allowance=5)
		self.assertEqual(result["status"], "within_tolerance")
		self.assertEqual(reasons(result), ["within_allowance"])
		self.assertEqual(result["references"][0]["over_by"], 0)

		result = only_pr(this=1050, allowance=5)
		self.assertEqual(result["status"], "within_tolerance")

	def test_past_the_allowance_is_over(self):
		self.assertEqual(only_po(this=1051, allowance=5)["status"], "over")
		self.assertEqual(only_pr(this=1050.02, allowance=5)["status"], "over")

	def test_a_cent_over_is_judged_as_erpnext_judges_it(self):
		# The receipt rule refuses only more than one unit of the last decimal place, so a cent over is
		# accepted; the order rule compares a percentage with 0.01 points of slack (10 cents on 1000).
		# Which side a cent falls on can depend on float noise (100.01 - 100 > 0.01, 1000.01 - 1000 < 0.01):
		# TestParityWithERPNext runs both against ERPNext's own code, this pins the outcome.
		self.assertEqual(only_pr(this=1000.01)["status"], "within_tolerance")
		self.assertEqual(only_pr(this=1000.02)["status"], "over")
		self.assertEqual(only_po(this=1000.05)["status"], "within_tolerance")
		self.assertEqual(only_po(this=1001)["status"], "over")

	def test_the_rules_as_plain_functions(self):
		self.assertEqual(po_rule_over_by(1000, 1000, 0), 0)
		self.assertEqual(po_rule_over_by(1000, 900, 0), 0)
		self.assertEqual(po_rule_over_by(0, 50, 0), 0, "nothing to compare with")
		self.assertAlmostEqual(po_rule_over_by(1000, 1100, 5), 50)
		self.assertEqual(pr_rule_over_by(1000, 1050, 5, 2), 0)
		self.assertAlmostEqual(pr_rule_over_by(1000, 1100, 5, 2), 50)
		self.assertEqual(pr_rule_over_by(0, 50, 0, 2), 0, "a zero reference amount is not checked")
		# whole numbers: the slack is exactly 1, so billing exactly 1 over is accepted and more is not
		self.assertEqual(pr_rule_over_by(10, 11, 0, 0), 0)
		self.assertGreater(pr_rule_over_by(10, 11.5, 0, 0), 0)
		# three decimals: the slack is a thousandth
		self.assertEqual(pr_rule_over_by(1000, 1000.0005, 0, 3), 0)
		self.assertGreater(pr_rule_over_by(1000, 1000.002, 0, 3), 0)

	def test_an_item_allowance_is_looked_up_by_the_reference_row_item(self):
		seen = []

		def allowance(item_code):
			seen.append(item_code)
			return 10.0

		result = evaluate_match(
			[invoice_row(amount=1100)],
			references(po={"po-row": ref_row("PO-1", amount=1000, item_code="GADGET")}),
			settings(allowance_for=allowance),
		)
		self.assertEqual(seen, ["GADGET"])
		self.assertEqual(result["status"], "within_tolerance")

	def test_two_rows_on_the_same_reference_row_are_added_together(self):
		result = evaluate_match(
			[invoice_row(idx=1, amount=400), invoice_row(idx=2, amount=400)],
			references(po={"po-row": ref_row("PO-1", amount=1000, billed_by_others=300)}),
			settings(),
		)
		# 300 + 400 + 400 against 1000
		self.assertEqual(result["status"], "over")
		self.assertEqual(result["references"][0]["rows"], 2)
		self.assertEqual(result["references"][0]["this_invoice"], 800)
		self.assertEqual(result["checked_rows"], 1)


class TestSeveralReferencesAndNone(unittest.TestCase):
	def test_every_referenced_document_is_judged_and_the_worst_wins(self):
		rows = [
			invoice_row(idx=1, amount=500, po_detail="po-a"),
			invoice_row(idx=2, amount=900, po_detail="po-b", pr_detail="pr-b"),
		]
		refs = references(
			po={
				"po-a": ref_row("PO-A", amount=500),
				"po-b": ref_row("PO-B", amount=1000),
			},
			pr={"pr-b": ref_row("PR-B", amount=800)},
		)
		result = evaluate_match(rows, refs, settings())
		by_name = {reference["name"]: reference for reference in result["references"]}

		self.assertEqual(set(by_name), {"PO-A", "PO-B", "PR-B"})
		self.assertEqual(by_name["PO-A"]["status"], "match")
		self.assertEqual(by_name["PO-B"]["status"], "match")
		# 900 billed against a receipt row of 800 (bill_for_rejected_quantity is off here)
		self.assertEqual(by_name["PR-B"]["status"], "over")
		self.assertEqual(result["status"], "over")
		# the worst come first, and each carries its own figures
		self.assertEqual(result["references"][0]["name"], "PR-B")
		self.assertEqual(by_name["PR-B"]["reference_amount"], 800)
		self.assertEqual(by_name["PO-A"]["this_invoice"], 500)
		# the totals add the references up
		self.assertEqual(result["totals"]["reference_amount"], 500 + 1000 + 800)
		self.assertEqual(result["totals"]["this_invoice"], 500 + 900 + 900)
		self.assertEqual(result["checked_rows"], 3)

	def test_one_reference_can_be_within_tolerance_while_another_matches(self):
		rows = [
			invoice_row(idx=1, amount=1030, po_detail="po-a"),
			invoice_row(idx=2, amount=10, po_detail="po-b"),
		]
		refs = references(po={"po-a": ref_row("PO-A", amount=1000), "po-b": ref_row("PO-B", amount=10)})
		result = evaluate_match(rows, refs, settings(allowance_for=lambda _item: 5.0))
		self.assertEqual(result["status"], "within_tolerance")
		self.assertEqual(
			{reference["name"]: reference["status"] for reference in result["references"]},
			{"PO-A": "within_tolerance", "PO-B": "match"},
		)

	def test_no_rows_or_no_references_is_no_reference(self):
		for rows in ([], [invoice_row(po_detail="", pr_detail="")]):
			result = evaluate_match(rows, references(), settings())
			self.assertEqual(result["status"], "no_reference")
			self.assertEqual(result["references"], [])
			self.assertEqual(result["checked_rows"], 0)

	def test_a_row_it_cannot_read_is_counted_not_guessed(self):
		result = evaluate_match([invoice_row()], references(), settings())
		self.assertEqual(result["status"], "no_reference")
		self.assertEqual(result["unreadable_rows"], 1)

		# a row whose parent document did not come back as readable is dropped the same way
		refs = references(po={"po-row": ref_row("PO-1")}, po_docs={})
		result = evaluate_match([invoice_row()], refs, settings())
		self.assertEqual(result["unreadable_rows"], 1)

	def test_an_unreadable_row_does_not_hide_the_ones_that_could_be_checked(self):
		rows = [invoice_row(idx=1, amount=1000), invoice_row(idx=2, po_detail="gone", amount=50)]
		result = evaluate_match(rows, references(po={"po-row": ref_row("PO-1")}), settings())
		self.assertEqual(result["status"], "match")
		self.assertEqual(result["unreadable_rows"], 1)


class TestOtherReasonsErpnextRefuses(unittest.TestCase):
	def test_a_reference_in_another_currency_is_a_mismatch_and_is_not_added_into_the_totals(self):
		refs = references(po={"po-row": ref_row("PO-1")}, po_docs={"PO-1": doc_row(currency="EUR")})
		result = evaluate_match([invoice_row(amount=1000)], refs, settings())
		self.assertEqual(result["status"], "over")
		self.assertEqual(reasons(result), ["currency"])
		self.assertEqual(result["totals"]["reference_amount"], 0)
		self.assertEqual(result["currency"], "USD")

	def test_a_reference_that_is_not_submitted_is_a_mismatch(self):
		for docstatus in (0, 2):
			refs = references(po={"po-row": ref_row("PO-1")}, po_docs={"PO-1": doc_row(docstatus=docstatus)})
			result = evaluate_match([invoice_row(amount=1000)], refs, settings())
			self.assertEqual(reasons(result), ["not_submitted"], docstatus)
			self.assertEqual(result["status"], "over")

	def test_a_closed_or_on_hold_order_is_a_mismatch_unless_the_row_also_names_a_receipt(self):
		for status in ("Closed", "On Hold"):
			refs = references(po={"po-row": ref_row("PO-1")}, po_docs={"PO-1": doc_row(status=status)})
			result = evaluate_match([invoice_row(amount=1000)], refs, settings())
			self.assertEqual(reasons(result), ["status"], status)

			# check_for_on_hold_or_closed_status leaves out rows with a purchase_receipt
			row = invoice_row(amount=1000, purchase_receipt="PR-1")
			result = evaluate_match([row], refs, settings())
			self.assertEqual(result["status"], "match", status)

	def test_a_closed_reference_row_is_a_mismatch(self):
		refs = references(po={"po-row": ref_row("PO-1", closed=1)})
		result = evaluate_match([invoice_row(amount=1000)], refs, settings())
		self.assertEqual(reasons(result), ["closed_row"])
		self.assertEqual(result["status"], "over")

	def test_the_receipt_rule_is_off_with_bill_for_rejected_quantity_but_the_order_rule_is_not(self):
		# Buying Settings "Bill for Rejected Quantity in Purchase Invoice" (on by default) skips the receipt check
		self.assertEqual(only_pr(this=1200, bill_for_rejected_quantity=False)["status"], "over")
		relaxed = only_pr(this=1200, bill_for_rejected_quantity=True)
		self.assertEqual(relaxed["status"], "within_tolerance")
		self.assertEqual(reasons(relaxed), ["over_allowed"])
		self.assertEqual(only_po(this=1200, bill_for_rejected_quantity=True)["status"], "over")

	def test_the_over_billing_role_turns_a_refusal_into_a_warning(self):
		for build in (only_po, only_pr):
			result = build(this=1200, can_overbill=True)
			self.assertEqual(result["status"], "within_tolerance", build.__name__)
			self.assertEqual(reasons(result), ["over_allowed"])

	def test_an_internal_supplier_is_not_stopped_on_amount(self):
		self.assertEqual(only_po(this=1200, is_internal_supplier=True)["status"], "within_tolerance")

	def test_a_zero_reference_amount_is_not_checked(self):
		self.assertEqual(only_pr(this=50, amount=0)["status"], "match")
		self.assertEqual(only_po(this=50, amount=0)["status"], "match")


class TestMaintainSameRate(unittest.TestCase):
	def rate_result(self, invoice_rate, ref_rate=100, **overrides):
		return evaluate_match(
			[invoice_row(amount=1000, rate=invoice_rate)],
			references(po={"po-row": ref_row("PO-1", amount=1000, rate=ref_rate)}),
			settings(**overrides),
		)

	def test_off_by_default_so_a_different_rate_alone_is_fine(self):
		self.assertEqual(self.rate_result(90)["status"], "match")

	def test_stop_makes_a_different_rate_a_mismatch(self):
		result = self.rate_result(90, maintain_same_rate=True, rate_action="Stop")
		self.assertEqual(result["status"], "over")
		self.assertEqual(reasons(result), ["rate"])

	def test_warn_and_the_override_role_only_warn(self):
		warn = self.rate_result(90, maintain_same_rate=True, rate_action="Warn")
		self.assertEqual((warn["status"], reasons(warn)), ("within_tolerance", ["rate_warned"]))
		role = self.rate_result(90, maintain_same_rate=True, rate_action="Stop", can_override_rate=True)
		self.assertEqual(role["status"], "within_tolerance")

	def test_the_difference_threshold_is_a_cent_of_the_rate_precision(self):
		on = {"maintain_same_rate": True}
		self.assertEqual(self.rate_result(100.005, **on)["status"], "match", "under 0.01 rounds away")
		self.assertEqual(self.rate_result(100.01, **on)["status"], "over", "0.01 is refused")
		self.assertEqual(self.rate_result(99.99, **on)["status"], "over")
		# three decimals: 0.005 is real
		self.assertEqual(self.rate_result(100.005, rate_precision=3, **on)["status"], "match")
		self.assertEqual(self.rate_result(100.011, rate_precision=3, **on)["status"], "over")

	def test_an_internal_supplier_keeps_any_rate(self):
		result = self.rate_result(90, maintain_same_rate=True, is_internal_supplier=True)
		self.assertEqual(result["status"], "match")

	def test_the_rate_is_compared_with_the_receipt_row_too(self):
		result = evaluate_match(
			[invoice_row(amount=1000, rate=90, po_detail="po-row", pr_detail="pr-row")],
			references(
				po={"po-row": ref_row("PO-1", amount=1000, rate=90)},
				pr={"pr-row": ref_row("PR-1", amount=1000, rate=100)},
			),
			settings(maintain_same_rate=True),
		)
		by_name = {reference["name"]: reference["status"] for reference in result["references"]}
		self.assertEqual(by_name, {"PO-1": "match", "PR-1": "over"})


# ---- the endpoint, for real -------------------------------------------------------------------------------------


def _insert(table, **values):
	now = frappe.utils.now()
	values.update(creation=now, modified=now, owner="Administrator", modified_by="Administrator")
	columns = ", ".join(f"`{column}`" for column in values)
	frappe.db.sql(
		f"insert into `tab{table}` ({columns}) values ({', '.join(['%s'] * len(values))})",
		tuple(values.values()),
	)


def make_order(name="ADHD-T-PO", row="adhd-t-po-row", amount=1000, rate=100, **doc):
	_insert(
		"Purchase Order",
		name=name,
		**{"docstatus": 1, "status": "To Receive and Bill", "currency": "USD", **doc},
	)
	_insert(
		"Purchase Order Item",
		name=row,
		parent=name,
		parenttype="Purchase Order",
		parentfield="items",
		idx=1,
		item_code="ADHD-T-ITEM",
		qty=amount / rate,
		rate=rate,
		amount=amount,
	)


def make_receipt(name="ADHD-T-PR", row="adhd-t-pr-row", amount=800, rate=100, **doc):
	_insert("Purchase Receipt", name=name, **{"docstatus": 1, "status": "To Bill", "currency": "USD", **doc})
	_insert(
		"Purchase Receipt Item",
		name=row,
		parent=name,
		parenttype="Purchase Receipt",
		parentfield="items",
		idx=1,
		item_code="ADHD-T-ITEM",
		qty=amount / rate,
		rate=rate,
		amount=amount,
	)


def bill(amount, po_detail=None, pr_detail=None, docstatus=1, parent="ADHD-T-PI-OLD", name=None):
	"""An invoice row that already bills against a reference row."""
	_insert(
		"Purchase Invoice Item",
		name=name or frappe.generate_hash(length=10),
		parent=parent,
		parenttype="Purchase Invoice",
		parentfield="items",
		idx=1,
		docstatus=docstatus,
		po_detail=po_detail,
		pr_detail=pr_detail,
		amount=amount,
	)


def draft_row(**overrides):
	return {
		"idx": 1,
		"item_code": "ADHD-T-ITEM",
		"purchase_order": "ADHD-T-PO",
		"po_detail": "adhd-t-po-row",
		"purchase_receipt": "",
		"pr_detail": "",
		"rate": 100,
		"amount": 700,
		**overrides,
	}


def check(*rows, currency="USD", **kwargs):
	return match.get_three_way_match(json.dumps(list(rows)), currency, **kwargs)


class TestEndpoint(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	def test_it_reads_what_the_order_still_has_open_from_submitted_invoices_only(self):
		make_order()
		bill(300, po_detail="adhd-t-po-row")
		# a draft invoice, a cancelled one and another row's billing are not "already billed"
		bill(999, po_detail="adhd-t-po-row", docstatus=0)
		bill(999, po_detail="adhd-t-po-row", docstatus=2)
		bill(999, po_detail="some-other-row")

		result = check(draft_row(amount=700))
		self.assertEqual(result["status"], "match")
		reference = result["references"][0]
		self.assertEqual((reference["doctype"], reference["name"]), ("Purchase Order", "ADHD-T-PO"))
		self.assertEqual(reference["already_billed"], 300)
		self.assertEqual(reference["open_amount"], 700)
		self.assertEqual(reference["remaining_after"], 0)
		self.assertEqual(result["currency"], "USD")

		self.assertEqual(check(draft_row(amount=500))["totals"]["remaining_after"], 200)
		self.assertEqual(check(draft_row(amount=710))["status"], "over")

	def test_a_receipt_row_is_checked_on_its_own_and_together_with_the_order(self):
		make_order()
		make_receipt(amount=800)
		bill(300, pr_detail="adhd-t-pr-row")

		# the receipt has 500 open, the order 1000
		row = draft_row(amount=500, pr_detail="adhd-t-pr-row", purchase_receipt="ADHD-T-PR")
		result = check(row)
		self.assertEqual(
			{(r["doctype"], r["name"]): r["status"] for r in result["references"]},
			{("Purchase Order", "ADHD-T-PO"): "match", ("Purchase Receipt", "ADHD-T-PR"): "match"},
		)

		row["amount"] = 600
		result = check(row)
		by_kind = {r["doctype"]: r for r in result["references"]}
		self.assertEqual(by_kind["Purchase Order"]["status"], "match")
		self.assertEqual(by_kind["Purchase Receipt"]["open_amount"], 500)
		# Buying Settings' "bill for rejected quantity" is on by default: the receipt overshoot is accepted
		expected = (
			"within_tolerance" if match._load_settings("USD", False).bill_for_rejected_quantity else "over"
		)
		self.assertEqual(by_kind["Purchase Receipt"]["status"], expected)

	def test_several_orders_on_one_invoice_are_each_judged(self):
		make_order("ADHD-T-PO-A", "adhd-t-po-row-a", amount=500)
		make_order("ADHD-T-PO-B", "adhd-t-po-row-b", amount=200)
		result = check(
			draft_row(idx=1, purchase_order="ADHD-T-PO-A", po_detail="adhd-t-po-row-a", amount=500),
			draft_row(idx=2, purchase_order="ADHD-T-PO-B", po_detail="adhd-t-po-row-b", amount=250),
		)
		self.assertEqual(result["status"], "over")
		self.assertEqual(
			{r["name"]: r["status"] for r in result["references"]},
			{"ADHD-T-PO-A": "match", "ADHD-T-PO-B": "over"},
		)
		self.assertEqual(result["totals"]["this_invoice"], 750)
		self.assertEqual(result["totals"]["reference_amount"], 700)

	def test_problems_with_the_reference_document_itself(self):
		make_order("ADHD-T-PO-EUR", "adhd-t-po-eur", currency="EUR")
		make_order("ADHD-T-PO-DRAFT", "adhd-t-po-draft", docstatus=0)
		make_order("ADHD-T-PO-HOLD", "adhd-t-po-hold", status="On Hold")
		for name, row, reason in (
			("ADHD-T-PO-EUR", "adhd-t-po-eur", "currency"),
			("ADHD-T-PO-DRAFT", "adhd-t-po-draft", "not_submitted"),
			("ADHD-T-PO-HOLD", "adhd-t-po-hold", "status"),
		):
			result = check(draft_row(purchase_order=name, po_detail=row, amount=1000))
			self.assertEqual(result["status"], "over", name)
			self.assertEqual(reasons(result), [reason], name)

	def test_nothing_to_compare_is_no_reference_and_reads_nothing(self):
		with patch("frappe.get_list") as get_list:
			self.assertEqual(check()["status"], "no_reference")
			self.assertEqual(check(draft_row(po_detail="", purchase_order=""))["status"], "no_reference")
		get_list.assert_not_called()

	def test_a_reference_that_does_not_exist_is_counted_as_unchecked(self):
		result = check(draft_row(po_detail="no-such-row"))
		self.assertEqual(result["status"], "no_reference")
		self.assertEqual(result["unreadable_rows"], 1)

	def test_documents_are_read_with_permission_checks_not_around_them(self):
		source = inspect.getsource(match)
		self.assertIsNone(re.search(r"\bget_all\b", source), "get_all would bypass permissions")
		self.assertNotIn("ignore_permissions", source)

		make_order()
		real_get_list = frappe.get_list
		seen = []

		def spy(doctype, *args, **kwargs):
			seen.append((doctype, kwargs.get("parent_doctype")))
			return real_get_list(doctype, *args, **kwargs)

		with patch("frappe.get_list", side_effect=spy):
			check(draft_row())
		self.assertEqual(seen, [("Purchase Order Item", "Purchase Order"), ("Purchase Order", None)])

	def test_a_row_whose_parent_the_user_may_not_read_is_dropped(self):
		make_order()
		real_get_list = frappe.get_list

		def parents_hidden(doctype, *args, **kwargs):
			return [] if doctype == "Purchase Order" else real_get_list(doctype, *args, **kwargs)

		with patch("frappe.get_list", side_effect=parents_hidden):
			result = check(draft_row())
		self.assertEqual(result["status"], "no_reference")
		self.assertEqual(result["unreadable_rows"], 1)

	def test_a_user_who_cannot_read_invoices_is_refused(self):
		frappe.set_user("Guest")
		# the permission check comes first, so even a request with nothing to compare is refused
		for rows in ([draft_row()], []):
			with self.assertRaises(frappe.PermissionError):
				check(*rows)

	def test_it_is_whitelisted_and_typed(self):
		# raises PermissionError when the method is not whitelisted
		frappe.is_whitelisted(match.get_three_way_match)
		self.assertIn(match.get_three_way_match, frappe.whitelisted)
		annotations = inspect.get_annotations(match.get_three_way_match)
		self.assertEqual(set(annotations) - {"return"}, {"items", "currency", "is_internal_supplier"})

	def test_inputs_are_bounded_and_cleaned(self):
		self.assertEqual(match.MAX_ROWS, 300, "the client stops at 300 rows too")
		too_many = json.dumps([draft_row(idx=i) for i in range(301)])
		with self.assertRaises(frappe.ValidationError):
			match.get_three_way_match(too_many, "USD")
		for bad in ("not json", json.dumps({"a": 1}), json.dumps("text")):
			with self.assertRaises(frappe.ValidationError, msg=bad):
				match.get_three_way_match(bad, "USD")

		rows = match.clean_rows(
			json.dumps(
				[
					"not a row",
					{"po_detail": "x" * 500, "amount": "NaN", "rate": "inf"},
					{"pr_detail": "pr", "amount": "12.5", "rate": "3", "idx": "4"},
				]
			)
		)
		self.assertEqual(len(rows), 2)
		self.assertEqual(len(rows[0]["po_detail"]), 140)
		self.assertEqual((rows[0]["amount"], rows[0]["rate"]), (0.0, 0.0))
		self.assertEqual((rows[1]["amount"], rows[1]["rate"], rows[1]["idx"]), (12.5, 3.0, 4))
		# exactly the limit is fine
		self.assertEqual(len(match.clean_rows(json.dumps([draft_row()] * match.MAX_ROWS))), match.MAX_ROWS)

	def test_the_settings_it_mirrors_are_read_from_the_site(self):
		loaded = match._load_settings("USD", True)
		self.assertEqual(loaded.currency, "USD")
		self.assertTrue(loaded.is_internal_supplier)
		self.assertIsInstance(loaded.amount_precision, int)
		self.assertIsInstance(loaded.rate_precision, int)
		self.assertIn(loaded.rate_action, ("Stop", "Warn"))
		self.assertGreaterEqual(loaded.allowance_for("an item that does not exist"), 0)


# ---- the same answer as ERPNext gives ---------------------------------------------------------------------------


class TestParityWithERPNext(unittest.TestCase):
	"""Sweep amounts around the limit and compare with what ERPNext's own code does with them."""

	def setUp(self):
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	def sweep(self, ref_amount, allowance):
		limit = ref_amount * (100 + allowance) / 100
		# from 4 cents under the limit to 5 cents over it, plus a few comfortable distances
		for cents in range(-4, 6):
			yield round(limit + cents / 100, 2)
		yield from (ref_amount / 2, ref_amount, limit * 2)

	def test_receipt_rule_agrees_with_validate_multiple_billing(self):
		from erpnext.accounts.services.billing_validation import BillingValidationService

		real_get_single_value = frappe.db.get_single_value

		def single_value(doctype, field, *args, **kwargs):
			if field == "bill_for_rejected_quantity_in_purchase_invoice":
				return 0
			return real_get_single_value(doctype, field, *args, **kwargs)

		outcomes = set()
		for ref_amount, allowance, others in (
			(100, 0, 0),
			(1000, 0, 0),
			(1000, 5, 0),
			(1234.56, 2.5, 0),
			(1000, 5, 400.5),
			(99.99, 10, 33.33),
		):
			make_receipt(name="ADHD-T-PR", row="adhd-t-pr-row", amount=ref_amount)
			if others:
				bill(others, pr_detail="adhd-t-pr-row")
			for this in self.sweep(ref_amount, allowance):
				this = round(this - others, 2)
				if this <= 0:
					continue
				row = _dict(
					doctype="Purchase Invoice Item",
					idx=1,
					item_code="ADHD-T-ITEM",
					pr_detail="adhd-t-pr-row",
					amount=this,
				)
				# a _dict cannot hold "items": dict.items would shadow it
				doc = SimpleNamespace(
					doctype="Purchase Invoice",
					name="ADHD-T-PI-NEW",
					currency="USD",
					items=[row],
					precision=lambda *_args: 2,
				)
				with (
					patch(
						"erpnext.controllers.status_updater.get_allowance_for",
						return_value=(allowance, {}, None, None),
					),
					patch("frappe.db.get_single_value", side_effect=single_value),
					patch("frappe.msgprint"),
				):
					try:
						BillingValidationService(doc).validate_multiple_billing(
							"Purchase Receipt", "pr_detail", "amount"
						)
						erpnext_refuses = False
					except frappe.ValidationError:
						erpnext_refuses = True

				ours = evaluate_match(
					[invoice_row(amount=this, po_detail="", pr_detail="pr-row")],
					references(pr={"pr-row": ref_row("PR-1", amount=ref_amount, billed_by_others=others)}),
					settings(allowance_for=lambda _item, a=allowance: a),
				)["status"]
				outcomes.add(erpnext_refuses)
				self.assertEqual(
					ours == "over",
					erpnext_refuses,
					f"receipt {ref_amount} + {allowance}% (already {others}), this invoice {this}: "
					f"ERPNext refuses={erpnext_refuses}, badge={ours}",
				)
			frappe.db.rollback()
		# the sweep has to cross the limit, or agreeing proves nothing
		self.assertEqual(outcomes, {True, False})

	def test_order_rule_agrees_with_check_overflow_with_allowance(self):
		from erpnext.controllers.status_updater import StatusUpdater

		class Updater:
			doctype = "Purchase Invoice"
			is_internal_supplier = 0
			item_allowance = None
			global_qty_allowance = None
			global_amount_allowance = None
			check_overflow_with_allowance = StatusUpdater.check_overflow_with_allowance
			limits_crossed_error = StatusUpdater.limits_crossed_error
			warn_about_bypassing_with_role = StatusUpdater.warn_about_bypassing_with_role

		args = {
			"source_dt": "Purchase Invoice Item",
			"target_dt": "Purchase Order Item",
			"target_ref_field": "amount",
			"target_field": "billed_amt",
			"overflow_type": "billing",
		}
		outcomes = set()
		for ref_amount, allowance in (
			(100, 0),
			(1000, 0),
			(1000, 5),
			(1234.56, 2.5),
			(99.99, 10),
			(25000, 1),
		):
			for billed in self.sweep(ref_amount, allowance):
				item = {
					"item_code": "ADHD-T-ITEM",
					"amount": ref_amount,
					"billed_amt": billed,
					# both set by StatusUpdater.validate_qty before it calls check_overflow_with_allowance
					"target_ref_field": "amount",
				}
				if not ref_amount < billed:
					# StatusUpdater.fetch_items_with_pending_qty only hands on rows billed above the order
					erpnext_refuses = False
				else:
					with (
						patch(
							"erpnext.controllers.status_updater.get_allowance_for",
							return_value=(allowance, {}, None, None),
						),
						patch("frappe.msgprint"),
					):
						try:
							Updater().check_overflow_with_allowance(item, args)
							erpnext_refuses = False
						except frappe.ValidationError:
							erpnext_refuses = True

				ours = only_po(this=billed, amount=ref_amount, allowance=allowance)["status"]
				outcomes.add(erpnext_refuses)
				self.assertEqual(
					ours == "over",
					erpnext_refuses,
					f"order {ref_amount} + {allowance}%, billed {billed}: "
					f"ERPNext refuses={erpnext_refuses}, badge={ours}",
				)
		self.assertEqual(outcomes, {True, False})
