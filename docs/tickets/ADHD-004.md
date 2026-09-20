# ADHD-004: Extend Command Bar Beyond CRM

## Summary
Adds four new natural-language command recipes to the existing Conversational CRM command bar — Task creation, Expense Claim, Material Request, and Timesheet Detail — each following the existing confirm-before-save contract so users can create documents without navigating to their respective modules.

## Background / Context
The conversational command bar already handles CRM document creation (Leads, Opportunities, Contacts) by parsing free-text input and confirming before saving. ADHD users who discovered this shortcut quickly find its vocabulary exhausting — they have to mentally switch to "CRM mode" for every creation that falls outside those three doctypes. Adding Task, Expense Claim, Material Request, and Timesheet Detail covers the four most common non-CRM daily operations, reducing the number of module navigations required to start new work items from four trips to one typed sentence.

## Cognitive Mechanism
Initiation | attention switching | working memory

## Prerequisites
- The `feat/conversational-crm-assistant` branch must be merged into the target branch before this work begins. Specifically:
  - `erpnext/assistant/recipes.py` must exist and contain at least one working recipe class.
  - `erpnext/assistant/engine.py` must contain the classifier/intent-detection prompt.
  - The confirm-before-save UI flow must be functional end-to-end.

## Scope
**Modify:**
- `erpnext/assistant/recipes.py` — add four new recipe classes
- `erpnext/assistant/engine.py` — extend the classifier prompt with the four new intents and their example utterances

**Create:**
- `erpnext/assistant/test_recipes_extended.py` — test module for the four new recipes, following conventions in existing `test_crm.py`

## What Needs to Be Done

1. **Study the existing recipe contract.** Each recipe in `recipes.py` must implement:
   - `intent` — string constant matching the classifier label (e.g., `"create_task"`)
   - `extract(parsed_input: dict) -> dict` — maps NLP-extracted slots to ERPNext field names
   - `confirm_message(extracted: dict) -> str` — returns a human-readable confirmation string shown to the user before save
   - `execute(extracted: dict) -> frappe.Document` — creates and optionally submits the document

2. **Recipe: `CreateTaskRecipe`.**
   - `intent = "create_task"`
   - Extracted fields: `subject` (required), `assigned_to` (default: current user), `exp_end_date` (parsed from utterance or default: today + 3 days), `project` (optional), `priority` (Low/Medium/High, default: Medium).
   - `confirm_message`: `"Create Task: '{subject}' assigned to {assigned_to}, due {exp_end_date} — Priority: {priority}. Confirm?"`
   - `execute`: `frappe.new_doc("Task")`, set fields, call `doc.insert()`. Do not submit (Tasks are not submitted docs).

3. **Recipe: `CreateExpenseClaimRecipe`.**
   - `intent = "create_expense_claim"`
   - Extracted fields: `employee` (required — resolve from `frappe.session.user` → Employee if not stated), `expense_date` (default: today), `expense_type` / `expense_claim_type` (required), `amount` (required), `description` (optional).
   - `confirm_message`: `"Create Expense Claim: {expense_type} for {amount} on {expense_date} by {employee}. Confirm?"`
   - `execute`: `frappe.new_doc("Expense Claim")`, append a row to the `expenses` child table with `expense_date`, `expense_type`, `amount`, `description`. Call `doc.insert()`.

4. **Recipe: `CreateMaterialRequestRecipe`.**
   - `intent = "create_material_request"`
   - Extracted fields: `item_code` (required), `qty` (required), `schedule_date` (default: today + 7 days), `material_request_type` (default: `"Purchase"`), `warehouse` (optional).
   - `confirm_message`: `"Create Material Request: {qty} × {item_code} by {schedule_date}. Type: {material_request_type}. Confirm?"`
   - `execute`: `frappe.new_doc("Material Request")`, append a row to the `items` child table with `item_code`, `qty`, `schedule_date`, `warehouse`. Call `doc.insert()`.

