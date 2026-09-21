from unittest.mock import patch

from erpnext.assistant.recipes import RECIPES


def test_extended_recipe_registry_preserves_existing_recipes():
	for key in (
		"create_lead",
		"create_opportunity",
		"log_time",
		"create_task",
		"create_expense_claim",
		"create_material_request",
		"create_timesheet_detail",
	):
		assert key in RECIPES


def test_expense_claim_builds_child_expense_row():
	doc = RECIPES["create_expense_claim"].build(
		{
			"employee": "EMP-001",
			"expense_date": "2026-09-20",
			"expense_type": "Travel",
			"amount": 850,
			"description": "Client visit",
		}
	)
	assert doc["doctype"] == "Expense Claim"
	assert doc["expenses"][0]["expense_type"] == "Travel"
	assert doc["expenses"][0]["amount"] == 850


def test_material_request_builds_child_item_row():
	doc = RECIPES["create_material_request"].build(
		{
			"item_code": "RM-001",
			"qty": 50,
			"schedule_date": "2026-09-27",
			"material_request_type": "Purchase",
			"warehouse": "Stores - ACME",
		}
	)
	assert doc["doctype"] == "Material Request"
	assert doc["items"][0]["item_code"] == "RM-001"
	assert doc["items"][0]["qty"] == 50


def test_timesheet_detail_builds_timesheet_row():
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
	assert doc["doctype"] == "Timesheet"
	assert doc["employee"] == "EMP-001"
	assert doc["time_logs"][0]["task"] == "TASK-0001"
	assert doc["time_logs"][0]["hours"] == 2
