# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Tests for the HR questions (hr.py): leave balance, who is out, holidays, payslip, attendance and
pending approvals, plus the `request_leave` recipe.

The cue tests and the "Hubble is not set up" / "no employee" tests need no HRMS install and no model:
they run everywhere. The rest is guarded by `unittest.skipUnless(hr.hr_installed(), ...)` and creates its
own Employee/User/Leave rows inside a transaction that is rolled back in `tearDown`, exactly like
`test_mail.py`. `frappe.db.commit` is patched to raise, so nothing here could ever persist for real.
"""

import unittest
from unittest.mock import patch

import frappe

from erpnext.assistant import engine, hr, recipes, search
from erpnext.assistant.test_assistant import TODAY, FakeLLM  # a Saturday, 19 Sep 2026


class NoModel:
	"""A model that must never be asked: proves an HR question is answered without it."""

	def __call__(self, messages, schema):
		raise AssertionError("the language model must not be consulted for an HR question")


def _block_commits(test: unittest.TestCase) -> None:
	no_commit = patch.object(frappe.db, "commit", side_effect=AssertionError("a test must not commit"))
	no_commit.start()
	test.addCleanup(no_commit.stop)


# --- cue matching: no DB, no model -----------------------------------------------------------------


class TestCues(unittest.TestCase):
	def test_leave_balance_phrases_are_recognised(self):
		for text in (
			"what's my leave balance",
			"my leave balance",
			"how much leave do I have",
			"how many leave days are left",
			"how many days do i have left",
			"my remaining leave balance",
		):
			self.assertTrue(hr.LEAVE_BALANCE_CUE.search(text.casefold()), text)

	def test_who_is_out_phrases_are_recognised(self):
		for text in (
			"who is out",
			"who's out today",
			"who is out this week",
			"who is off tomorrow",
			"who is on leave",
			"is anyone out today",
			"team out today",
		):
			self.assertTrue(hr.WHO_IS_OUT_CUE.search(text.casefold()), text)

	def test_holiday_phrases_are_recognised(self):
		for text in (
			"upcoming holidays",
			"what's the next holiday",
			"when is the next holiday",
			"holidays this year",
			"holidays coming up",
		):
			self.assertTrue(hr.HOLIDAYS_CUE.search(text.casefold()), text)

	def test_payslip_phrases_are_recognised(self):
		for text in (
			"my payslip",
			"my last payslip",
			"my pay slip",
			"how much did I get paid",
			"how much was I paid",
			"my net pay",
		):
			self.assertTrue(hr.PAYSLIP_CUE.search(text.casefold()), text)

	def test_attendance_phrases_are_recognised(self):
		for text in (
			"my attendance",
			"my attendance this month",
			"how many days have i worked",
			"was i marked present today",
		):
			self.assertTrue(hr.ATTENDANCE_CUE.search(text.casefold()), text)

	def test_pending_approval_phrases_are_recognised(self):
		for text in (
			"pending my approval",
			"pending approvals",
			"what needs my approval",
			"anything to approve",
			"leave requests to approve",
			"expense claims to approve",
		):
			self.assertTrue(hr.PENDING_APPROVAL_CUE.search(text.casefold()), text)

	def test_hr_cues_are_not_fooled_by_ordinary_notes(self):
		# these mention the same words but are not questions about HR data
		for text in (
			"book leave for the team offsite",
			"add a holiday party for Acme",
			"log a call: they're going on leave next month",
			"add task: approve the vendor invoice",
			"new client Holiday Homes Inc",
			"spent 2h on payroll setup for Acme",
		):
			self.assertFalse(hr.LEAVE_BALANCE_CUE.search(text.casefold()), text)
			self.assertFalse(hr.WHO_IS_OUT_CUE.search(text.casefold()), text)
			self.assertFalse(hr.HOLIDAYS_CUE.search(text.casefold()), text)
			self.assertFalse(hr.PAYSLIP_CUE.search(text.casefold()), text)
			self.assertFalse(hr.ATTENDANCE_CUE.search(text.casefold()), text)
			self.assertFalse(hr.PENDING_APPROVAL_CUE.search(text.casefold()), text)

	def test_hr_cues_do_not_collide_with_crm_or_email_cues(self):
		# the CRM/email phrases from test_assistant.py / test_mail.py must still resolve to themselves
		crm_and_mail = {
			"what should i do today": "my_day",
			"how many hours this week": "hours_summary",
			"how is my pipeline": "pipeline",
			"what did Acme email me": "emails",
			"connect my email": "connect_email",
		}
		for text, expected in crm_and_mail.items():
			found = next((n for n, cue in engine.QUERY_CUES.items() if cue.search(text.casefold())), None)
			self.assertEqual(found, expected, text)

		# and the HR phrases must not be swallowed by an earlier CRM/email cue
		hr_phrases = {
			"what's my leave balance": "leave_balance",
			"who is out this week": "who_is_out",
			"upcoming holidays": "upcoming_holidays",
			"my last payslip": "my_payslip",
			"my attendance this month": "my_attendance",
			"pending my approval": "pending_my_approval",
		}
		for text, expected in hr_phrases.items():
			found = next((n for n, cue in engine.QUERY_CUES.items() if cue.search(text.casefold())), None)
			self.assertEqual(found, expected, text)


# --- no model, ever ----------------------------------------------------------------------------------


class TestNoModel(unittest.TestCase):
	"""Every HR question is answered by code; the model is never even asked."""

	def test_hr_questions_never_reach_the_model(self):
		for text in (
			"what's my leave balance",
			"who is out today",
			"upcoming holidays",
			"my last payslip",
			"my attendance this month",
			"pending my approval",
		):
			# a fresh conversation each time, and hr_installed()/current_employee() are irrelevant here:
			# reaching the model at all is what this test forbids, regardless of what is found afterwards
			engine.respond(text, llm=NoModel(), today=TODAY)


# --- feature detection: no HRMS install needed -------------------------------------------------------


class TestNotSetUp(unittest.TestCase):
	"""Every answer degrades to the same friendly sentence when Hubble is not installed."""

	def setUp(self):
		patcher = patch.object(hr, "hr_installed", return_value=False)
		patcher.start()
		self.addCleanup(patcher.stop)

	def test_every_answer_says_hubble_is_not_set_up(self):
		message = "Hubble (HR) is not set up on this site."
		self.assertEqual(hr.leave_balance_answer()["reply"], message)
		self.assertEqual(hr.who_is_out_answer("")["reply"], message)
		self.assertEqual(hr.holidays_answer()["reply"], message)
		self.assertEqual(hr.payslip_answer()["reply"], message)
		self.assertEqual(hr.attendance_answer()["reply"], message)
		self.assertEqual(hr.pending_approval_answer()["reply"], message)

	def test_the_request_leave_recipe_is_blocked(self):
		self.assertEqual(recipes.RECIPES["request_leave"].guard(), "Hubble (HR) is not set up on this site.")

	def test_starting_it_through_the_engine_degrades_gracefully(self):
		reply = engine.respond(
			"I need next friday off",
			llm=FakeLLM({"intent": "request_leave"}),
			today=TODAY,
		)
		self.assertIn("Hubble (HR) is not set up", reply["reply"])
		self.assertIsNone(reply["state"]["recipe"])  # never actually started

	def test_the_search_bar_hides_the_hr_actions(self):
		labels = [do.label for do in search.catalogue()]
		self.assertNotIn("My leave balance", labels)
		self.assertNotIn("Who is out", labels)


# --- no employee record --------------------------------------------------------------------------------


class TestNoEmployee(unittest.TestCase):
	def setUp(self):
		installed = patch.object(hr, "hr_installed", return_value=True)
		installed.start()
		self.addCleanup(installed.stop)
		no_employee = patch.object(hr, "current_employee", return_value=None)
		no_employee.start()
		self.addCleanup(no_employee.stop)

	def test_every_answer_says_so_kindly(self):
		for answer in (
			hr.leave_balance_answer(),
			hr.who_is_out_answer(""),
			hr.holidays_answer(),
			hr.payslip_answer(),
			hr.attendance_answer(),
			hr.pending_approval_answer(),
		):
			self.assertIn("employee record", answer["reply"])
			self.assertNotIn("HRMS", answer["reply"])
			self.assertNotIn("Frappe HR", answer["reply"])


# --- pure unit tests of the recipe's build() --------------------------------------------------------


class TestBuildLeaveRequest(unittest.TestCase):
	def test_it_builds_a_leave_application(self):
		with patch("erpnext.assistant.recipes._employee_for_user", return_value="HR-EMP-0001"):
			with patch.object(hr, "leave_approver_for", return_value="approver@example.com"):
				doc = recipes.RECIPES["request_leave"].build(
					{
						"leave_type": "Casual Leave",
						"from_date": "2026-09-28",
						"to_date": "2026-09-28",
						"half_day": "Yes",
						"reason": "Dentist",
					}
				)
		self.assertEqual(doc["doctype"], "Leave Application")
		self.assertEqual(doc["employee"], "HR-EMP-0001")
		self.assertEqual(doc["leave_type"], "Casual Leave")
		self.assertEqual(doc["half_day"], 1)
		self.assertEqual(doc["description"], "Dentist")
		self.assertEqual(doc["leave_approver"], "approver@example.com")

	def test_half_day_defaults_to_no(self):
		with patch("erpnext.assistant.recipes._employee_for_user", return_value="HR-EMP-0001"):
			with patch.object(hr, "leave_approver_for", return_value=None):
				doc = recipes.RECIPES["request_leave"].build(
					{"leave_type": "Casual Leave", "from_date": "2026-09-28", "to_date": "2026-09-28"}
				)
		self.assertEqual(doc["half_day"], 0)

	def test_with_no_employee_the_approver_is_never_looked_up(self):
		with patch("erpnext.assistant.recipes._employee_for_user", return_value=None):
			with patch.object(hr, "leave_approver_for") as approver:
				doc = recipes.RECIPES["request_leave"].build({"leave_type": "Casual Leave"})
				approver.assert_not_called()
		self.assertIsNone(doc["employee"])

	def test_leave_approver_for_never_crashes_when_hrms_import_fails(self):
		with patch("hrms.hr.doctype.leave_application.leave_application.get_employee_leave_approver") as fn:
			fn.side_effect = RuntimeError("boom")
			self.assertIsNone(hr.leave_approver_for("HR-EMP-0001"))


# --- HRMS-backed: real rows, rolled back -------------------------------------------------------------


@unittest.skipUnless(hr.hr_installed(), "Hubble (the hrms app) is not installed on this site")
class TestHRMSBacked(unittest.TestCase):
	"""Every row made here lives only inside this test's transaction, undone by tearDown's rollback."""

	def setUp(self):
		# every fixture is made and torn down inside the same test: setUpClass would not survive this
		# test's own tearDown rollback (there is one long transaction, not a savepoint per test)
		frappe.set_user("Administrator")
		frappe.flags.mute_emails = True
		# a cleanup, not tearDown: it still runs when setUp itself fails half-way, so a broken fixture
		# never leaks into the next test's transaction
		self.addCleanup(self._undo)
		_block_commits(self)
		self._email_queue_before = frappe.db.count("Email Queue")
		self.company = frappe.db.get_single_value("Global Defaults", "default_company")
		self._hl = frappe.get_doc(
			{
				"doctype": "Holiday List",
				"holiday_list_name": f"Assistant HR test holidays {frappe.generate_hash(length=8)}",
				"from_date": "2026-01-01",
				"to_date": "2026-12-31",
			}
		).insert(ignore_permissions=True)
		self.user_a = self._make_user("hr-test-a@example.com", "Ash")
		self.user_b = self._make_user("hr-test-b@example.com", "Bay")
		self.emp_a = self._make_employee("Ash", self.user_a.name)
		self.emp_b = self._make_employee("Bay", self.user_b.name)

	def _undo(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		# never a real commit, and never a queued message
		self.assertEqual(frappe.db.count("Email Queue"), self._email_queue_before)

	def _make_user(self, email, first_name):
		return frappe.get_doc(
			{"doctype": "User", "email": email, "first_name": first_name, "send_welcome_email": 0}
		).insert(ignore_permissions=True)

	def _make_employee(self, first_name, user_id):
		employee = frappe.get_doc(
			{
				"doctype": "Employee",
				"first_name": first_name,
				"company": self.company,
				"gender": "Female",
				"date_of_birth": "1990-01-01",
				"date_of_joining": "2020-01-01",
				"status": "Active",
				"user_id": user_id,
			}
		).insert(ignore_permissions=True)
		# Hubble resolves an employee's holidays through a Holiday List Assignment; one made for the
		# employee themself can never collide with whatever the site already assigns to the company
		frappe.get_doc(
			{
				"doctype": "Holiday List Assignment",
				"holiday_list": self._hl.name,
				"applicable_for": "Employee",
				"assigned_to": employee.name,
				"from_date": "2026-01-01",
			}
		).insert(ignore_permissions=True).submit()
		return employee

	def _fixture(self, doctype, submit=False, **fields):
		"""A row for the read side of hr.py, without running the doctype's own (often heavy) validate()."""
		doc = frappe.get_doc({"doctype": doctype, **fields})
		doc.flags.ignore_validate = True
		doc.insert(ignore_permissions=True, ignore_mandatory=True)
		if submit:
			frappe.db.set_value(doctype, doc.name, "docstatus", 1, update_modified=False)
			doc.reload()
		return doc

	def _allocate_leave(self, employee: str, leave_type: str, days: float) -> None:
		"""A real, submitted Leave Allocation: `leave_balance_answer` reads the Leave Ledger Entry that
		only a real `on_submit` writes, so this one is never built with `_fixture`'s bypass."""
		allocation = frappe.get_doc(
			{
				"doctype": "Leave Allocation",
				"employee": employee,
				"leave_type": leave_type,
				"from_date": "2026-01-01",
				"to_date": "2026-12-31",
				"new_leaves_allocated": days,
			}
		).insert(ignore_permissions=True)
		allocation.submit()

	# --- current_employee / no-employee ---

	def test_current_employee_finds_the_signed_in_persons_own_record(self):
		frappe.set_user(self.user_a.name)
		found = hr.current_employee()
		self.assertEqual(found.name, self.emp_a.name)

	def test_a_user_with_no_employee_record_gets_no_employee(self):
		stray = self._make_user("hr-test-stray@example.com", "Stray")
		frappe.set_user(stray.name)
		self.assertIsNone(hr.current_employee())
		self.assertIn("employee record", hr.leave_balance_answer()["reply"])

	# --- leave balance ---

	def test_leave_balance_lists_each_type_with_its_own_remaining_days(self):
		leave_type = self._fixture("Leave Type", leave_type_name="Assistant Test Leave A")
		self._allocate_leave(self.emp_a.name, leave_type.name, 12)
		frappe.set_user(self.user_a.name)
		answer = hr.leave_balance_answer()
		self.assertIn("12", answer["reply"])
		self.assertEqual(answer["items"][0]["label"], leave_type.name)
		self.assertIn("12 of 12", answer["items"][0]["meta"])

	def test_no_allocation_says_so(self):
		frappe.set_user(self.user_a.name)
		answer = hr.leave_balance_answer()
		self.assertEqual(answer["items"], [])
		self.assertIn("No leave", answer["reply"])

	# --- who is out ---

	def test_who_is_out_shows_an_approved_leave_today_to_a_colleague(self):
		leave_type = self._fixture("Leave Type", leave_type_name="Assistant Test Leave B")
		self._fixture(
			"Leave Application",
			submit=True,
			employee=self.emp_a.name,
			employee_name="Ash",
			leave_type=leave_type.name,
			from_date=TODAY.isoformat(),
			to_date=TODAY.isoformat(),
			status="Approved",
			company=self.company,
			leave_approver=self.user_b.name,
		)
		frappe.set_user(self.user_b.name)
		with patch("erpnext.assistant.hr.nowdate", return_value=TODAY.isoformat()):
			answer = hr.who_is_out_answer("")
		self.assertEqual(len(answer["items"]), 1)
		self.assertEqual(answer["items"][0]["label"], "Ash")
		self.assertIn(leave_type.name, answer["items"][0]["meta"])

	def test_an_open_unapproved_leave_does_not_count_as_out(self):
		leave_type = self._fixture("Leave Type", leave_type_name="Assistant Test Leave C")
		self._fixture(
			"Leave Application",
			employee=self.emp_a.name,
			employee_name="Ash",
			leave_type=leave_type.name,
			from_date=TODAY.isoformat(),
			to_date=TODAY.isoformat(),
			status="Open",
			company=self.company,
		)
		frappe.set_user(self.user_b.name)
		with patch("erpnext.assistant.hr.nowdate", return_value=TODAY.isoformat()):
			answer = hr.who_is_out_answer("")
		self.assertEqual(answer["items"], [])

	def test_who_is_out_respects_permission(self):
		frappe.set_user(self.user_a.name)
		with patch("frappe.has_permission", return_value=False):
			answer = hr.who_is_out_answer("")
		self.assertIn("don't have access", answer["reply"])

	# --- holidays ---

	def test_upcoming_holidays_lists_the_next_one(self):
		frappe.get_doc(
			{
				"doctype": "Holiday",
				"parenttype": "Holiday List",
				"parentfield": "holidays",
				"parent": self._hl.name,
				"holiday_date": "2026-12-25",
				"description": "Test Holiday",
			}
		).insert(ignore_permissions=True)
		frappe.set_user(self.user_a.name)
		with patch("erpnext.assistant.hr.nowdate", return_value=TODAY.isoformat()):
			answer = hr.holidays_answer()
		self.assertTrue(any(item["label"] == "Test Holiday" for item in answer["items"]))

	# --- payslip: pay is shown only to its owner ---

	def test_payslip_shows_only_the_signed_in_persons_own_pay(self):
		self._fixture(
			"Salary Slip",
			submit=True,
			employee=self.emp_a.name,
			posting_date="2026-09-01",
			start_date="2026-09-01",
			end_date="2026-09-30",
			net_pay=5000,
			currency="USD",
			status="Submitted",
		)
		self._fixture(
			"Salary Slip",
			submit=True,
			employee=self.emp_b.name,
			posting_date="2026-09-01",
			start_date="2026-09-01",
			end_date="2026-09-30",
			net_pay=99999,
			currency="USD",
			status="Submitted",
		)

		frappe.set_user(self.user_a.name)
		answer = hr.payslip_answer()
		self.assertIn("5,000", answer["reply"])
		self.assertNotIn("99999", answer["reply"])
		self.assertNotIn("99,999", answer["reply"])
		for item in answer["items"]:
			self.assertNotIn("99999", str(item))
			self.assertNotIn("99,999", str(item))

		frappe.set_user(self.user_b.name)
		answer = hr.payslip_answer()
		self.assertIn("99,999", answer["reply"])
		self.assertNotIn("5,000", answer["reply"])

	def test_no_payslip_says_so(self):
		frappe.set_user(self.user_a.name)
		self.assertEqual(hr.payslip_answer()["reply"], "No payslips yet.")

	# --- attendance ---

	def test_attendance_counts_this_months_marked_days(self):
		self._fixture(
			"Attendance",
			submit=True,
			employee=self.emp_a.name,
			attendance_date=TODAY.isoformat(),
			status="Present",
			company=self.company,
		)
		frappe.set_user(self.user_a.name)
		with patch("erpnext.assistant.hr.nowdate", return_value=TODAY.isoformat()):
			answer = hr.attendance_answer()
		self.assertIn("1 present", answer["reply"])

		frappe.set_user(self.user_b.name)
		with patch("erpnext.assistant.hr.nowdate", return_value=TODAY.isoformat()):
			answer = hr.attendance_answer()
		self.assertEqual(answer["items"], [])

	# --- pending my approval ---

	def test_pending_approval_shows_the_approver_their_teams_requests(self):
		leave_type = self._fixture("Leave Type", leave_type_name="Assistant Test Leave D")
		self._fixture(
			"Leave Application",
			employee=self.emp_a.name,
			employee_name="Ash",
			leave_type=leave_type.name,
			from_date=TODAY.isoformat(),
			to_date=TODAY.isoformat(),
			status="Open",
			company=self.company,
			leave_approver=self.user_b.name,
		)
		frappe.set_user(self.user_b.name)
		answer = hr.pending_approval_answer()
		self.assertEqual(len(answer["items"]), 1)
		self.assertEqual(answer["items"][0]["label"], "Ash")

		# the applicant themself never sees their own request as "pending my approval"
		frappe.set_user(self.user_a.name)
		answer = hr.pending_approval_answer()
		self.assertEqual(answer["items"], [])

	# --- the full request_leave recipe, through the engine ---

	def test_requesting_leave_saves_a_real_validated_leave_application(self):
		leave_type = self._fixture("Leave Type", leave_type_name="Assistant Test Leave E")
		self._allocate_leave(self.emp_a.name, leave_type.name, 10)
		frappe.db.set_single_value("HR Settings", "leave_approver_mandatory_in_leave_application", 0)
		frappe.set_user(self.user_a.name)

		extracted = {
			"leave_type": leave_type.name,
			"from_date": "2026-09-28",
			"to_date": "2026-09-28",
			"half_day": "No",
			"reason": "Dentist",
		}
		reply = engine.respond(
			"I need next monday off",
			llm=FakeLLM({"intent": "request_leave"}, extracted),
			today=TODAY,
		)
		self.assertTrue(reply["card"]["ready"], reply["card"]["problems"])
		result = engine.create(reply["state"], today=TODAY)
		self.assertIsNotNone(result["created"])

		saved = frappe.get_doc("Leave Application", result["created"]["name"])
		self.assertEqual(saved.employee, self.emp_a.name)
		self.assertEqual(saved.leave_type, leave_type.name)
		self.assertEqual(str(saved.from_date), "2026-09-28")
		self.assertEqual(saved.description, "Dentist")

	def test_a_real_validation_problem_is_surfaced_not_hidden(self):
		# HR Settings on this site requires a leave approver; this employee has none resolvable
		# (no department, no Department Approver row), so Hubble's own validate() should refuse it
		frappe.db.set_single_value("HR Settings", "leave_approver_mandatory_in_leave_application", 1)
		leave_type = self._fixture("Leave Type", leave_type_name="Assistant Test Leave F")
		self._allocate_leave(self.emp_a.name, leave_type.name, 10)
		frappe.set_user(self.user_a.name)

		extracted = {
			"leave_type": leave_type.name,
			"from_date": "2026-09-28",
			"to_date": "2026-09-28",
			"half_day": "No",
			"reason": "",
		}
		reply = engine.respond(
			"I need next monday off",
			llm=FakeLLM({"intent": "request_leave"}, extracted),
			today=TODAY,
		)
		self.assertFalse(reply["card"]["ready"])
		self.assertTrue(reply["card"]["problems"])
		self.assertIn("approver", reply["card"]["problems"][0].casefold())

	def test_requesting_leave_never_queues_mail(self):
		# HR Settings.send_leave_notification is on by default on a fresh install; mute_emails must hold
		leave_type = self._fixture("Leave Type", leave_type_name="Assistant Test Leave G")
		self._allocate_leave(self.emp_a.name, leave_type.name, 10)
		frappe.db.set_single_value("HR Settings", "leave_approver_mandatory_in_leave_application", 0)
		frappe.set_user(self.user_a.name)
		extracted = {
			"leave_type": leave_type.name,
			"from_date": "2026-09-28",
			"to_date": "2026-09-28",
			"half_day": "No",
			"reason": "",
		}
		reply = engine.respond(
			"I need next monday off", llm=FakeLLM({"intent": "request_leave"}, extracted), today=TODAY
		)
		if reply["card"]["ready"]:
			engine.create(reply["state"], today=TODAY)
		frappe.set_user("Administrator")
		self.assertEqual(frappe.db.count("Email Queue"), self._email_queue_before)

	def test_the_search_bar_offers_the_hr_actions_once_installed(self):
		labels = [do.label for do in search.catalogue()]
		self.assertIn("My leave balance", labels)
		self.assertIn("Who is out", labels)


if __name__ == "__main__":
	unittest.main()
