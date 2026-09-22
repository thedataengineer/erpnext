# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Every module on this site must be integrable at three levels, and this proves it for whatever is
installed: RTB (erpnext), Hubble (hrms), Learning (lms), Suite, Raven and Payments.

- **Code level:** every app's hooks load; every document-event handler an app hangs on another app's
  doctype resolves; every desk bundle an app includes is built; the desk boots for Administrator with
  every app on it; and RTB's own cross-app calls (the assistant's HR answers, the Focus inbox source)
  reach into Hubble.
- **Database level:** one schema; every doctype of every app has its table; every Link and Table field
  points at a doctype that exists (or at a declared optional module that is not installed); and every
  app links to doctypes it does not own.
- **Solution level:** one person is one User. Creating a User inside a transaction shows every installed
  app taking it up (Suite's role and settings, Learning's role, Raven's user), and an Employee for that
  User lets RTB's assistant answer an HR question and RTB's Focus inbox show what Hubble says waits on
  them, so the parts behave as one product.

Plain unittest, rolled back, no fixture bootstrap (importing erpnext.tests.utils commits test data into
whatever site it runs on). Background jobs run inline and mail is muted, so nothing an app's hook enqueues
can outlive the rollback or reach a real mailbox."""

import json
import os
import unittest
from collections import Counter
from datetime import date
from unittest.mock import patch

import frappe
from frappe.utils import get_bench_path, nowdate

INSTALLED = set(frappe.get_installed_apps())

# Link targets an installed app may legitimately name although the module that owns them is not installed:
# Hubble's payroll can deduct loan repayments when Frappe's Lending app is present.
OPTIONAL_TARGETS = {
	"Loan": "lending",
	"Loan Repayment": "lending",
	"Loan Product": "lending",
	"Loan Interest Accrual": "lending",
	"Loan Disbursement": "lending",
}


def _app_of_doctype() -> dict[str, str]:
	module_app = {m.name: m.app_name for m in frappe.get_all("Module Def", fields=["name", "app_name"])}
	return {d.name: module_app.get(d.module) for d in frappe.get_all("DocType", fields=["name", "module"])}


class StackTestCase(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.flags.mute_emails = True
		self.addCleanup(self._undo)
		# an app's hook may hand work to the worker (Suite mails about a shared folder); run it here instead,
		# inside this transaction, so it is rolled back with everything else. Not by delegating to the real
		# enqueue with now=True: that still asks Redis about de-duplicated jobs, and a test needs no worker.
		import frappe.utils.background_jobs as jobs

		def inline(method, *args, **kwargs):
			for option in (
				"queue",
				"timeout",
				"event",
				"is_async",
				"job_name",
				"now",
				"enqueue_after_commit",
				"on_success",
				"on_failure",
				"at_front",
				"job_id",
				"deduplicate",
			):
				kwargs.pop(option, None)
			return frappe.call(
				frappe.get_attr(method) if isinstance(method, str) else method, *args, **kwargs
			)

		for target in (patch.object(jobs, "enqueue", inline), patch.object(frappe, "enqueue", inline)):
			target.start()
			self.addCleanup(target.stop)
		self._email_queue = frappe.db.count("Email Queue")

	def _undo(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		self.assertEqual(frappe.db.count("Email Queue"), self._email_queue, "a test queued mail")


# --- code level ------------------------------------------------------------------------------------------


class TestCodeLevel(StackTestCase):
	def test_every_apps_hooks_load_and_every_document_hook_resolves(self):
		unresolved = []
		for app in INSTALLED:
			self.assertIsNotNone(frappe.get_hooks(app_name=app), app)
			for doctype, events in (frappe.get_hooks("doc_events", app_name=app) or {}).items():
				for handlers in events.values():
					for handler in handlers if isinstance(handlers, list) else [handlers]:
						try:
							frappe.get_attr(handler)
						except Exception as error:
							unresolved.append((app, doctype, handler, str(error)[:80]))
		self.assertEqual(unresolved, [])

	def test_every_desk_bundle_an_app_includes_is_built(self):
		assets_file = os.path.join(get_bench_path(), "sites", "assets", "assets.json")
		with open(assets_file) as f:
			built = json.load(f)
		missing = []
		for app in INSTALLED:
			for hook in ("app_include_js", "app_include_css"):
				for bundle in frappe.get_hooks(hook, app_name=app) or []:
					if bundle.endswith(".bundle.js") or bundle.endswith(".bundle.css"):
						if bundle not in built:
							missing.append((app, bundle))
		self.assertEqual(missing, [], "run bench build for these apps")

	def test_the_desk_boots_with_every_app_on_it(self):
		from frappe.boot import get_bootinfo

		boot = get_bootinfo()
		on_desk = {row.get("app_name") or row.get("name") for row in boot.get("app_data") or []}
		self.assertTrue(INSTALLED <= on_desk, f"missing from the desk: {INSTALLED - on_desk}")
		# the desk loads each app's script after the apps it builds on: Hubble's Focus aids register with
		# RTB's, so RTB must come first
		order = [b for b in frappe.get_hooks("app_include_js") if isinstance(b, str)]
		if "hrms" in INSTALLED:
			self.assertLess(order.index("erpnext.bundle.js"), order.index("hrms.bundle.js"))

	@unittest.skipUnless("hrms" in INSTALLED, "Hubble is not installed")
	def test_rtb_reaches_into_hubble_where_the_product_relies_on_it(self):
		from erpnext.assistant import hr, recipes, search

		# the assistant: Hubble's own leave functions answer the person's questions
		self.assertTrue(hr.hr_installed())
		self.assertIsNone(recipes.RECIPES["request_leave"].guard())
		self.assertIn("My leave balance", [do.label for do in search.catalogue()])
		# the Focus inbox: Hubble's source is wired through RTB's hook and importable
		sources = frappe.get_hooks("focus_urgent_items")
		self.assertIn("hrms.hr.focus.urgent_items", sources)
		for source in sources:
			self.assertTrue(callable(frappe.get_attr(source)), source)


# --- database level --------------------------------------------------------------------------------------


class TestDatabaseLevel(StackTestCase):
	def test_every_doctype_of_every_app_has_its_table_in_the_one_schema(self):
		self.assertTrue(frappe.conf.db_name)
		missing = [
			d.name
			for d in frappe.get_all("DocType", filters={"issingle": 0, "is_virtual": 0}, fields=["name"])
			if not frappe.db.table_exists(d.name)
		]
		self.assertEqual(missing, [])

	def test_every_link_points_at_a_doctype_that_exists_or_at_a_declared_optional_module(self):
		known = set(_app_of_doctype())
		fields = frappe.get_all(
			"DocField",
			filters={"fieldtype": ("in", ["Link", "Table", "Table MultiSelect"])},
			fields=["parent", "options"],
		)
		dangling = sorted({(f.parent, f.options) for f in fields if f.options and f.options not in known})
		unexplained = [pair for pair in dangling if pair[1] not in OPTIONAL_TARGETS]
		self.assertEqual(
			unexplained, [], "a link field points at a doctype no installed or optional app owns"
		)
		for _parent, target in dangling:
			self.assertNotIn(
				OPTIONAL_TARGETS[target], INSTALLED, f"{target} is missing although its app is installed"
			)

	def test_every_app_links_to_doctypes_it_does_not_own(self):
		app_of = _app_of_doctype()
		fields = frappe.get_all(
			"DocField",
			filters={"fieldtype": ("in", ["Link", "Table", "Table MultiSelect"])},
			fields=["parent", "options"],
		)
		cross = Counter()
		for f in fields:
			source, target = app_of.get(f.parent), app_of.get(f.options)
			if source and target and source != target:
				cross[(source, target)] += 1
		for app in INSTALLED - {"frappe"}:
			outgoing = sum(n for (source, _target), n in cross.items() if source == app)
			self.assertGreater(outgoing, 0, f"{app} links to no doctype of another app")
		if "hrms" in INSTALLED:
			# Hubble is built on RTB's Employee, Company, accounts and projects, not beside them
			self.assertGreater(cross[("hrms", "erpnext")], 100)


# --- solution level --------------------------------------------------------------------------------------


class NoModel:
	def __call__(self, messages, schema):
		raise AssertionError("the language model must not be consulted for an HR question")


class TestSolutionLevel(StackTestCase):
	"""One person is one User, and every app takes that User up."""

	def _make_user(self, email, first_name, roles=()):
		return frappe.get_doc(
			{
				"doctype": "User",
				"email": email,
				"first_name": first_name,
				"send_welcome_email": 0,
				"user_type": "System User",
				"roles": [{"role": role} for role in roles],
			}
		).insert(ignore_permissions=True)

	def test_a_new_user_is_taken_up_by_every_installed_app(self):
		roles = ["Raven User"] if "raven" in INSTALLED else []
		user = self._make_user("stack-one-person@example.com", "One", roles)
		held = {row.role for row in user.roles}
		if "suite" in INSTALLED:
			self.assertIn("Suite User", held, "Suite gives every new User its role before insert")
			self.assertTrue(frappe.db.exists("User Settings", {"user": user.name}), "Suite's mail settings")
		if "lms" in INSTALLED:
			self.assertIn("LMS Student", held, "Learning gives every new User its student role")
		if "raven" in INSTALLED:
			self.assertTrue(frappe.db.exists("Raven User", {"user": user.name}), "Raven's user record")

	@unittest.skipUnless("hrms" in INSTALLED, "Hubble is not installed")
	def test_an_employee_of_that_user_lets_rtb_answer_hr_questions_and_show_hubbles_work(self):
		from erpnext.adhd import api as adhd_api
		from erpnext.assistant import engine, hr

		company = frappe.db.get_single_value("Global Defaults", "default_company")
		approver = self._make_user("stack-approver@example.com", "Approver", ["HR User"])
		colleague = self._make_user("stack-colleague@example.com", "Colleague", ["HR User"])
		employee = frappe.get_doc(
			{
				"doctype": "Employee",
				"first_name": "Colleague",
				"company": company,
				"gender": "Female",
				"date_of_birth": "1990-01-01",
				"date_of_joining": "2020-01-01",
				"status": "Active",
				"user_id": colleague.name,
			}
		).insert(ignore_permissions=True)
		leave = frappe.get_doc(
			{
				"doctype": "Leave Application",
				"employee": employee.name,
				"employee_name": "Colleague",
				"leave_type": "Casual Leave",
				"from_date": nowdate(),
				"to_date": nowdate(),
				"status": "Open",
				"leave_approver": approver.name,
				"company": company,
			}
		)
		leave.flags.ignore_validate = True
		leave.insert(ignore_permissions=True, ignore_mandatory=True, ignore_links=True)

		# RTB's assistant finds the person's own Employee record and answers from Hubble, without the model
		frappe.set_user(colleague.name)
		self.assertEqual(hr.current_employee().name, employee.name)
		reply = engine.respond("what's my leave balance", llm=NoModel(), today=date.fromisoformat(nowdate()))
		self.assertNotIn("not set up", reply["reply"])
		self.assertNotIn("employee record", reply["reply"])

		# RTB's Focus inbox lists what Hubble says waits on the approver
		frappe.set_user(approver.name)
		names = [(row["doctype"], row["name"]) for row in adhd_api.get_urgent_items()]
		self.assertIn(("Leave Application", leave.name), names)


if __name__ == "__main__":
	unittest.main()
