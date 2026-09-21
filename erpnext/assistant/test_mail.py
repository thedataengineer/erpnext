# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Tests for asking about email and connecting a mailbox through the conversation.

Like the other assistant tests these run in a transaction that is rolled back, use a scripted fake in place
of the model, and deliberately do not use ERPNextTestSuite (importing erpnext.tests.utils bootstraps and
commits test data into whatever site it runs on).
"""

import json
import unittest
from contextlib import contextmanager
from unittest.mock import patch

import frappe
from frappe.utils import add_to_date, now_datetime

from erpnext.assistant import engine, mail, search
from erpnext.assistant.test_assistant import TODAY, FakeLLM

SUBJECT_TRICK = "Invoice" + chr(0x202E) + chr(0) + " due\nnow " + "x" * 400


class NoModel:
	"""A model that must never be asked: proves a question is answered without it."""

	def __init__(self):
		self.calls = 0

	def __call__(self, messages, schema):
		self.calls += 1
		raise AssertionError("the language model must not be consulted")


class TestCues(unittest.TestCase):
	def test_questions_about_mail_are_recognised(self):
		for text in (
			"what did Acme email me",
			"any emails from Acme?",
			"show my emails",
			"my inbox",
			"any new mail",
			"did jo reply",
			"has Jo replied?",
			"who wrote to me",
			"latest emails",
			"check my email from globex",
		):
			self.assertTrue(mail.is_email_question(text), text)

	def test_other_sentences_are_left_alone(self):
		# most of these contain the word "email" but are about doing something else
		for text in (
			"what is Jo's email",
			"new lead Jo, email jo@acme.com",
			"log a call with jo: they will reply on friday",
			"spent 2h on the email campaign",
			"create a task to email the client",
			"remind me to email jo",
			"how's my pipeline",
			"what should i do today",
			"add an email to Acme's contact",
			"i sent the proposal",
			# found by the security review: they mention mail but are notes, tasks or other questions
			"new email campaign for Acme",
			"Have Sam email the client about pricing",
			"Have Priya write the proposal",
			"what mail server does Acme use",
			"who wrote the SOW",
			"Any update: she replied on Friday",
			"Inbox Zero",
		):
			self.assertFalse(mail.is_email_question(text), text)

	def test_connecting_is_recognised(self):
		for text in (
			"connect my email",
			"sync my gmail",
			"set up my inbox",
			"email sync",
			"hook up outlook",
			"can you connect my mailbox jo@gmail.com",
			"connect jo@gmail.com",
			"please sync my email",
			"connect jo@gmail.com password hunter2",
		):
			self.assertTrue(mail.is_connect_request(text), text)
		for text in (
			"add an email address to Jo",
			"sync the timesheets",
			"my emails",
			# a customer whose name ends in "Sync" is not a request to sync email
			"what did Acme Sync email me",
			"link the email from Jo to the Acme lead",
			"add outlook meeting invite for Jo",
			"set up an inbox rule",
			"connect the mail to the lead",
		):
			self.assertFalse(mail.is_connect_request(text), text)
		self.assertTrue(mail.is_email_question("what did Acme Sync email me"))

	def test_a_bare_fragment_is_left_to_the_model_not_the_cue(self):
		# "emails about the proposal" reads like a query, but it is also how a note might start; while a draft
		# is open a cue would swallow it, so only whole questions are matched without the model
		self.assertFalse(mail.is_email_question("emails about the proposal"))
		self.assertEqual(mail.term_of("emails about the proposal"), "proposal")

	def test_who_is_asked_about(self):
		for text, term in (
			("what did Acme email me", "Acme"),
			("emails from Acme Corp this week", "Acme Corp"),
			("did jo reply?", "jo"),
			("has Globex replied", "Globex"),
			("emails about the proposal", "proposal"),
			("any emails?", ""),
			("show my emails", ""),
			("what did the client say by email", ""),
			("emails from 100%_abc", "100_abc"),
			("what did Acme Sync email me", "Acme Sync"),
			# a whole address is the term, not the part before its first dot or underscore
			("emails from jo.smith@acme.com", "jo.smith@acme.com"),
			("did john_smith@acme.com reply", "john_smith@acme.com"),
		):
			self.assertEqual(mail.term_of(text), term, text)

	def test_connecting_wins_over_asking_when_both_could_match(self):
		lowered = "sync my email"
		found = next(name for name, cue in engine.QUERY_CUES.items() if cue.search(lowered))
		self.assertEqual(found, "connect_email")


class TestMail(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.lead = self.make(
			"Lead",
			first_name="Jo",
			last_name="Bloggs",
			company_name="Acme Labs",
			email_id="jo@personal.example",
		)
		self.older = self.email("Quote for the rollout", sender="pat@acme.example", name="Pat", days_ago=2)
		self.newer = self.email("Re: quote", sender="pat@acme.example", name="Pat", days_ago=1)
		# neither the sender nor the subject mention the company: only the lead it is attached to does
		self.attached = self.email(
			"Following up", sender="jo@personal.example", name="Jo Bloggs", reference=self.lead
		)
		self.other = self.email("Lunch?", sender="sam@elsewhere.example", name="Sam")

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	@staticmethod
	def make(doctype, **fields):
		return frappe.get_doc({"doctype": doctype, **fields}).insert()

	def email(
		self, subject, *, sender, name, days_ago=0, reference=None, received=True, medium="Email", **extra
	):
		doc = {
			"doctype": "Communication",
			"communication_type": "Communication",
			"communication_medium": medium,
			"sent_or_received": "Received" if received else "Sent",
			"subject": subject,
			"sender": sender,
			"sender_full_name": name,
			"recipients": "me@example.com",
			"content": "<p>secret body text</p>",
			"communication_date": add_to_date(now_datetime(), days=-days_ago),
			**extra,
		}
		if reference:
			doc.update(reference_doctype=reference.doctype, reference_name=reference.name)
		return frappe.get_doc(doc).insert(ignore_permissions=True)

	# --- what is found ---

	def test_the_newest_received_email_comes_first(self):
		subjects = [row["subject"] for row in mail.received_emails("")]
		# "Following up" and "Lunch?" arrived just now, "Re: quote" yesterday, "Quote for the rollout" before
		self.assertEqual(set(subjects[:2]), {"Following up", "Lunch?"})
		self.assertLess(subjects.index("Re: quote"), subjects.index("Quote for the rollout"))

	def test_only_received_email_is_listed(self):
		self.email("We sent this", sender="me@example.com", name="Me", received=False)
		self.email("A call", sender="pat@acme.example", name="Pat", medium="Phone")
		subjects = [row["subject"] for row in mail.received_emails("")]
		self.assertNotIn("We sent this", subjects)
		self.assertNotIn("A call", subjects)

	def test_a_name_finds_mail_by_sender_and_by_the_record_it_is_attached_to(self):
		subjects = {row["subject"] for row in mail.received_emails("Acme")}
		self.assertEqual(subjects, {"Quote for the rollout", "Re: quote", "Following up"})
		# "Following up" is neither from nor about Acme: it is on Acme Labs' lead
		self.assertNotIn("Lunch?", subjects)

	def test_a_name_finds_mail_by_subject(self):
		self.assertEqual([row["subject"] for row in mail.received_emails("lunch")], ["Lunch?"])

	def test_a_wildcard_in_a_search_is_not_a_wildcard(self):
		self.assertEqual(mail.term_of("emails from %"), "")
		self.assertEqual(mail.received_emails("zzz-no-such-sender"), [])

	def test_someone_who_may_not_read_email_sees_none_of_it(self):
		user = self.make(
			"User", email="mail-noperms@example.com", first_name="No Perms", send_welcome_email=0
		)
		frappe.set_user(user.name)
		with patch("frappe.has_permission", side_effect=lambda dt, *a, **k: dt != "Communication"):
			self.assertIsNone(mail.received_emails("Acme"))
			reply = engine.respond("any emails from acme", llm=NoModel(), today=TODAY)
		self.assertEqual(reply["items"], [])
		self.assertIn("access", reply["reply"])

	# --- what is shown ---

	def test_text_written_by_a_sender_is_shown_as_one_short_plain_line(self):
		self.email(SUBJECT_TRICK, sender="evil@example.com", name="Evil" + chr(0x202E) + "\nName")
		row = next(r for r in mail.received_emails("evil") if r["sender"] == "evil@example.com")
		item = mail.email_items([row])[0]
		self.assertLessEqual(len(item["label"]), 120)
		for text in (item["label"], item["meta"]):
			self.assertNotIn("\n", text)
			self.assertTrue(all(ch.isprintable() for ch in text), repr(text))

	def test_a_mail_on_a_lead_opens_the_lead_and_others_open_the_email(self):
		items = {i["label"]: i for i in mail.email_items(mail.received_emails(""))}
		self.assertEqual(items["Following up"]["route"], ["Form", "Lead", self.lead.name])
		self.assertEqual(items["Lunch?"]["route"], ["Form", "Communication", self.other.name])

	# --- the conversation ---

	def test_the_question_is_answered_without_the_model_and_without_its_text(self):
		model = NoModel()
		reply = engine.respond("what did Acme email me", llm=model, today=TODAY)
		self.assertEqual(model.calls, 0)
		self.assertEqual(len(reply["items"]), 3)
		self.assertIn("3 emails from Acme", reply["reply"])
		# the sentence is built from counts and dates, never from what a mail says
		self.assertNotIn("secret body text", json.dumps(reply))
		self.assertNotIn("Following up", reply["reply"])

	def test_nothing_from_a_name_says_so(self):
		with patch("frappe.db.count", side_effect=lambda dt, *a, **k: 1 if dt == "Email Account" else 0):
			reply = engine.respond("did nobody-here reply", llm=NoModel(), today=TODAY)
		self.assertIn("Nothing from", reply["reply"])
		self.assertIn("10 minutes", reply["reply"])

	def test_with_no_mailbox_connected_it_offers_to_connect_one(self):
		frappe.db.delete("Communication", {"communication_medium": "Email"})
		with patch("frappe.db.count", side_effect=lambda dt, *a, **k: 0 if dt == "Email Account" else 1):
			reply = engine.respond("show my emails", llm=NoModel(), today=TODAY)
		self.assertIn("No email is connected", reply["reply"])
		self.assertEqual([c["label"] for c in reply["chips"]], ["Connect my email"])
		self.assertEqual(reply["chips"][0]["action"], {"type": "query", "name": "connect_email"})

	def test_email_can_be_asked_about_while_a_draft_is_open(self):
		model = FakeLLM({"intent": "create_lead"}, {"lead_name": None, "company": "Initech", "email": None})
		first = engine.respond("new lead at Initech", llm=model, today=TODAY)
		self.assertEqual(first["state"]["recipe"], "create_lead")
		second = engine.respond("any emails from acme?", state=first["state"], llm=NoModel(), today=TODAY)
		self.assertEqual(len(second["items"]), 3)
		self.assertEqual(second["state"]["recipe"], "create_lead", "the open draft stays open")

	def test_a_reply_the_owner_sent_is_not_listed_as_something_a_customer_wrote(self):
		# Frappe stores an owner's reply that carries In-Reply-To as received mail
		self.email("Re: quote (my reply)", sender="me@example.com", name="Me")
		with patch.object(mail, "_own_addresses", return_value=["me@example.com"]):
			subjects = [row["subject"] for row in mail.received_emails("")]
		self.assertNotIn("Re: quote (my reply)", subjects)
		self.assertIn("Re: quote", subjects)

	def test_mail_the_person_may_not_read_is_dropped_even_when_the_list_query_returns_it(self):
		# frappe.get_list applies roles and permission query conditions, not each document's own hook
		with patch.object(mail, "_may_read", side_effect=lambda name: name != self.attached.name):
			subjects = [row["subject"] for row in mail.received_emails("")]
		self.assertNotIn("Following up", subjects)
		self.assertIn("Lunch?", subjects)

	def test_the_sender_is_shown_with_their_address(self):
		# "Jane (CFO)" is whatever a sender chose to be called
		self.email("Wire this today", sender="attacker@evil.example", name="Jane (CFO)")
		row = next(r for r in mail.received_emails("wire") if r["subject"] == "Wire this today")
		self.assertIn("<attacker@evil.example>", mail.email_items([row])[0]["meta"])

	def test_a_mail_linked_through_the_timeline_opens_the_lead(self):
		# Frappe links synced mail to the sender's Lead with a Communication Link row, not reference_*
		mail_doc = self.email("Via the timeline", sender="jo@personal.example", name="Jo")
		mail_doc.append("timeline_links", {"link_doctype": "Lead", "link_name": self.lead.name})
		mail_doc.save(ignore_permissions=True)
		row = next(r for r in mail.received_emails("timeline") if r["name"] == mail_doc.name)
		self.assertEqual(mail.email_items([row])[0]["route"], ["Form", "Lead", self.lead.name])

	def test_a_typed_password_is_not_used_kept_or_sent_to_the_model(self):
		model = NoModel()
		reply = engine.respond("my gmail password is hunter2", llm=model, today=TODAY)
		self.assertEqual(model.calls, 0)
		self.assertIn("password or key", reply["reply"])
		self.assertNotIn("hunter2", json.dumps(reply))
		self.assertIsNone(reply["state"]["recipe"])

	def test_asking_to_connect_while_a_draft_is_open_keeps_the_drafts_card(self):
		model = FakeLLM({"intent": "create_lead"}, {"lead_name": None, "company": "Initech", "email": None})
		first = engine.respond("new lead at Initech", llm=model, today=TODAY)
		second = engine.respond("connect my email", state=first["state"], llm=NoModel(), today=TODAY)
		self.assertEqual(second["state"]["recipe"], "create_lead")
		self.assertEqual(second["card"]["recipe"], "create_lead", "the draft's card, not the connect card")
		self.assertIn("once this is done", second["reply"])

	# --- searching ---

	def test_searching_a_name_finds_mail_in_its_own_group(self):
		groups = {g["doctype"]: g for g in search.search("Following")["groups"]}
		self.assertIn("Communication", groups)
		self.assertEqual(groups["Communication"]["label"], "Emails")
		item = groups["Communication"]["items"][0]
		self.assertEqual(item["title"], "Following up")
		self.assertNotIn("secret body text", json.dumps(search.search("Following")))

	def test_the_bar_does_not_scan_the_mail_table_for_a_couple_of_letters(self):
		self.assertNotIn("Communication", {g["doctype"] for g in search.search("Fo")["groups"]})
		self.assertIn("Communication", {g["doctype"] for g in search.search("Follo")["groups"]})

	def test_mail_is_not_in_the_recent_list(self):
		recent = search.search("")
		self.assertNotIn("Communication", {g["doctype"] for g in recent["groups"]})

	def test_the_bar_offers_the_email_actions(self):
		titles = {a["label"] for a in search.search("email")["actions"]}
		self.assertIn("My emails", titles)
		self.assertIn("Connect my email", titles)


class TestConnect(unittest.TestCase):
	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	def connect(self, message):
		return engine.respond(message, llm=NoModel(), today=TODAY)

	def test_an_address_becomes_a_card_that_opens_the_form_receive_only(self):
		with patch("frappe.get_all", return_value=[]):
			reply = self.connect("connect my gmail jo@gmail.com")
		card = reply["card"]
		self.assertEqual(card["doctype"], "Email Account")
		self.assertTrue(card["form_only"])
		self.assertFalse(card["ready"], "there is nothing to create until the password is typed in the form")
		prefill = card["prefill"]
		self.assertEqual(prefill["email_id"], "jo@gmail.com")
		self.assertEqual(prefill["service"], "GMail")
		self.assertEqual(prefill["email_server"], "imap.gmail.com")
		self.assertEqual((prefill["use_imap"], prefill["use_ssl"], prefill["incoming_port"]), (1, 1, "993"))
		self.assertEqual(prefill["enable_incoming"], 1)
		self.assertEqual(prefill["enable_outgoing"], 0, "nothing here sends mail")
		self.assertEqual(prefill["create_contact"], 0)
		self.assertEqual(prefill["email_sync_option"], "UNSEEN")
		self.assertIn("app password", " ".join(card["problems"]).lower())

	def test_the_card_never_carries_a_password(self):
		with patch("frappe.get_all", return_value=[]):
			reply = self.connect("connect jo@gmail.com password hunter2")
		self.assertNotIn("hunter2", json.dumps(reply))
		self.assertFalse({"password", "awaiting_password", "login_id"} & set(reply["card"]["prefill"]))
		password_row = next(r for r in reply["card"]["rows"] if r["field"] == "password")
		self.assertEqual(password_row["status"], "missing")
		self.assertIn("never in this chat", password_row["note"])

	def test_an_unknown_provider_gets_a_guessed_server_and_says_so(self):
		with patch("frappe.get_all", return_value=[]):
			reply = self.connect("connect my email jo@smallfirm.example")
		card = reply["card"]
		self.assertIsNone(card["prefill"]["service"])
		self.assertEqual(card["prefill"]["email_server"], "imap.smallfirm.example")
		self.assertIn("guess", " ".join(card["problems"]))

	def test_without_an_address_the_form_asks_for_it(self):
		with patch("frappe.get_all", return_value=[]):
			reply = self.connect("connect my email")
		card = reply["card"]
		self.assertNotIn("email_id", card["prefill"])
		self.assertEqual(card["prefill"]["enable_incoming"], 1)
		address = next(r for r in card["rows"] if r["field"] == "email_id")
		self.assertEqual(address["status"], "missing")

	def test_when_a_mailbox_is_connected_it_says_so_instead(self):
		account = frappe._dict(name="Work", email_id="me@work.example")
		with (
			patch("frappe.get_all", return_value=[account]),
			patch("frappe.has_permission", return_value=True),
		):
			reply = self.connect("sync my email")
		self.assertIsNone(reply["card"])
		self.assertIn("connected", reply["reply"])
		self.assertEqual(reply["items"][0]["route"], ["Form", "Email Account", "Work"])

	def test_a_password_typed_after_the_address_is_ignored_and_the_person_is_told(self):
		with patch("frappe.get_all", return_value=[]):
			reply = self.connect("connect jo@gmail.com password hunter2")
		self.assertIn("ignored", reply["reply"])
		self.assertNotIn("hunter2", json.dumps(reply))
		self.assertIsNotNone(reply["card"])

	def test_the_card_says_to_leave_outgoing_mail_off(self):
		# picking a provider in Frappe's form switches outgoing mail on, so the person is told
		with patch("frappe.get_all", return_value=[]):
			reply = self.connect("connect my email")
		self.assertIn("Enable Outgoing", " ".join(reply["card"]["problems"]))

	def test_someone_who_cannot_create_an_email_account_is_not_given_the_card(self):
		with patch(
			"frappe.has_permission",
			side_effect=lambda dt, ptype=None, *a, **k: not (dt == "Email Account" and ptype == "create"),
		):
			reply = self.connect("connect my email")
		self.assertIsNone(reply["card"])
		self.assertIn("administrator", reply["reply"])

	def test_an_address_that_is_already_connected_says_so_instead_of_offering_a_duplicate(self):
		account = frappe._dict(name="Work", email_id="me@work.example")
		with (
			patch("frappe.db.exists", side_effect=lambda dt, *a, **k: dt == "Email Account"),
			patch("frappe.get_all", return_value=[account]),
			patch("frappe.has_permission", return_value=True),
		):
			reply = self.connect("connect me@work.example")
		self.assertIsNone(reply["card"])
		self.assertIn("already connected", reply["reply"])

	def test_the_password_never_reaches_the_saved_conversation_state(self):
		with patch("frappe.get_all", return_value=[]):
			reply = self.connect("set up my inbox me@work.example pw: correct-horse-battery")
		self.assertNotIn("correct-horse-battery", json.dumps(reply["state"]))

	@contextmanager
	def _nothing(self):
		yield
