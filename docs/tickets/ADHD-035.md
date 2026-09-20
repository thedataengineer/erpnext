# ADHD-035: Stock Entry "Before / After" Preview

## Summary
When ADHD mode is active on a Draft Stock Entry, inject a collapsible "Stock Impact Preview" section below the items child table that shows the current warehouse quantity, the change this entry will apply, and the resulting quantity after submission — making the effect of the entry visually obvious before committing.

## Background / Context
Stock Entries (Material Issue, Material Transfer, Manufacture, etc.) modify warehouse bin quantities in ways that are invisible at the time of data entry. ADHD users frequently submit entries with wrong quantities or wrong warehouses without realising the impact, because the current-qty context is hidden inside separate Bin reports. The friction is worst when a user returns to a partially-filled Stock Entry after an interruption and cannot remember what numbers they intended to enter. Showing "Current: 80, Change: −30, After: 50" in-line removes the need to open a separate report.

## Cognitive Mechanism
Working memory | attention switching | time blindness

## Prerequisites
- ADHD mode toggle (Phase 1, `public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` must be readable.

## Scope
**Create:**
- `erpnext/stock/doctype/stock_entry/adhd_stock_entry.js`

**Modify:**
- `erpnext/hooks.py` — add `"Stock Entry": "stock/doctype/stock_entry/adhd_stock_entry.js"` to `doctype_js`.

## What Needs to Be Done

1. **Register form hooks.**
   ```js
   frappe.ui.form.on("Stock Entry", {
     refresh(frm)            { if (frappe.boot.adhd_mode && frm.doc.docstatus === 0) schedulePreviewRefresh(frm); },
     after_save(frm)         { if (frappe.boot.adhd_mode && frm.doc.docstatus === 0) schedulePreviewRefresh(frm); },
   });
   frappe.ui.form.on("Stock Entry Detail", {
     item_code(frm)          { if (frappe.boot.adhd_mode) schedulePreviewRefresh(frm); },
     qty(frm)                { if (frappe.boot.adhd_mode) schedulePreviewRefresh(frm); },
     s_warehouse(frm)        { if (frappe.boot.adhd_mode) schedulePreviewRefresh(frm); },
     t_warehouse(frm)        { if (frappe.boot.adhd_mode) schedulePreviewRefresh(frm); },
     items_remove(frm)       { if (frappe.boot.adhd_mode) schedulePreviewRefresh(frm); },
   });
   ```

2. **Debounce refresh.** `schedulePreviewRefresh` uses a 600 ms debounce to avoid firing on every keystroke:
   ```js
   let _previewTimer = null;
   function schedulePreviewRefresh(frm) {
     clearTimeout(_previewTimer);
     _previewTimer = setTimeout(() => renderPreview(frm), 600);
   }
   ```

3. **Collect item/warehouse pairs.** `getItemWarehousePairs(frm)`:
   - Iterate `frm.doc.items`. For each row, collect:
     - `item_code`, `s_warehouse` (source), `t_warehouse` (target), `qty`, `transfer_qty`.
   - Deduplicate: build a set of unique `{item_code, warehouse}` pairs from both `s_warehouse` and `t_warehouse`.
   - Skip rows where `item_code` is blank.
   - Return the deduplicated array.

4. **Fetch current Bin quantities.** Single `frappe.call`:
   ```js
   async function fetchBinQtys(pairs) {
     if (!pairs.length) return {};
     const result = await frappe.call({
       method: "frappe.client.get_list",
       args: {
         doctype: "Bin",
         filters: pairs.map(p => [["item_code", "=", p.item_code], ["warehouse", "=", p.warehouse]]),
         fields: ["item_code", "warehouse", "actual_qty"],
         limit: pairs.length * 2 + 10,
       },
     });
     // Build a lookup map: `${item_code}::${warehouse}` → actual_qty
     const map = {};
     (result.message || []).forEach(b => {
       map[`${b.item_code}::${b.warehouse}`] = b.actual_qty || 0;
     });
     return map;
   }
   ```
   Note: `frappe.client.get_list` with nested filter arrays requires Frappe 14+. For broader compatibility, build a single `frappe.call` to a lightweight custom method in `adhd_stock_entry.py` that accepts `item_codes` and `warehouses` arrays and returns a flat list.

5. **Compute preview rows.** For each `frm.doc.items` row with a valid `item_code`:
   - **Source warehouse row** (if `s_warehouse`): `current_qty = binMap[key]`, `change = -qty`, `after = current_qty + change`.
   - **Target warehouse row** (if `t_warehouse`): `current_qty = binMap[key]`, `change = +qty`, `after = current_qty + change`.
   - Flag rows where `after < 0` — these are potential stock-out issues.

6. **Render the preview section.**
   ```js
   function renderPreview(frm) {
     $("#adhd-stock-preview").remove();

     const pairs = getItemWarehousePairs(frm);
     if (!pairs.length) return;

     fetchBinQtys(pairs).then(binMap => {
       const rows = buildPreviewRows(frm.doc.items, binMap);
       if (!rows.length) return;

       const $table = buildPreviewTable(rows);
       const $section = $(`
         <div id="adhd-stock-preview" class="adhd-stock-preview">
           <details open>
             <summary class="adhd-preview-title">📦 Stock Impact Preview</summary>
           </details>
         </div>
       `);
       $section.find("details").append($table);

       // Insert below the items child table
       $(frm.fields_dict.items.wrapper).after($section);
     });
   }
   ```

7. **`buildPreviewTable(rows)`.** Returns a `<table class="table table-condensed adhd-preview-table">` with columns:
   - **Item** (item_code)
   - **Warehouse**
   - **Current Qty** (from binMap, right-aligned)
   - **Change** (±qty, green for positive, red for negative)
   - **After Submit** (after value; red background if `after < 0`)

8. **Stock-out warning.** If any row has `after < 0`, prepend a `<div class="alert alert-danger adhd-stockout-warning">` above the table: `"⚠ Warning: {N} warehouse(s) would go below zero after this entry."`.

9. **CSS** (inline or `adhd_mode.scss`):
   - `.adhd-stock-preview` — `margin: 8px 0; border: 1px solid var(--border-color); border-radius: 4px;`
   - `.adhd-preview-title` — `cursor: pointer; font-weight: 600; padding: 8px 12px; list-style: none;`
   - `.adhd-preview-table` — `font-size: 0.8rem; margin: 0;`
   - `.adhd-change-positive` — `color: var(--green-500); font-weight: 600;`
   - `.adhd-change-negative` — `color: var(--red-500); font-weight: 600;`
   - `.adhd-row-stockout` — `background: rgba(var(--red-rgb), 0.1);`

## How to Test

1. Open ERPNext with ADHD mode enabled.
2. Navigate to **Stock → Stock Entry → New**. Set `Stock Entry Type` = "Material Issue".
3. Add an item with a known warehouse (`s_warehouse`) and set `qty` = 5.
4. Confirm the "Stock Impact Preview" collapsible section appears below the items table within ~1 second.
5. Confirm the table shows: Item name | Warehouse | Current Qty (matching Bin report for that item/warehouse) | Change (−5 in red) | After Submit (current − 5).
6. Change `qty` to a value larger than the current stock (e.g., if stock = 10, enter qty = 15). Confirm the "After Submit" cell turns red and a `⚠ Warning` banner appears above the table.
7. Add a second item row. Confirm the table updates to show both rows.
8. Remove an item row. Confirm the preview table row disappears.
9. Submit the Stock Entry. Confirm the preview section is not rendered on submitted documents (`docstatus === 1`).
10. Disable ADHD mode. Open a new Stock Entry, add items. Confirm no preview section appears.

## Acceptance Criteria
- [ ] Preview section appears below the items child table on all Draft Stock Entries when ADHD mode is active.
- [ ] Preview is read-only and collapsible via a `<details>` element (open by default).
- [ ] Current Qty values match the Bin doctype for the corresponding item and warehouse.
- [ ] Change column correctly shows positive (green) for target warehouses and negative (red) for source warehouses.
- [ ] "After Submit" column correctly computes `current_qty + change`.
- [ ] Rows where "After Submit" would be negative are highlighted in red.
- [ ] Stock-out warning banner appears when any row would result in negative stock.
- [ ] Preview updates within 600 ms of any change to items (item_code, qty, warehouse).
- [ ] Preview is absent on submitted (`docstatus = 1`) documents.
- [ ] No preview section appears when ADHD mode is disabled.
- [ ] No JavaScript console errors on the Stock Entry form.

## Dependencies
- **Blocks:** ADHD-038 (Putaway Rule explanation — uses the same `adhd_stock_entry.js` file).
- **Blocked by:** ADHD mode toggle (Phase 1, already shipped).

## Complexity
M — Requires async Bin data fetch, multi-row computation across both source and target warehouses, collapsible table render, and debounced child-table event handling; no new server endpoints strictly required but a helper Python method improves reliability.

## Phase
Phase 7 — Module-by-Module Expansion
