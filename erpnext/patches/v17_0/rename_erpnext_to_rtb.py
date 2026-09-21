# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Move a site from the "ERPNext" names to "RTB".

- The app name the site shows (browser tabs, emails, the login page) is site data, not code, so it is set here
  when it still holds a default: a name somebody typed in is left alone.
- The navigation records that were renamed in the app (the app icon, the settings icon, workspace and sidebar,
  the integrations sidebar) are named by their label. The sync creates the renamed ones, so the old ones are
  removed here, together with their child rows. They are deleted directly, not with `frappe.delete_doc`:
  deleting a standard record in developer mode also looks for folders on disk and removes them.
"""

import frappe

OLD, NEW = "ERPNext", "RTB"
# names the site had before anyone chose one
DEFAULT_APP_NAMES = (None, "", "Frappe", OLD)
STALE = (
	("Desktop Icon", "ERPNext"),
	("Desktop Icon", "ERPNext Settings"),
	("Workspace Sidebar", "ERPNext Settings"),
	("Workspace", "ERPNext Settings"),
	("Sidebar", "ERPNext Integrations"),
)


def execute():
	rename_app_names()
	remove_stale_navigation()


def rename_app_names():
	for doctype in ("System Settings", "Website Settings"):
		if frappe.db.get_single_value(doctype, "app_name") in DEFAULT_APP_NAMES:
			frappe.db.set_single_value(doctype, "app_name", NEW)


def remove_stale_navigation():
	# the app icon is the parent of the module icons: they move to the new one before the old one goes
	if frappe.db.exists("Desktop Icon", NEW):
		frappe.db.set_value("Desktop Icon", {"parent_icon": OLD}, "parent_icon", NEW, update_modified=False)

	for doctype, name in STALE:
		if not frappe.db.exists(doctype, name):
			continue
		for table in frappe.get_meta(doctype).get_table_fields():
			frappe.db.delete(table.options, {"parent": name, "parenttype": doctype})
		frappe.db.delete(doctype, {"name": name})
