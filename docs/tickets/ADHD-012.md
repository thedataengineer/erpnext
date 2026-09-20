# ADHD-012: Month-End Close Checklist

## Summary
Provide a structured, auto-verifying Month-End Close checklist in the Accounts workspace so ADHD users can complete the close process step-by-step without losing track of what remains.

## Background / Context
Month-end accounting close involves 5–8 sequential tasks that must be completed in a specific order across different ERPNext modules — bank reconciliation, aging reports, provisions, and period close. ADHD users frequently lose their place mid-process, forget which steps they completed in a prior session, or close periods without running essential checks. The absence of any guided workflow in ERPNext means every close requires re-reading a personal checklist outside the app, which breaks flow and invites errors.

## Cognitive Mechanism
working memory | initiation | time blindness

## Prerequisites
- ADHD mode toggle (shipped) — checklist is shown only when ADHD mode is active
- ADHD-016 (ADHD Settings Panel) — ideally in place so the checklist can be toggled per-user; can launch without it

## Scope
**Create:**
- `erpnext/accounts/services/adhd_month_end.py` — server-side auto-detection helpers
- `erpnext/public/js/adhd/adhd_month_end.js` — checklist UI logic
- Accounts workspace customization OR Focus Panel tab (new tab in `focus_panel.js`)

**Modify:**
- `erpnext/public/js/adhd/focus_panel.js` — add "Month-End" tab if Focus Panel approach is chosen
- `erpnext/accounts/workspace/accounts/accounts.json` — add a "Month-End Checklist" shortcut card if workspace approach is chosen

## What Needs to Be Done

1. **Define the checklist steps as a JS constant in `adhd_month_end.js`**
   Each step is an object:
   ```js
   {
     id: 'bank_recon',
     label: 'Bank Reconciliation',
     description: 'Match all bank transactions to ledger entries for the closing month.',
     link: '/app/bank-reconciliation-tool',
     estimatedMinutes: 30,
     autoCheckMethod: 'erpnext.accounts.services.adhd_month_end.is_bank_reconciled'
   }
   ```
   Define all 5 steps in order:
   - `bank_recon` → `/app/bank-reconciliation-tool`, 30 min
   - `debtors_aging` → `/app/accounts-receivable`, 15 min
   - `provisions` → `/app/journal-entry/new-journal-entry-1` (with type preset to "Accrual"), 20 min
   - `period_close` → `/app/period-closing-voucher`, 10 min
   - `pl_review` → `/app/profit-and-loss-statement`, 15 min

2. **Server-side auto-check helpers (`adhd_month_end.py`)**
   - `is_period_closed(month_str: str, company: str) -> bool` — checks for an existing submitted `Period Closing Voucher` with `period_end_date` within the given month.
   - Expose via `frappe.whitelist()` as `erpnext.accounts.services.adhd_month_end.is_period_closed`.
   - For steps without reliable auto-detection (bank_recon, debtors_aging, provisions, pl_review), the method returns `None` (not auto-checkable; user must tick manually).

3. **Persist checkbox state in User Settings**
   - Storage key: `adhd_month_end_{YYYY_MM}` (e.g. `adhd_month_end_2025_01`).
   - On checklist open, read state from `frappe.boot.user_info` or `localStorage` keyed to the logged-in user.
   - On each checkbox toggle, write back via `frappe.call('frappe.client.set_value', { doctype: 'User', name: frappe.session.user, fieldname: 'adhd_month_end_state', value: JSON.stringify(state) })`. Use a `User` custom field (added via Custom Field doctype, not hardcoded schema).
   - Alternatively, use `localStorage` with key `adhd_me_{user}_{YYYY_MM}` as a simpler fallback.

4. **Render the checklist UI**
   - Container: `<div class="adhd-month-end-checklist">` with a header "Month-End Close — [Month Year]".
   - For each step render:
     - Checkbox `<input type="checkbox" id="adhd-me-{id}">` bound to persisted state
     - Step label as `<label>` (bold when incomplete, struck through when complete)
     - Description in `<small>`
     - Estimated time badge: `<span class="adhd-time-badge">~30 min</span>`
     - "Open →" link button navigating to `step.link`
   - Auto-checked steps (only `period_close` currently) show a small "✓ auto-detected" badge instead of a manual checkbox.
   - A progress bar at the top: `X of 5 steps complete` using a `<progress>` element.

5. **Auto-check on checklist open**
   - On render, call `frappe.call` to `is_period_closed` for the current month + `frappe.boot.sysdefaults.company`.
   - If returns `true`, force-check `period_close` and persist.

6. **Reset button**
   - "Start New Month" button that clears the state for the current month key and re-renders. Prompts a `frappe.confirm` before clearing.

7. **Entry points**
   - Focus Panel: add a "📅 Month-End" tab in `focus_panel.js`; render `initMonthEndChecklist(container)` when the tab is activated.
   - Accounts workspace: add a custom "Month-End Checklist" shortcut that sets a URL hash or fires a dialog containing the checklist.

## How to Test

1. Log in with ADHD mode **enabled**.
2. Open the **Accounts workspace**. Confirm a "Month-End Checklist" shortcut or card is visible.
3. Click it. Confirm the checklist dialog/panel opens showing 5 steps in order with descriptions, time estimates, and "Open →" links.
4. Confirm the progress bar shows "0 of 5 steps complete".
5. Tick "Bank Reconciliation". Confirm the checkbox persists after closing and reopening the checklist.
6. Navigate to **Accounts → Period Closing Voucher → New**. Create and submit a Period Closing Voucher for the current month.
7. Reopen the checklist. Confirm "Period Close" is auto-checked with an "✓ auto-detected" badge.
8. Confirm progress bar now shows "2 of 5 steps complete".
9. Click "Start New Month". Confirm a confirmation dialog appears. Confirm. Confirm all checkboxes reset to unchecked.
10. Disable ADHD mode. Confirm the Month-End Checklist shortcut/card is hidden or the panel shows a "ADHD mode is off" message.

## Acceptance Criteria
- [ ] Checklist is accessible from the Accounts workspace and/or Focus Panel when ADHD mode is active.
- [ ] All 5 steps appear in the correct order with label, description, estimated time, and navigation link.
- [ ] Checkbox state persists across page reloads for the current month.
- [ ] Period Closing Voucher existence auto-checks the "Period Close" step.
- [ ] Progress bar accurately reflects completed step count.
- [ ] "Start New Month" resets state after confirmation.
- [ ] Checklist is not visible when ADHD mode is disabled.
- [ ] No server errors in `adhd_month_end.py` when the period is not yet closed.

## Dependencies
- Blocked by: ADHD mode toggle (shipped)
- Blocks: ADHD-016 should add a per-feature toggle for this checklist
- Related: ADHD-016 (Period Closing Readiness Dashboard — recommended follow-on)

## Complexity
M — requires server-side auto-detection, persistent state, and a multi-entry-point UI component.

## Phase
Phase 4 — Workflow Clarity
