# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# hooks.py is the one file the whole app hangs off: every scheduled job, document event, permission rule
# and boot hook is registered there. It was once overwritten by a feature commit and nothing failed, so
# this checks that the essentials are still present. Plain unittest on purpose: it needs no site and
# does not import erpnext.tests.utils (which bootstraps and commits test data).

import json
import unittest

import frappe

from erpnext import hooks

ESSENTIAL_HOOKS = (
	"app_name",
	"app_title",
	"app_include_css",
	"after_install",
	"boot_session",
	"doc_events",
	"doctype_js",
	"has_permission",
	"permission_query_conditions",
	"scheduler_events",
	"setup_wizard_stages",
)


class TestHooks(unittest.TestCase):
	def test_essential_hooks_are_defined(self):
		missing = [name for name in ESSENTIAL_HOOKS if not getattr(hooks, name, None)]
		self.assertEqual(missing, [], f"hooks.py no longer defines: {', '.join(missing)}")

	def test_app_identity(self):
		self.assertEqual(hooks.app_name, "erpnext")

	def test_the_client_bundle_is_included(self):
		scripts = hooks.app_include_js
		scripts = [scripts] if isinstance(scripts, str) else scripts
		self.assertIn("erpnext.bundle.js", scripts)

	def test_scheduler_has_jobs(self):
		events = hooks.scheduler_events
		self.assertTrue(
			any(events.get(kind) for kind in ("all", "hourly", "daily", "weekly", "monthly", "cron"))
		)


class TestFixtures(unittest.TestCase):
	"""bench migrate imports these files. One without a "doctype" key once crashed the migrate, and a name the
	hooks list but the file lacks would silently ship nothing, so check both without needing a site."""

	def _named_by_hooks(self):
		names = []
		for fixture in hooks.fixtures:
			for _field, operator, value in fixture.get("filters", []):
				names += value if operator == "in" else [value]
		return names

	def _rows(self):
		with open(frappe.get_app_path("erpnext", "fixtures", "custom_field.json")) as f:
			return {row["name"]: row for row in json.load(f)}

	def test_every_custom_field_the_hooks_name_is_in_the_fixture_file(self):
		rows = self._rows()
		missing = [name for name in self._named_by_hooks() if name not in rows]
		self.assertEqual(missing, [], f"named in hooks.fixtures but not in custom_field.json: {missing}")

	def test_every_fixture_row_can_be_imported(self):
		for name, row in self._rows().items():
			self.assertEqual(row.get("doctype"), "Custom Field", name)
			for key in ("dt", "fieldname", "fieldtype", "label"):
				self.assertTrue(row.get(key), f"{name} has no {key}")
			self.assertEqual(
				name, f"{row['dt']}-{row['fieldname']}", "a Custom Field is named <doctype>-<fieldname>"
			)

	def test_the_installed_checkbox_is_hidden_until_adhd_mode_shows_it(self):
		row = self._rows()["Installation Note Item-adhd_confirmed_installed"]
		self.assertEqual(row["dt"], "Installation Note Item")
		self.assertEqual(row["fieldtype"], "Check")
		self.assertEqual(row["hidden"], 1, "stock ERPNext must not show it")
		self.assertEqual(row["no_copy"], 1, "an amended note starts unconfirmed")
		self.assertEqual(row["print_hide"], 1)
