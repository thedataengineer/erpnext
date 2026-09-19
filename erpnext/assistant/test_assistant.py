# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# For license information, please see license.txt

import unittest
from contextlib import contextmanager
from datetime import date
from unittest.mock import MagicMock, patch

import frappe
import requests
from frappe.utils import add_days, getdate

from erpnext.assistant import api, engine, llm
from erpnext.assistant.parsing import find_date, find_hours, parse_date, parse_hours

TODAY = date(2026, 9, 19)  # a Saturday
CANDIDATES = [("PROJ-1", "Website Redesign"), ("PROJ-2", "Q4 Audit"), ("PROJ-3", "Website Migration")]


class FakeLLM:
	"""Stands in for the local model: replays canned answers in order and records what it was asked."""

	def __init__(self, *answers):
		self.answers = list(answers)
		self.calls = []

	def __call__(self, messages, schema):
		self.calls.append((messages, schema))
		return self.answers.pop(0)


def time_entry(**fields):
	"""What the model returns for a time entry sentence: every key present, null when not said."""
	blank = dict.fromkeys(("client", "project", "hours", "date", "activity", "description"))
	return {**blank, **fields}


class TestParsing(unittest.TestCase):
	def test_hours_in_the_ways_people_write_them(self):
		for text, expected in (
			("2.5", 2.5),
			("2h", 2),
			("1h30", 1.5),
			("1h 30m", 1.5),
			("1:30", 1.5),
			("90 min", 1.5),
			("45 minutes", 0.75),
			("1 hour and 30 minutes", 1.5),
			("half an hour", 0.5),
			(3, 3),
		):
			self.assertEqual(parse_hours(text), expected, text)

	def test_hours_rejects_nonsense(self):
		for value in (0, -1, 25, "", None, True, "lots", "3pm"):
			self.assertIsNone(parse_hours(value), value)

	def test_find_hours_needs_a_unit(self):
		self.assertEqual(find_hours("spent 90 mins writing"), 1.5)
		self.assertEqual(find_hours("2 hours 15 minutes on audit"), 2.25)
		self.assertIsNone(find_hours("call with 3 people"))
		self.assertIsNone(find_hours("meeting at 3pm"))

	def test_dates_are_worked_out_in_code(self):
		# TODAY is Saturday 19 Sep 2026
		self.assertEqual(find_date("yesterday", TODAY), date(2026, 9, 18))
		self.assertEqual(find_date("last friday", TODAY), date(2026, 9, 18))
		self.assertEqual(find_date("thursday", TODAY), date(2026, 9, 17))
		self.assertEqual(find_date("3 days ago", TODAY), date(2026, 9, 16))
		self.assertEqual(find_date("by friday", TODAY, "future"), date(2026, 9, 25))
		self.assertEqual(find_date("next monday", TODAY, "future"), date(2026, 9, 21))
		self.assertEqual(find_date("saturday", TODAY), TODAY)
		self.assertEqual(find_date("last saturday", TODAY), date(2026, 9, 12))
		self.assertIsNone(find_date("nothing to see", TODAY))

	def test_parse_date_handles_iso_and_month_names(self):
		self.assertEqual(parse_date("2026-09-18", TODAY), date(2026, 9, 18))
		self.assertEqual(parse_date("Sep 12", TODAY), date(2026, 9, 12))
		self.assertEqual(parse_date("Dec 20", TODAY), date(2025, 12, 20))  # said in September: last December
		self.assertEqual(parse_date("Dec 20", TODAY, "future"), date(2026, 12, 20))
		self.assertIsNone(parse_date("blorp", TODAY))


