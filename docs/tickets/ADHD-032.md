# ADHD-032: Payment Entry Invoice Shortlist

## Summary
When ADHD mode is active on a Payment Entry form and a party is selected, automatically fetch outstanding invoices and display them as a priority-sorted shortlist — eliminating the invisible "click Get Outstanding Invoices" step and the cognitive effort of triaging a flat, unsorted list.

## Background / Context
The standard Payment Entry workflow requires users to set the party, then manually click "Get Outstanding Invoices," then mentally sort through an unsorted flat list of every open invoice — sometimes dozens deep — to figure out what to pay first. For ADHD users, the manual trigger is an initiation barrier (it's easy to forget the button exists), and the unsorted list creates significant working memory load while the user tries to identify what is actually overdue. The friction lives in the Payment Entry form at `/app/payment-entry`.

## Cognitive Mechanism
Initiation | working memory | attention switching

## Prerequisites
- ADHD mode toggle (Phase 1, `public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` must be readable.
- Standard ERPNext `get_outstanding_reference_documents` server method must be available (it is — it ships with core ERPNext accounts).

## Scope
**Create:**
- `erpnext/accounts/doctype/payment_entry/adhd_payment_entry.js`

**Modify:**
- `erpnext/hooks.py` — add `"Payment Entry": "accounts/doctype/payment_entry/adhd_payment_entry.js"` to `doctype_js`.

## What Needs to Be Done

1. **Register the form hook.** In `adhd_payment_entry.js`:
   ```js
   frappe.ui.form.on("Payment Entry", {
     party(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (!frm.doc.party || !frm.doc.party_type) return;
       fetchAndRenderShortlist(frm);
     },
     party_type(frm) {
       if (!frappe.boot.adhd_mode) return;
       // Clear shortlist when party type changes
       removeShortlist(frm);
     },
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (frm.doc.party && frm.doc.docstatus === 0) fetchAndRenderShortlist(frm);
     },
   });
   ```

2. **Fetch outstanding invoices.** `fetchAndRenderShortlist(frm)`:
   ```js
   function fetchAndRenderShortlist(frm) {
     frm.set_df_property("references", "description", "Loading outstanding invoices…");
     frappe.call({
       method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_outstanding_reference_documents",
       args: {
         args: {
           posting_date: frm.doc.posting_date || frappe.datetime.get_today(),
           company: frm.doc.company,
           party_type: frm.doc.party_type,
           party: frm.doc.party,
           party_account: frm.doc.party_account,
           payment_type: frm.doc.payment_type,
           currency: frm.doc.currency,
           cost_center: frm.doc.cost_center,
         },
       },
       callback(r) {
         frm.set_df_property("references", "description", "");
         if (r.message && r.message.length) {
           renderShortlist(frm, r.message);
         } else {
           removeShortlist(frm);
         }
       },
     });
   }
   ```

3. **Sort and bucket results.** `bucketInvoices(invoices)`:
   - Today's date as `frappe.datetime.get_today()`.
   - **Bucket 1 — Overdue / Due Today:** `due_date <= today`, sorted by `due_date` ascending.
   - **Bucket 2 — Due This Week:** `due_date > today && due_date <= weekEnd`, sorted by `due_date` ascending. Compute `weekEnd` as today + 6 days: `frappe.datetime.add_days(today, 6)`.
   - **Bucket 3 — All Others:** remaining, sorted by `due_date` ascending.
   - Return `{ urgent: [], thisWeek: [], other: [] }`.

4. **Render the shortlist panel.** `renderShortlist(frm, invoices)`:
   - Remove any existing `#adhd-invoice-shortlist` first.
   - Build a `<div id="adhd-invoice-shortlist" class="adhd-invoice-shortlist">` and insert it **above** the `references` child table by targeting `$(frm.fields_dict.references.wrapper).before(panel)`.
   - For each bucket with results, render a section header (`<h6 class="adhd-bucket-label">`) and a `<table class="adhd-invoice-table table table-condensed">`.
   - Each table row has columns: **Invoice #** (clickable link to the doc), **Due Date**, **Outstanding** (formatted as currency), **Apply** (a checkbox/toggle labeled "Apply full amount").
   - Bucket 1 header: `"⚠ Overdue / Due Today (N)"` with class `adhd-bucket--urgent` (red text).
   - Bucket 2 header: `"Due This Week (N)"` with class `adhd-bucket--soon` (amber text).
   - Bucket 3 header: render as a collapsed `<details><summary>All Others (N)</summary>…</details>` so it doesn't dominate the view.

5. **"Apply" toggle behaviour.** When user checks an "Apply full amount" toggle:
   - Add a new row to `frm.doc.references` child table via `frappe.model.add_child(frm.doc, "references")`.
   - Set fields: `reference_doctype`, `reference_name`, `due_date`, `total_amount`, `outstanding_amount`, `allocated_amount` (= `outstanding_amount`).
   - Call `frm.refresh_field("references")`.
   - Visually mark the shortlist row as applied (add class `adhd-row--applied`, grey out the row, change toggle label to "✓ Applied").
   - When unchecked, find the matching row in `frm.doc.references` by `reference_name` and remove it via `frappe.model.clear_doc` or splice, then refresh.

6. **"Apply All Urgent" convenience button.** If Bucket 1 is non-empty, add a `<button class="btn btn-sm btn-danger adhd-apply-all-urgent">Apply All Overdue</button>` in the Bucket 1 header row. Clicking it iterates all Bucket 1 invoices and fires the apply toggle logic for each.

7. **Remove shortlist.** `removeShortlist(frm)`: `$("#adhd-invoice-shortlist").remove()`.

8. **CSS** (inline `<style>` tag injected once, or add to `adhd_mode.scss`):
   - `.adhd-invoice-shortlist` — `margin-bottom: 1rem; border: 1px solid var(--border-color); border-radius: 4px; padding: 8px;`
   - `.adhd-bucket-label` — `font-size: 0.75rem; font-weight: 700; text-transform: uppercase; margin: 6px 0 4px;`
   - `.adhd-bucket--urgent` — `color: var(--red-500);`
   - `.adhd-bucket--soon` — `color: var(--yellow-500);`
   - `.adhd-row--applied` — `opacity: 0.5; background: var(--control-bg);`

## How to Test

1. Open a fresh ERPNext desk with ADHD mode enabled.
2. Navigate to **Accounts → Payment Entry → New**.
3. Set `Payment Type` = "Pay", `Party Type` = "Supplier", and select a supplier that has at least one overdue Purchase Invoice.
4. Immediately after setting the party, confirm — without clicking any button — that the ADHD shortlist panel appears above the References child table.
5. Confirm invoices are bucketed: overdue ones appear in the red "Overdue / Due Today" section, near-term ones in the amber section, and the rest under the collapsed "All Others" toggle.
6. Click "Apply full amount" on one overdue invoice. Confirm a new row appears in the References child table with the correct `reference_name` and `allocated_amount`.
7. Uncheck the same toggle. Confirm the References row is removed.
8. Click "Apply All Overdue." Confirm all Bucket 1 invoices are added to References and all their rows show the "✓ Applied" state.
9. Change `Party` to a different supplier. Confirm the shortlist panel is removed and reloaded with the new party's invoices.
10. Disable ADHD mode. Open a new Payment Entry. Set a party. Confirm no shortlist panel appears and the standard "Get Outstanding Invoices" button workflow is unaffected.

## Acceptance Criteria
- [ ] Shortlist panel auto-renders on `party` field change without any user button click.
- [ ] Invoices are correctly bucketed into Overdue/Due Today, Due This Week, and All Others.
- [ ] Overdue bucket is sorted by `due_date` ascending; same for other buckets.
- [ ] "All Others" section is collapsed by default.
- [ ] Applying a shortlist invoice adds the correct row to the References child table with `allocated_amount` = `outstanding_amount`.
- [ ] Unapplying an invoice removes the corresponding References row.
- [ ] "Apply All Overdue" button applies all Bucket 1 invoices in one click.
- [ ] Changing the party clears and reloads the shortlist.
- [ ] Panel and auto-fetch do not appear when ADHD mode is disabled.
- [ ] No JavaScript console errors on the Payment Entry form.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD mode toggle (Phase 1, already shipped).

## Complexity
M — Requires async server call, three-bucket sort logic, bidirectional sync between shortlist UI and References child table, and conditional "Apply All" button; no new server endpoints needed.

## Phase
Phase 7 — Module-by-Module Expansion
