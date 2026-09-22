# ADHD-058: Leave Application "Balance at a Glance"

## Current implementation record

- **Status:** Implemented in Hubble (the HR app), 2026-09-21.
- **Implementation:** `hrms/public/js/adhd/adhd_leave_application.js` over `hrms/hr/services/adhd_leave_balance.py`, which wraps Hubble's own leave functions (`get_leave_details`, `get_leave_balance_on`, `get_number_of_leave_days`) and the exact insufficient-balance rule the doctype applies on save. The card shows entitlement, used, remaining and this application's days as soon as employee, type and from date are in; debounced, permission-checked per employee, display only, removed the moment Focus Mode goes off.
- **Verification:** `hrms/tests/adhd_leave_expense.test.js` and `hrms/tests/test_adhd_leave_expense.py` (16, rolled back), shared with ADHD-059.
- **Acceptance:** Not yet seen in a logged-in browser.

## Summary
Inject a compact leave balance card on the Leave Application form that shows entitlement, used, remaining, and the impact of the current application, so the user always knows their balance before submitting.

## Background / Context
An ADHD employee submitting a leave application often has no idea how many leave days they have left. ERPNext does not show leave balance on the Leave Application form itself — the user must separately navigate to Leave Balance or Leave Allocation to check. When a leave application is rejected due to insufficient balance, the resulting surprise and perceived rejection triggers significant RSD. The friction point is the Leave Application form, which asks for `leave_type` and dates but gives no feedback about whether the leave will be approved.

## Cognitive Mechanism
Working memory | RSD (rejection-sensitive dysphoria) | Attention switching

## Prerequisites
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/hr/doctype/leave_application/adhd_leave_application.js`

## What Needs to Be Done

1. **Create `adhd_leave_application.js`**. Guard with `if (!frappe.boot.adhd_mode) return;` at the top.

2. **Register `frappe.ui.form.on('Leave Application', { ... })`** with hooks: `refresh`, `leave_type`, `from_date`, `to_date`, `employee`.

3. **In the handler for `refresh`, `leave_type`, `from_date`, `to_date`, and `employee`**: call `fetchAndRenderBalance(frm)`.

4. **`fetchAndRenderBalance(frm)`**:
   a. If any of `frm.doc.employee`, `frm.doc.leave_type`, `frm.doc.from_date` is blank, remove any existing balance card and return.
   b. Call:
      ```js
      frappe.call({
        method: 'hrms.hr.doctype.leave_application.leave_application.get_leave_balance_on',
        args: {
          employee: frm.doc.employee,
          date: frm.doc.from_date,
          leave_type: frm.doc.leave_type,
          consider_all_leaves_in_the_allocation_period: 1,
        },
        callback(r) {
          renderBalanceCard(frm, r.message);
        }
      });
      ```
   c. The method `get_leave_balance_on` returns the available balance as a number. To get entitlement and used, also call `frappe.call` to `hrms.hr.doctype.leave_application.leave_application.get_leave_details` (check the actual method name in `hrms/hr/doctype/leave_application/leave_application.py` — it returns a dict with `total_leaves_allocated`, `leaves_taken`, `remaining_leaves`).
   d. Alternatively, use a single `frappe.call` to a method that returns all three values. If `get_leave_details` takes `employee` and `date`, use that. Inspect `hrms/hr/doctype/leave_application/leave_application.py` to find the correct method and argument signature before coding.

5. **Compute "this application will use X days"**:
   a. If `frm.doc.from_date` and `frm.doc.to_date` are both set, call `frappe.call({ method: 'hrms.hr.utils.get_number_of_leave_days', args: { employee, leave_type, from_date, to_date, half_day, half_day_date } })` — or compute naively as `Math.ceil((new Date(to_date) - new Date(from_date)) / 86400000) + 1` for a rough estimate shown while the API result loads.

6. **`renderBalanceCard(frm, balanceData)`**:
   a. Remove any existing `#adhd-leave-balance` element.
   b. Extract `total_leaves_allocated`, `leaves_taken`, `remaining_leaves` from `balanceData`.
   c. Determine color: if `leavesThisApplication > remaining_leaves`, use red; if `remaining_leaves - leavesThisApplication < 2`, use amber; else green.
   d. Build HTML:
      ```html
      <div id="adhd-leave-balance" class="adhd-leave-card adhd-leave-{color}">
        <strong>{leave_type}</strong>
        <span>Entitlement: {total_leaves_allocated}</span>
        <span>Used: {leaves_taken}</span>
        <span>Remaining: {remaining_leaves}</span>
        <span>This application: {leavesThisApplication} days</span>
        {remaining_leaves < leavesThisApplication ? '<span class="adhd-leave-warn">⚠ Insufficient balance</span>' : ''}
      </div>
      ```
   e. Inject the card **below the `leave_type` field** by using `frm.fields_dict.leave_type.$wrapper.after(cardElement)` — or inject into a custom HTML field placed after `leave_type` in the form layout if a suitable placeholder field exists.
   f. If injecting via `.after()`, wrap the raw HTML in `$(html)` and use jQuery's `.after()` method.

