# ADHD-059: Expense Claim "Receipt Attached?" Ambient Check

## Current implementation record

- **Status:** Implemented in Hubble (the HR app), 2026-09-21.
- **Implementation:** `hrms/public/js/adhd/adhd_expense_claim.js`: a summary of how many expense rows still lack a receipt, from the claim's own attachments, cached per document and refreshed on save; display only, gone when Focus Mode goes off.
- **Verification:** `hrms/tests/adhd_leave_expense.test.js` and `hrms/tests/test_adhd_leave_expense.py`, shared with ADHD-058.
- **Acceptance:** Not yet seen in a logged-in browser.

## Summary
On an Expense Claim form in ADHD mode, display a "📎 No receipt" badge on each expense row lacking an attachment and a summary line showing how many expenses have receipts, preventing rejection-by-missing-receipt.

## Background / Context
ERPNext does not enforce receipt attachment on Expense Claim rows, so users commonly submit claims without receipts and have them returned by the approver. For ADHD users, the rejection ("your claim was returned") is a genuine RSD trigger — especially when the fix is trivial (just attach the file) but the delay causes payroll to be missed. The friction is purely ambient: nothing on the form tells the user a receipt is missing until it's too late. The Expense Claim form's `expenses` child table has no visual indicator of attachment presence per row.

## Cognitive Mechanism
Working memory | RSD (rejection-sensitive dysphoria) | Attention switching

## Prerequisites
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/hr/doctype/expense_claim/adhd_expense_claim.js`

## What Needs to Be Done

1. **Create `adhd_expense_claim.js`**. Guard with `if (!frappe.boot.adhd_mode) return;` at the top.

2. **Register `frappe.ui.form.on('Expense Claim', { refresh(frm) { ... } })`**. On refresh, call `checkReceiptAttachments(frm)`.

3. **`checkReceiptAttachments(frm)`**:
   a. If `frm.doc.expenses` is empty or undefined, return.
   b. Call `frappe.call` to retrieve all attachments for this document:
      ```js
      frappe.call({
        method: 'frappe.client.get_list',
        args: {
          doctype: 'File',
          filters: {
            attached_to_doctype: 'Expense Claim',
            attached_to_name: frm.doc.name,
          },
          fields: ['name', 'file_name', 'attached_to_field'],
          limit: 100,
        },
        callback(r) {
          renderReceiptBadges(frm, r.message || []);
        }
      });
      ```

4. **`renderReceiptBadges(frm, attachments)`**:
   a. Build a Set of `attached_to_field` values from the attachments array. Note: ERPNext stores `attached_to_field` as the child table row name when attached from a child row — verify this assumption by inspecting the `File` doctype schema. If `attached_to_field` is not reliable per-row, fall back to using `file_name` matching by expense description, or simply count total attachments vs total rows.
   b. **Per-row badge logic**: iterate `frm.doc.expenses`. For each row:
      - Find the row's rendered `<div data-name="{row.name}">` in the child table grid.
      - If the row's name is NOT in the attachment set (or if the fallback count approach is used and there are fewer attachments than rows), inject `<span class="adhd-no-receipt">📎 No receipt</span>` at the end of the row's first visible column cell.
      - If a badge already exists for this row, do not add another.
      - If the row HAS an attachment, remove any existing `adhd-no-receipt` badge from it.
   c. **Summary line**:
      - Count: `rowsWithReceipt = attachments.length` (approximate) or the more precise per-row count from step b.
      - Total rows: `frm.doc.expenses.length`.
      - Remove any existing `#adhd-receipt-summary` element.
      - Build: `<div id="adhd-receipt-summary" class="adhd-receipt-summary">{rowsWithReceipt} of {total} expenses have receipts attached.</div>`
      - Inject below the `expenses` child table wrapper: `frm.fields_dict.expenses.$wrapper.after(summaryElement)`.
      - Apply CSS: green background if all have receipts, amber if some are missing, red if none have receipts.

5. **Re-run on attachment changes**: ERPNext fires `frm.reload_doc()` after an attachment is added via the standard "Attach" button. The `refresh` hook re-runs `checkReceiptAttachments`, so this is handled automatically. No additional hook needed.

6. **Re-run when child table rows change**: add hooks `frappe.ui.form.on('Expense Claim Detail', { expenses_add(frm) { checkReceiptAttachments(frm); }, expenses_remove(frm) { checkReceiptAttachments(frm); } })` — use the actual child doctype name from `expense_claim.json` (likely `'Expense Claim Detail'`; confirm before finalising).

7. **CSS**:
   ```css
   .adhd-no-receipt { background: #f8d7da; color: #721c24; font-size: 0.75rem; padding: 2px 6px; border-radius: 3px; margin-left: 8px; }
   .adhd-receipt-summary { padding: 6px 12px; border-radius: 4px; font-size: 0.85rem; margin-top: 6px; }
   .adhd-receipt-summary.green { background: #d4edda; color: #155724; }
   .adhd-receipt-summary.amber { background: #fff3cd; color: #856404; }
   .adhd-receipt-summary.red   { background: #f8d7da; color: #721c24; }
   ```

8. **Fallback if per-row attachment detection is not reliable**: if `attached_to_field` in the `File` doctype does not distinguish per-row attachments, fall back to showing a single summary line: "X attachments for {total} expenses. Please ensure each expense has a receipt." This is a known limitation of ERPNext's attachment model for child tables.

9. **Bundle**: add `adhd_expense_claim.js` to `hooks.py` under `doctype_js["Expense Claim"]`.

## How to Test

1. Enable ADHD mode. Go to **HR → Expense Claim → New**.
2. Add 3 expense rows (different expense types and amounts). Save as draft.
3. Confirm a "📎 No receipt" badge appears on all 3 rows.
4. Confirm a summary line reads "0 of 3 expenses have receipts attached" with a red background.
5. Click the "Attach" button on the Expense Claim form and attach a file (e.g. a PNG). Save. Reload.
6. Confirm the summary updates (e.g. "1 of 3 expenses have receipts attached" with amber background).
7. Attach a file to each of the remaining 2 rows (or attach 3 total files). Reload.
8. Confirm summary reads "3 of 3 expenses have receipts attached" with green background and no "📎 No receipt" badges are visible.
9. Add a new 4th expense row. Confirm a "📎 No receipt" badge immediately appears on the new row and the summary updates.
10. Disable ADHD mode. Reload the Expense Claim. Confirm no badges and no summary line.
11. Open a submitted Expense Claim with missing receipts. Confirm badges still render (informational on read-only form).

## Acceptance Criteria
- [ ] "📎 No receipt" badge appears on each expense row without an attached file.
- [ ] No badge appears on rows that have an attached file.
- [ ] Summary line shows "X of Y expenses have receipts attached" below the child table.
- [ ] Summary is green (all attached), amber (some missing), or red (none attached).
- [ ] Summary and badges update when a new row is added or removed.
- [ ] Summary and badges update after an attachment is added (on form reload/refresh).
- [ ] Feature is absent when ADHD mode is off.
- [ ] No JS errors when `expenses` child table is empty.
- [ ] No extra API calls beyond the single File list fetch on refresh.

## Dependencies
- Blocks: none
- Blocked by: none (ADHD mode toggle already shipped)

## Complexity
S — one `frappe.call` for file list, child table row DOM targeting, and summary injection; no server-side code.

## Phase
Phase 7 — Module-by-Module Expansion
