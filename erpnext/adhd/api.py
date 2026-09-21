# Copyright (c) 2024, ERPNext Contributors
# License: GNU General Public License v3. See license.txt

import json
import re
from html import unescape

import frappe
from frappe import _
from frappe.utils import date_diff, get_fullname, getdate, now_datetime, strip_html, today

MAX_URGENT_ITEMS = 20
MAX_ACTION_ITEMS = 30

# Where one block of a Text Editor value ends and the next begins: stripping the tags alone would glue the
# last word of a paragraph to the first word of the next.
BLOCK_TAG = re.compile(r"<\s*/?\s*(?:p|div|br|li|ul|ol|h[1-6])\b[^>]*>", re.IGNORECASE)


def _as_date(value):
	return getdate(value) if value else None


def _urgency_score(due_date):
	due = _as_date(due_date)
	if not due:
		return 0

	days_overdue = date_diff(today(), due)
	return 10 + days_overdue if days_overdue > 0 else 5


def _urgency_badge(due_date):
	due = _as_date(due_date)
	return "overdue" if due and due < getdate(today()) else "today"


def _plain_text(value):
	"""Text Editor fields (a ToDo description) hold HTML; the inbox shows one plain line."""
	return " ".join(unescape(strip_html(BLOCK_TAG.sub(" ", value or ""))).split())


def _assignee_names(assign):
	"""A document's `_assign` is a JSON list of user ids ('["a@b.com"]'); show their full names."""
	try:
		users = json.loads(assign) if assign else []
	except (TypeError, ValueError):
		return None

	if not isinstance(users, list):
		return None

	return ", ".join(get_fullname(user) for user in users if user and isinstance(user, str)) or None


def _doctype_exists(doctype):
	return frappe.db.exists("DocType", doctype)


def _has_field(doctype, fieldname):
	try:
		return frappe.get_meta(doctype).has_field(fieldname)
	except frappe.DoesNotExistError:
		return False


def _get_list(doctype, *, filters, fields, limit_page_length=None, order_by=None):
	if not _doctype_exists(doctype):
		return []

	kwargs = {
		"doctype": doctype,
		"filters": filters,
		"fields": fields,
	}
	if limit_page_length:
		kwargs["limit_page_length"] = limit_page_length
	if order_by:
		kwargs["order_by"] = order_by

	return frappe.get_list(**kwargs)


def _assigned_task_names(user):
	todos = _get_list(
		"ToDo",
		filters={
			"allocated_to": user,
			"reference_type": "Task",
			"status": ("in", ["Open", "Overdue"]),
		},
		fields=["reference_name"],
		limit_page_length=200,
	)
	return [todo.reference_name for todo in todos if todo.reference_name]


def _make_urgent_row(doctype, doc, due_field, title_field=None, counterparty_field=None):
	due_date = doc.get(due_field)
	counterparty = doc.get(counterparty_field) if counterparty_field else None
	if counterparty_field == "_assign":
		counterparty = _assignee_names(counterparty)

	return {
		"doctype": doctype,
		"name": doc.name,
		"title": doc.get(title_field) if title_field else doc.name,
		"counterparty": counterparty,
		"due_date": due_date,
		"urgency_score": _urgency_score(due_date),
		"urgency": _urgency_badge(due_date),
	}