5. **Recipe: `CreateTimesheetDetailRecipe`.**
   - `intent = "create_timesheet_detail"`
   - Extracted fields: `project` (optional), `task` (optional), `from_time` (parsed, default: now − `hours`), `to_time` (parsed, default: now), `hours` (computed from from/to if not explicit), `activity_type` (from user preference `adhd_default_activity_type` or default `"Execution"`).
   - `confirm_message`: `"Log {hours}h on '{task or project}' ({activity_type}) from {from_time} to {to_time}. Confirm?"`
   - `execute`: Find or create a Timesheet for today for the current employee. Append a `time_logs` row. Call `doc.save()` (not submit — timesheets may accumulate entries).

6. **Extend the classifier prompt in `engine.py`.** Add the four new intents to the `INTENT_EXAMPLES` dict (or equivalent structure) with 3–5 example utterances each:
   - `create_task`: "add task review supplier invoices by Friday", "create a task for budget reconciliation high priority"
   - `create_expense_claim`: "log expense 850 for travel", "claim 1200 accommodation expense for Riya"
   - `create_material_request`: "request 50 units of item RM-001 for next week", "raise purchase request for 10 laptops"
   - `create_timesheet_detail`: "log 2 hours on Project Alpha", "log time on task TASK-0032 1.5h"

7. **Write `test_recipes_extended.py`.** Follow the pattern in existing `test_crm.py`:
   - One test class per recipe inheriting from `frappe.tests.utils.FrappeTestCase`.
   - Test `extract()` with a representative natural-language input dict and assert all required fields are present.
   - Test `confirm_message()` returns a non-empty string containing key field values.
   - Test `execute()` creates a document of the correct doctype and the document persists in the database (`frappe.db.exists`).
   - Add a teardown that deletes test documents created during the run.

## How to Test

1. Ensure the command bar is visible (ADHD mode active, or command bar always shown per project config).
2. Type: `"create a task to follow up on supplier payment due Friday high priority"`. Confirm the intent is detected as `create_task`. A confirmation message appears. Click Confirm. Verify a Task document is created in the Task list with the correct subject, priority, and due date.
3. Type: `"log expense 950 for client entertainment"`. Confirm the intent resolves to `create_expense_claim`. Confirm. Verify an Expense Claim document is created for the current user with the correct amount and expense type.
4. Type: `"request 30 units of RM-STEEL-001 by next Monday"`. Confirm intent is `create_material_request`. Confirm. Verify a Material Request document with the correct item and quantity.
5. Type: `"log 2 hours on project Infra Upgrade"`. Confirm intent is `create_timesheet_detail`. Confirm. Verify a Timesheet (or updated Timesheet) for today with a 2-hour entry on the correct project.
6. Type: `"add task"` (ambiguous, missing subject). Confirm the command bar asks for clarification or shows a validation error rather than creating an empty Task.
7. Run `python -m pytest erpnext/assistant/test_recipes_extended.py -v`. Confirm all tests pass.

## Acceptance Criteria
- [ ] `CreateTaskRecipe` creates a Task document with correct `subject`, `assigned_to`, `exp_end_date`, and `priority`.
- [ ] `CreateExpenseClaimRecipe` creates an Expense Claim with a populated `expenses` child table row.
- [ ] `CreateMaterialRequestRecipe` creates a Material Request with a populated `items` child table row.
- [ ] `CreateTimesheetDetailRecipe` creates or updates a Timesheet with a `time_logs` row, using the current user's employee record.
- [ ] All four intents are classified correctly from natural-language input (verified manually and in tests).
- [ ] The confirm-before-save message is shown for all four new recipes before any document is created.
- [ ] No document is created if the user dismisses or rejects the confirmation.
- [ ] All tests in `test_recipes_extended.py` pass with `pytest`.
- [ ] No regressions in existing CRM recipe tests (`test_crm.py`).

## Dependencies
- **Blocked by:** `feat/conversational-crm-assistant` branch merged (provides `recipes.py`, `engine.py`, confirm-before-save UI)
- **Blocks:** ADHD-007 (Automatic Time-Log Prompt, which reuses the Timesheet Detail creation path)

## Complexity
M — Four recipe classes plus classifier prompt extension plus test coverage; follows an established pattern but each recipe has distinct field extraction and child-table logic.

## Phase
Phase 2 — Core Workflow Clarity
