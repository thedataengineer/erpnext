# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Yadavilli Solutions: a demo organisation for RTB.

A small IT consultancy with just enough going on to see every Focus aid on a real screen: quotations that are
about to expire, an opportunity nobody has touched, a customer close to its credit limit, a partly delivered
Sales Order, an RFQ with two quotes, a partly received Purchase Order with an invoice that bills too much,
an Installation Note, and tasks that are overdue, due today and waiting on you.

    bench --site <site> execute erpnext.setup.rtb_demo.create_yadavilli_solutions
    bench --site <site> execute erpnext.setup.rtb_demo.create_yadavilli_solutions --kwargs "{'dry_run': True}"

A dry run does everything and rolls it back, so the data can be checked without keeping it. Running it again
when the company exists changes nothing.

Nothing here sends mail: mail is muted for the run, no RFQ supplier is set to receive one, and every address is
on example.com, which can never be delivered to.
"""

import frappe
from frappe.desk.form import assign_to
from frappe.utils import add_days, add_months, flt, getdate, nowdate

COMPANY = "Yadavilli Solutions"
ABBR = "YS"
CURRENCY = "USD"
COUNTRY = "United States"
STORES = f"Stores - {ABBR}"
NET_30 = "Net 30 Days"

CUSTOMERS = (
	# name, contact, credit limit (0 = none), payment terms
	("Bluebird Analytics", "Maya Brooks", 15000, NET_30),
	("Harbor & Pine Foods", "Daniel Okafor", 25000, NET_30),
	("Meridian Clinics", "Sofia Lindqvist", 0, None),
	("Cobalt Freight", "Ravi Menon", 0, None),
)
SUPPLIERS = (
	("Summit Office Supply", "Hardware", "Carla Reyes"),
	("Kestrel Hardware Co", "Hardware", "Tom Whitfield"),
	("Lumen Cloud Services", "Services", "Ines Duarte"),
)
# code, name, group, stock item, unit, valuation rate, selling rate
ITEMS = (
	("YS-CONSULT-HR", "Consulting Hour", "Services", 0, "Hour", 0, 150),
	("YS-IMPL", "Implementation Package", "Services", 0, "Nos", 0, 4500),
	("YS-SUPPORT", "Monthly Support Retainer", "Services", 0, "Nos", 0, 1200),
	("YS-LAPTOP", "Laptop Pro 14", "Products", 1, "Nos", 900, 1300),
	("YS-DOCK", "USB-C Docking Station", "Products", 1, "Nos", 90, 140),
	("YS-SWITCH", "24-port Network Switch", "Products", 1, "Nos", 210, 320),
)


def create_yadavilli_solutions(dry_run: bool = False) -> dict:
	"""Create the company and its demo data. Returns what was made, by document type."""
	if frappe.db.exists("Company", COMPANY):
		print(f"{COMPANY} already exists: nothing to do.")
		return {}

	mail_before = frappe.db.count("Email Queue")
	frappe.flags.mute_emails = True
	frappe.set_user("Administrator")
	frappe.db.savepoint("rtb_demo")
	made: dict[str, list[str]] = {}

	def keep(doc):
		made.setdefault(doc.doctype, []).append(doc.name)
		return doc

	try:
		create_company(keep)
		create_masters(keep)
		receive_stock(keep)
		create_crm(keep)
		create_selling(keep)
		create_buying(keep)
		create_work(keep)
		create_installation_note(keep)
		frappe.defaults.set_user_default("company", COMPANY, "Administrator")
	except Exception:
		frappe.db.rollback(save_point="rtb_demo")
		raise

	if frappe.db.count("Email Queue") != mail_before:
		frappe.db.rollback(save_point="rtb_demo")
		frappe.throw("The demo data queued an email. Nothing was kept.")

	if dry_run:
		frappe.db.rollback(save_point="rtb_demo")
	else:
		frappe.db.commit()

	for doctype, names in made.items():
		print(f"{doctype:28} {len(names):3}  {names[0]}{' ...' if len(names) > 1 else ''}")
	print("dry run: rolled back" if dry_run else "saved")
	return made


def insert(doc: dict, submit: bool = False):
	doc = frappe.get_doc(doc).insert(ignore_permissions=True)
	if submit:
		doc.submit()
	return doc


def create_company(keep):
	year = getdate(nowdate()).year
	holidays = frappe.get_doc(
		{
			"doctype": "Holiday List",
			"holiday_list_name": f"{COMPANY} {year}",
			"from_date": f"{year}-01-01",
			"to_date": f"{year}-12-31",
			"weekly_off": "Sunday",
		}
	)
	holidays.get_weekly_off_dates()
	holidays.weekly_off = "Saturday"
	holidays.get_weekly_off_dates()
	keep(holidays.insert(ignore_permissions=True))

	keep(
		insert(
			{
				"doctype": "Company",
				"company_name": COMPANY,
				"abbr": ABBR,
				"default_currency": CURRENCY,
				"country": COUNTRY,
				"create_chart_of_accounts_based_on": "Standard Template",
				"chart_of_accounts": "Standard",
				"default_holiday_list": holidays.name,
				"enable_perpetual_inventory": 1,
			}
		)
	)

	keep(
		insert(
			{
				"doctype": "Payment Term",
				"payment_term_name": "Net 30",
				"invoice_portion": 100,
				"due_date_based_on": "Day(s) after invoice date",
				"credit_days": 30,
			}
		)
	)
	keep(
		insert(
			{
				"doctype": "Payment Terms Template",
				"template_name": NET_30,
				"terms": [
					{
						"payment_term": "Net 30",
						"invoice_portion": 100,
						"due_date_based_on": "Day(s) after invoice date",
						"credit_days": 30,
					}
				],
			}
		)
	)


def contact_for(name: str, person: str, link_doctype: str, domain: str):
	first, _, last = person.partition(" ")
	slug = "".join(ch for ch in name.lower() if ch.isalnum())
	return insert(
		{
			"doctype": "Contact",
			"first_name": first,
			"last_name": last,
			"email_ids": [{"email_id": f"{first.lower()}@{slug}.{domain}", "is_primary": 1}],
			"links": [{"link_doctype": link_doctype, "link_name": name}],
		}
	)


def create_masters(keep):
	for name, person, limit, terms in CUSTOMERS:
		customer = insert(
			{
				"doctype": "Customer",
				"customer_name": name,
				"customer_type": "Company",
				"customer_group": "Commercial",
				"territory": COUNTRY,
				"payment_terms": terms,
				"credit_limits": [{"company": COMPANY, "credit_limit": limit}] if limit else [],
			}
		)
		keep(customer)
		contact = keep(contact_for(name, person, "Customer", "example.com"))
		frappe.db.set_value("Customer", customer.name, "customer_primary_contact", contact.name)

	for name, group, person in SUPPLIERS:
		supplier = insert(
			{
				"doctype": "Supplier",
				"supplier_name": name,
				"supplier_group": group,
				"supplier_type": "Company",
				"payment_terms": NET_30,
			}
		)
		keep(supplier)
		keep(contact_for(name, person, "Supplier", "example.com"))

	for code, name, group, is_stock, uom, valuation_rate, rate in ITEMS:
		keep(
			insert(
				{
					"doctype": "Item",
					"item_code": code,
					"item_name": name,
					"item_group": group,
					"stock_uom": uom,
					"is_stock_item": is_stock,
					"is_sales_item": 1,
					"is_purchase_item": 1 if is_stock else 0,
					"valuation_rate": valuation_rate,
					"standard_rate": rate,
					"item_defaults": [{"company": COMPANY, "default_warehouse": STORES}] if is_stock else [],
				}
			)
		)


def receive_stock(keep):
	"""What is on the shelf before the demo starts."""
	keep(
		insert(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Receipt",
				"company": COMPANY,
				"items": [
					{"item_code": "YS-LAPTOP", "qty": 10, "basic_rate": 900, "t_warehouse": STORES},
					{"item_code": "YS-DOCK", "qty": 10, "basic_rate": 90, "t_warehouse": STORES},
					{"item_code": "YS-SWITCH", "qty": 6, "basic_rate": 210, "t_warehouse": STORES},
				],
			},
			submit=True,
		)
	)


def create_crm(keep):
	today = getdate(nowdate())
	keep(
		insert(
			{
				"doctype": "Lead",
				"first_name": "Priya",
				"last_name": "Nair",
				"company_name": "Fabrikam Logistics",
				"email_id": "priya@fabrikamlogistics.example.com",
				"status": "Open",
			}
		)
	)
	fresh = keep(
		insert(
			{
				"doctype": "Opportunity",
				"opportunity_from": "Customer",
				"party_name": "Harbor & Pine Foods",
				"company": COMPANY,
				"opportunity_type": "Sales",
				"transaction_date": add_days(today, -3),
				"opportunity_amount": 9500,
				"currency": CURRENCY,
				"title": "Inventory forecasting pilot",
			}
		)
	)
	stale = keep(
		insert(
			{
				"doctype": "Opportunity",
				"opportunity_from": "Customer",
				"party_name": "Cobalt Freight",
				"company": COMPANY,
				"opportunity_type": "Sales",
				"transaction_date": add_days(today, -30),
				"opportunity_amount": 18000,
				"currency": CURRENCY,
				"title": "Warehouse dashboard rollout",
			}
		)
	)
	# nobody has saved this one for three weeks
	frappe.db.set_value("Opportunity", stale.name, "modified", add_days(today, -21), update_modified=False)
	return fresh


def quotation(customer: str, items: list[dict], posted: int, valid_days: int, submit: bool):
	today = getdate(nowdate())
	return insert(
		{
			"doctype": "Quotation",
			"quotation_to": "Customer",
			"party_name": customer,
			"company": COMPANY,
			"transaction_date": add_days(today, posted),
			"valid_till": add_days(today, valid_days),
			"order_type": "Sales",
			"items": items,
		},
		submit=submit,
	)


def create_selling(keep):
	today = getdate(nowdate())
	# about to expire, already expired, and still a draft
	keep(quotation("Meridian Clinics", [{"item_code": "YS-IMPL", "qty": 1, "rate": 4500}], -12, 3, True))
	keep(quotation("Cobalt Freight", [{"item_code": "YS-SUPPORT", "qty": 6, "rate": 1200}], -20, -2, True))
	keep(
		quotation(
			"Harbor & Pine Foods",
			[{"item_code": "YS-CONSULT-HR", "qty": 40, "rate": 150}],
			0,
			21,
			False,
		)
	)

	# what Bluebird already owes, billed first: the credit limit check adds open orders to it
	keep(
		insert(
			{
				"doctype": "Sales Invoice",
				"customer": "Bluebird Analytics",
				"company": COMPANY,
				"posting_date": add_days(today, -14),
				"set_posting_time": 1,
				"update_stock": 0,
				"items": [{"item_code": "YS-CONSULT-HR", "qty": 56, "rate": 150}],
			},
			submit=True,
		)
	)

	order = keep(
		insert(
			{
				"doctype": "Sales Order",
				"customer": "Bluebird Analytics",
				"company": COMPANY,
				"transaction_date": add_days(today, -6),
				"delivery_date": add_days(today, 7),
				"set_warehouse": STORES,
				"items": [
					{"item_code": "YS-LAPTOP", "qty": 4, "rate": 1300, "warehouse": STORES},
					{"item_code": "YS-DOCK", "qty": 4, "rate": 140, "warehouse": STORES},
				],
			},
			submit=True,
		)
	)

	from erpnext.selling.doctype.sales_order.mapper import make_delivery_note

	note = make_delivery_note(order.name)
	for row in note.items:
		row.qty = 2
	keep(note.insert(ignore_permissions=True))
	note.submit()


def create_buying(keep):
	today = getdate(nowdate())
	rfq = keep(
		insert(
			{
				"doctype": "Request for Quotation",
				"company": COMPANY,
				"transaction_date": add_days(today, -9),
				"subject": "Laptops and docks for the Bluebird rollout",
				"message_for_supplier": "Please quote for the items below, delivered to our stores.",
				# no supplier is set to receive mail: this is a demo
				"suppliers": [
					{"supplier": "Summit Office Supply", "send_email": 0},
					{"supplier": "Kestrel Hardware Co", "send_email": 0},
				],
				"items": [
					{
						"item_code": "YS-LAPTOP",
						"qty": 6,
						"uom": "Nos",
						"conversion_factor": 1,
						"schedule_date": add_days(today, 10),
						"warehouse": STORES,
					},
					{
						"item_code": "YS-DOCK",
						"qty": 6,
						"uom": "Nos",
						"conversion_factor": 1,
						"schedule_date": add_days(today, 10),
						"warehouse": STORES,
					},
				],
			},
			submit=True,
		)
	)

	rates = {
		"Summit Office Supply": {"YS-LAPTOP": 880, "YS-DOCK": 96},
		"Kestrel Hardware Co": {"YS-LAPTOP": 905, "YS-DOCK": 84},
	}
	quotes = {}
	for supplier, prices in rates.items():
		quotes[supplier] = keep(
			insert(
				{
					"doctype": "Supplier Quotation",
					"supplier": supplier,
					"company": COMPANY,
					"transaction_date": add_days(today, -6),
					"valid_till": add_days(today, 20),
					"items": [
						{
							"item_code": row.item_code,
							"qty": row.qty,
							"rate": prices[row.item_code],
							"warehouse": STORES,
							"schedule_date": add_days(today, 10),
							"request_for_quotation": rfq.name,
							"request_for_quotation_item": row.name,
						}
						for row in rfq.items
					],
				},
				submit=True,
			)
		)

	from erpnext.buying.doctype.supplier_quotation.mapper import make_purchase_order

	order = make_purchase_order(quotes["Summit Office Supply"].name)
	order.schedule_date = add_days(today, 10)
	for row in order.items:
		row.schedule_date = add_days(today, 10)
	keep(order.insert(ignore_permissions=True))
	order.submit()

	# four of the six laptops and docks have arrived
	from erpnext.buying.doctype.purchase_order.mapper import make_purchase_invoice, make_purchase_receipt

	receipt = make_purchase_receipt(order.name)
	for row in receipt.items:
		row.qty = 4
	keep(receipt.insert(ignore_permissions=True))
	receipt.submit()

	# the supplier's invoice bills one laptop more than was ordered: the match badge goes red
	invoice = make_purchase_invoice(order.name)
	invoice.bill_no = "SUM-2291"
	invoice.bill_date = today
	for row in invoice.items:
		if row.item_code == "YS-LAPTOP":
			row.qty = 7
	keep(invoice.insert(ignore_permissions=True))

	create_scorecard(keep)


def create_scorecard(keep):
	"""A weak scorecard for Lumen Cloud Services, so the Purchase Order nudge has something to say."""
	if not frappe.db.exists("Supplier Scorecard Criteria", "On-time delivery"):
		keep(
			insert(
				{
					"doctype": "Supplier Scorecard Criteria",
					"criteria_name": "On-time delivery",
					"max_score": 100,
					"formula": "100",
					"weight": 100,
				}
			)
		)
	standing_fields = [
		"standing_name",
		"standing_color",
		"min_grade",
		"max_grade",
		"warn_rfqs",
		"warn_pos",
		"prevent_rfqs",
		"prevent_pos",
		"notify_supplier",
		"notify_employee",
	]
	standings = frappe.get_all(
		"Supplier Scorecard Standing", fields=standing_fields, order_by="min_grade asc"
	)
	scorecard = insert(
		{
			"doctype": "Supplier Scorecard",
			"supplier": "Lumen Cloud Services",
			"period": "Per Month",
			"weighting_function": "{total_score} * max(0, min(1, (3000 - {period_number}) / 2900))",
			"criteria": [
				{"criteria_name": "On-time delivery", "weight": 100, "max_score": 100, "formula": "100"}
			],
			"standings": [dict(row) for row in standings],
		}
	)
	keep(scorecard)
	# 38 is "Poor" in the standard standings (30 up to 50)
	frappe.db.set_value(
		"Supplier Scorecard",
		scorecard.name,
		{"supplier_score": "38", "status": "Poor"},
		update_modified=False,
	)


def create_work(keep):
	today = getdate(nowdate())
	project = keep(
		insert(
			{
				"doctype": "Project",
				"project_name": "Bluebird Analytics dashboard build",
				"company": COMPANY,
				"customer": "Bluebird Analytics",
				"expected_start_date": add_days(today, -20),
				"expected_end_date": add_months(today, 2),
			}
		)
	)
	tasks = (
		("Confirm the data sources with Maya", -2, "Open"),
		("Draft the dashboard wireframes", 0, "Working"),
		("Set up the reporting database", 3, "Open"),
		("Review the wireframes with the client", 5, "Pending Review"),
		("Agree the go-live checklist", 9, "Open"),
		("Kick-off call", -12, "Completed"),
	)
	for subject, days, status in tasks:
		task = keep(
			insert(
				{
					"doctype": "Task",
					"subject": subject,
					"project": project.name,
					"status": status,
					"exp_end_date": add_days(today, days),
				}
			)
		)
		if status != "Completed":
			assign_to.add({"doctype": "Task", "name": task.name, "assign_to": ["Administrator"], "notify": 0})


def create_installation_note(keep):
	today = getdate(nowdate())
	note = keep(
		insert(
			{
				"doctype": "Installation Note",
				"customer": "Bluebird Analytics",
				"territory": COUNTRY,
				"company": COMPANY,
				"inst_date": add_days(today, 1),
				"items": [
					{"item_code": "YS-LAPTOP", "qty": 2, "adhd_confirmed_installed": 1},
					{"item_code": "YS-DOCK", "qty": 2, "adhd_confirmed_installed": 0},
				],
			}
		)
	)
	return flt(len(note.items))
