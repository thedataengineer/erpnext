# ADHD-057: Payroll Cycle Checklist

## Summary
A "Run Payroll" step-by-step checklist accessible from the HR workspace that guides ADHD users through the complete payroll cycle, auto-detecting completed steps where possible and persisting progress per payroll period.

## Background / Context
Running payroll in ERPNext involves six distinct steps across multiple doctypes, each in a different part of the system. ADHD users frequently complete steps out of order, skip a step (e.g. forgetting to process leave applications before generating salary slips), or believe they have finished when they have not. The resulting payroll errors are time-consuming to fix and cause significant RSD when employees are underpaid. The friction point is the complete absence of a linear, stateful guide to the payroll cycle.

## Cognitive Mechanism
Working memory | Initiation | Time blindness | Attention switching

## Prerequisites
- ADHD-012 (Month-End Close Checklist — follow this pattern for the Python backend, User Settings persistence, and checklist UI component)
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/payroll/services/adhd_payroll_cycle.py` — server-side step completion detection
- **Create** `erpnext/payroll/page/adhd_payroll_checklist/adhd_payroll_checklist.js` — checklist UI (or integrate into HR workspace as a widget following ADHD-012's approach)
- **Create** `erpnext/payroll/page/adhd_payroll_checklist/adhd_payroll_checklist.py`
- **Modify** HR workspace JSON or workspace customization to add a "Run Payroll" checklist link/widget

## What Needs to Be Done

### Backend: `adhd_payroll_cycle.py`

1. **Create a whitelisted method `get_payroll_checklist_status(month, year, company)`**:
   ```python
   @frappe.whitelist()
   def get_payroll_checklist_status(month, year, company):
   ```
   Returns a dict with keys for each step and boolean completion status.

2. **Step completion detection logic** (each returns `True` or `False`):

   a. **Step 1 — Mark Attendance**: check that the number of `Attendance` records for `company`, `attendance_date` within the month/year range is >= the count of active employees (`Employee` where `status = 'Active'` and company matches) × 0.9 (90% threshold is a reasonable heuristic; document this assumption). If attendance is fully integrated with biometric imports, this is enough.

   b. **Step 2 — Process Leave Applications**: check that no `Leave Application` records for the period have `status = 'Open'` (i.e. all submitted or all approved). Query: `frappe.db.count('Leave Application', {'from_date': ['<=', period_end], 'to_date': ['>=', period_start], 'status': 'Open'}) == 0`.

   c. **Step 3 — Generate Salary Slips**: check that at least one `Salary Slip` exists with `start_date` and `end_date` within the payroll period, `company = company`, `docstatus != 2`. Query: `frappe.db.count('Salary Slip', {'start_date': period_start, 'end_date': period_end, 'company': company, 'docstatus': ['!=', 2]}) > 0`.

   d. **Step 4 — Review Salary Slips**: check that all generated Salary Slips for the period have `docstatus = 0` (draft, ready for review). Return True if slips exist. This step is a manual checkpoint — cannot be auto-detected; always return `False` (requires manual check-off by user).

   e. **Step 5 — Submit Salary Slips**: check that all Salary Slips for the period have `docstatus = 1` (submitted). `frappe.db.count('Salary Slip', {'start_date': period_start, 'end_date': period_end, 'company': company, 'docstatus': 0}) == 0` AND total slips > 0.

   f. **Step 6 — Create Payment Entry**: check that at least one `Payment Entry` exists linked to a `Payroll Entry` for the period. Query via `frappe.db.get_all('Payment Entry', {'payment_type': 'Pay', 'posting_date': ['between', [period_start, period_end]], 'company': company, 'docstatus': 1})`.

3. **Return format**:
   ```python
   return {
     "step_1_attendance": True/False,
     "step_2_leave": True/False,
     "step_3_slips_generated": True/False,
     "step_4_review": False,  # always manual
     "step_5_slips_submitted": True/False,
     "step_6_payment": True/False,
     "period_start": period_start,
     "period_end": period_end,
   }
   ```

4. **Persist manual overrides** (for step 4 and user overrides of other steps) using `frappe.db.set_value('User Settings', ...)` or `frappe.cache().set_value(key, value, user=frappe.session.user)` with a key like `adhd_payroll_step_4_<company>_<month>_<year>`. Expose a `set_payroll_step_complete(step, month, year, company, value)` whitelisted method.

### Frontend: Checklist UI

5. **Follow the ADHD-012 pattern exactly** for the checklist component. Reuse the same HTML/CSS structure: a vertical list of steps, each with a checkbox (checked if complete), a plain-English description, a direct navigation link, and a status badge.

6. **Step definitions** (render in this order):
   | # | Label | Description | Navigation link | Auto-detectable |
   |---|-------|-------------|-----------------|-----------------|
   | 1 | Mark Attendance | Ensure all employee attendance for the period is recorded | `frappe.set_route('List', 'Attendance')` | Yes |
   | 2 | Process Leave Applications | Approve or reject all pending leave requests for the period | `frappe.set_route('List', 'Leave Application', {status: 'Open'})` | Yes |
   | 3 | Generate Salary Slips | Run the Payroll Entry to generate salary slips for all employees | `frappe.set_route('Form', 'Payroll Entry', 'new-payroll-entry-1')` | Yes |
   | 4 | Review Salary Slips | Check all generated slips for accuracy before submitting | `frappe.set_route('List', 'Salary Slip')` | No — manual checkbox |
   | 5 | Submit Salary Slips | Submit all reviewed and approved salary slips | `frappe.set_route('List', 'Salary Slip', {docstatus: 0})` | Yes |
   | 6 | Create Payment Entry | Record the actual salary payment against the bank account | `frappe.set_route('Form', 'Payment Entry', 'new-payment-entry-1')` | Yes |

7. **Period selector**: render a `<select>` for month and year at the top of the checklist. Defaults to the current month. On change, call `get_payroll_checklist_status` and re-render.

8. **Company selector**: render a `<select>` for company (populated from `frappe.call` to fetch all companies). Defaults to the user's default company.

9. **Progress bar**: `X of 6 steps complete` with a filled progress bar (reuse ADHD-012 styles).

10. **HR workspace integration**: add a "Run Payroll Checklist" card/shortcut to the HR workspace that opens this checklist. Follow the ADHD-012 approach (Page or Dialog or Workspace widget, whichever ADHD-012 uses).

11. **Bundle**: register the page in `hooks.py` under `page_js` or `website_route_rules` as appropriate.

## How to Test

1. Enable ADHD mode. Go to the HR workspace. Confirm a "Run Payroll Checklist" link/card is visible.
2. Click the link. Confirm the checklist opens with 6 steps for the current month and the user's default company.
3. Confirm steps with no activity are unchecked. If attendance records exist for the current month, confirm Step 1 shows as checked.
4. Manually check Step 4 (Review). Reload the checklist. Confirm Step 4 remains checked (persisted).
5. Submit all Salary Slips for the current month. Return to the checklist. Confirm Step 5 shows as auto-checked.
6. Change the month selector to a previous month that had a complete payroll run. Confirm all auto-detectable steps are checked.
7. Change to a month with no payroll data. Confirm all steps are unchecked.
8. Disable ADHD mode. Confirm the checklist card is hidden from the HR workspace (or the checklist simply does not load).
9. Click "Mark Attendance" link on Step 1. Confirm it navigates to the Attendance list.
10. Confirm the progress bar updates correctly as steps are checked off.

## Acceptance Criteria
- [ ] Payroll Cycle Checklist is accessible from the HR workspace in ADHD mode.
- [ ] Checklist shows 6 steps in the correct order.
- [ ] Auto-detectable steps (1, 2, 3, 5, 6) are checked/unchecked based on actual ERPNext data for the selected period.
- [ ] Step 4 (Review) is a manual checkbox that persists across page loads.
- [ ] Period (month/year) and company selectors update the checklist data dynamically.
- [ ] Each step has a direct navigation link to the relevant ERPNext view.
- [ ] Progress bar shows correct count of completed steps.
- [ ] Checklist is not accessible or visible when ADHD mode is off.
- [ ] No server errors for months with no payroll data.

## Dependencies
- Blocked by: ADHD-012 (Month-End Checklist — must read and follow its implementation pattern)
- Blocks: none

## Complexity
M — requires a Python backend with multiple DB queries, a stateful UI component, workspace integration, and persistence logic.

## Phase
Phase 7 — Module-by-Module Expansion
