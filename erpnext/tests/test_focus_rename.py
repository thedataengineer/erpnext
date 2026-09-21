# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""The people-facing names say "Focus", not "ADHD" (files only: none of this needs a site)."""

import json
import unittest
from pathlib import Path

import erpnext

APP = Path(erpnext.__file__).parent
# what is kept on purpose: internal names that no person reads (see the Naming section of docs/adhd_mode_features.md)
KEPT = {"System Settings-adhd_telemetry_enabled", "Installation Note Item-adhd_confirmed_installed"}


def _standard_docs():
	for folder in ("setup", "focus_usage_log"):
		for path in (APP / folder).rglob("*.json"):
			yield path, json.loads(path.read_text())


class TestFocusNames(unittest.TestCase):
	def test_no_standard_doc_carries_the_old_name(self):
		for path, doc in _standard_docs():
			if not isinstance(doc, dict) or doc.get("doctype") not in (
				"Page",
				"Workspace",
				"Report",
				"DocType",
			):
				continue
			for key in ("name", "title", "label", "module", "page_name", "report_name"):
				value = str(doc.get(key) or "")
				self.assertNotIn("ADHD", value, f"{path.name}: {key} is {value!r}")
				self.assertNotIn("adhd", value.lower(), f"{path.name}: {key} is {value!r}")

	def test_the_pages_are_named_after_their_folders(self):
		for slug in ("focus-inbox", "focus-task-board"):
			folder = APP / "setup" / "page" / slug.replace("-", "_")
			doc = json.loads((folder / f"{folder.name}.json").read_text())
			self.assertEqual((doc["name"], doc["page_name"]), (slug, slug))
			self.assertTrue((folder / f"{folder.name}.js").exists())

	def test_the_usage_log_module_is_declared_and_the_old_one_is_gone(self):
		modules = (APP / "modules.txt").read_text().splitlines()
		self.assertIn("Focus Usage Log", modules)
		self.assertNotIn("ADHD Usage Log", modules)
		self.assertTrue(
			(APP / "focus_usage_log" / "doctype" / "focus_usage_log" / "focus_usage_log.py").exists()
		)
		self.assertFalse((APP / "adhd_usage_log").exists())

	def test_fixtures_point_at_the_new_module(self):
		rows = json.loads((APP / "fixtures" / "custom_field.json").read_text())
		for row in rows:
			self.assertNotIn("ADHD", row.get("label") or "", row["name"])
			self.assertNotIn("ADHD", row.get("description") or "", row["name"])
			if row["name"] == "System Settings-adhd_telemetry_enabled":
				self.assertEqual(row["module"], "Focus Usage Log")

	def test_the_rename_patch_runs_before_the_model_sync(self):
		lines = (APP / "patches.txt").read_text().splitlines()
		patch = "erpnext.patches.v17_0.rename_adhd_to_focus"
		self.assertIn(patch, lines)
		self.assertLess(lines.index(patch), lines.index("[post_model_sync]"))

	def test_the_workspace_links_the_renamed_pages(self):
		doc = json.loads((APP / "setup" / "workspace" / "focus_home" / "focus_home.json").read_text())
		self.assertEqual(doc["name"], "Focus Home")
		self.assertEqual({row["link_to"] for row in doc["shortcuts"]}, {"focus-inbox", "focus-task-board"})


class TestWhitelistedMethodsAreAnnotated(unittest.TestCase):
	"""hooks.py sets require_type_annotated_api_methods, so a whitelisted function with an unannotated argument
	answers every real request with HTTP 417. Calling it from a test skips that check, which is how four of
	them (the Smart Inbox, the payment digest and the telemetry call) shipped broken."""

	def test_every_whitelisted_function_annotates_all_its_arguments(self):
		import ast

		hooks = (APP / "hooks.py").read_text()
		self.assertIn("require_type_annotated_api_methods = True", hooks)

		missing = []
		for path in APP.rglob("*.py"):
			if "tests" in path.parts or path.name.startswith("test_"):
				continue
			for node in ast.walk(ast.parse(path.read_text())):
				if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
					continue
				if not any("whitelist" in ast.unparse(d) for d in node.decorator_list):
					continue
				args = node.args
				for index, arg in enumerate([*args.posonlyargs, *args.args, *args.kwonlyargs]):
					if not arg.annotation and not (index == 0 and arg.arg in ("self", "cls")):
						missing.append(f"{path.relative_to(APP)}:{node.lineno} {node.name}({arg.arg})")
		self.assertEqual(missing, [])
