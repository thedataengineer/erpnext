# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Recipes: small, friendly forms that replace pages of fields.

A recipe lists the few things a person actually says ("2.5 hours on the website redesign for Acme,
yesterday") and knows how to turn them into a real DocType. The language model only fills these
few fields in. Everything else (defaults, name matching, validation) is done by the engine.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

import frappe
from frappe.query_builder.functions import Sum
from frappe.utils import escape_html, getdate, nowdate

from erpnext.assistant.records import split_ref


@dataclass(frozen=True)
class Field:
	name: str
	label: str
	kind: str = "text"  # text | number (hours) | money | date | link | choice
	required: bool = False
	hint: str = ""  # tells the language model what belongs in this field
	link_doctype: str | None = None
	link_label: str | None = None  # the column people know the record by (defaults to its name)
	link_filters: dict[str, Any] | None = None  # only offer records that match
	narrow_by: tuple[str, str] | None = None  # (other field, link column): prefer records of that other link
	only_hint: bool = False  # helps to find other fields; never blocks and is not saved itself
	grounded: bool = False  # keep the model's value only if the user's own words contain it
	link_doctypes: tuple[str, ...] = ()  # a link that may point at any of several kinds of record
	ask: str = ""  # the question to ask when this is missing (defaults to "What's the <label>?")
	context: bool = False  # default to the record the person is looking at, when it is one of link_doctypes
	pattern: str = (
		""  # a regex that finds this value in the sentence; code beats the model, and no match drops it
	)
	choices: tuple[str, ...] = ()
	prefer: str = "past"  # dates: which way a bare weekday points, "past" or "future"


@dataclass(frozen=True)
class Recipe:
	key: str
	label: str
	what: str  # "a time entry": used in the prompt to the model
	doctype: str
	fields: tuple[Field, ...]
	build: Callable[[dict[str, Any]], dict[str, Any]]
	done: str  # sentence shown after saving; {field} placeholders are filled with display values
	defaults: Callable[[date], dict[str, Any]] = lambda today: {}
	any_of: tuple[str, ...] = ()  # at least one of these must be given, though none is required on its own
	subject_fields: tuple[str, ...] = ()  # the first of these that has a value names the record in {subject}
	short: str = ""  # what to call one in a sentence ("time entry"); `what` is written for the model

	@property
	def noun(self) -> str:
		return self.short or self.what.removeprefix("an ").removeprefix("a ")

	@property
	def field_names(self) -> tuple[str, ...]:
		return tuple(field.name for field in self.fields)

	def field(self, name: str) -> Field:
		return next(field for field in self.fields if field.name == name)


# --- builders ------------------------------------------------------------------------------------
# Builders tolerate missing values (they return None for them) so a half-finished draft can still be
# opened in the full form. The engine drops the Nones before saving.


def _employee_for_user() -> str | None:
	return frappe.db.get_value("Employee", {"user_id": frappe.session.user, "status": "Active"}, "name")


def _next_start(day: str) -> str:
	"""Start the entry after whatever this person already logged that day (from 08:00), so entries
	do not overlap and trip the timesheet overlap check."""
	start_of_day = datetime.combine(getdate(day), time(8, 0))
	Timesheet = frappe.qb.DocType("Timesheet")
	Detail = frappe.qb.DocType("Timesheet Detail")
	logged = (
		frappe.qb.from_(Detail)
		.join(Timesheet)
		.on(Detail.parent == Timesheet.name)
		.select(Sum(Detail.hours))
		.where(
			(Timesheet.owner == frappe.session.user)
			& (Timesheet.docstatus < 2)
			& (Detail.from_time >= start_of_day.replace(hour=0))
			& (Detail.from_time < start_of_day.replace(hour=0) + timedelta(days=1))
		)
	).run()[0][0]
	return (start_of_day + timedelta(hours=float(logged or 0))).strftime("%Y-%m-%d %H:%M:%S")


def _build_log_time(v: dict[str, Any]) -> dict[str, Any]:
	row = {
		"from_time": _next_start(v.get("date") or nowdate()),
		"hours": v.get("hours"),
		"project": v.get("project"),
		"activity_type": v.get("activity"),
		"description": v.get("description"),
	}
	return {
		"doctype": "Timesheet",
		"parent_project": v.get("project"),
		"employee": _employee_for_user(),
		"time_logs": [row],
	}


def _build_task(v: dict[str, Any]) -> dict[str, Any]:
	return {
		"doctype": "Task",
		"subject": v.get("subject"),
		"project": v.get("project"),
		"exp_end_date": v.get("due_date"),
		"priority": v.get("priority"),
		"description": v.get("description"),
		"_assign": frappe.as_json([v["assigned_to"]]) if v.get("assigned_to") else None,
	}


def _build_expense_claim(v: dict[str, Any]) -> dict[str, Any]:
	return {
		"doctype": "Expense Claim",
		"employee": v.get("employee"),
		"expenses": [
			{
				"expense_date": v.get("expense_date"),
				"expense_type": v.get("expense_type"),
				"amount": v.get("amount"),
				"description": v.get("description"),
			}
		],
	}


def _build_material_request(v: dict[str, Any]) -> dict[str, Any]:
	return {
		"doctype": "Material Request",
		"material_request_type": v.get("material_request_type"),
		"schedule_date": v.get("schedule_date"),
		"items": [
			{
				"item_code": v.get("item_code"),
				"qty": v.get("qty"),
				"schedule_date": v.get("schedule_date"),
				"warehouse": v.get("warehouse"),
			}
		],
	}


def _build_timesheet_detail(v: dict[str, Any]) -> dict[str, Any]:
	start = _next_start(v.get("date") or nowdate())
	return {
		"doctype": "Timesheet",
		"parent_project": v.get("project"),
		"employee": _employee_for_user(),
		"time_logs": [
			{
				"from_time": start,
				"hours": v.get("hours"),
				"project": v.get("project"),
				"task": v.get("task"),
				"activity_type": v.get("activity_type"),
			}
		],
	}


def _build_project(v: dict[str, Any]) -> dict[str, Any]:
	return {
		"doctype": "Project",
		"project_name": v.get("project_name"),
		"customer": v.get("customer"),
		"expected_start_date": v.get("start_date"),
		"expected_end_date": v.get("end_date"),
		"notes": v.get("notes"),
	}


def _build_customer(v: dict[str, Any]) -> dict[str, Any]:
	return {
		"doctype": "Customer",
		"customer_name": v.get("customer_name"),
		"customer_type": v.get("customer_type"),
	}


def _ref(value: str | None) -> tuple[str | None, str | None]:
	ref = split_ref(value or "")
	return ref if ref else (None, None)


def _build_lead(v: dict[str, Any]) -> dict[str, Any]:
	first, _sep, last = (v.get("person") or "").partition(" ")
	return {
		"doctype": "Lead",
		"first_name": first,
		"last_name": last.strip(),
		"company_name": v.get("company"),
		"email_id": v.get("email"),
		"mobile_no": v.get("phone"),
		"notes": [{"note": v["notes"]}] if v.get("notes") else None,
	}


def _build_note(v: dict[str, Any]) -> dict[str, Any]:
	doctype, name = _ref(v.get("about"))
	text = escape_html(v.get("note") or "")
	kind = v.get("kind")
	return {
		"doctype": "Comment",
		"comment_type": "Comment",
		"reference_doctype": doctype,
		"reference_name": name,
		"content": f"<b>{escape_html(kind)}</b>: {text}" if kind and kind != "Note" else text,
	}


def _build_opportunity(v: dict[str, Any]) -> dict[str, Any]:
	doctype, name = _ref(v.get("party"))
	return {
		"doctype": "Opportunity",
		"opportunity_from": doctype,
		"party_name": name,
		"title": v.get("title"),
		"opportunity_amount": v.get("amount"),
		"expected_closing": v.get("closing"),
		"notes": [{"note": v["notes"]}] if v.get("notes") else None,
	}


def _build_follow_up(v: dict[str, Any]) -> dict[str, Any]:
	doctype, name = _ref(v.get("about"))
	return {
		"doctype": "ToDo",
		"description": escape_html(v.get("what") or ""),
		"date": v.get("when"),
		"allocated_to": frappe.session.user,
		"reference_type": doctype,
		"reference_name": name,
		"priority": "Medium",
	}


# --- the recipes ---------------------------------------------------------------------------------

_CUSTOMER = {"link_doctype": "Customer", "link_label": "customer_name"}
_PROJECT = {"link_doctype": "Project", "link_label": "project_name"}

_ABOUT = ("Lead", "Opportunity", "Customer", "Prospect")
_ABOUT_HINT = "the lead, customer, prospect or opportunity it is about (a person's or company's name)"

RECIPES: dict[str, Recipe] = {
	recipe.key: recipe
	for recipe in (
		Recipe(
			key="create_lead",
			short="lead",
			label="New lead",
			what="a sales lead",
			doctype="Lead",
			fields=(
				Field(
					"person",
					"Name",
					hint="the person's full name, if given",
					ask="Who's the lead? A person's name or a company works.",
				),
				Field("company", "Company", hint="the company they are from, if given"),
				Field(
					"email",
					"Email",
					hint="their email address, only if written in the message",
					pattern=r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+",
				),
				Field(
					"phone",
					"Phone",
					hint="their phone number, only if written in the message",
					pattern=r"\+?\d[\d\s().-]{6,}\d",
				),
				Field("notes", "Notes", hint="what they want or how you met, if stated"),
			),
			any_of=("person", "company", "email"),
			subject_fields=("person", "company", "email"),
			build=_build_lead,
			done="Lead added: {subject}.",
		),
		Recipe(
			key="log_note",
			short="note",
			label="Log a call or note",
			what="a note about a call, meeting or conversation with a lead, customer or opportunity",
			doctype="Comment",
			fields=(
				Field(
					"about",
					"About",
					"link",
					required=True,
					hint=_ABOUT_HINT,
					link_doctypes=_ABOUT,
					context=True,
					ask="Who is this about?",
				),
				Field(
					"note",
					"Note",
					required=True,
					hint="what happened or was said, in the user's own words (keep it short)",
					ask="What happened?",
				),
				Field(
					"kind",
					"Type",
					"choice",
					choices=("Call", "Meeting", "Email", "Note"),
					hint="Call, Meeting, Email or Note: pick the one the user's words point to",
				),
			),
			defaults=lambda today: {"kind": "Note"},
			build=_build_note,
			done="Noted on {about}.",
		),
		Recipe(
			key="create_opportunity",
			short="opportunity",
			label="New opportunity",
			what="a sales opportunity (a potential deal)",
			doctype="Opportunity",
			fields=(
				Field(
					"party",
					"For",
					"link",
					required=True,
					hint="the lead, customer or prospect the deal is with (a person's or company's name)",
					link_doctypes=("Lead", "Customer", "Prospect"),
					context=True,
					ask="Which lead or customer is this for?",
				),
				Field("title", "Deal", hint="a short name for the deal (e.g. ERP audit), only if stated"),
				Field(
					"amount",
					"Value",
					"money",
					hint="the deal value as a number (20k is 20000), only if a price or budget is stated",
				),
				Field(
					"closing",
					"Closing",
					"date",
					prefer="future",
					hint="when it should close, the date words exactly as said; null if not said",
				),
				Field("notes", "Notes", hint="extra detail, only if stated"),
			),
			subject_fields=("title", "party"),
			build=_build_opportunity,
			done="Opportunity created: {subject}.",
		),
		Recipe(
			key="follow_up",
			short="follow-up",
			label="Follow up",
			what="a reminder to follow up with someone (contact them, chase, send something)",
			doctype="ToDo",
			fields=(
				Field(
					"what",
					"Follow up",
					required=True,
					hint="what to do, as a short action (e.g. Call about the proposal)",
					ask="What should the follow-up be?",
				),
				Field(
					"when",
					"When",
					"date",
					prefer="future",
					hint="the date words exactly as said (tuesday, next week, Oct 3); null if not said",
				),
				Field(
					"about",
					"About",
					"link",
					hint=_ABOUT_HINT + ", only if named",
					link_doctypes=_ABOUT,
					context=True,
				),
			),
			build=_build_follow_up,
			done="Follow-up set: {what}.",
		),
		Recipe(
			key="log_time",
			short="time entry",
			label="Log time",
			what="a time entry",
			doctype="Timesheet",
			fields=(
				Field(
					"client",
					"Client",
					"link",
					only_hint=True,
					hint="the customer or company name, if mentioned (e.g. Acme, Globex)",
					**_CUSTOMER,
				),
				Field(
					"project",
					"Project",
					"link",
					required=True,
					hint="the project or piece of work, if named (e.g. website redesign, Q4 audit). "
					"If the user gives only a company name, leave this null",
					link_filters={"status": "Open"},
					narrow_by=("client", "customer"),
					**_PROJECT,
				),
				Field(
					"hours",
					"Hours",
					"number",
					required=True,
					hint="number of hours (convert minutes to hours)",
				),
				Field(
					"date",
					"Date",
					"date",
					required=True,
					hint="the date words exactly as the user said them (yesterday, last friday, Sep 12); "
					"null if not said",
				),
				Field(
					"activity",
					"Activity",
					"link",
					hint="one of Planning, Research, Proposal Writing, Execution, Communication, "
					"only if the user names it. Otherwise null",
					link_doctype="Activity Type",
					grounded=True,
				),
				Field("description", "What you did", hint="what was done, in a few words, only if stated"),
			),
			build=_build_log_time,
			defaults=lambda today: {"date": today.isoformat()},
			done="Logged {hours} on {project} ({date}).",
		),
		Recipe(
			key="create_task",
			short="task",
			label="New task",
			what="a task",
			doctype="Task",
			fields=(
				Field(
					"subject",
					"Task",
					required=True,
					hint="what needs doing, as a short action (e.g. Send the SOW to Globex)",
				),
				Field(
					"project",
					"Project",
					"link",
					hint="the project it belongs to, only if named",
					link_filters={"status": "Open"},
					**_PROJECT,
				),
				Field(
					"assigned_to",
					"Assigned to",
					"link",
					required=True,
					link_doctype="User",
					link_label="full_name",
				),
				Field(
					"due_date",
					"Due",
					"date",
					prefer="future",
					hint="the due date words exactly as the user said them (friday, next monday, Oct 3); "
					"null if not said",
				),
				Field(
					"priority",
					"Priority",
					"choice",
					choices=("Low", "Medium", "High", "Urgent"),
					hint="Low, Medium, High or Urgent, only if the user says how important or urgent it is",
				),
				Field("description", "Notes", hint="extra detail, only if stated"),
			),
			build=_build_task,
			defaults=lambda today: {
				"assigned_to": frappe.session.user,
				"due_date": (today + timedelta(days=3)).isoformat(),
				"priority": "Medium",
			},
			done="Task added: {subject}.",
		),
		Recipe(
			key="create_expense_claim",
			short="expense claim",
			label="New expense claim",
			what="an expense claim",
			doctype="Expense Claim",
			fields=(
				Field(
					"employee",
					"Employee",
					"link",
					required=True,
					link_doctype="Employee",
					link_label="employee_name",
					ask="Which employee is this claim for?",
				),
				Field("expense_date", "Date", "date", required=True),
				Field(
					"expense_type",
					"Expense type",
					"link",
					required=True,
					link_doctype="Expense Claim Type",
					ask="What type of expense was this?",
				),
				Field("amount", "Amount", "money", required=True),
				Field("description", "Description", hint="what the expense was for, if stated"),
			),
			build=_build_expense_claim,
			defaults=lambda today: {
				"employee": _employee_for_user(),
				"expense_date": today.isoformat(),
			},
			done="Expense claim added: {expense_type} for {amount} on {expense_date}.",
		),
		Recipe(
			key="create_material_request",
			short="material request",
			label="New material request",
			what="a material request",
			doctype="Material Request",
			fields=(
				Field(
					"item_code",
					"Item",
					"link",
					required=True,
					link_doctype="Item",
					link_label="item_name",
					ask="What item is needed?",
				),
				Field("qty", "Quantity", "number", required=True),
				Field("schedule_date", "Needed by", "date", required=True, prefer="future"),
				Field(
					"material_request_type",
					"Type",
					"choice",
					required=True,
					choices=("Purchase", "Material Transfer", "Material Issue", "Manufacture"),
				),
				Field(
					"warehouse",
					"Warehouse",
					"link",
					link_doctype="Warehouse",
					link_label="warehouse_name",
				),
			),
			build=_build_material_request,
			defaults=lambda today: {
				"schedule_date": (today + timedelta(days=7)).isoformat(),
				"material_request_type": "Purchase",
			},
			done="Material request added for {qty} × {item_code}, needed {schedule_date}.",
		),
		Recipe(
			key="create_timesheet_detail",
			short="time entry",
			label="New timesheet entry",
			what="a timesheet entry for a task or project",
			doctype="Timesheet",
			fields=(
				Field(
					"task",
					"Task",
					"link",
					link_doctype="Task",
					link_label="subject",
				),
				Field(
					"project",
					"Project",
					"link",
					link_filters={"status": "Open"},
					**_PROJECT,
				),
				Field("hours", "Hours", "number", required=True),
				Field("date", "Date", "date", required=True),
				Field(
					"activity_type",
					"Activity",
					"link",
					link_doctype="Activity Type",
				),
			),
			any_of=("task", "project"),
			build=_build_timesheet_detail,
			defaults=lambda today: {"date": today.isoformat(), "activity_type": "Execution"},
			done="Logged {hours} on {subject} ({date}).",
			subject_fields=("task", "project"),
		),
		Recipe(
			key="create_project",
			short="project",
			label="New project",
			what="a project",
			doctype="Project",
			fields=(
				Field(
					"project_name",
					"Project",
					required=True,
					hint="the name of the project (e.g. ERP audit, Website redesign)",
				),
				Field(
					"customer",
					"Client",
					"link",
					hint="the client the project is for, only if mentioned",
					**_CUSTOMER,
				),
				Field(
					"start_date",
					"Starts",
					"date",
					prefer="future",
					hint="the start date words exactly as said (monday, Oct 1); null if not said",
				),
				Field(
					"end_date",
					"Ends",
					"date",
					prefer="future",
					hint="the end date words exactly as said; null if not said",
				),
				Field("notes", "Notes", hint="scope or extra detail, only if stated"),
			),
			build=_build_project,
			done="Project created: {project_name}.",
		),
		Recipe(
			key="create_customer",
			short="client",
			label="New client",
			what="a customer",
			doctype="Customer",
			fields=(
				Field(
					"customer_name",
					"Client",
					required=True,
					hint="the customer's name (a company or a person)",
				),
				Field(
					"customer_type",
					"Type",
					"choice",
					required=True,
					choices=("Company", "Individual"),
					hint="Company or Individual; Company unless the name is clearly a person",
				),
			),
			build=_build_customer,
			defaults=lambda today: {"customer_type": "Company"},
			done="Client added: {customer_name}.",
		),
	)
}

# Read-only questions the assistant can answer, alongside the recipes above.
QUERIES = {
	"my_day": "what is on my plate today, my tasks, what to do next",
	"hours_summary": "how many hours I have logged, my timesheet totals",
	"pipeline": "my sales pipeline, open deals or opportunities, what is in the funnel",
	"emails": "recent emails I received, what someone wrote or said, whether someone replied",
	"connect_email": "connect or set up my email inbox so it syncs, sync my mail",
}

# What to offer when a name does not match anything: link doctype -> (recipe to start, its name field, noun)
CREATE_FOR_LINK = {
	"Project": ("create_project", "project_name", "project"),
	"Customer": ("create_customer", "customer_name", "client"),
	"Lead": ("create_lead", "person", "lead"),
}
