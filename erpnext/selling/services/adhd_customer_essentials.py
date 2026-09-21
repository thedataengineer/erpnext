# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""The numbers behind the ADHD-mode "Essentials" strip on the Customer form (ADHD-022).

Neither the credit limit nor the outstanding amount is a column on Customer: limits are a child table with
one row per company, and the outstanding amount is worked out from the ledger. Both are computed here with the
functions the credit-limit check itself uses (`get_credit_limit`, `get_customer_outstanding`), so the strip agrees
with what would happen when an order for this customer is submitted.

The figures are scoped to one company, in that company's currency. A user with several companies gets their
default Company; see `_resolve_company` for what happens when there is none.
"""

import frappe
from frappe import _
from frappe.utils import cint, flt

from erpnext.accounts.party import get_payment_terms_template
from erpnext.selling.doctype.customer.customer import get_credit_limit, get_customer_outstanding

# DocType names are at most 140 characters (frappe.model.naming), so a longer value cannot be a Customer or a Company
MAX_NAME_LENGTH = 140


def _check_name(value: str | None, label: str) -> str:
	if not isinstance(value, str) or not value.strip() or len(value) > MAX_NAME_LENGTH:
		frappe.throw(_("Invalid {0}").format(label), frappe.ValidationError)
	return value


def _resolve_company(company: str | None) -> str | None:
	"""Pick the one company the figures are for, or None when that is not clear.

	1. The company the caller asked for, which must be readable by the user.
	2. The user's default Company (the one the desk shows).
	3. The only company on the site, if there is exactly one.

	With several companies and no default the figures are withheld rather than guessed: a credit limit is per
	company, and showing another company's limit next to this company's balance would mislead.
	"""
	if company:
		frappe.has_permission("Company", "read", doc=_check_name(company, "Company"), throw=True)
		return company

	default = frappe.defaults.get_user_default("Company")
	if default and frappe.has_permission("Company", "read", doc=default):
		return default

	names = frappe.get_list("Company", pluck="name", limit_page_length=2)
	return names[0] if len(names) == 1 else None


def _primary_contact(customer: str) -> dict:
	"""The customer's primary contact, or failing that its first contact with an email address.

	`frappe.get_list` applies the caller's permissions, so a contact the user may not read is skipped.
	"""
	fields = ["name", "full_name", "email_id"]
	primary = frappe.db.get_value("Customer", customer, "customer_primary_contact")
	if primary:
		rows = frappe.get_list("Contact", filters={"name": primary}, fields=fields, limit_page_length=1)
		if rows and rows[0].email_id:
			return rows[0]

	rows = frappe.get_list(
		"Contact",
		filters=[
			["Dynamic Link", "link_doctype", "=", "Customer"],
			["Dynamic Link", "link_name", "=", customer],
			["Contact", "email_id", "is", "set"],
		],
		fields=fields,
		order_by="is_primary_contact desc, creation asc",
		limit_page_length=1,
	)
	return rows[0] if rows else frappe._dict()


@frappe.whitelist()
def get_customer_essentials(customer: str, company: str | None = None) -> dict:
	"""Credit limit, payment terms, primary contact email and outstanding amount of one customer.

	Returns, all in the currency of `credit_limit_company` (the company the figures are for):

	- credit_limit: the limit that applies (customer, else customer group, else company). 0 means none is set.
	- outstanding: what the credit-limit check compares against the limit. It is the ledger balance plus
	  the value of open Sales Orders and undelivered-not-invoiced Delivery Notes, unless the customer's
	  credit limit row for this company bypasses the check at Sales Order (`includes_open_orders`).
	- over_limit: outstanding is above a credit limit that is set, which is when ERPNext blocks the order.
	- payment_terms: the Payment Terms Template invoices would get, and whether it is inherited (from the
	  customer group or the company) rather than set on the customer.

	`credit_limit`, `outstanding` and `currency` are None when no company can be chosen. The customer itself must
	be readable and that check raises. That is the same access the standard Customer Credit Balance report has
	(its roles are exactly those that can read Customer), and it shows these same two numbers, so nothing is
	exposed that the report does not already show. Everything optional degrades instead of raising, so the form
	can ask without a permission dialog for a part the user has no access to.
	"""
	customer = _check_name(customer, "Customer")
	frappe.has_permission("Customer", "read", doc=customer, throw=True)
	# Administrator passes the permission check without the record being loaded, so a missing one is caught here
	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} does not exist").format(customer), frappe.DoesNotExistError)
	company = _resolve_company(company)

	credit_limit = outstanding = currency = None
	bypass = 0
	if company:
		currency = frappe.get_cached_value("Company", company, "default_currency")
		credit_limit = flt(get_credit_limit(customer, company))
		bypass = cint(
			frappe.db.get_value(
				"Customer Credit Limit",
				{"parent": customer, "parenttype": "Customer", "company": company},
				"bypass_credit_limit_check",
			)
		)
		outstanding = flt(get_customer_outstanding(customer, company, ignore_outstanding_sales_order=bypass))

	payment_terms = get_payment_terms_template(customer, "Customer", company)
	own_terms = frappe.get_cached_value("Customer", customer, "payment_terms")
	contact = _primary_contact(customer)

	return {
		"customer": customer,
		"credit_limit_company": company,
		"credit_limit": credit_limit,
		"outstanding": outstanding,
		"currency": currency,
		"over_limit": bool(outstanding is not None and credit_limit and outstanding > credit_limit),
		"includes_open_orders": not bypass,
		"payment_terms": payment_terms or None,
		"payment_terms_inherited": bool(payment_terms and not own_terms),
		"primary_email": contact.get("email_id") or None,
		"primary_contact_name": contact.get("full_name") or None,
	}
