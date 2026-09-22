# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""HR questions the assistant answers with plain code, for Hubble (the HR app), never the model.

Everything here is about the signed-in person's own Employee record: their leave balance, who else is
out, the next holidays, their own latest payslip, their own attendance, and (for an approver) what is
waiting on them. Six questions are recognised without the model, the same way `mail.py` recognises
"what did Acme email me": a regex matches the whole question, so a bare mention inside a note ("book the
holiday photos for Acme") never fires one of these.

Two rules run through every function below, matching the design of the rest of the assistant:

- **Pay is personal.** `payslip_answer` and `attendance_answer` never take an employee as an argument:
  they always look up the signed-in person's own Employee record, so there is no way to ask for anyone
  else's numbers through this module. "Who is out" and "pending my approval" show only the name, leave
  type and dates of others, never their private reason text.
- **The model is never involved.** Every answer is built from real records with `frappe.get_list` (which
  applies the caller's own permissions), formatted by code. If Hubble (the `hrms` app) is not installed,
  or the signed-in user has no Employee record, everything degrades to one plain sentence.
"""

import re
from datetime import timedelta
from typing import Any

import frappe
from frappe import _
from frappe.utils import formatdate, get_first_day, getdate, nowdate

MAX_ITEMS = 8
HOLIDAY_WINDOW_DAYS = 120
PENDING_LIMIT = 6

# --- what people ask, recognised without the model ------------------------------------------------
# Anchored to whole phrases (never a bare word) so a note that merely mentions "leave" or "holiday" is
# left alone: "book leave for the team offsite" is a note, not a question about a balance.

LEAVE_BALANCE_CUE = re.compile(
	r"\bleave balance\b"
	r"|\bhow (?:much|many) leave(?:s)? (?:do i have|is left|are left|have i got|left|remaining)\b"
	r"|\bhow many (?:leave )?days? (?:do i have|are left|left|remaining)\b"
	r"|\bmy (?:remaining |available )?leave(?:s)? (?:balance|left|remaining)\b",
	re.I,
)
WHO_IS_OUT_CUE = re.compile(
	r"\bwho(?:'s| is) (?:out|off|away)\b"
	r"|\bwho(?:'s| is) on leave\b"
	r"|\bis (?:anyone|anybody) (?:out|off|away|on leave)\b"
	r"|\b(?:anyone|team) out (?:today|this week|tomorrow)\b",
	re.I,
)
HOLIDAYS_CUE = re.compile(
	r"\b(?:upcoming|next|coming) holidays?\b"
	r"|\bwhen(?:'s| is) the next holiday\b"
	r"|\bwhat(?:'s| is) the next holiday\b"
	r"|\bholidays? (?:this year|coming up|list)\b",
	re.I,
)
PAYSLIP_CUE = re.compile(
	r"\bmy (?:latest |last |recent )?pay ?slip\b"
	r"|\bhow much (?:did i get paid|was i paid|is my (?:net )?pay)\b"
	r"|\bmy net pay\b",
	re.I,
)
ATTENDANCE_CUE = re.compile(
	r"\bmy attendance\b"
	r"|\bhow many days (?:have i|did i) (?:worked|work|attend)\b"
	r"|\bwas i (?:marked )?(?:present|absent) (?:today|yesterday)\b",
	re.I,
)
PENDING_APPROVAL_CUE = re.compile(
	r"\bpending my approval\b"
	r"|\bpending approvals?\b"
	r"|\b(?:what|anything) (?:needs?|is pending) my approval\b"
	r"|\b(?:leave requests?|expense claims?) (?:to|i need to|waiting to be) approve\b"
	r"|\banything (?:for me )?to approve\b",
	re.I,
)


def hr_installed() -> bool:
	"""Hubble (the `hrms` app) adds these doctypes; a plain ERPNext site does not have them."""
	return bool(frappe.db.exists("DocType", "Leave Application"))


def not_set_up_message() -> str:
	return _("Hubble (HR) is not set up on this site.")


def _not_set_up() -> dict[str, Any]:
	return {"reply": not_set_up_message(), "items": []}


def current_employee() -> dict[str, Any] | None:
	"""The signed-in person's own Employee record, if they have one."""
	return frappe.db.get_value(
		"Employee",
		{"user_id": frappe.session.user, "status": "Active"},
		["name", "employee_name", "company", "department", "holiday_list", "reports_to"],
		as_dict=True,
	)


def _no_employee() -> dict[str, Any]:
	return {
		"reply": _("I can't find an employee record linked to your account, so I can't show you that."),
		"items": [],
	}


def _fmt(number: float | int | None) -> str:
	return f"{float(number or 0):g}"


# --- leave balance ---------------------------------------------------------------------------------


def leave_balance_answer() -> dict[str, Any]:
	if not hr_installed():
		return _not_set_up()
	employee = current_employee()
	if not employee:
		return _no_employee()

	from hrms.hr.doctype.leave_application.leave_application import get_leave_details

	details = get_leave_details(employee.name, getdate(nowdate()))
	allocation = details.get("leave_allocation") or {}
	items = [
		{
			"label": leave_type,
			"meta": _("{0} of {1} left").format(
				_fmt(row.get("remaining_leaves")), _fmt(row.get("total_leaves"))
			),
			"route": None,
			"tone": "danger" if (row.get("remaining_leaves") or 0) <= 0 else "",
		}
		for leave_type, row in sorted(allocation.items())
	]
	if not items:
		return {"reply": _("No leave is allocated to you yet."), "items": []}

	total = sum(row.get("remaining_leaves") or 0 for row in allocation.values())
	reply = _("{0} leave day(s) left across {1} type(s).").format(_fmt(total), len(items))
	return {"reply": reply, "items": items}


# --- who is out -------------------------------------------------------------------------------------


def who_is_out_answer(message: str = "") -> dict[str, Any]:
	if not hr_installed():
		return _not_set_up()
	if not current_employee():
		return _no_employee()
	if not frappe.has_permission("Leave Application", "read"):
		return {"reply": _("You don't have access to leave applications."), "items": []}

	today = getdate(nowdate())
	this_week = bool(re.search(r"\bweek\b", message or "", re.I))
	start = today - timedelta(days=today.weekday()) if this_week else today
	end = start + timedelta(days=6) if this_week else today

	try:
		rows = frappe.get_list(
			"Leave Application",
			filters={
				"status": "Approved",
				"docstatus": 1,
				"from_date": ["<=", end],
				"to_date": [">=", start],
			},
			fields=["name", "employee", "employee_name", "leave_type", "from_date", "to_date"],
			order_by="from_date asc",
			limit_page_length=MAX_ITEMS,
		)
	except frappe.PermissionError:
		return {"reply": _("You don't have access to leave applications."), "items": []}

	if not rows:
		reply = _("No one is out this week.") if this_week else _("No one is out today.")
		return {"reply": reply, "items": []}

	def _span(row) -> str:
		if row.to_date == row.from_date:
			return formatdate(row.from_date)
		return f"{formatdate(row.from_date)} – {formatdate(row.to_date)}"

	items = [
		{
			"label": row.employee_name or row.employee,
			"meta": f"{row.leave_type} · {_span(row)}",
			"route": ["Form", "Leave Application", row.name],
			"tone": "",
		}
		for row in rows
	]
	reply = _("{0} out this week.").format(len(rows)) if this_week else _("{0} out today.").format(len(rows))
	return {"reply": reply, "items": items}


# --- upcoming holidays -------------------------------------------------------------------------------


def holidays_answer() -> dict[str, Any]:
	if not hr_installed():
		return _not_set_up()
	employee = current_employee()
	if not employee:
		return _no_employee()

	from hrms.hr.utils import get_holidays_for_employee

	today = getdate(nowdate())
	holidays = get_holidays_for_employee(
		employee.name,
		today,
		today + timedelta(days=HOLIDAY_WINDOW_DAYS),
		raise_exception=False,
		only_non_weekly=True,
	)
	holidays = sorted(holidays, key=lambda h: h.get("holiday_date"))[:MAX_ITEMS]
	if not holidays:
		return {"reply": _("No upcoming holidays found."), "items": []}

	items = [
		{
			"label": h.get("description") or _("Holiday"),
			"meta": formatdate(h.get("holiday_date")),
			"route": None,
			"tone": "",
		}
		for h in holidays
	]
	reply = _("Next: {0} on {1}.").format(items[0]["label"], items[0]["meta"])
	return {"reply": reply, "items": items}


# --- my payslip --------------------------------------------------------------------------------------


def payslip_answer() -> dict[str, Any]:
	"""Status, period and net pay of the signed-in person's own latest payslip. `employee` is never taken
	as an argument: there is no way to reach anyone else's pay through this function."""
	if not hr_installed():
		return _not_set_up()
	employee = current_employee()
	if not employee:
		return _no_employee()
	if not frappe.has_permission("Salary Slip", "read"):
		return {"reply": _("You don't have access to payslips."), "items": []}

	try:
		rows = frappe.get_list(
			"Salary Slip",
			filters={"employee": employee.name, "docstatus": ["!=", 2]},
			fields=["name", "status", "start_date", "end_date", "net_pay", "currency"],
			order_by="end_date desc",
			limit_page_length=1,
		)
	except frappe.PermissionError:
		return {"reply": _("You don't have access to payslips."), "items": []}

	if not rows:
		return {"reply": _("No payslips yet."), "items": []}

	slip = rows[0]
	period = f"{formatdate(slip.start_date)} – {formatdate(slip.end_date)}"
	amount = frappe.utils.fmt_money(slip.net_pay, currency=slip.currency)
	reply = _("Your latest payslip ({0}): {1}, net pay {2}.").format(period, slip.status, amount)
	items = [
		{
			"label": _("Payslip {0}").format(period),
			"meta": f"{slip.status} · {amount}",
			"route": ["Form", "Salary Slip", slip.name],
			"tone": "",
		}
	]
	return {"reply": reply, "items": items}


# --- my attendance -----------------------------------------------------------------------------------


def attendance_answer() -> dict[str, Any]:
	if not hr_installed():
		return _not_set_up()
	employee = current_employee()
	if not employee:
		return _no_employee()
	if not frappe.has_permission("Attendance", "read"):
		return {"reply": _("You don't have access to attendance."), "items": []}

	today = getdate(nowdate())
	month_start = get_first_day(today)
	try:
		rows = frappe.get_list(
			"Attendance",
			filters={
				"employee": employee.name,
				"attendance_date": ["between", [month_start, today]],
				"docstatus": 1,
			},
			fields=["status"],
			limit_page_length=200,
		)
	except frappe.PermissionError:
		return {"reply": _("You don't have access to attendance."), "items": []}

	if not rows:
		return {"reply": _("No attendance marked yet this month."), "items": []}

	counts: dict[str, int] = {}
	for row in rows:
		counts[row.status] = counts.get(row.status, 0) + 1
	items = [
		{"label": status, "meta": str(count), "route": None, "tone": ""}
		for status, count in sorted(counts.items())
	]
	present = counts.get("Present", 0) + counts.get("Work From Home", 0)
	reply = _("{0} present of {1} marked day(s) this month.").format(present, len(rows))
	return {"reply": reply, "items": items}


# --- pending my approval -----------------------------------------------------------------------------


def pending_approval_answer() -> dict[str, Any]:
	"""Leave applications and expense claims waiting on the signed-in person, for whoever is set as an
	approver on them. Only the name, type and dates are shown, never anyone else's reason text."""
	if not hr_installed():
		return _not_set_up()
	employee = current_employee()
	if not employee:
		return _no_employee()

	from hrms.api import get_expense_claims, get_leave_applications

	approver = frappe.session.user
	leaves = get_leave_applications(
		employee.name, approver_id=approver, for_approval=True, limit=PENDING_LIMIT
	)
	claims = get_expense_claims(employee.name, approver_id=approver, for_approval=True, limit=PENDING_LIMIT)

	items = [
		{
			"label": leave.get("employee_name") or leave.get("employee"),
			"meta": f"{leave.get('leave_type')} · {formatdate(leave.get('from_date'))}"
			f"–{formatdate(leave.get('to_date'))}",
			"route": ["Form", "Leave Application", leave.get("name")],
			"tone": "",
		}
		for leave in leaves
	]
	items += [
		{
			"label": claim.get("employee_name") or claim.get("employee"),
			"meta": frappe.utils.fmt_money(claim.get("total_claimed_amount"), currency=claim.get("currency")),
			"route": ["Form", "Expense Claim", claim.get("name")],
			"tone": "",
		}
		for claim in claims
	]
	items = items[:MAX_ITEMS]

	if not leaves and not claims:
		return {"reply": _("Nothing waiting on your approval."), "items": []}

	reply = _("{0} leave application(s) and {1} expense claim(s) waiting on you.").format(
		len(leaves), len(claims)
	)
	return {"reply": reply, "items": items}


# --- request leave (the recipe's supporting lookups) --------------------------------------------------


def leave_approver_for(employee: str) -> str | None:
	"""Hubble's own approver lookup (the employee's leave approver, or their department's): never
	re-derived here, only called."""
	try:
		from hrms.hr.doctype.leave_application.leave_application import get_employee_leave_approver

		return get_employee_leave_approver(employee)
	except Exception:
		return None
