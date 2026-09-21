"""Anonymous ADHD interaction signals."""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, today

ALLOWED_EVENT_TYPES = {"tooltip_dwell", "form_save", "wizard_skip", "command_intent"}


class ADHDUsageLog(Document):
	def before_insert(self):
		if self.event_type not in ALLOWED_EVENT_TYPES:
			frappe.throw(_("Unknown ADHD event type."), frappe.ValidationError)


@frappe.whitelist()
def log_adhd_event(
	event_type,
	doctype_name=None,
	field_name=None,
	duration_ms=None,
	step_index=None,
	intent=None,
):
	if not frappe.db.get_single_value("System Settings", "adhd_telemetry_enabled"):
		return

	frappe.get_doc(
		{
			"doctype": "ADHD Usage Log",
			"event_type": event_type,
			"doctype_name": doctype_name,
			"field_name": field_name,
			"duration_ms": cint(duration_ms),
			"step_index": cint(step_index),
			"intent": intent,
			"session_date": today(),
		}
	).insert(ignore_permissions=True)
