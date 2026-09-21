import frappe
from frappe import _


def execute(filters=None):
	if "System Manager" not in frappe.get_roles():
		frappe.throw(_("Not permitted."), frappe.PermissionError)

	columns = [
		{"fieldname": "event_type", "label": _("Event Type"), "fieldtype": "Data", "width": 140},
		{"fieldname": "doctype_name", "label": _("DocType"), "fieldtype": "Data", "width": 160},
		{"fieldname": "field_name", "label": _("Field"), "fieldtype": "Data", "width": 140},
		{"fieldname": "count", "label": _("Count"), "fieldtype": "Int", "width": 80},
		{
			"fieldname": "avg_duration_ms",
			"label": _("Average Duration (ms)"),
			"fieldtype": "Int",
			"width": 170,
		},
		{"fieldname": "session_date", "label": _("Session Date"), "fieldtype": "Date", "width": 110},
	]
	data = frappe.db.sql(
		"""
		SELECT event_type, doctype_name, field_name, COUNT(*) AS count,
			AVG(duration_ms) AS avg_duration_ms, session_date
		FROM `tabFocus Usage Log`
		GROUP BY event_type, doctype_name, field_name, session_date
		ORDER BY session_date DESC, count DESC
		""",
		as_dict=True,
	)
	return columns, data
