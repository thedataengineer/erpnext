"""Anonymous Focus interaction signals."""

import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, today

ALLOWED_EVENT_TYPES = {"tooltip_dwell", "form_save", "wizard_skip", "command_intent"}

# Frappe stamps every document with the user who created it. These signals are meant to be anonymous, so
# that stamp is replaced with this neutral user as soon as the row is saved.
ANONYMOUS_USER = "Guest"
MAX_TEXT_LENGTH = 140  # the length of a Data field


def _intent(value):
	"""An action key like 'create_lead'. Anything else (free text, a serialised object) is dropped, so a
	client can never put what someone typed into the log."""
	value = _text(value)
	return value if value and re.fullmatch(r"[a-z0-9_.:-]{1,60}", value) else None


def _text(value):
	"""A short plain string, or None. Anyone signed in can call log_focus_event, so bound what it stores."""
	if value is None or value == "":
		return None
	return str(value)[:MAX_TEXT_LENGTH]


class FocusUsageLog(Document):
	def before_insert(self):
		if self.event_type not in ALLOWED_EVENT_TYPES:
			frappe.throw(_("Unknown Focus event type."), frappe.ValidationError)


@frappe.whitelist()
def log_focus_event(
	event_type,
	doctype_name=None,
	field_name=None,
	duration_ms=None,
	step_index=None,
	intent=None,
):
	if not frappe.db.get_single_value("System Settings", "adhd_telemetry_enabled"):
		return

	log = frappe.get_doc(
		{
			"doctype": "Focus Usage Log",
			"event_type": _text(event_type),
			"doctype_name": _text(doctype_name),
			"field_name": _text(field_name),
			"duration_ms": max(cint(duration_ms), 0),
			"step_index": max(cint(step_index), 0),
			"intent": _intent(intent),
			"session_date": today(),
		}
	).insert(ignore_permissions=True)
	frappe.db.set_value(
		"Focus Usage Log",
		log.name,
		{"owner": ANONYMOUS_USER, "modified_by": ANONYMOUS_USER},
		update_modified=False,
	)