class TestMatching(unittest.TestCase):
	def test_exact_match_ignores_case_and_accepts_the_record_id(self):
		self.assertEqual(engine.match_candidate("website redesign", CANDIDATES).name, "PROJ-1")
		self.assertEqual(engine.match_candidate("PROJ-2", CANDIDATES).label, "Q4 Audit")

	def test_a_close_and_clear_winner_is_accepted(self):
		match = engine.match_candidate("acme", [("C-1", "Acme Corp"), ("C-2", "Globex")])
		self.assertEqual((match.status, match.name), ("ok", "C-1"))
		self.assertTrue(match.note)

	def test_two_equally_close_records_are_left_to_the_person(self):
		match = engine.match_candidate("acme", [("C-1", "Acme Corp"), ("C-2", "Acme Labs")])
		self.assertEqual(match.status, "ambiguous")
		self.assertEqual({name for name, _label in match.candidates}, {"C-1", "C-2"})

	def test_no_match(self):
		self.assertEqual(engine.match_candidate("zzzzzz", CANDIDATES).status, "none")
		self.assertEqual(engine.match_candidate("anything", []).status, "none")

	def test_model_choice_prefers_the_best_installed(self):
		self.assertEqual(llm.pick_model(["gemma4-e2b:latest", "qwen3:14b"]), "qwen3:14b")
		self.assertEqual(llm.pick_model(["gemma4-e2b:latest"]), "gemma4-e2b:latest")
		self.assertEqual(llm.pick_model(["mystery:7b"]), "mystery:7b")
		self.assertEqual(llm.pick_model(["qwen3:14b"], configured="mine"), "mine")
		self.assertIsNone(llm.pick_model([]))


