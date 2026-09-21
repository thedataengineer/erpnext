# ADHD-014: HR Employee Onboarding Wizard

## Current implementation record

- **Status:** Blocked.
- **Implementation:** ERPNext no longer contains the HR/Payroll doctypes and workspace assumed by this ticket; HRMS is absent from this repository.
- **Verification:** No implementation or acceptance test was run. Implement in the HRMS repository or add HRMS as a tested dependency.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
A guided multi-step wizard that creates all required HR documents for a new employee in sequence, so users never have to figure out the correct order or navigate between five separate forms.

## Background / Context
Onboarding a new employee in ERPNext requires creating at least five separate documents — Employee, Education, Address, Salary Structure Assignment, and Leave Allocation — each accessed from a different module menu. For ADHD users, this multi-document sequence is a serious initiation blocker: there is no map of what needs to be done, documents are easy to forget, and partial completions are invisible in the system. The wizard replaces open-ended navigation with a linear, completable flow.

## Cognitive Mechanism
initiation | working memory | attention switching

## Prerequisites
- ADHD mode toggle (shipped) — wizard accessible from the HR workspace only when ADHD mode is active (or as a standalone HR workspace shortcut regardless of ADHD mode — decide at implementation time)

## Scope
**Create:**
- `erpnext/hr/page/employee_onboarding_wizard/employee_onboarding_wizard.js` — wizard UI
- `erpnext/hr/page/employee_onboarding_wizard/employee_onboarding_wizard.py` — Page controller
- `erpnext/hr/page/employee_onboarding_wizard/employee_onboarding_wizard.json` — Page doctype record
- `erpnext/public/js/adhd/adhd_hr.js` — optional shared HR helpers

**Modify:**
- `erpnext/hr/workspace/hr/hr.json` — add "Onboard New Employee" shortcut card

## What Needs to Be Done

1. **Create the Frappe Page doctype record (`employee_onboarding_wizard.json`)**
   - `name`: `Employee Onboarding Wizard`
   - `module`: `HR`
   - `title`: `Onboard New Employee`
   - `standard`: `Yes`
   - Route: `/employee-onboarding-wizard`

2. **Define the 5 wizard steps as a JS constant**
   ```js
   const WIZARD_STEPS = [
     { id: 'employee',    label: 'Employee Details',       doctype: 'Employee',                  optional: false },
     { id: 'education',   label: 'Education',              doctype: 'Employee Education',         optional: true  },
     { id: 'address',     label: 'Address',                doctype: 'Address',                    optional: true  },
     { id: 'salary',      label: 'Salary Structure',       doctype: 'Salary Structure Assignment',optional: false },
     { id: 'leave',       label: 'Leave Allocation',       doctype: 'Leave Allocation',           optional: false },
   ];
   ```

3. **Render the progress bar**
   - Fixed header: `<div class="adhd-wizard-header">` with a horizontal progress bar `<progress max="5" value="1">` and label "Step 1 of 5 — Employee Details".
   - Update `value` and label on each step transition.

