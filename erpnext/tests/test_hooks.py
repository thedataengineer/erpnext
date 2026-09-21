# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# hooks.py is the one file the whole app hangs off: every scheduled job, document event, permission rule
# and boot hook is registered there. It was once overwritten by a feature commit and nothing failed, so
# this checks that the essentials are still present. Plain unittest on purpose: it needs no site and
# does not import erpnext.tests.utils (which bootstraps and commits test data).

import unittest

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