class TestAssistant(unittest.TestCase):
	"""Runs inside one transaction that is rolled back after every test, so nothing is ever saved.

	This deliberately does not use ERPNextTestSuite: importing erpnext.tests.utils bootstraps (and commits)
	a large set of test companies, fiscal years and warehouses into whatever site it is run on.
	"""

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	@contextmanager
	def set_user(self, user):
		frappe.set_user(user)
		try:
			yield
		finally:
			frappe.set_user("Administrator")

	def setUp(self):
		frappe.set_user("Administrator")
		self.acme = self.make("Customer", customer_name="Acme Corp")
		self.globex = self.make("Customer", customer_name="Globex")
		self.redesign = self.make("Project", project_name="Website Redesign", customer=self.acme.name)

	@staticmethod
	def make(doctype, **fields):
		return frappe.get_doc({"doctype": doctype, **fields}).insert()

	def say(self, message, *answers, state=None):
		"""One turn where the model classifies as log_time (unless told otherwise) and then extracts."""
		return engine.respond(message=message, state=state, llm=FakeLLM(*answers), today=TODAY)

	# --- logging time ---

	def test_one_sentence_becomes_a_ready_draft_and_then_a_timesheet(self):
		reply = self.say(
			"log 2.5 hours for Acme on the website redesign yesterday",
			{"intent": "log_time"},
			time_entry(client="Acme", project="website redesign", hours=2.5, date="yesterday"),
		)
		self.assertTrue(reply["card"]["ready"], reply)
		rows = {row["field"]: row for row in reply["card"]["rows"]}
		self.assertEqual(rows["project"]["value"], "Website Redesign")
		self.assertEqual(rows["hours"]["value"], "2.5 h")
		self.assertEqual(rows["date"]["value"], "Fri 18 Sep 2026")
		self.assertEqual(frappe.db.count("Timesheet"), 0, "checking the draft must not save anything")

		done = engine.create(reply["state"], today=TODAY)
		self.assertEqual(done["created"]["doctype"], "Timesheet")
		timesheet = frappe.get_doc("Timesheet", done["created"]["name"])
		self.assertEqual(timesheet.docstatus, 0)
		self.assertEqual(timesheet.parent_project, self.redesign.name)
		self.assertEqual(timesheet.time_logs[0].hours, 2.5)
		self.assertEqual(str(timesheet.time_logs[0].from_time)[:10], "2026-09-18")
		self.assertEqual(done["state"]["recipe"], None)

	def test_only_the_missing_piece_is_asked_for_and_chips_answer_it(self):
		reply = self.say("2h today", {"intent": "log_time"}, time_entry(hours=2))
		self.assertFalse(reply["card"]["ready"])
		self.assertIn("project", reply["reply"].lower())
		self.assertEqual(reply["state"]["asking"], "project")
		chip = next(c for c in reply["chips"] if c["label"] == "Website Redesign")

		# tapping a suggestion never needs the model
		reply = engine.respond(action=chip["action"], state=reply["state"], llm=FakeLLM(), today=TODAY)
		self.assertTrue(reply["card"]["ready"], reply)

	def test_a_bare_answer_fills_the_field_that_was_asked_about(self):
		first = self.say("2h today", {"intent": "log_time"}, time_entry(hours=2))
		llm_ = FakeLLM(time_entry())  # the model finds nothing in "Website Redesign"
		reply = engine.respond(message="Website Redesign", state=first["state"], llm=llm_, today=TODAY)
		self.assertTrue(reply["card"]["ready"], reply)
		prompt = llm_.calls[0][0][0]["content"]
		self.assertIn('"project"', prompt, "the model is told which field was just asked about")

	def test_the_client_narrows_the_project(self):
		self.make("Project", project_name="Acme Kickoff", customer=self.acme.name)
		globex_kickoff = self.make("Project", project_name="Globex Kickoff", customer=self.globex.name)
		# On its own "kickoff" fits both projects equally well, so the person would have to choose ...
		unsure = self.say("1h kickoff", {"intent": "log_time"}, time_entry(project="Kickoff", hours=1))
		self.assertFalse(unsure["card"]["ready"])
		# ... but "for Globex" settles it.
		reply = self.say(
			"1h kickoff for Globex",
			{"intent": "log_time"},
			time_entry(client="Globex", project="Kickoff", hours=1),
		)
		self.assertTrue(reply["card"]["ready"], reply)
		done = engine.create(reply["state"], today=TODAY)
		timesheet = frappe.get_doc("Timesheet", done["created"]["name"])
		self.assertEqual(timesheet.parent_project, globex_kickoff.name)

	def test_a_clients_only_project_is_used_when_only_the_client_is_named(self):
		reply = self.say("90 mins with Acme", {"intent": "log_time"}, time_entry(client="Acme", hours=1.5))
		self.assertTrue(reply["card"]["ready"], reply)
		note = next(row["note"] for row in reply["card"]["rows"] if row["field"] == "project")
		self.assertTrue(note)

	def test_an_unknown_project_can_be_created_on_the_spot_and_the_time_entry_resumes(self):
		reply = self.say(
			"3h on Brand Refresh for Acme",
			{"intent": "log_time"},
			time_entry(client="Acme", project="Brand Refresh", hours=3),
		)
		self.assertIn("couldn't find", reply["reply"])
		chip = next(c for c in reply["chips"] if c["label"].startswith("Create project"))
		self.assertEqual(chip["action"]["values"], {"project_name": "Brand Refresh", "customer": "Acme"})

		reply = engine.respond(action=chip["action"], state=reply["state"], llm=FakeLLM(), today=TODAY)
		self.assertEqual(reply["state"]["recipe"], "create_project")
		self.assertEqual(len(reply["state"]["stack"]), 1)
		self.assertTrue(reply["card"]["ready"], reply)

		reply = engine.create(reply["state"], today=TODAY)  # makes the project, then resumes the time entry
		self.assertEqual(reply["created"]["doctype"], "Project")
		self.assertEqual(reply["state"]["recipe"], "log_time")
		self.assertTrue(reply["card"]["ready"], reply)
		self.assertEqual(frappe.db.get_value("Project", reply["created"]["name"], "customer"), self.acme.name)

		reply = engine.create(reply["state"], today=TODAY)
		self.assertEqual(reply["created"]["doctype"], "Timesheet")

	def test_weekday_maths_is_done_in_code_not_by_the_model(self):
		reply = self.say(
			"2h on website redesign last friday",
			{"intent": "log_time"},
			time_entry(project="website redesign", hours=2, date="2026-09-12"),  # the model got it wrong
		)
		date_row = next(row for row in reply["card"]["rows"] if row["field"] == "date")
		self.assertEqual(date_row["value"], "Fri 18 Sep 2026")

	def test_a_date_that_cannot_be_read_is_asked_about_and_not_guessed(self):
		reply = self.say(
			"2h on website redesign",
			{"intent": "log_time"},
			time_entry(project="website redesign", hours=2, date="blorp"),
		)
		self.assertFalse(reply["card"]["ready"])
		self.assertIn("blorp", reply["reply"])
		self.assertEqual([c["label"] for c in reply["chips"]], ["Today", "Yesterday"])

	def test_explicit_hours_in_the_sentence_beat_the_model(self):
		reply = self.say(
			"spent 90 mins on website redesign",
			{"intent": "log_time"},
			time_entry(project="website redesign", hours=9),
		)
		hours_row = next(row for row in reply["card"]["rows"] if row["field"] == "hours")
		self.assertEqual(hours_row["value"], "1.5 h")

	def test_optional_details_the_user_never_said_are_dropped(self):
		reply = self.say(
			"1h on website redesign, wrote the findings memo",
			{"intent": "log_time"},
			time_entry(
				project="website redesign",
				hours=1,
				activity="Proposal Writing",
				description="wrote the findings memo",
			),
		)
		self.assertNotIn("activity", [row["field"] for row in reply["card"]["rows"]])
		reply = self.say(
			"1h research on website redesign",
			{"intent": "log_time"},
			time_entry(project="website redesign", hours=1, activity="Research"),
		)
		activity = next(row for row in reply["card"]["rows"] if row["field"] == "activity")
		self.assertEqual(activity["value"], "Research")

	def test_entries_on_the_same_day_do_not_overlap(self):
		for _ in range(2):
			reply = self.say(
				"2h on website redesign",
				{"intent": "log_time"},
				time_entry(project="website redesign", hours=2),
			)
			self.assertTrue(
				reply["card"]["ready"], reply
			)  # a second entry would fail validation if it overlapped
			engine.create(reply["state"], today=TODAY)
		starts = sorted(str(t) for t in frappe.get_all("Timesheet Detail", pluck="from_time"))
		self.assertEqual([s[11:16] for s in starts], ["08:00", "10:00"])

	# --- other recipes ---

	def test_a_task_with_a_due_date_and_priority(self):
		reply = self.say(
			"remind me to send the SOW to Globex by friday, it's urgent",
			{"intent": "create_task"},
			{
				"subject": "Send the SOW to Globex",
				"project": None,
				"due_date": "2026-09-30",
				"priority": "urgent",
				"description": None,
			},
		)
		self.assertTrue(reply["card"]["ready"], reply)
		done = engine.create(reply["state"], today=TODAY)
		task = frappe.get_doc("Task", done["created"]["name"])
		self.assertEqual((task.subject, task.priority), ("Send the SOW to Globex", "Urgent"))
		self.assertEqual(getdate(task.exp_end_date), date(2026, 9, 25))  # "friday", worked out in code

	def test_a_new_client_defaults_to_a_company(self):
		reply = self.say(
			"new client Umbrella Corp",
			{"intent": "create_customer"},
			{"customer_name": "Umbrella Corp", "customer_type": None},
		)
		self.assertTrue(reply["card"]["ready"], reply)
		done = engine.create(reply["state"], today=TODAY)
		self.assertEqual(frappe.db.get_value("Customer", done["created"]["name"], "customer_type"), "Company")

	def test_a_new_project_for_a_known_client(self):
		reply = self.say(
			"set up a project for acme called ERP audit",
			{"intent": "create_project"},
			{
				"project_name": "ERP audit",
				"customer": "acme",
				"start_date": None,
				"end_date": None,
				"notes": None,
			},
		)
		self.assertTrue(reply["card"]["ready"], reply)
		done = engine.create(reply["state"], today=TODAY)
		self.assertEqual(frappe.db.get_value("Project", done["created"]["name"], "customer"), self.acme.name)

	# --- conversation handling ---

	def test_yes_confirms_and_cancel_drops(self):
		ready = self.say(
			"2h on website redesign",
			{"intent": "log_time"},
			time_entry(project="website redesign", hours=2),
		)
		reply = engine.respond(message="Yes!", state=ready["state"], llm=FakeLLM(), today=TODAY)
		self.assertEqual(reply["created"]["doctype"], "Timesheet")

		reply = engine.respond(message="never mind", state=ready["state"], llm=FakeLLM(), today=TODAY)
		self.assertEqual(reply["state"]["recipe"], None)
		self.assertEqual(frappe.db.count("Timesheet"), 1)

	def test_a_question_mid_draft_is_answered_and_the_draft_survives(self):
		self.make("Task", subject="Send the SOW", exp_end_date=add_days(TODAY, -1))
		first = self.say("2h today", {"intent": "log_time"}, time_entry(hours=2))
		reply = engine.respond(
			message="what's on my plate", state=first["state"], llm=FakeLLM(), today=TODAY
		)  # a known phrase: answered without asking the model
		self.assertNotIn("couldn't find", reply["reply"])
		self.assertEqual([item["label"] for item in reply["items"]], ["Send the SOW"])
		self.assertIn("still open", reply["reply"])
		self.assertEqual(reply["state"]["recipe"], "log_time")
		self.assertTrue(reply["card"])
		self.assertTrue(any(c["label"] == "Website Redesign" for c in reply["chips"]))

		# the model catches questions worded differently
		reply = engine.respond(
			message="how much have I worked lately",
			state=first["state"],
			llm=FakeLLM({"intent": "hours_summary"}),
			today=TODAY,
		)
		self.assertIn("still open", reply["reply"])

		done = engine.respond(
			message="Website Redesign", state=reply["state"], llm=FakeLLM(time_entry()), today=TODAY
		)
		self.assertTrue(done["card"]["ready"], done)

	def test_a_new_request_mid_draft_parks_the_draft_and_it_comes_back(self):
		first = self.say("2h today", {"intent": "log_time"}, time_entry(hours=2))
		task = {
			"subject": "Call the bank",
			"project": None,
			"due_date": "tomorrow",
			"priority": None,
			"description": None,
		}
		reply = engine.respond(
			message="remind me to call the bank tomorrow",
			state=first["state"],
			llm=FakeLLM({"intent": "create_task"}, task),
			today=TODAY,
		)
		self.assertEqual(reply["state"]["recipe"], "create_task")
		self.assertEqual(len(reply["state"]["stack"]), 1)
		self.assertTrue(reply["card"]["ready"], reply)

		back = engine.create(reply["state"], today=TODAY)
		self.assertEqual(back["created"]["doctype"], "Task")
		self.assertEqual(
			back["state"]["recipe"], "log_time"
		)  # the time entry is back, still waiting for a project
		self.assertEqual(back["state"]["values"]["hours"], 2)

	def test_a_long_answer_is_not_mistaken_for_a_new_request(self):
		first = self.say("2h today", {"intent": "log_time"}, time_entry(hours=2))
		reply = engine.respond(
			message="the website redesign one",
			state=first["state"],
			llm=FakeLLM({"intent": "create_project"}, time_entry(project="website redesign")),
			today=TODAY,
		)
		self.assertEqual(reply["state"]["recipe"], "log_time")
		self.assertEqual(reply["state"]["stack"], [])
		self.assertTrue(reply["card"]["ready"], reply)

	def test_yes_does_nothing_until_the_draft_is_ready(self):
		first = self.say("2h today", {"intent": "log_time"}, time_entry(hours=2))
		reply = engine.respond(message="yes", state=first["state"], llm=FakeLLM(time_entry()), today=TODAY)
		self.assertNotIn("created", reply)
		self.assertEqual(frappe.db.count("Timesheet"), 0)

	def test_create_refuses_an_incomplete_draft(self):
		state = {"recipe": "log_time", "values": {"hours": 2}, "stack": [], "asking": None}
		result = engine.create(state, today=TODAY)
		self.assertIsNone(result["created"])
		self.assertEqual(frappe.db.count("Timesheet"), 0)

	def test_greetings_and_gibberish_get_the_menu_without_calling_the_model(self):
		reply = engine.respond(message="hi", llm=FakeLLM(), today=TODAY)
		self.assertTrue(reply["chips"])
		reply = self.say("what is the capital of France", {"intent": "help"})
		self.assertIn("didn't quite get", reply["reply"])

	def test_a_tampered_state_is_cleaned_not_trusted(self):
		state = {
			"recipe": "log_time",
			"values": {"hours": {"nested": 1}, "project": "x" * 5000, "__class__": "evil", "date": None},
			"stack": [
				1,
				"two",
				{"recipe": "no such recipe"},
				{"recipe": "create_task", "values": {"subject": "ok"}},
			]
			* 3,
			"asking": "not a field",
		}
		clean = engine.sanitize_state(state)
		self.assertEqual(set(clean["values"]), {"project"})
		self.assertEqual(len(clean["values"]["project"]), 500)
		self.assertIsNone(clean["asking"])
		self.assertLessEqual(len(clean["stack"]), engine.MAX_STACK)
		self.assertEqual(engine.sanitize_state("garbage"), engine.empty_state())
		reply = engine.respond(
			action={"type": "start", "recipe": "nope"}, state=state, llm=FakeLLM(), today=TODAY
		)
		self.assertTrue(reply["reply"])

	def test_someone_without_permission_cannot_create(self):
		user = self.make(
			"User", email="assistant-noperms@example.com", first_name="No Perms", send_welcome_email=0
		)
		with self.set_user(user.name):
			reply = self.say(
				"2h on website redesign",
				{"intent": "log_time"},
				time_entry(project="website redesign", hours=2),
			)
			self.assertIn("permission", reply["reply"])
			self.assertFalse(reply["card"]["ready"])
			self.assertIsNone(engine.create(reply["state"], today=TODAY).get("created"))
			self.assertEqual(frappe.db.count("Timesheet"), 0)

	# --- questions ---

	def test_my_day_lists_overdue_work_first(self):
		self.make("Task", subject="Later thing", exp_end_date=add_days(TODAY, 5))
		self.make("Task", subject="Late thing", exp_end_date=add_days(TODAY, -3), priority="High")
		reply = self.say("what's on my plate", {"intent": "my_day"})
		self.assertEqual([item["label"] for item in reply["items"]], ["Late thing", "Later thing"])
		self.assertEqual(reply["items"][0]["tone"], "danger")
		self.assertIn("1 overdue", reply["reply"])
		self.assertEqual(reply["items"][0]["route"], ["Form", "Task", reply["items"][0]["route"][2]])

	def test_my_day_with_nothing_offers_to_add_a_task(self):
		reply = self.say("what's on my plate", {"intent": "my_day"})
		self.assertEqual(reply["items"], [])
		self.assertEqual(reply["chips"][0]["action"]["recipe"], "create_task")

	def test_hours_summary_adds_up_this_week(self):
		for hours in (2, 3.5):
			reply = self.say(
				f"{hours}h on website redesign today",
				{"intent": "log_time"},
				time_entry(project="website redesign", hours=hours),
			)
			engine.create(reply["state"], today=TODAY)
		reply = self.say("how many hours this week", {"intent": "hours_summary"})
		self.assertIn("5.5 h", reply["reply"])
		self.assertEqual(reply["items"][0]["label"], "Website Redesign")

	# --- endpoints ---

	def test_api_reports_a_missing_model_as_a_reply_not_an_error(self):
		with patch.object(
			llm, "chat_json", side_effect=llm.LLMError("The local model server isn't running.")
		):
			result = api.chat(message="log 2h on website redesign")
		self.assertTrue(result["error"])
		self.assertIn("isn't running", result["reply"])
		self.assertEqual(result["state"], engine.empty_state())

	def test_api_accepts_json_strings_like_a_browser_sends(self):
		with patch.object(llm, "chat_json", side_effect=[{"intent": "help"}]):
			result = api.chat(message="what is this", state='{"recipe": null, "values": {}, "stack": []}')
		self.assertIn("didn't quite get", result["reply"])