4. **Render each step's form**
   - Use `frappe.ui.form.make_quick_entry` or render a lightweight Frappe form (`new frappe.ui.Dialog` with `fields` derived from the target doctype's mandatory fields only).
   - Mandatory fields for each step:
     - **Employee**: `first_name`, `last_name`, `company`, `date_of_joining`, `gender`, `employment_type`
     - **Employee Education**: `employee` (auto-filled from step 1 result), `school_univ`, `qualification`, `year_of_passing`
     - **Address**: `address_title`, `address_type`, `address_line1`, `city`, `country`; link to Employee via `Dynamic Link` field
     - **Salary Structure Assignment**: `employee` (auto-filled), `salary_structure`, `from_date`
     - **Leave Allocation**: `employee` (auto-filled), `leave_type`, `new_leaves_allocated`, `from_date`, `to_date`
   - Auto-fill `employee` field in steps 2–5 from the `name` returned by step 1's save.

5. **Save each step on "Next" click**
   - Call `frappe.call('frappe.client.insert', { doc: { doctype: STEP.doctype, ...formValues } })`.
   - On success, store the returned `doc.name` in a `wizardState` object and advance to the next step.
   - On error, display the frappe error message inline (do **not** advance); keep form values intact.

6. **"Skip" for optional steps**
   - Show a "Skip — complete later" link for optional steps (`optional: true`).
   - On skip, create a Frappe **ToDo** via `frappe.call('frappe.client.insert', { doc: { doctype: 'ToDo', description: 'Complete ${STEP.label} for employee ${employeeName}', reference_type: 'Employee', reference_name: employeeName, date: frappe.datetime.add_days(frappe.datetime.today(), 7) } })`.
   - Show a toast: "Reminder set for 7 days from now."

7. **Rollback on step failure**
   - If step N fails after step N-1 succeeded, show an error dialog: "Step N failed. Previously created documents are listed below. You can continue manually or restart the wizard."
   - List created doc names as links. Do **not** silently delete already-created docs.

8. **Completion summary card**
   - After step 5 (or the last non-skipped step), render a `<div class="adhd-wizard-summary">`:
     - Heading: "✓ [Employee Name] onboarded successfully"
     - List of created documents with their names as clickable links
     - Any skipped steps listed as "Pending ToDos"
   - Buttons: "Onboard Another Employee" (resets wizard state) and "Go to Employee Record".

9. **Entry point in HR workspace**
   - Add a shortcut card in `hr.json` with `link_to: 'employee-onboarding-wizard'` and icon `👤`.

## How to Test

1. Log in with ADHD mode **enabled**. Navigate to **HR workspace**.
2. Confirm an "Onboard New Employee" shortcut card is visible.
3. Click it. Confirm the wizard opens at Step 1 — Employee Details with a progress bar showing "Step 1 of 5".
4. Fill in mandatory Employee fields and click "Next". Confirm an Employee document is created and visible under HR → Employee.
5. Confirm Step 2 — Education is shown with "Step 2 of 5" and the `employee` field pre-filled.
6. Click "Skip" on the Education step. Confirm a ToDo is created (check via **Tools → ToDo**) with the correct description linking to the new Employee.
7. Continue through Address (skip), Salary Structure Assignment (fill and save), Leave Allocation (fill and save).
8. Confirm the completion summary card lists all created documents and any pending ToDos.
9. Click a document link in the summary; confirm it opens the correct record.
10. Click "Onboard Another Employee"; confirm the wizard resets to Step 1 with an empty form.
11. On Step 1, enter an invalid value to force a save error. Confirm the error is shown inline and the wizard does not advance.
12. Disable ADHD mode and reload the HR workspace. Confirm the shortcut card is either hidden or accessible as a standalone page (per implementation decision); confirm the wizard itself still functions if accessed directly at `/employee-onboarding-wizard`.

## Acceptance Criteria
- [ ] Wizard is accessible from the HR workspace.
- [ ] Progress bar correctly shows current step number and total steps.
- [ ] Each step saves its document before advancing.
- [ ] Employee name/ID is auto-filled in steps 2–5 from step 1 result.
- [ ] Optional steps show a "Skip" option that creates a ToDo reminder.
- [ ] Save errors are shown inline without data loss; wizard does not advance on error.
- [ ] Rollback dialog lists previously created docs on mid-sequence failure.
- [ ] Completion summary lists all created documents with clickable links.
- [ ] "Onboard Another Employee" fully resets wizard state.
- [ ] No orphaned documents are left when the wizard is abandoned mid-flow (user navigates away); this is documented as acceptable behaviour, not a bug, in `docs/adhd_testing.md`.

## Dependencies
- Blocked by: ADHD mode toggle (shipped)
- Blocks: none
- Related: ADHD-020 (test harness) — wizard should expose `getState()` method

## Complexity
L — multi-step form orchestration, sequential document creation with rollback logic, and a new Frappe Page.

## Phase
Phase 4 — Workflow Clarity
