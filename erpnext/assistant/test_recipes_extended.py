# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

# The recipes added for ADHD-004: expense claim, material request, and time against a task.
# Pure unit tests of each recipe's `build` (no site, no model), so they need no bootstrap data.

import unittest
from unittest.mock import patch

from erpnext.assistant.recipes import RECIPES


class TestExtendedRecipes(unittest.TestCase):
	def test_registry_keeps_the_existing_recipes(self):
		for key in (
			"create_lead",
			"create_opportunity",
			"log_time",
			"create_task",
			"create_expense_claim",
			"create_material_request",
			"create_timesheet_detail",
		):
			self.assertIn(key, RECIPES)

	def test_expense_claim_builds_child_expense_row(self):
		doc = RECIPES["create_expense_claim"].build(
			{
				"employee": "EMP-001",
				"expense_date": "2026-09-20",
				"expense_type": "Travel",
				"amount": 850,
				"description": "Client visit",
			}
		)
		self.assertEqual(doc["doctype"], "Expense Claim")
		self.assertEqual(doc["expenses"][0]["expense_type"], "Travel")
		self.assertEqual(doc["expenses"][0]["amount"], 850)

	def test_material_request_builds_child_item_row(self):
		doc = RECIPES["create_material_request"].build(
			{
				"item_code": "RM-001",
				"qty": 50,
				"schedule_date": "2026-09-27",
				"material_request_type": "Purchase",
				"warehouse": "Stores - ACME",
			}
		)
		self.assertEqual(doc["doctype"], "Material Request")
		self.assertEqual(doc["items"][0]["item_code"], "RM-001")
		self.assertEqual(doc["items"][0]["qty"], 50)

	def test_timesheet_detail_builds_timesheet_row(self):
		with (
			patch("erpnext.assistant.recipes._next_start", return_value="2026-09-20 08:00:00"),
			patch("erpnext.assistant.recipes._employee_for_user", return_value="EMP-001"),
		):
			doc = RECIPES["create_timesheet_detail"].build(
				{
					"task": "TASK-0001",
					"project": "PROJ-001",
					"hours": 2,
					"date": "2026-09-20",
					"activity_type": "Execution",
				}
			)
		self.assertEqual(doc["doctype"], "Timesheet")
		self.assertEqual(doc["employee"], "EMP-001")
		self.assertEqual(doc["time_logs"][0]["task"], "TASK-0001")
		self.assertEqual(doc["time_logs"][0]["hours"], 2)
