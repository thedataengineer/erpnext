# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# Server side of the ADHD-mode Customer "Essentials" strip (ADHD-022). The Node suite only reads the client, so it
# cannot notice that the endpoint returns a wrong balance; these build a Customer, a Contact and real invoices and
# check the numbers the strip would show.
#
# Plain unittest, rolled back, and deliberately without erpnext.tests.utils (importing it bootstraps and
# commits test data into whatever site it runs on). Needs a site with one Company that has a chart of accounts and a
# Fiscal Year covering today, as the dev site has.

import unittest
from unittest.mock import patch

import frappe
from frappe.utils import add_days, today

from erpnext.selling.services import adhd_customer_essentials as essentials

CUSTOMER = "ADHD Essentials Customer"
ITEM = "ADHD-ESSENTIALS-SERVICE"


class TestCustomerEssentials(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.company = (
			frappe.defaults.get_user_default("Company")
			or frappe.get_all("Company", pluck="name", limit_page_length=1)[0]
		)

	def setUp(self):
		frappe.set_user("Administrator")
		self.currency = frappe.get_cached_value("Company", self.company, "default_currency")
		self.customer = self.make_customer(credit_limit=10000)
		self.item = self.make_item()

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	# --- fixtures ---

	@staticmethod
	def make(doctype, **fields):
		return frappe.get_doc({"doctype": doctype, **fields}).insert()

	def make_customer(self, credit_limit=None, **fields):
		limits = [{"company": self.company, "credit_limit": credit_limit}] if credit_limit is not None else []
		return self.make(
			"Customer",
			customer_name=CUSTOMER,
			customer_group=frappe.db.get_value("Customer Group", {"is_group": 0}, "name"),
			territory=frappe.db.get_value("Territory", {"is_group": 0}, "name"),
			credit_limits=limits,
			**fields,
		)

	def make_item(self):
		return self.make(
			"Item",
			item_code=ITEM,
			item_name=ITEM,
			item_group=frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
			stock_uom=frappe.db.get_value("UOM", {"enabled": 1}, "name"),
			is_stock_item=0,
		).name

	def make_terms(self, name="ADHD Net 30"):
		term = self.make(
			"Payment Term",
			payment_term_name=name,
			invoice_portion=100,
			credit_days=30,
		)
		return self.make(
			"Payment Terms Template",
			template_name=name,
			terms=[{"payment_term": term.name, "invoice_portion": 100, "credit_days": 30}],
		).name

	def make_contact(self, email, *, primary, first_name="Jo", flagged=False):
		"""`primary` makes it the customer's primary contact; `flagged` only ticks the Contact's own checkbox."""
		contact = self.make(
			"Contact",
			first_name=first_name,
			is_primary_contact=int(flagged),
			email_ids=[{"email_id": email, "is_primary": 1}] if email else [],
			links=[{"link_doctype": "Customer", "link_name": self.customer.name}],
		)
		if primary:
			self.customer.db_set("customer_primary_contact", contact.name)
		return contact

	def invoice(self, amount):
		company = frappe.get_cached_doc("Company", self.company)
		doc = self.make(
			"Sales Invoice",
			customer=self.customer.name,
			company=self.company,
			posting_date=today(),
			due_date=add_days(today(), 30),
			items=[
				{
					"item_code": self.item,
					"qty": 1,
					"rate": amount,
					"income_account": company.default_income_account,
					"cost_center": company.cost_center,
				}
			],
		)
		doc.submit()
		return doc

	def essentials(self, **kwargs):
		return essentials.get_customer_essentials(self.customer.name, **kwargs)

	# --- the numbers ---

	def test_credit_limit_and_outstanding_are_the_real_figures_in_company_currency(self):
		self.invoice(8500)

		result = self.essentials()

		self.assertEqual(result["credit_limit"], 10000)
		self.assertEqual(result["outstanding"], 8500)
		self.assertEqual(result["credit_limit_company"], self.company)
		self.assertEqual(result["currency"], self.currency)
		self.assertFalse(result["over_limit"])

	def test_over_the_limit_only_when_outstanding_is_above_it(self):
		self.invoice(10000)
		# exactly at the limit is not over: check_credit_limit only blocks above it
		self.assertFalse(self.essentials()["over_limit"])

		# ERPNext refuses to submit an invoice past the limit, so the limit is what moves
		frappe.db.set_value(
			"Customer Credit Limit", self.customer.credit_limits[0].name, "credit_limit", 9999
		)
		result = self.essentials()
		self.assertEqual(result["credit_limit"], 9999)
		self.assertEqual(result["outstanding"], 10000)
		self.assertTrue(result["over_limit"])

	def test_no_limit_set_is_zero_and_never_over(self):
		customer = self.make_customer(credit_limit=None)
		self.customer = customer
		self.invoice(500)

		result = essentials.get_customer_essentials(customer.name)

		self.assertEqual(result["credit_limit"], 0)
		self.assertEqual(result["outstanding"], 500)
		self.assertFalse(result["over_limit"])

	def test_a_customer_with_no_invoices_owes_nothing(self):
		result = self.essentials()
		self.assertEqual(result["outstanding"], 0)
		self.assertFalse(result["over_limit"])

	def test_an_invoice_in_another_currency_is_counted_in_company_currency(self):
		# outstanding_amount on the invoice is in the receivable account's currency; the ledger is company currency
		foreign = "EUR" if self.currency != "EUR" else "USD"
		company = frappe.get_cached_doc("Company", self.company)
		receivable = self.make(
			"Account",
			account_name="ADHD Debtors Foreign",
			parent_account=frappe.db.get_value(
				"Account", company.default_receivable_account, "parent_account"
			),
			company=self.company,
			account_type="Receivable",
			account_currency=foreign,
		)
		doc = self.make(
			"Sales Invoice",
			customer=self.customer.name,
			company=self.company,
			currency=foreign,
			conversion_rate=2,
			debit_to=receivable.name,
			posting_date=today(),
			due_date=add_days(today(), 30),
			items=[
				{
					"item_code": self.item,
					"qty": 1,
					"rate": 100,
					"income_account": company.default_income_account,
					"cost_center": company.cost_center,
				}
			],
		)
		doc.submit()

		# the invoice itself says 100 (in the receivable account's currency); the strip says 200 in company currency
		self.assertEqual(doc.outstanding_amount, 100)
		self.assertEqual(self.essentials()["outstanding"], 200)

	def test_open_orders_count_unless_the_customer_bypasses_the_check_at_sales_order(self):
		company = frappe.get_cached_doc("Company", self.company)
		order = self.make(
			"Sales Order",
			customer=self.customer.name,
			company=self.company,
			transaction_date=today(),
			delivery_date=add_days(today(), 7),
			items=[
				{
					"item_code": self.item,
					"qty": 1,
					"rate": 3000,
					"delivery_date": add_days(today(), 7),
					"cost_center": company.cost_center,
				}
			],
		)
		order.submit()

		with_orders = self.essentials()
		self.assertEqual(with_orders["outstanding"], 3000)
		self.assertTrue(with_orders["includes_open_orders"])

		self.customer.credit_limits[0].bypass_credit_limit_check = 1
		self.customer.save()
		bypassed = self.essentials()
		self.assertEqual(bypassed["outstanding"], 0)
		self.assertFalse(bypassed["includes_open_orders"])

	def test_the_group_limit_then_the_company_limit_apply_when_the_customer_has_none(self):
		# same fallback the credit-limit check uses (get_credit_limit): customer, then group, then company
		customer = self.make_customer(credit_limit=None)
		self.customer = customer
		frappe.db.set_value("Company", self.company, "credit_limit", 777)
		self.assertEqual(self.essentials()["credit_limit"], 777)

		group = frappe.get_doc("Customer Group", customer.customer_group)
		group.append("credit_limits", {"company": self.company, "credit_limit": 555})
		group.save()
		self.assertEqual(self.essentials()["credit_limit"], 555)

		self.customer.append("credit_limits", {"company": self.company, "credit_limit": 333})
		self.customer.save()
		self.assertEqual(self.essentials()["credit_limit"], 333)

	# --- payment terms and contact ---

	def test_payment_terms_of_the_customer_and_whether_they_are_inherited(self):
		template = self.make_terms()
		self.assertIsNone(self.essentials()["payment_terms"])

		self.customer.db_set("payment_terms", template)
		own = self.essentials()
		self.assertEqual(own["payment_terms"], template)
		self.assertFalse(own["payment_terms_inherited"])

		self.customer.db_set("payment_terms", None)
		frappe.db.set_value("Customer Group", self.customer.customer_group, "payment_terms", template)
		frappe.clear_document_cache("Customer", self.customer.name)
		inherited = self.essentials()
		self.assertEqual(inherited["payment_terms"], template)
		self.assertTrue(inherited["payment_terms_inherited"])

	def test_the_primary_contacts_email_and_name(self):
		self.make_contact("other@acme.example", primary=False, first_name="Other")
		self.make_contact("jo@acme.example", primary=True)

		result = self.essentials()

		self.assertEqual(result["primary_email"], "jo@acme.example")
		self.assertIn("Jo", result["primary_contact_name"])

	def test_without_a_primary_contact_the_first_contact_with_an_email_is_used(self):
		self.make_contact("first@acme.example", primary=False, first_name="First")

		self.assertEqual(self.essentials()["primary_email"], "first@acme.example")

	def test_among_several_contacts_the_flagged_then_the_oldest_wins(self):
		self.make_contact("oldest@acme.example", primary=False, first_name="Oldest")
		self.make_contact("second@acme.example", primary=False, first_name="Second")
		self.assertEqual(self.essentials()["primary_email"], "oldest@acme.example")

		self.make_contact("flagged@acme.example", primary=False, first_name="Flagged", flagged=True)
		self.assertEqual(self.essentials()["primary_email"], "flagged@acme.example")

	def test_a_primary_contact_without_an_email_gives_way_to_one_that_has_one(self):
		self.make_contact(None, primary=True, first_name="Nomail")
		self.make_contact("other@acme.example", primary=False, first_name="Other")

		result = self.essentials()

		self.assertEqual(result["primary_email"], "other@acme.example")
		# the name is the person the address belongs to, never the primary contact's
		self.assertIn("Other", result["primary_contact_name"])

	def test_a_customer_with_no_contact_has_no_email(self):
		result = self.essentials()
		self.assertIsNone(result["primary_email"])
		self.assertIsNone(result["primary_contact_name"])

	# --- which company ---

	def test_without_a_default_company_and_with_several_companies_the_figures_are_withheld(self):
		self.invoice(100)
		with patch("frappe.defaults.get_user_default", return_value=None):
			result = self.essentials()

		self.assertGreater(frappe.db.count("Company"), 1)
		self.assertIsNone(result["credit_limit_company"])
		self.assertIsNone(result["credit_limit"])
		self.assertIsNone(result["outstanding"])
		self.assertIsNone(result["currency"])
		self.assertFalse(result["over_limit"])

	def test_a_site_with_one_company_needs_no_default(self):
		with (
			patch("frappe.defaults.get_user_default", return_value=None),
			patch("frappe.get_list", return_value=[self.company]),
		):
			self.assertEqual(essentials._resolve_company(None), self.company)

	def test_another_company_can_be_asked_for_and_gets_its_own_currency(self):
		other = frappe.db.get_value(
			"Company", {"name": ("!=", self.company), "default_currency": ("!=", self.currency)}, "name"
		)
		if not other:
			self.skipTest("the site has no company in another currency")

		result = self.essentials(company=other)

		self.assertEqual(result["credit_limit_company"], other)
		self.assertEqual(result["currency"], frappe.get_cached_value("Company", other, "default_currency"))
		# this customer only has a limit for the default company
		self.assertEqual(result["credit_limit"], 0)

	# --- permissions and inputs ---

	def test_a_user_who_can_read_customers_sees_the_figures(self):
		user = self.make(
			"User",
			email="adhd-sales-user@example.com",
			first_name="Sales",
			send_welcome_email=0,
			roles=[{"role": "Sales User"}],
		)
		self.invoice(4000)
		frappe.set_user(user.name)

		result = self.essentials()

		self.assertEqual(result["outstanding"], 4000)
		self.assertEqual(result["credit_limit"], 10000)

	def test_a_user_who_cannot_read_customers_is_refused(self):
		# Purchase User can read Company but has no access to Customer, so the refusal is about the customer itself
		user = self.make(
			"User",
			email="adhd-no-access@example.com",
			first_name="Nobody",
			send_welcome_email=0,
			roles=[{"role": "Purchase User"}],
		)
		self.assertTrue(frappe.has_permission("Company", "read", doc=self.company, user=user.name))
		self.assertFalse(frappe.has_permission("Customer", "read", user=user.name))
		frappe.set_user(user.name)

		with self.assertRaises(frappe.PermissionError):
			self.essentials()

	def test_a_company_the_user_cannot_read_is_refused(self):
		def refuse_company(doctype, *args, throw=False, **kwargs):
			if doctype == "Company" and throw:
				raise frappe.PermissionError
			return doctype != "Company"

		with patch("frappe.has_permission", side_effect=refuse_company):
			with self.assertRaises(frappe.PermissionError):
				essentials._resolve_company(self.company)
			# a default company the user cannot read is not used either: the figures are withheld
			with patch("frappe.get_list", return_value=[self.company, "Other"]):
				self.assertIsNone(essentials._resolve_company(None))

	def test_bad_names_are_refused(self):
		for name in ("", "   ", "x" * 141, None, 5):
			with self.assertRaises(frappe.ValidationError, msg=repr(name)):
				essentials.get_customer_essentials(name)
		with self.assertRaises(frappe.ValidationError):
			essentials.get_customer_essentials(self.customer.name, company="x" * 141)

	def test_a_customer_that_does_not_exist_is_not_found(self):
		with self.assertRaises(frappe.DoesNotExistError):
			essentials.get_customer_essentials("No Such Customer 123")

	def test_the_endpoint_is_whitelisted(self):
		self.assertIn(essentials.get_customer_essentials, frappe.whitelisted)
