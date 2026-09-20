# ADHD-011: Journal Entry Balance Indicator

## Summary
Inject a live debit/credit balance meter into the Journal Entry form so users instantly see whether their entry is balanced without manually summing rows.

## Background / Context
Journal Entries require equal debit and credit totals, but ERPNext's standard form shows no running total — users must add up rows mentally or wait for a validation error on save. For ADHD users, this silent wait-until-error feedback loop breaks concentration, wastes working memory on arithmetic, and causes repeated failed save attempts. The friction is highest when editing multi-row entries where one miskeyed amount throws the whole entry off.

## Cognitive Mechanism
working memory | attention switching

## Prerequisites
- ADHD mode toggle (shipped) — the balance indicator is only injected when ADHD mode is active

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_accounts.js` — balance meter logic

**Modify:**
- `erpnext/accounts/doctype/journal_entry/journal_entry.js` — import / call `initBalanceMeter(frm)` in `onload` and `refresh` hooks

## What Needs to Be Done

1. **Create `erpnext/public/js/adhd/adhd_accounts.js`**
   - Export a single function `initJournalEntryBalanceMeter(frm)`.
   - Early-return if `window.ADHDMode?.isActive()` is falsy.

2. **Inject the balance bar HTML**
   - After the `accounts` child table (`frm.get_field('accounts').wrapper`), append a `<div id="adhd-balance-meter">` with three `<span>` children:
     - `#adhd-debit-total` — "Debit: ₹0.00"
     - `#adhd-credit-total` — "Credit: ₹0.00"
     - `#adhd-difference` — "Difference: ₹0.00"
   - Apply CSS class `adhd-balance-meter` (styles in `adhd_mode.scss`).

3. **Wire the real-time update**
   - Retrieve the grid: `const grid = frm.get_field('accounts').grid;`
   - Hook `grid.wrapper.on('change', 'input, select', updateBalanceMeter)` where `updateBalanceMeter` is a debounced (150 ms) function.
   - Also call `updateBalanceMeter()` directly at the end of `initJournalEntryBalanceMeter` so it reflects existing data on form open.

4. **Implement `updateBalanceMeter()`**
   - Iterate `frm.doc.accounts` array; accumulate `debit_in_account_currency` and `credit_in_account_currency` for each row.
   - Update the three `<span>` text nodes with formatted values using `format_currency(value, frm.doc.company_currency)`.
   - If `Math.abs(debit - credit) < 0.001`, apply CSS class `adhd-balanced` to `#adhd-difference` (green text) and remove `adhd-unbalanced`; otherwise do the inverse (red text).

5. **Add "Balanced ✓" to form status bar**
   - When balanced, call `frm.set_indicator('Balanced ✓', 'green')`.
   - When unbalanced and the form is dirty, call `frm.set_indicator('Unbalanced', 'red')`.
   - On a fresh unsaved form with all-zero rows, show no indicator override.

6. **Hook into `journal_entry.js`**
   - Add `import { initJournalEntryBalanceMeter } from '../../public/js/adhd/adhd_accounts.js';` (or use `frappe.require` if ESM not available).
   - In the `frappe.ui.form.on('Journal Entry', { refresh(frm) { ... } })` block, call `initJournalEntryBalanceMeter(frm)`.
   - Also hook `accounts_add`, `accounts_remove`, and `accounts_move` grid events to re-run `updateBalanceMeter`.

7. **CSS (in `adhd_mode.scss`)**
   - `.adhd-balance-meter` — `display: flex; gap: 16px; padding: 8px 12px; background: var(--fg-color); border-radius: 4px; font-size: var(--text-sm); margin-top: 6px;`
   - `.adhd-balanced` — `color: var(--green-600); font-weight: 600;`
   - `.adhd-unbalanced` — `color: var(--red-600); font-weight: 600;`

8. **Cleanup on form unload**
   - In the `Journal Entry` `before_unload` or `on_detach` hook, remove the `#adhd-balance-meter` element and unbind the grid change listener to prevent memory leaks.

## How to Test

1. Log in to an ERPNext instance with ADHD mode **enabled**.
2. Navigate to **Accounts → Journal Entry → New**.
3. Confirm a `<div id="adhd-balance-meter">` is visible below the Accounts table showing "Debit: ₹0.00 | Credit: ₹0.00 | Difference: ₹0.00".
4. Add a row: set Account = any payable ledger, Debit = 1000. Confirm "Debit: ₹1,000.00 | Difference: ₹1,000.00" updates within 200 ms and the Difference span has red styling.
5. Add a second row: set Account = bank account, Credit = 1000. Confirm "Difference: ₹0.00" updates to green and the form status bar shows "Balanced ✓" in green.
6. Change the credit amount to 999. Confirm Difference = ₹1.00 in red and status bar shows "Unbalanced" in red.
7. Save the entry (debit ≠ credit). ERPNext's native validation should still fire; the ADHD indicator is informational only.
8. Reload the form on the saved entry; confirm the meter re-renders from saved data.
9. Disable ADHD mode. Refresh the Journal Entry form; confirm the balance meter is **not** present.
10. Open a different doctype (e.g., Sales Invoice); confirm no balance meter appears there.

## Acceptance Criteria
- [ ] Balance meter `<div>` is injected below the Accounts child table when ADHD mode is active.
- [ ] Debit, Credit, and Difference figures update within 200 ms of any cell edit.
- [ ] Difference cell has green text and `adhd-balanced` class when debit equals credit (within 0.001 tolerance).
- [ ] Difference cell has red text and `adhd-unbalanced` class when debit ≠ credit.
- [ ] Form status bar shows "Balanced ✓" (green) or "Unbalanced" (red) accordingly.
- [ ] Meter is absent when ADHD mode is disabled.
- [ ] No duplicate meter element appears when the form is refreshed multiple times.
- [ ] No JS errors in console on form open, row add, or row delete.

## Dependencies
- Blocked by: none
- Blocks: none
- Related: ADHD-016 (settings panel) — when shipped, the balance meter on/off toggle should be wired there

## Complexity
S — DOM injection + arithmetic on an existing child table; no server-side work required.

## Phase
Phase 4 — Workflow Clarity