class TestLocalModelClient(unittest.TestCase):
	def setUp(self):
		llm._busy_until.clear()

	def response(self, status=200, content='{"intent": "help"}'):
		mock = MagicMock(status_code=status)
		mock.json.return_value = {"message": {"content": content}}
		return mock

	def test_sends_the_schema_and_turns_thinking_off(self):
		schema = {"type": "object"}
		with (
			patch.object(llm.requests, "post", return_value=self.response()) as post,
			patch.object(llm, "list_models", return_value=["gemma4-e2b:latest", "qwen3:14b"]),
		):
			out = llm.chat_json([{"role": "user", "content": "hi"}], schema)
		self.assertEqual(out, {"intent": "help"})
		body = post.call_args.kwargs["json"]
		self.assertEqual(
			(body["model"], body["format"], body["think"], body["stream"]),
			("qwen3:14b", schema, False, False),
		)

	def test_a_configured_model_skips_the_lookup(self):
		with (
			patch.object(llm.frappe, "conf", {"assistant_llm_model": "mine"}),
			patch.object(llm, "list_models", side_effect=AssertionError("should not be called")),
			patch.object(llm.requests, "post", return_value=self.response()) as post,
		):
			llm.chat_json([], {})
		self.assertEqual(post.call_args.kwargs["json"]["model"], "mine")

	def test_failures_become_readable_messages(self):
		cases = (
			(requests.ConnectionError(), "isn't running"),
			(requests.Timeout(), "too long"),
		)
		for error, expected in cases:
			with (
				patch.object(llm, "list_models", return_value=["qwen3:14b"]),
				patch.object(llm.requests, "post", side_effect=error),
				self.assertRaisesRegex(llm.LLMError, expected),
			):
				llm.chat_json([], {})

		for status, content, expected in (
			(404, "{}", "isn't installed"),
			(500, "{}", "error"),
			(200, "nope", "unreadable"),
			(200, "[1]", "unreadable"),
		):
			with (
				patch.object(llm, "list_models", return_value=["qwen3:14b"]),
				patch.object(llm.requests, "post", return_value=self.response(status, content)),
				self.assertRaisesRegex(llm.LLMError, expected),
			):
				llm.chat_json([], {})

	def test_a_busy_model_hands_over_to_a_faster_one_and_is_left_alone_for_a_while(self):
		models = ["gemma4-e2b:latest", "qwen3:14b"]
		with (
			patch.object(llm, "list_models", return_value=models),
			patch.object(
				llm.requests, "post", side_effect=[requests.Timeout(), self.response(), self.response()]
			) as post,
		):
			self.assertEqual(llm.chat_json([], {}), {"intent": "help"})
			self.assertEqual(llm.chat_json([], {}), {"intent": "help"})  # the slow model is not asked again
		tried = [call.kwargs["json"]["model"] for call in post.call_args_list]
		self.assertEqual(tried, ["qwen3:14b", "gemma4-e2b:latest", "gemma4-e2b:latest"])
		self.assertEqual(post.call_args_list[0].kwargs["timeout"], llm.FIRST_TRY_SECONDS)

	def test_a_configured_model_is_never_swapped_out(self):
		with (
			patch.object(llm.frappe, "conf", {"assistant_llm_model": "mine"}),
			patch.object(llm.requests, "post", side_effect=requests.Timeout()) as post,
			self.assertRaisesRegex(llm.LLMError, "too long"),
		):
			llm.chat_json([], {})
		self.assertEqual(post.call_count, 1)

	def test_status_says_what_is_wrong(self):
		with patch.object(llm.requests, "get", side_effect=requests.ConnectionError()):
			self.assertFalse(llm.status()["ok"])
		with patch.object(llm, "list_models", return_value=[]):
			self.assertIn("ollama pull", llm.status()["message"])
		with patch.object(llm, "list_models", return_value=["qwen3:14b"]):
			self.assertEqual(llm.status()["model"], "qwen3:14b")
