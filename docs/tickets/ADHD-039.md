# ADHD-039: Stock Reconciliation "Variance Highlight"

## Current implementation record

- **Status:** Implemented.
- **Implementation:** `erpnext/public/js/adhd/adhd_stock_reconciliation.js`, imported by the bundle.
- **Verification:** `node --test erpnext/tests/adhd_tickets_031_040.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When ADHD mode is active on a Stock Reconciliation form, automatically compare user-entered quantities against ERPNext's fetched current quantities for each row, highlight rows with significant variance, and add a visible "Variance" column — catching accidental typos before submission.

## Background / Context
Stock Reconciliation is one of the highest-stakes forms in ERPNext: a submitted reconciliation directly rewrites bin quantities with no further confirmation. ADHD users are especially prone to transposition errors (entering "100" instead of "10") and to missing the `current_qty` field because it sits far to the right of the data-entry `qty` field. The cognitive load of comparing dozens of rows manually is high enough that most users don't do it. Inline variance highlighting makes errors visually impossible to miss.

## Cognitive Mechanism
Working memory | attention switching | time blindness

## Prerequisites
- ADHD mode toggle (Phase 1, `public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` must be readable.

## Scope
**Create:**
- `erpnext/stock/doctype/stock_reconciliation/adhd_stock_reconciliation.js`

**Modify:**
- `erpnext/hooks.py` — add `"Stock Reconciliation": "stock/doctype/stock_reconciliation/adhd_stock_reconciliation.js"` to `doctype_js`.

## What Needs to Be Done

1. **Register form and child table hooks.**
   ```js
   frappe.ui.form.on("Stock Reconciliation", {
     refresh(frm)    { if (frappe.boot.adhd_mode && frm.doc.docstatus === 0) scheduleVarianceCheck(frm); },
     after_save(frm) { if (frappe.boot.adhd_mode && frm.doc.docstatus === 0) scheduleVarianceCheck(frm); },
   });

   frappe.ui.form.on("Stock Reconciliation Item", {
     qty(frm, cdt, cdn)         { if (frappe.boot.adhd_mode) scheduleVarianceCheck(frm); },
     current_qty(frm, cdt, cdn) { if (frappe.boot.adhd_mode) scheduleVarianceCheck(frm); },
     items_remove(frm)          { if (frappe.boot.adhd_mode) scheduleVarianceCheck(frm); },
   });
   ```

2. **Debounce.** Use a 400 ms debounce to avoid thrashing on rapid input:
   ```js
   let _varianceTimer = null;
   function scheduleVarianceCheck(frm) {
     clearTimeout(_varianceTimer);
     _varianceTimer = setTimeout(() => applyVarianceHighlights(frm), 400);
   }
   ```

3. **`applyVarianceHighlights(frm)`.** Core logic:
   ```js
   function applyVarianceHighlights(frm) {
     let hasHighVariance = false;

     (frm.doc.items || []).forEach(row => {
       const enteredQty  = parseFloat(row.qty)         ?? 0;
       const currentQty  = parseFloat(row.current_qty) ?? 0;

       // Skip rows with no entered qty or no current_qty fetched yet
       if (row.qty === null || row.qty === undefined || row.qty === "") return;
       if (row.current_qty === null || row.current_qty === undefined) return;

       const absoluteVariance = Math.abs(enteredQty - currentQty);
       const percentVariance  = currentQty !== 0
         ? (absoluteVariance / Math.abs(currentQty)) * 100
         : (enteredQty !== 0 ? 100 : 0);

       const isHighVariance = percentVariance > 10 || absoluteVariance > 50;

       const $gridRow = getGridRow(frm, row.name);
       if (!$gridRow.length) return;

       // Apply or remove highlight
       $gridRow.toggleClass("adhd-variance-row", isHighVariance);

       // Update or insert variance cell
       updateVarianceCell($gridRow, enteredQty, currentQty, absoluteVariance, isHighVariance);

       if (isHighVariance) hasHighVariance = true;
     });

     renderVarianceSummaryBanner(frm, hasHighVariance);
   }
   ```

4. **`getGridRow(frm, rowName)`.** Helper to locate a grid row's `<tr>` by docname:
   ```js
   function getGridRow(frm, rowName) {
     return $(frm.fields_dict.items.grid.wrapper)
       .find(`tr[data-name="${rowName}"], .grid-row[data-name="${rowName}"]`);
   }
   ```

5. **`updateVarianceCell($gridRow, enteredQty, currentQty, absoluteVariance, isHighVariance)`.** Injects or updates a "Variance" pseudo-column:
   ```js
   function updateVarianceCell($gridRow, enteredQty, currentQty, absoluteVariance, isHighVariance) {
     $gridRow.find(".adhd-variance-cell").remove();  // idempotent

     if (!isHighVariance) return;  // only show cell for flagged rows

     const diff = enteredQty - currentQty;
     const sign = diff >= 0 ? "+" : "−";
     const $cell = $(`
       <td class="adhd-variance-cell" style="
         font-size:0.78rem; font-weight:600; padding:4px 8px;
         color: ${diff > 0 ? "var(--green-600)" : "var(--red-600)"};
         white-space:nowrap;">
         Variance: ${sign}${Math.abs(diff).toFixed(2)}
       </td>
     `);
     $gridRow.append($cell);
   }
   ```

6. **`renderVarianceSummaryBanner(frm, hasHighVariance)`.** Shows or hides a banner above the items table:
   ```js
   function renderVarianceSummaryBanner(frm, hasHighVariance) {
     const $existing = $("#adhd-variance-banner");

     if (!hasHighVariance) {
       $existing.remove();
       return;
     }

     const flaggedCount = $(frm.fields_dict.items.wrapper)
       .find(".adhd-variance-row").length;

     if ($existing.length) {
       $existing.find(".adhd-variance-count").text(flaggedCount);
       return;
     }

     const $banner = $(`
       <div id="adhd-variance-banner" class="alert alert-warning adhd-variance-banner"
            style="margin:8px 0; display:flex; align-items:center; gap:8px;">
         <span>⚠</span>
         <span>
           <strong><span class="adhd-variance-count">${flaggedCount}</span> row(s)</strong>
           have a variance &gt;10% or &gt;50 units. Review before submitting.
         </span>
       </div>
     `);
     $(frm.fields_dict.items.wrapper).before($banner);
   }
   ```

7. **Yellow row highlight CSS:**
   ```css
   .adhd-variance-row > td {
     background-color: rgba(255, 220, 0, 0.18) !important;
   }
   .adhd-variance-banner {
     border-left: 4px solid var(--yellow-500);
   }
   ```
   Inject as a `<style>` tag on first load (check for `#adhd-stock-recon-styles` to avoid duplicates), or add to `adhd_mode.scss`.