7. **CSS**:
   ```css
   .adhd-leave-card { display: flex; gap: 16px; flex-wrap: wrap; padding: 8px 12px; border-radius: 4px; font-size: 0.85rem; margin-top: 8px; }
   .adhd-leave-green { background: #d4edda; color: #155724; }
   .adhd-leave-amber { background: #fff3cd; color: #856404; }
   .adhd-leave-red   { background: #f8d7da; color: #721c24; }
   .adhd-leave-warn  { font-weight: 700; }
   ```

8. **Debounce**: if `leave_type`, `from_date`, and `to_date` all trigger the fetch, debounce the API call with a 400 ms delay to avoid multiple simultaneous requests.

9. **Bundle**: add `adhd_leave_application.js` to `hooks.py` under `doctype_js["Leave Application"]`.

## How to Test

1. Enable ADHD mode. Go to **HR → Leave Application → New**.
2. Select an employee. Leave `leave_type` blank. Confirm no balance card appears.
3. Select a `leave_type` (e.g. "Casual Leave") and a `from_date`. Confirm a balance card appears below the `leave_type` field showing entitlement, used, and remaining.
4. Set `to_date` to a date 3 days after `from_date`. Confirm the card updates to show "This application: 3 days".
5. Find an employee with very few remaining leaves (e.g. 1 day left). Select a `leave_type` and enter dates spanning 5 days. Confirm the card turns **red** and shows a "⚠ Insufficient balance" warning.
6. Change `leave_type` to one with ample balance. Confirm the card updates reactively and turns **green**.
7. Submit the Leave Application. Confirm no JS errors.
8. Open a submitted Leave Application. Confirm the balance card still renders (read-only form).
9. Disable ADHD mode. Open a new Leave Application. Confirm no balance card appears.
10. Confirm only one API call is made when changing `leave_type` rapidly (debounce works).

## Acceptance Criteria
- [ ] Balance card appears below `leave_type` after `employee`, `leave_type`, and `from_date` are all filled.
- [ ] Card shows: leave type, total entitlement, leaves used, leaves remaining.
- [ ] Card shows "This application: X days" once `to_date` is set.
- [ ] Card is green when balance is sufficient, amber when nearly exhausted, red when insufficient.
- [ ] Insufficient-balance warning ("⚠ Insufficient balance") appears in red state.
- [ ] Card updates reactively when `leave_type`, `from_date`, or `to_date` changes.
- [ ] No card when any required field is blank.
- [ ] API calls are debounced — no rapid-fire duplicate requests.
- [ ] No card when ADHD mode is off.
- [ ] No JS errors.

## Dependencies
- Blocks: none
- Blocked by: none (ADHD mode toggle already shipped)

## Complexity
S — two `frappe.call` invocations, reactive field hooks, and DOM injection; no server-side code to write.

## Phase
Phase 7 — Module-by-Module Expansion
