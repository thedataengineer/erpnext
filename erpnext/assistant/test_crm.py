# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# For license information, please see license.txt

"""The conversation-first CRM: leads, calls, deals and follow-ups from a sentence, search anything,
and the parsing they rely on. Runs in a rolled-back transaction, like test_assistant.py."""

import unittest
from contextlib import contextmanager
from datetime import date

import frappe

from erpnext.assistant import engine, search
from erpnext.assistant.parsing import find_amount, find_date, parse_amount, parse_date
from erpnext.assistant.test_assistant import TODAY, FakeLLM  # a Saturday, 19 Sep 2026

LEAD = ("person", "company", "email", "phone", "notes")
NOTE = ("about", "note", "kind")
DEAL = ("party", "title", "amount", "closing", "notes")
FOLLOW = ("what", "when", "about")


def said(fields, **values):
	"""What the model returns: every key present, null for whatever was not said."""
	return {**dict.fromkeys(fields), **values}


class TestCRMParsing(unittest.TestCase):
	def test_amounts_the_way_people_say_them(self):
		for text, expected in (
			("20k", 20000),
			("$1.5m", 1500000),
			("20,000", 20000),
			("2.5 million", 2500000),
			(15000, 15000),
		):
			self.assertEqual(parse_amount(text), expected, text)
		for text in ("", "0", "lots", None, True, "-5"):
			self.assertIsNone(parse_amount(text), text)

	def test_an_amount_in_a_sentence_needs_a_sign_or_a_suffix(self):
		self.assertEqual(find_amount("opportunity for acme, erp audit, 20k, closing soon"), 20000)
		self.assertEqual(find_amount("worth $15,000"), 15000)
		self.assertIsNone(find_amount("spent 2 hours on it"))
		self.assertIsNone(find_amount("call with 3 people"))

	def test_period_ends_are_worked_out_in_code(self):
		# TODAY is Saturday 19 Sep 2026
		expected = {
			"end of month": date(2026, 9, 30),
			"end of the month": date(2026, 9, 30),
			"end of next month": date(2026, 10, 31),
			"end of week": date(2026, 9, 25),
			"end of this quarter": date(2026, 9, 30),
			"end of the year": date(2026, 12, 31),
			"next week": date(2026, 9, 21),
			"next month": date(2026, 10, 1),
		}
		for text, day in expected.items():
			self.assertEqual(parse_date(text, TODAY, "future"), day, text)
		self.assertEqual(find_date("ship it by end of month please", TODAY, "future"), date(2026, 9, 30))