8. **Clear highlights on docstatus change.** When `frm.doc.docstatus` changes to 1 (on submit), remove all highlights and the banner:
   ```js
   frappe.ui.form.on("Stock Reconciliation", {
     after_submit(frm) {
       $("#adhd-variance-banner").remove();
       $(".adhd-variance-row").removeClass("adhd-variance-row");
       $(".adhd-variance-cell").remove();
     },
   });
   ```

## How to Test

1. Open ERPNext with ADHD mode enabled.
2. Navigate to **Stock → Stock Reconciliation → New**.
3. Click "Get Items" or manually add an item that has a known `current_qty` (e.g., 10 units as shown by the Stock Balance report).
4. In the `qty` field of that row, enter `11` (a change of 1 unit, within 10%). Confirm no yellow highlight and no variance cell appear.
5. Change `qty` to `100` (a variance of 90 units, well above both thresholds). Confirm:
   - The row background turns yellow.
   - A "Variance: +90.00" cell appears at the end of the row.
   - A warning banner appears above the items table: "⚠ 1 row(s) have a variance >10% or >50 units."
6. Change `qty` to `5` (a variance of −5 units, below both thresholds). Confirm yellow highlight disappears and banner disappears.
7. Add a second item row with a large variance. Confirm the banner count updates to "2 row(s)".
8. Submit the document. Confirm all yellow highlights and the banner are cleared on the submitted form.
9. Disable ADHD mode. Open a new Stock Reconciliation, enter large variances. Confirm no yellow highlighting or banner appears.

## Acceptance Criteria
- [ ] Rows where `abs(qty - current_qty) > 50` are highlighted yellow.
- [ ] Rows where `abs(qty - current_qty) / abs(current_qty) > 10%` are also highlighted yellow.
- [ ] A "Variance: ±N.NN" cell appears at the end of every highlighted row.
- [ ] Positive variances display in green text; negative variances display in red text.
- [ ] Warning banner above the items table shows the count of flagged rows.
- [ ] Banner count updates in real time as quantities are changed.
- [ ] Rows that no longer meet the threshold lose their highlight and cell immediately.
- [ ] All highlights and the banner are removed after the document is submitted.
- [ ] No highlights or banner appear when ADHD mode is disabled.
- [ ] No JavaScript console errors on the Stock Reconciliation form.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD mode toggle (Phase 1, already shipped).

## Complexity
S — Pure client-side arithmetic against values already present in the child table `frm.doc.items`; no API calls required; straightforward DOM class toggling and cell injection.

## Phase
Phase 7 — Module-by-Module Expansion
