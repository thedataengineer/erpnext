# ADHD-028: Purchase Invoice Three-Way Match Indicator

## Summary
Compares the Purchase Invoice `net_total` against the originating Purchase Order and Purchase Receipt totals in ADHD mode, displaying a colour-coded "Match Status" badge next to `grand_total` — converting a submit-time blocking validation error into an ambient, pre-submit signal the user can act on calmly.

## Background / Context
ERPNext enforces three-way matching at Purchase Invoice submission: the invoice total must reconcile with the PO and the receipt. When there is a variance, the system throws a hard error at submit time — after the user has already filled in the form. For ADHD users, a blocking error at the last step is a high-RSD (rejection-sensitive dysphoria) moment: it feels like the system is punishing effort, and the impulse to abandon the task is strong. Showing the match status as an ambient badge during form fill converts a stressful final-step error into a calm, early warning.

## Cognitive Mechanism
RSD | working memory | attention switching

## Prerequisites
- ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` readable on the client.

## Scope
**Create:**
- `erpnext/accounts/doctype/purchase_invoice/adhd_purchase_invoice_match.js`

## What Needs to Be Done

1. **Create `adhd_purchase_invoice_match.js` and register triggers:**
   ```js
   frappe.ui.form.on("Purchase Invoice", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (frm.doc.docstatus === 1) return; // Already submitted — badge is informational only
       renderMatchStatusBadge(frm);
     },
     net_total(frm) {
       if (!frappe.boot.adhd_mode) return;
       renderMatchStatusBadge(frm);
     },
     // Re-run whenever the PO or receipt reference changes
     purchase_order: triggerMatchCheck,
     bill_no:        triggerMatchCheck,
   });

   function triggerMatchCheck(frm) {
     if (!frappe.boot.adhd_mode) return;
     renderMatchStatusBadge(frm);
   }
   ```

2. **Implement `renderMatchStatusBadge(frm)`.** Orchestrates fetching reference totals and rendering the badge:
   ```js
   async function renderMatchStatusBadge(frm) {
     removeMatchBadge(frm);

     const invoiceNetTotal = frm.doc.net_total || 0;
     if (!invoiceNetTotal) return; // Nothing to compare yet

     const poName = frm.doc.purchase_order
       || (frm.doc.items && frm.doc.items[0] && frm.doc.items[0].purchase_order);

     if (!poName) return; // No PO reference — three-way match not applicable

     // Fetch PO net_total
     let poNetTotal = null;
     try {
       const poResult = await frappe.call({
         method: "frappe.model.get_value",
         args: { doctype: "Purchase Order", fieldname: "net_total", filters: { name: poName } },
       });
       poNetTotal = (poResult.message && poResult.message.net_total) || null;
     } catch {
       // Fail silently — badge will not render without PO data
       return;
     }

     // Fetch linked Purchase Receipt net_total (most recent receipt for this PO)
     let receiptNetTotal = null;
     try {
       const receiptResult = await frappe.call({
         method: "frappe.client.get_list",
         args: {
           doctype: "Purchase Receipt",
           filters: { purchase_order: poName, docstatus: 1 },
           fields: ["name", "net_total"],
           limit: 1,
           order_by: "modified desc",
         },
       });
       const receipts = receiptResult.message || [];
       receiptNetTotal = receipts.length ? receipts[0].net_total : null;
     } catch {
       receiptNetTotal = null;
     }

     injectMatchBadge(frm, invoiceNetTotal, poNetTotal, receiptNetTotal);
   }
   ```

3. **Implement `injectMatchBadge(frm, invoiceTotal, poTotal, receiptTotal)`.** Determines match status and renders the badge:
   ```js
   function injectMatchBadge(frm, invoiceTotal, poTotal, receiptTotal) {
     // Tolerance: within 5% is a "warning" variance; beyond 5% is a mismatch
     const WARN_THRESHOLD = 0.05;

     // Compare invoice to PO (primary reference)
     const refTotal = poTotal || receiptTotal;
     if (!refTotal) return;

     const variance    = invoiceTotal - refTotal;
     const varPct      = Math.abs(variance) / refTotal;
     const currency    = frm.doc.currency || frappe.boot.sysdefaults.currency || "";
     const varFormatted = frappe.format(Math.abs(variance), { fieldtype: "Currency" });

     let badgeClass, badgeText, title;

     if (varPct === 0) {
       badgeClass = "adhd-match-ok";
       badgeText  = "✓ Matched";
       title      = `Invoice total matches PO (${frappe.format(refTotal, { fieldtype: "Currency" })} ${currency})`;
     } else if (varPct <= WARN_THRESHOLD) {
       badgeClass = "adhd-match-warn";
       badgeText  = `⚠ Variance: ${varFormatted} ${currency}`;
       title      = `Within 5% tolerance. PO total: ${frappe.format(refTotal, { fieldtype: "Currency" })} ${currency}`;
     } else {
       badgeClass = "adhd-match-fail";
       badgeText  = `✗ Mismatch: ${varFormatted} ${currency}`;
       title      = `Exceeds 5% tolerance. PO total: ${frappe.format(refTotal, { fieldtype: "Currency" })} ${currency}`;
     }

     // Also note if receipt total diverges from invoice
     let receiptNote = "";
     if (receiptTotal && Math.abs(invoiceTotal - receiptTotal) / receiptTotal > WARN_THRESHOLD) {
       const rVar = frappe.format(Math.abs(invoiceTotal - receiptTotal), { fieldtype: "Currency" });
       receiptNote = ` (Receipt variance: ${rVar} ${currency})`;
     }

     const badge = $(`
       <span class="adhd-match-badge ${badgeClass}" title="${title}${receiptNote}">
         ${badgeText}
       </span>
     `);

     // Inject immediately after the grand_total field label
     const $grandTotalWrapper = $(frm.fields_dict.grand_total.wrapper);
     $grandTotalWrapper.append(badge);
   }

   function removeMatchBadge(frm) {
     $(frm.wrapper).find(".adhd-match-badge").remove();
   }
   ```

4. **CSS in `adhd_mode.scss`:**
   - `.adhd-match-badge` — `display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 700; vertical-align: middle; cursor: default;`
   - `.adhd-match-ok` — `background: var(--green-100); color: var(--green-700); border: 1px solid var(--green-300);`
   - `.adhd-match-warn` — `background: var(--yellow-100); color: var(--yellow-800); border: 1px solid var(--yellow-400);`
   - `.adhd-match-fail` — `background: var(--red-100); color: var(--red-700); border: 1px solid var(--red-400);`

5. **Include in `hooks.py`** under `app_include_js`.

## How to Test

1. Enable ADHD mode. Create a Purchase Order for Supplier X with Item A qty 10 at rate 100 (net total = 1,000). Submit it.
2. From the PO, make a Purchase Receipt for the full quantity. Submit it.
3. From the PO, make a Purchase Invoice. Before setting any amounts, confirm no badge appears (net_total is 0).
4. The invoice should auto-populate with net_total = 1,000. After the form loads, confirm a green **✓ Matched** badge appears next to the Grand Total field. Hover over it to confirm the tooltip shows the PO total.
5. Manually change an item rate to make net_total = 1,040 (4% variance). Confirm the badge updates to amber **⚠ Variance: 40.00 INR** (or site currency).
6. Change the rate further to make net_total = 1,200 (20% variance). Confirm the badge updates to red **✗ Mismatch: 200.00 INR**.
7. Remove the `purchase_order` reference from the invoice. Confirm the badge disappears.
8. Submit the invoice (with the matched amount). Confirm the badge still shows on the submitted form (read-only state) but is not interactive.
9. Open a Purchase Invoice that was not created from a PO. Confirm no badge appears.
10. Disable ADHD mode. Open a new Purchase Invoice from the PO. Confirm no badge appears.
11. Confirm no console errors at any step.

## Acceptance Criteria
- [ ] A "Match Status" badge appears next to `grand_total` on Purchase Invoice forms in ADHD mode when the form has a PO reference and a non-zero `net_total`.
- [ ] Green "✓ Matched" badge shows when the variance between invoice and PO net total is 0.
- [ ] Amber "⚠ Variance: X" badge shows when variance is > 0 and ≤ 5% of PO net total.
- [ ] Red "✗ Mismatch: X" badge shows when variance exceeds 5% of PO net total.
- [ ] Badge tooltip shows the PO net total for context.
- [ ] Badge updates in real time as item rates are changed on the form.
- [ ] Badge is absent when no PO reference exists or when net_total is zero.
- [ ] Badge renders on submitted invoices (informational, read-only).
- [ ] Badge is absent when ADHD mode is disabled.
- [ ] No JavaScript console errors in any of the above states.

## Dependencies
- **Blocked by:** ADHD mode toggle (shipped)
- **Blocked by (complementary):** ADHD-027 (Purchase Receipt diff — same Buying module, same flow)
- **Blocks:** None

## Complexity
S — Single form script, two async value fetches, badge injected into an existing field wrapper. No server endpoint, no DocType changes.

## Phase
Phase 7 — Module-by-Module Expansion
