# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Move a site from the "ADHD" names to the "Focus" ones.

Runs before the model sync, so the sync finds the renamed DocType and updates it instead of creating an empty
second one next to the old table:

- the "ADHD Usage Log" DocType becomes "Focus Usage Log", table and rows kept;
- the "ADHD Usage Log" module (its row is not renamed, Frappe only renames custom modules) is replaced by the
  "Focus Usage Log" one that migrate has just added, and everything that pointed at the old one is moved over;
- the old report and the two old pages are removed, the sync creates the renamed ones from the files.

The list of modules an app has is cached, and the model sync that follows walks that list: with the old one it
imports the folder that was just renamed and migrate stops. So the patch rebuilds it.

Rows are deleted directly, not with `frappe.delete_doc`: deleting a standard Module Def, Report or Page in
developer mode also looks for folders on disk and removes them, and these old folders are gone from the app.
"""

import frappe

OLD_MODULE, NEW_MODULE = "ADHD Usage Log", "Focus Usage Log"
OLD_DOCTYPE, NEW_DOCTYPE = "ADHD Usage Log", "Focus Usage Log"
OLD_REPORT = "ADHD Usage Summary"
OLD_PAGES = ("adhd-inbox", "adhd-task-board")
# the tables whose rows can point at the usage-log module
MODULE_LINKED = ("DocType", "Report", "Page", "Custom Field", "Property Setter")


def execute():
	move_module()
	rename_doctype()
	remove_old_report()
	remove_old_pages()
	refresh_module_map()


def move_module():
	if not frappe.db.exists("Module Def", OLD_MODULE):
		return

	# the new row is added by migrate ahead of the patches; make it if this runs some other way
	if not frappe.db.exists("Module Def", NEW_MODULE):
		old = frappe.db.get_value("Module Def", OLD_MODULE, ["app_name", "custom"], as_dict=True)
		frappe.get_doc(
			{
				"doctype": "Module Def",
				"module_name": NEW_MODULE,
				"app_name": old.app_name,
				"custom": old.custom,
			}
		).insert(ignore_permissions=True)

	for doctype in MODULE_LINKED:
		if frappe.db.has_column(doctype, "module"):
			frappe.db.set_value(doctype, {"module": OLD_MODULE}, "module", NEW_MODULE, update_modified=False)

	frappe.db.delete("Module Def", {"name": OLD_MODULE})


def rename_doctype():
	if frappe.db.exists("DocType", OLD_DOCTYPE) and not frappe.db.exists("DocType", NEW_DOCTYPE):
		frappe.rename_doc("DocType", OLD_DOCTYPE, NEW_DOCTYPE, force=True)


def remove_old_report():
	_remove("Report", [OLD_REPORT])


def remove_old_pages():
	_remove("Page", list(OLD_PAGES))


def _remove(doctype: str, names: list[str]):
	frappe.db.delete("Has Role", {"parenttype": doctype, "parent": ("in", names)})
	frappe.db.delete(doctype, {"name": ("in", names)})


def refresh_module_map():
	frappe.cache.delete_value("app_modules")
	frappe.setup_module_map()
