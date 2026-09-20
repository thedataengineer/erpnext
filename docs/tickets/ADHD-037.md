# ADHD-037: Batch & Serial Lookup Inline

## Summary
When ADHD mode is active and a user clicks into a `batch_no` cell in any items child table, replace the standard link dialog with a compact inline batch picker showing expiry-sorted batches with available quantities — eliminating the context-breaking popup and making FEFO selection effortless.

## Background / Context
The standard ERPNext batch selection flow opens a generic link dialog that shows only Batch IDs, requiring the user to separately check expiry dates and available quantities in another report before selecting. For ADHD users, this multi-step lookup is a context-switch that breaks concentration and is frequently skipped — leading to expired-batch selections or incorrect allocation. The friction appears on any child table that has a `batch_no` field: Stock Entry Detail, Delivery Note Item, Purchase Receipt Item, and others.

## Cognitive Mechanism
Attention switching | working memory | initiation

## Prerequisites
- ADHD mode toggle (Phase 1, `public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` must be readable.

## Scope
**Create:**
- `erpnext/stock/doctype/stock_entry/adhd_batch_picker.js` — reusable batch picker component (referenced from Stock Entry and importable by other doctypes).

**Modify:**
- `erpnext/hooks.py` — add `adhd_batch_picker.js` to `app_include_js` (loaded globally so it can intercept grid events on any doctype).

## What Needs to Be Done

1. **Intercept `batch_no` cell click globally.** After the file loads, register a delegated event listener on the document to catch grid field edits before the standard link dialog opens:
   ```js
   $(document).on("frappe.ui.form.Grid.edit_row", function () {});
   // Preferred: hook via grid's built-in before_field_edit event
   ```
   Since Frappe grids do not expose a global `before_field_edit`, use a different approach — override the `link` control's `get_query`-level popup. The most reliable hook is:
   ```js
   frappe.ui.form.ControlLink.prototype.open_advanced_search = (function (original) {
     return function (...args) {
       if (!frappe.boot.adhd_mode) return original.apply(this, args);
       if (this.df.fieldname === "batch_no" && this.grid_row) {
         const row = this.grid_row.doc;
         openAdhdBatchPicker(this, row);
         return;  // suppress default popup
       }
       return original.apply(this, args);
     };
   })(frappe.ui.form.ControlLink.prototype.open_advanced_search);
   ```
   This wraps the prototype method that fires when the link-field search icon or lookup is triggered.

2. **`openAdhdBatchPicker(control, row)`.** Accepts the ControlLink instance (to fill the value back) and the child-table row doc (for `item_code` and `warehouse`).
   - Extract `item_code = row.item_code` and `warehouse = row.s_warehouse || row.warehouse || row.t_warehouse`.
   - If `item_code` is blank, fall back to original behaviour.
   - Fetch batches (step 3), then render picker dialog (step 4).

3. **Fetch available batches.** Single `frappe.call`:
   ```js
   async function fetchBatches(item_code, warehouse) {
     const res = await frappe.call({
       method: "frappe.client.get_list",
       args: {
         doctype: "Batch",
         filters: [
           ["item", "=", item_code],
           ["disabled", "=", 0],
         ],
         fields: ["name", "manufacturing_date", "expiry_date"],
         order_by: "expiry_date asc",
         limit: 50,
       },
     });
     const batches = res.message || [];

     // Fetch available qty per batch from Bin / Batch Bundle
     // Use erpnext's get_batch_qty if available, else frappe.db
     const qtyRes = await frappe.call({
       method: "erpnext.stock.doctype.batch.batch.get_batch_qty",
       args: { batch_no: null, warehouse, item_code },
     });
     // Returns array of {batch_no, qty} — build a map
     const qtyMap = {};
     (qtyRes.message || []).forEach(b => { qtyMap[b.batch_no] = b.qty || 0; });

     // Merge qty into batch list
     return batches.map(b => ({ ...b, available_qty: qtyMap[b.name] || 0 }));
   }
   ```

4. **Render the picker dialog.** Use `new frappe.ui.Dialog`:
   ```js
   function renderBatchPicker(control, batches, item_code, warehouse) {
     const dialog = new frappe.ui.Dialog({
       title: `Select Batch — ${item_code}`,
       size: "large",
     });
     dialog.show();

     const $body = $(dialog.$wrapper.find(".modal-body"));
     $body.empty();

     if (!batches.length) {
       $body.html('<p class="text-muted">No batches found for this item.</p>');
       return;
     }

     const today = frappe.datetime.get_today();
     const rows = batches.map(b => {
       const expired  = b.expiry_date && b.expiry_date < today;
       const expiring = b.expiry_date && b.expiry_date <= frappe.datetime.add_days(today, 30);
       return `
         <tr class="${expired ? "adhd-batch-expired" : expiring ? "adhd-batch-expiring" : ""}"
             data-batch="${frappe.utils.escape_html(b.name)}"
             style="cursor:pointer;">
           <td><strong>${frappe.utils.escape_html(b.name)}</strong></td>
           <td>${b.manufacturing_date || "—"}</td>
           <td class="${expired ? "text-danger" : expiring ? "text-warning" : ""}">
             ${b.expiry_date || "No expiry"}${expired ? " ⚠ Expired" : expiring ? " ⏳ Expiring soon" : ""}
           </td>
           <td class="text-right"><strong>${b.available_qty}</strong></td>
           <td>
             <button class="btn btn-xs btn-primary adhd-batch-select-btn"
                     data-batch="${frappe.utils.escape_html(b.name)}">
               Select
             </button>
           </td>
         </tr>`;
     }).join("");

     $body.html(`
       <table class="table table-condensed adhd-batch-table">
         <thead>
           <tr>
             <th>Batch ID</th><th>Mfg. Date</th><th>Expiry Date</th>
             <th class="text-right">Available Qty</th><th></th>
           </tr>
         </thead>
         <tbody>${rows}</tbody>
       </table>
       <p class="text-muted" style="font-size:0.75rem;margin-top:4px;">
         Sorted by expiry date (FEFO). ${warehouse ? `Warehouse: ${frappe.utils.escape_html(warehouse)}` : ""}
       </p>
     `);

     // Row click or Select button click fills the value
     $body.on("click", ".adhd-batch-select-btn", function () {
       const batchNo = $(this).data("batch");
       control.set_value(batchNo);
       dialog.hide();
     });
   }
   ```

5. **CSS:**
   - `.adhd-batch-expired`  — `opacity: 0.5; text-decoration: line-through;`
   - `.adhd-batch-expiring` — `background: rgba(var(--yellow-rgb), 0.1);`
   - `.adhd-batch-table`    — `font-size: 0.82rem;`

6. **Full `openAdhdBatchPicker` function:**
   ```js
   async function openAdhdBatchPicker(control, row) {
     const item_code = row.item_code;
     const warehouse = row.s_warehouse || row.t_warehouse || row.warehouse || "";
     if (!item_code) { return control.open_advanced_search.__original?.apply(control); }
     frappe.show_progress("Loading batches…", 0, 100, "Please wait");
     const batches = await fetchBatches(item_code, warehouse).catch(() => []);
     frappe.hide_progress();
     renderBatchPicker(control, batches, item_code, warehouse);
   }
   ```

## How to Test

1. Open ERPNext with ADHD mode enabled.
2. Navigate to **Stock → Stock Entry → New**. Set type to "Material Issue". Add an item that has multiple batches (verify via Batch list).
3. Set `s_warehouse`. Click into the `batch_no` cell of the items child table.
4. Confirm the ADHD batch picker dialog opens **instead of** the standard link dialog.
5. Confirm the dialog shows columns: Batch ID, Manufacturing Date, Expiry Date, Available Qty, and a Select button.
6. Confirm rows are sorted by expiry date ascending.
7. If a batch has an expiry date in the past, confirm it is shown with strikethrough and reduced opacity.
8. If a batch expires within 30 days, confirm it is shown with a yellow background.
9. Click "Select" on a row. Confirm the `batch_no` cell is filled with the selected batch ID and the dialog closes.
10. Navigate to **Stock → Delivery Note → New**. Add an item with batches. Click the `batch_no` cell. Confirm the same picker appears (reusability across doctypes).
11. Disable ADHD mode. Open a new Stock Entry, add an item, click `batch_no`. Confirm the standard link dialog appears.

## Acceptance Criteria
- [ ] ADHD batch picker intercepts the `batch_no` cell link dialog on all items child tables when ADHD mode is active.
- [ ] Picker shows Batch ID, Manufacturing Date, Expiry Date, and Available Qty for each batch.
- [ ] Rows are sorted by expiry date ascending (FEFO order).
- [ ] Expired batches display with strikethrough styling.
- [ ] Batches expiring within 30 days display with a yellow-tinted row.
- [ ] Clicking "Select" fills the `batch_no` field and closes the dialog.
- [ ] The picker works on Stock Entry, Delivery Note, and Purchase Receipt items tables.
- [ ] Standard link dialog appears (fallback) when ADHD mode is disabled.
- [ ] No JavaScript console errors on any doctype that has a `batch_no` child field.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD mode toggle (Phase 1, already shipped).

## Complexity
M — Requires prototype-level override of ControlLink, two async API calls (Batch list + get_batch_qty), conditional expiry-date styling, and cross-doctype reusability via global load; moderate but well-contained scope.

## Phase
Phase 7 — Module-by-Module Expansion