class TestCRM(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.acme = self.make("Customer", customer_name="Acme Corp")
		self.globex = self.make("Customer", customer_name="Globex")
		self.lead = self.make(
			"Lead",
			first_name="John",
			last_name="Smith",
			company_name="Initech",
			email_id="john@initech.example",
		)
		self.deal = self.make(
			"Opportunity",
			opportunity_from="Customer",
			party_name="Acme Corp",
			title="ERP audit",
			opportunity_amount=20000,
		)

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

	@staticmethod
	def make(doctype, **fields):
		return frappe.get_doc({"doctype": doctype, **fields}).insert()

	def say(self, message, *answers, state=None, context=None):
		llm = FakeLLM(*answers)
		reply = engine.respond(message=message, state=state, llm=llm, today=TODAY, context=context)
		return reply

	@staticmethod
	def row(reply, field):
		return next(r for r in reply["card"]["rows"] if r["field"] == field)

	# --- leads ---

	def test_a_lead_from_one_sentence_with_exact_contact_details(self):
		reply = self.say(
			"new lead Jane Doe from Initech, jane@initech.com, 555 123 4567, interested in an audit",
			{"intent": "create_lead"},
			said(  # the model garbles the exact strings; the sentence decides
				LEAD,
				person="Jane Doe",
				company="Initech",
				email="jane@initech.co",
				phone="5551234567",
				notes="interested in an audit",
			),
		)
		self.assertTrue(reply["card"]["ready"], reply)
		self.assertEqual(self.row(reply, "email")["value"], "jane@initech.com")
		self.assertEqual(self.row(reply, "phone")["value"], "555 123 4567")

		done = engine.create(reply["state"], today=TODAY)
		self.assertEqual(done["reply"], "Lead added: Jane Doe.")
		lead = frappe.get_doc("Lead", done["created"]["name"])
		self.assertEqual((lead.first_name, lead.last_name, lead.company_name), ("Jane", "Doe", "Initech"))
		self.assertEqual((lead.email_id, lead.mobile_no), ("jane@initech.com", "555 123 4567"))
		self.assertEqual(lead.notes[0].note, "interested in an audit")

	def test_a_lead_needs_someone_to_be_a_lead(self):
		reply = self.say("new lead", {"intent": "create_lead"}, said(LEAD))
		self.assertEqual(reply["reply"], "Who's the lead? A person's name or a company works.")
		self.assertEqual(reply["state"]["asking"], "person")
		self.assertFalse(reply["card"]["ready"])

		# a company alone is enough
		reply = engine.respond(
			message="Zeta Corp",
			state=reply["state"],
			llm=FakeLLM(said(LEAD, company="Zeta Corp")),
			today=TODAY,
		)
		self.assertTrue(reply["card"]["ready"], reply)

	def test_the_command_itself_is_not_mistaken_for_a_value(self):
		reply = self.say("new lead", {"intent": "create_lead"}, said(LEAD, notes="new lead"))
		self.assertNotIn("notes", [r["field"] for r in reply["card"]["rows"]])
		# ...but a bare answer to the question just asked is exactly that field
		reply = engine.respond(
			message="Zeta Corp",
			state=reply["state"],
			llm=FakeLLM(said(LEAD, person="Zeta Corp")),
			today=TODAY,
		)
		self.assertEqual(self.row(reply, "person")["value"], "Zeta Corp")

	def test_contact_details_the_sentence_does_not_contain_are_dropped(self):
		reply = self.say(
			"new lead Jane Doe",
			{"intent": "create_lead"},
			said(LEAD, person="Jane Doe", email="jane@made-up.com", phone="555 000 1111"),
		)
		self.assertEqual({r["field"] for r in reply["card"]["rows"]}, {"person"})

	def test_a_duplicate_email_is_reported_before_saving(self):
		reply = self.say(
			"new lead John Smith john@initech.example",
			{"intent": "create_lead"},
			said(LEAD, person="John Smith", email="john@initech.example"),
		)
		self.assertFalse(reply["card"]["ready"])
		self.assertTrue(reply["card"]["problems"])
		self.assertIn("can't save", reply["reply"])

	# --- calls and notes ---

	def test_a_call_note_lands_on_the_customer_and_html_is_escaped(self):
		reply = self.say(
			"just spoke to Acme, they want a proposal",
			{"intent": "log_note"},
			said(NOTE, about="Acme", note="<script>alert(1)</script> want a proposal", kind="Call"),
		)
		self.assertTrue(reply["card"]["ready"], reply)
		self.assertEqual(self.row(reply, "about")["value"], "Acme Corp · Customer")

		done = engine.create(reply["state"], today=TODAY)
		# the link after saving opens the customer, not the comment record
		self.assertEqual(done["created"]["route"], ["Form", "Customer", "Acme Corp"])
		note = frappe.get_all(
			"Comment", filters={"reference_name": "Acme Corp", "comment_type": "Comment"}, fields=["*"]
		)[0]
		self.assertEqual((note.reference_doctype, note.reference_name), ("Customer", "Acme Corp"))
		self.assertTrue(note.content.startswith("<b>Call</b>: "))
		self.assertIn("&lt;script&gt;", note.content)
		self.assertNotIn("<script>", note.content)

	def test_the_record_in_view_is_who_it_is_about(self):
		context = {"doctype": "Lead", "name": self.lead.name}
		reply = self.say(
			"log a call: left a voicemail",
			{"intent": "log_note"},
			said(NOTE, note="left a voicemail", kind="Call"),
			context=context,
		)
		self.assertTrue(reply["card"]["ready"], reply)
		self.assertIn("John Smith", self.row(reply, "about")["value"])

		done = engine.create(reply["state"], today=TODAY)
		self.assertEqual(done["created"]["route"], ["Form", "Lead", self.lead.name])
		self.assertTrue(
			frappe.db.exists("Comment", {"reference_doctype": "Lead", "reference_name": self.lead.name})
		)

	def test_naming_someone_else_beats_the_record_in_view(self):
		reply = self.say(
			"spoke to Globex, all good",
			{"intent": "log_note"},
			said(NOTE, about="Globex", note="all good", kind="Call"),
			context={"doctype": "Lead", "name": self.lead.name},
		)
		self.assertEqual(self.row(reply, "about")["value"], "Globex · Customer")

	def test_a_tapped_suggestion_starts_on_the_record_in_view(self):
		reply = engine.respond(
			action={"type": "start", "recipe": "log_note", "values": {"kind": "Call"}},
			llm=FakeLLM(),
			today=TODAY,
			context={"doctype": "Customer", "name": "Acme Corp"},
		)
		self.assertEqual(self.row(reply, "about")["value"], "Acme Corp · Customer")
		self.assertEqual(reply["state"]["asking"], "note")
		self.assertEqual(reply["reply"], "What happened?")

	def test_a_reference_to_a_record_that_is_not_there_is_not_trusted(self):
		state = {"recipe": "log_note", "values": {"about": "Lead::NO-SUCH-LEAD", "note": "hi"}, "stack": []}
		reply = engine.respond(
			action={"type": "discard"}, state={**state, "stack": [state]}, llm=FakeLLM(), today=TODAY
		)
		self.assertEqual(self.row(reply, "about")["status"], "none")

	def test_an_unknown_name_offers_to_create_it_and_the_note_carries_on(self):
		reply = self.say(
			"log a call with Zeta Corp: they are hiring",
			{"intent": "log_note"},
			said(NOTE, about="Zeta Corp", note="they are hiring", kind="Call"),
		)
		self.assertEqual(
			reply["reply"], "I couldn't find “Zeta Corp”."
		)  # and not "Acme Corp", which shares only "Corp"
		labels = [c["label"] for c in reply["chips"]]
		self.assertIn("Create lead “Zeta Corp”", labels)
		self.assertIn("Create client “Zeta Corp”", labels)
		lead_chip = next(c for c in reply["chips"] if c["label"].startswith("Create lead"))
		self.assertEqual(lead_chip["action"]["values"], {"company": "Zeta Corp"})  # a company, not a person

		reply = engine.respond(action=lead_chip["action"], state=reply["state"], llm=FakeLLM(), today=TODAY)
		self.assertEqual(reply["state"]["recipe"], "create_lead")
		reply = engine.create(reply["state"], today=TODAY)  # makes the lead, then goes back to the note
		self.assertEqual(reply["created"]["doctype"], "Lead")
		self.assertEqual(reply["state"]["recipe"], "log_note")
		self.assertTrue(reply["card"]["ready"], reply)

		reply = engine.create(reply["state"], today=TODAY)
		new_lead = frappe.get_all("Lead", filters={"company_name": "Zeta Corp"}, pluck="name")[0]
		self.assertEqual(reply["created"]["route"], ["Form", "Lead", new_lead])
		self.assertTrue(
			frappe.db.exists("Comment", {"reference_doctype": "Lead", "reference_name": new_lead})
		)

	def test_a_person_looks_like_a_person_and_gets_a_lead_with_their_name(self):
		reply = self.say(
			"note on Jane Doe: interested",
			{"intent": "log_note"},
			said(NOTE, about="Jane Doe", note="interested", kind="Note"),
		)
		lead_chip = next(c for c in reply["chips"] if c["label"].startswith("Create lead"))
		self.assertEqual(lead_chip["action"]["values"], {"person": "Jane Doe"})

	# --- opportunities ---

	def test_an_opportunity_with_a_value_and_a_closing_date(self):
		reply = self.say(
			"opportunity for Acme: ERP audit, 20k, closing end of month",
			{"intent": "create_opportunity"},
			said(
				DEAL, party="Acme", title="ERP audit", amount=2000, closing="end of month"
			),  # the model dropped a zero
		)
		self.assertTrue(reply["card"]["ready"], reply)
		self.assertIn("20,000", self.row(reply, "amount")["value"])
		self.assertEqual(self.row(reply, "closing")["value"], "Wed 30 Sep 2026")

		done = engine.create(reply["state"], today=TODAY)
		deal = frappe.get_doc("Opportunity", done["created"]["name"])
		self.assertEqual((deal.opportunity_from, deal.party_name), ("Customer", "Acme Corp"))
		self.assertEqual((deal.opportunity_amount, str(deal.expected_closing)), (20000, "2026-09-30"))

	def test_an_opportunity_can_be_for_a_lead(self):
		reply = self.say(
			"deal for John Smith",
			{"intent": "create_opportunity"},
			said(DEAL, party="John Smith"),
		)
		self.assertTrue(reply["card"]["ready"], reply)
		done = engine.create(reply["state"], today=TODAY)
		deal = frappe.get_doc("Opportunity", done["created"]["name"])
		self.assertEqual((deal.opportunity_from, deal.party_name), ("Lead", self.lead.name))

	# --- follow-ups ---

	def test_a_follow_up_becomes_a_todo_for_me_on_that_customer(self):
		reply = self.say(
			"follow up with Globex next tuesday about the contract",
			{"intent": "follow_up"},
			said(FOLLOW, what="follow up about the <contract>", when="next tuesday", about="Globex"),
		)
		self.assertTrue(reply["card"]["ready"], reply)
		self.assertEqual(self.row(reply, "when")["value"], "Tue 22 Sep 2026")

		done = engine.create(reply["state"], today=TODAY)
		todo = frappe.get_doc("ToDo", done["created"]["name"])
		self.assertEqual(
			(todo.allocated_to, todo.reference_type, todo.reference_name),
			("Administrator", "Customer", "Globex"),
		)
		self.assertEqual(str(todo.date), "2026-09-22")
		self.assertIn("&lt;contract&gt;", todo.description)

	def test_a_follow_up_does_not_need_to_be_about_anyone(self):
		reply = self.say(
			"remind me to chase invoices", {"intent": "follow_up"}, said(FOLLOW, what="chase invoices")
		)
		self.assertTrue(reply["card"]["ready"], reply)

	# --- questions and the menu ---

	def test_the_pipeline_is_answered_without_the_model(self):
		reply = self.say("how's my pipeline")  # FakeLLM has no answers: asking it would fail
		self.assertEqual([i["label"] for i in reply["items"]], ["ERP audit"])
		self.assertIn("1 open deals", reply["reply"])
		self.assertEqual(reply["items"][0]["route"], ["Form", "Opportunity", self.deal.name])

	def test_no_open_deals_offers_to_add_one(self):
		frappe.db.set_value("Opportunity", self.deal.name, "status", "Lost")
		reply = self.say("open deals")
		self.assertEqual(reply["chips"][0]["action"]["recipe"], "create_opportunity")

	def test_the_menu_starts_with_crm(self):
		reply = self.say("hi")
		self.assertEqual(
			[c["label"] for c in reply["chips"]][:4],
			["New lead", "Log a call", "Follow up", "New opportunity"],
		)

	def test_after_saving_the_next_step_is_offered(self):
		reply = self.say(
			"new client Umbrella",
			{"intent": "create_customer"},
			{"customer_name": "Umbrella", "customer_type": None},
		)
		done = engine.create(reply["state"], today=TODAY)
		self.assertEqual(done["chips"][0]["label"], "Another client")


class TestSearch(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		make = lambda doctype, **f: frappe.get_doc({"doctype": doctype, **f}).insert()  # noqa: E731
		self.acme = make("Customer", customer_name="Acme Corp")
		self.lead = make(
			"Lead",
			first_name="John",
			last_name="Smith",
			company_name="Acme Labs",
			email_id="john@acme.example",
		)
		make(
			"Opportunity",
			opportunity_from="Customer",
			party_name="Acme Corp",
			title="ERP audit",
			opportunity_amount=20000,
		)
		make("Task", subject="Prepare Acme proposal")

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	def test_records_are_grouped_by_kind_with_crm_first(self):
		result = search.search("acme")
		labels = [g["label"] for g in result["groups"]]
		self.assertEqual(labels[:3], ["Leads", "Opportunities", "Customers"])
		self.assertIn("Tasks", labels)
		lead = result["groups"][0]["items"][0]
		self.assertEqual((lead["title"], lead["route"]), ("John Smith", ["Form", "Lead", self.lead.name]))
		self.assertIn("Acme Labs", lead["subtitle"])

	def test_the_kind_you_are_looking_at_comes_first(self):
		result = search.search("acme", {"doctype": "Customer", "name": "Acme Corp"})
		self.assertEqual(result["groups"][0]["label"], "Customers")

	def test_a_kind_name_offers_its_list(self):
		result = search.search("leads")
		self.assertEqual(result["groups"][0]["label"], "Go to")
		self.assertEqual(result["groups"][0]["items"][0]["route"], ["List", "Lead"])

	def test_actions_follow_what_is_typed(self):
		self.assertEqual([a["label"] for a in search.search("new le")["actions"]], ["New lead"])
		self.assertEqual(search.search("pipe")["actions"][0]["label"], "Pipeline")
		self.assertEqual(
			search.search("log a call")["actions"][0]["action"],
			{"type": "start", "recipe": "log_note", "values": {"kind": "Call"}},
		)

	def test_opening_the_bar_shows_recent_records_and_crm_actions_without_duplicates(self):
		result = search.search("")
		self.assertEqual(result["groups"][0]["label"], "Recent")
		titles = [i["title"] for i in result["groups"][0]["items"]]
		self.assertEqual(len(titles), len(set(titles)), "a lead's auto-created contact must not repeat it")
		self.assertEqual(
			[a["label"] for a in result["actions"]][:4],
			["New lead", "Log a call", "Follow up", "New opportunity"],
		)
		self.assertIsNone(result["ask"])

	def test_viewing_a_customer_puts_call_and_follow_up_first(self):
		result = search.search("", {"doctype": "Customer", "name": "Acme Corp"})
		self.assertEqual([a["label"] for a in result["actions"]][:2], ["Log a call", "Follow up"])

	def test_a_sentence_is_offered_to_the_assistant_as_the_main_choice(self):
		self.assertTrue(search.search("log a call with acme about the renewal")["ask"]["primary"])
		self.assertTrue(search.search("how's my pipeline")["ask"]["primary"])
		self.assertFalse(search.search("acme")["ask"]["primary"])

	def test_it_only_shows_what_the_person_may_read(self):
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": "no-access@example.com",
				"first_name": "No Access",
				"send_welcome_email": 0,
			}
		).insert()
		frappe.set_user(user.name)
		result = search.search("acme")
		self.assertEqual(result["groups"], [])
		self.assertEqual(result["actions"], [])

	def test_hostile_input_is_tamed(self):
		self.assertEqual(len(search.search("x" * 1000)["query"]), 100)
		self.assertEqual(search.search(None)["groups"][0]["label"], "Recent")
		result = search.search("acme%'; drop table tabLead; --", {"doctype": "nope", "name": "x"})
		self.assertEqual(result["groups"], [])
		self.assertTrue(frappe.db.exists("DocType", "Lead"))