@frappe.whitelist()
def get_urgent_items(user=None):
	"""Return overdue and due-today documents for the Smart Inbox."""
	user = user or frappe.session.user
	if user != frappe.session.user and "System Manager" not in frappe.get_roles(frappe.session.user):
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	current_day = today()
	items = []

	items.extend(
		_make_urgent_row("Sales Order", doc, "delivery_date", counterparty_field="customer")
		for doc in _get_list(
			"Sales Order",
			filters={
				"delivery_date": ("<=", current_day),
				"status": ("not in", ["Closed", "Completed", "Cancelled"]),
				"docstatus": ("<", 2),
			},
			fields=["name", "customer", "delivery_date", "status"],
			limit_page_length=MAX_URGENT_ITEMS,
			order_by="delivery_date asc",
		)
	)

	items.extend(
		_make_urgent_row("Sales Invoice", doc, "due_date", counterparty_field="customer")
		for doc in _get_list(
			"Sales Invoice",
			filters={
				"due_date": ("<=", current_day),
				"outstanding_amount": (">", 0),
				"docstatus": ("<", 2),
			},
			fields=["name", "customer", "due_date", "outstanding_amount"],
			limit_page_length=MAX_URGENT_ITEMS,
			order_by="due_date asc",
		)
	)

	purchase_order_due_field = (
		"schedule_date" if _has_field("Purchase Order", "schedule_date") else "transaction_date"
	)
	items.extend(
		_make_urgent_row("Purchase Order", doc, purchase_order_due_field, counterparty_field="supplier")
		for doc in _get_list(
			"Purchase Order",
			filters={
				purchase_order_due_field: ("<=", current_day),
				"status": ("not in", ["Closed", "Completed", "Cancelled"]),
				"docstatus": ("<", 2),
			},
			fields=["name", "supplier", purchase_order_due_field, "status"],
			limit_page_length=MAX_URGENT_ITEMS,
			order_by=f"{purchase_order_due_field} asc",
		)
	)

	assigned_tasks = set(_assigned_task_names(user))
	for doc in _get_list(
		"Task",
		filters={
			"_assign": ("like", f'%"{user}"%'),
			"exp_end_date": ("<=", current_day),
			"status": ("not in", ["Closed", "Completed", "Cancelled"]),
		},
		fields=["name"],
		limit_page_length=MAX_URGENT_ITEMS,
	):
		assigned_tasks.add(doc.name)

	if assigned_tasks:
		items.extend(
			_make_urgent_row("Task", doc, "exp_end_date", title_field="subject", counterparty_field="_assign")
			for doc in _get_list(
				"Task",
				filters={
					"name": ("in", list(assigned_tasks)),
					"exp_end_date": ("<=", current_day),
					"status": ("not in", ["Closed", "Completed", "Cancelled"]),
				},
				fields=["name", "subject", "exp_end_date", "status", "_assign"],
				limit_page_length=MAX_URGENT_ITEMS,
				order_by="exp_end_date asc",
			)
		)

	items = [item for item in items if item.get("urgency_score")]
	items.sort(key=lambda item: item.get("urgency_score", 0), reverse=True)
	return items[:MAX_URGENT_ITEMS]


def _make_action_row(row_type, doctype, name, title=None, status=None, timestamp=None):
	return {
		"type": row_type,
		"doctype": doctype,
		"name": name,
		"title": title or name,
		"status": status,
		"timestamp": timestamp,
	}


@frappe.whitelist()
def get_action_queue(user=None):
	"""Return current user's ToDos, workflow actions, and HR leave approvals."""
	user = user or frappe.session.user
	if user != frappe.session.user and "System Manager" not in frappe.get_roles(frappe.session.user):
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	items = []

	for todo in _get_list(
		"ToDo",
		filters={"allocated_to": user, "status": ("in", ["Open", "Overdue"])},
		fields=["name", "description", "reference_type", "reference_name", "modified"],
		limit_page_length=MAX_ACTION_ITEMS,
		order_by="modified desc",
	):
		items.append(
			_make_action_row(
				"ToDo",
				todo.reference_type or "ToDo",
				todo.reference_name or todo.name,
				_plain_text(todo.description) or todo.reference_name or todo.name,
				"Open",
				todo.modified,
			)
		)

	workflow_filters = {"user": user, "status": "Open"}
	has_workflow_state = _has_field("Workflow Action", "workflow_state")
	if has_workflow_state:
		workflow_filters["workflow_state"] = ("not in", ["Approved", "Rejected", "Cancelled"])
	workflow_fields = ["name", "reference_doctype", "reference_name", "modified"]
	if has_workflow_state:
		workflow_fields.append("workflow_state")

	for action in _get_list(
		"Workflow Action",
		filters=workflow_filters,
		fields=workflow_fields,
		limit_page_length=MAX_ACTION_ITEMS,
		order_by="modified desc",
	):
		if action.reference_doctype and action.reference_name:
			items.append(
				_make_action_row(
					"Approval",
					action.reference_doctype,
					action.reference_name,
					action.reference_name,
					action.get("workflow_state") or "Open",
					action.modified,
				)
			)

	if "HR User" in frappe.get_roles(user) or "HR Manager" in frappe.get_roles(user):
		for leave in _get_list(
			"Leave Application",
			filters={"status": "Open", "docstatus": 0},
			fields=["name", "employee_name", "from_date", "to_date", "status", "modified"],
			limit_page_length=MAX_ACTION_ITEMS,
			order_by="modified desc",
		):
			items.append(
				_make_action_row(
					"Leave",
					"Leave Application",
					leave.name,
					leave.employee_name or leave.name,
					leave.status,
					leave.modified,
				)
			)

	items.sort(key=lambda item: item.get("timestamp") or now_datetime(), reverse=True)
	return items[:MAX_ACTION_ITEMS]
