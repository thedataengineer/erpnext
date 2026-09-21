# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""The people-facing name is "RTB", not "ERPNext". The Python package, the module paths and the DocType and
module names that other code imports stay `erpnext`: they are technical names no page shows (files only, no site)."""

import json
import re
import unittest
from pathlib import Path

import erpnext

APP = Path(erpnext.__file__).parent
ROOT = APP.parent
TAGLINE = "Run the business, not your ERP"
# the only nav record that keeps the old name: the module whose folder and imports are named after it
KEPT_MODULE = "ERPNext Integrations"


def _hooks_value(name):
	match = re.search(
		rf'^{name}\s*=\s*(?:"{{3}}|")(.+?)(?:"{{3}}|")\s*$', (APP / "hooks.py").read_text(), re.MULTILINE
	)
	return match.group(1) if match else None


class TestBrandName(unittest.TestCase):
	def test_the_app_is_called_rtb(self):
		self.assertEqual(_hooks_value("app_title"), "RTB")
		self.assertEqual(_hooks_value("app_description"), TAGLINE)
		# the technical name is unchanged: every import and other app depends on it
		self.assertEqual(_hooks_value("app_name"), "erpnext")

	def test_every_logo_hooks_and_the_app_point_at_exists(self):
		text = (APP / "hooks.py").read_text() + (ROOT / "banking" / "index.html").read_text()
		text += (APP / "desktop_icon" / "rtb.json").read_text()
		for path in re.findall(r"assets/erpnext/images/([\w.-]+)", text):
			self.assertTrue((APP / "public" / "images" / path).exists(), path)
			self.assertNotIn("erpnext-", path)

	def test_no_navigation_record_carries_the_old_name(self):
		folders = (
			"desktop_icon",
			"dock",
			"workspace_sidebar",
			"setup/workspace",
			"erpnext_integrations/sidebar",
		)
		for folder in folders:
			for path in (APP / folder).rglob("*.json"):
				doc = json.loads(path.read_text())
				for key in ("name", "label", "title", "link_to", "parent_icon"):
					value = str(doc.get(key) or "")
					self.assertNotIn("ERPNext", value, f"{path.name}: {key} is {value!r}")

	def test_the_integrations_module_keeps_its_name_only_as_a_module(self):
		doc = json.loads(
			(APP / "erpnext_integrations/sidebar/rtb_integrations/rtb_integrations.json").read_text()
		)
		self.assertEqual(
			(doc["name"], doc["title"], doc["module"]), ("RTB Integrations", "RTB Integrations", KEPT_MODULE)
		)
		self.assertIn(KEPT_MODULE, (APP / "modules.txt").read_text().splitlines())

	def test_no_translatable_string_says_erpnext(self):
		"""`__("...")`, `_("...")` and template `_("...")` are what a person reads."""
		pattern = re.compile(r"""\b_{1,2}\(\s*(["'`])(?:(?!\1).)*ERPNext""", re.DOTALL)
		found = []
		for suffix in ("*.js", "*.py", "*.html"):
			for path in APP.rglob(suffix):
				if "tests" in path.parts or path.name.startswith("test_") or "patches" in path.parts:
					continue
				if pattern.search(path.read_text(errors="ignore")):
					found.append(str(path.relative_to(APP)))
		self.assertEqual(found, [])

	def test_the_rename_patch_runs_after_the_model_sync(self):
		lines = (APP / "patches.txt").read_text().splitlines()
		patch = "erpnext.patches.v17_0.rename_erpnext_to_rtb"
		self.assertIn(patch, lines)
		self.assertGreater(lines.index(patch), lines.index("[post_model_sync]"))
