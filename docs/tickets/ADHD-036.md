# ADHD-036: Reorder Level "Almost There" Ambient Indicator

## Summary
When ADHD mode is active on the Item list view, extend the existing ADHD-006 heat-map infrastructure to colour-code each item row based on stock health relative to its reorder level — surfacing low-stock and near-reorder items at a glance without opening a separate report.

## Background / Context
ERPNext's Item list view displays no stock quantity information — users must open individual item records or run a Stock Balance report to know whether anything needs reordering. For ADHD users, the mental effort required to switch between the item list and stock reports is a context-switching tax that means low-stock situations often go unnoticed until they become urgent. The heat-map infrastructure already built in ADHD-006 provides the colour-coding pattern; this ticket extends it to stock health.

## Cognitive Mechanism
Attention switching | working memory | time blindness

## Prerequisites
- ADHD-006 (heat-map infrastructure in `public/js/adhd/adhd_list_view.js` — the Item support hooks into the existing module and piggybacks on its batch-fetch and colour-application patterns).

## Scope
**Modify:**
- `erpnext/public/js/adhd/adhd_list_view.js` — add Item doctype support with stock-health colour coding.

## What Needs to Be Done

1. **Register the Item list handler.** Inside `adhd_list_view.js`, alongside existing doctype handlers, add:
   ```js
   if (frappe.boot.adhd_mode) {
     frappe.listview_settings["Item"] = frappe.listview_settings["Item"] || {};
     const _origOnload = frappe.listview_settings["Item"].onload;
     frappe.listview_settings["Item"].onload = function (listview) {
       if (_origOnload) _origOnload.call(this, listview);
       listview.page.main.on("click", ".list-row", () => {}); // keep existing
       applyItemStockHealth(listview);
       // Re-apply after list refresh (pagination, filter change)
       listview.list_renderer?.on?.("render", () => applyItemStockHealth(listview));
     };
   }
   ```

2. **Detect the user's default warehouse.** Fetch once per session:
   ```js
   let _defaultWarehouse = null;
   async function getDefaultWarehouse() {
     if (_defaultWarehouse) return _defaultWarehouse;
     _defaultWarehouse = frappe.boot.user_info?.default_warehouse
       || await frappe.db.get_value("User", frappe.session.user, "default_warehouse")
             .then(r => r.message?.default_warehouse || null);
     if (!_defaultWarehouse) {
       // Fall back to the first warehouse in the default company
       const wh = await frappe.db.get_list("Warehouse", {
         filters: [["company", "=", frappe.boot.sysdefaults.company], ["is_group", "=", 0]],
         fields: ["name"], limit: 1,
       });
       _defaultWarehouse = wh[0]?.name || null;
     }
     return _defaultWarehouse;
   }
   ```

3. **Collect visible Item names and their reorder levels.** `applyItemStockHealth(listview)`:
   ```js
   async function applyItemStockHealth(listview) {
     if (!frappe.boot.adhd_mode) return;
     const warehouse = await getDefaultWarehouse();
     if (!warehouse) return;

     // Collect item names from visible rows
     const itemNames = [];
     listview.page.main.find(".list-row[data-name]").each(function () {
       itemNames.push($(this).attr("data-name"));
     });
     if (!itemNames.length) return;

     // Fetch reorder_level for each item (needed for colour thresholds)
     const itemMeta = await frappe.db.get_list("Item", {
       filters: [["name", "in", itemNames]],
       fields: ["name", "reorder_level"],
       limit: itemNames.length,
     });
     const reorderMap = {};
     itemMeta.forEach(i => { reorderMap[i.name] = i.reorder_level || 0; });

     // Batch-fetch Bin quantities for all items against the default warehouse
     const bins = await frappe.db.get_list("Bin", {
       filters: [
         ["item_code", "in", itemNames],
         ["warehouse", "=", warehouse],
       ],
       fields: ["item_code", "actual_qty"],
       limit: itemNames.length,
     });
     const qtyMap = {};
     bins.forEach(b => { qtyMap[b.item_code] = b.actual_qty || 0; });

     // Apply colour classes and tooltips
     listview.page.main.find(".list-row[data-name]").each(function () {
       const name = $(this).attr("data-name");
       const actualQty   = qtyMap[name]    ?? null;
       const reorderLevel = reorderMap[name] ?? 0;
       applyStockHealthClass($(this), actualQty, reorderLevel, warehouse);
     });
   }
   ```

4. **`applyStockHealthClass($row, actualQty, reorderLevel, warehouse)`.**
   - If `actualQty === null` — no Bin record exists — apply class `adhd-stock-unknown` (no colour change, no tooltip).
   - If `actualQty <= reorderLevel` — apply class `adhd-stock-critical` (red left border).
   - Else if `actualQty <= reorderLevel * 1.25` — apply class `adhd-stock-low` (amber left border).
   - Else — no special class.
   - In all coloured cases, set the `title` attribute on the row for hover tooltip: `"Stock: ${actualQty} units | Reorder at: ${reorderLevel} | Warehouse: ${warehouse}"`.
   - Prepend a small coloured dot `<span class="adhd-stock-dot">` inside the row's list-subject cell (`.list-subject`) for accessible colour indication alongside the border.

5. **CSS** (add to `adhd_list_view.js` via a one-time injected `<style>` tag, or to `adhd_mode.scss`):
   ```css
   .adhd-stock-critical { border-left: 4px solid var(--red-500) !important; }
   .adhd-stock-low      { border-left: 4px solid var(--yellow-500) !important; }
   .adhd-stock-dot {
     display: inline-block;
     width: 8px; height: 8px;
     border-radius: 50%;
     margin-right: 6px;
     vertical-align: middle;
   }
   .adhd-stock-critical .adhd-stock-dot { background: var(--red-500); }
   .adhd-stock-low      .adhd-stock-dot { background: var(--yellow-500); }
   ```

6. **Re-apply on page navigation.** Frappe's list view re-renders rows when filters change or pages advance. Hook `listview.on("after_render", ...)` if available, otherwise use a `MutationObserver` on the list container and debounce with 300 ms to re-call `applyItemStockHealth(listview)`.

7. **Performance guard.** Skip the entire operation if more than 200 rows are visible (to avoid large API calls on unfiltered lists). Show a brief notice: `"ADHD stock health: showing for first 200 items."` Limit `frappe.db.get_list` calls with `limit: 200`.

## How to Test

1. Open ERPNext with ADHD mode enabled. Ensure at least one item has `reorder_level` set and another has stock below that level in the default warehouse (verify via Stock Balance report).
2. Navigate to **Stock → Items** (Item list view).
3. Confirm that within ~1 second, item rows with `actual_qty <= reorder_level` show a red left border and a red dot in the list subject.
4. Confirm items with `actual_qty` between `reorder_level` and `reorder_level * 1.25` show an amber border and amber dot.
5. Hover over a coloured row. Confirm the tooltip reads: "Stock: X units | Reorder at: Y | Warehouse: [warehouse name]".
6. Apply a list filter to change the visible rows. Confirm colour-coding re-applies to the new set of rows.
7. Navigate to page 2 of the list (if pagination applies). Confirm new rows are also colour-coded.
8. Open an item that is currently amber. Update its stock via a quick Stock Entry to push it above `reorder_level * 1.25`. Return to the Item list. Confirm the amber indicator is gone.
9. Disable ADHD mode. Navigate to the Item list. Confirm no coloured borders or dots appear.

## Acceptance Criteria
- [ ] Items with `actual_qty <= reorder_level` display a red left border and red dot in the Item list view.
- [ ] Items with `actual_qty` between `reorder_level` and `reorder_level * 1.25` display an amber left border and amber dot.
- [ ] Hover tooltip correctly shows actual qty, reorder level, and warehouse name.
- [ ] A single batched API call fetches all visible Bin records (not one call per row).
- [ ] Colour-coding re-applies after list filter changes and pagination.
- [ ] No colour is applied when ADHD mode is disabled.
- [ ] Lists with more than 200 visible rows skip the operation and show a brief notice.
- [ ] No JavaScript console errors on the Item list view.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD-006 (heat-map infrastructure must exist in `adhd_list_view.js`).

## Complexity
M — Requires two async API calls (item meta + Bin), a warehouse-detection fallback chain, DOM colour application with debounced MutationObserver re-trigger, and a performance guard; integrates with existing ADHD-006 infra.

## Phase
Phase 7 — Module-by-Module Expansion
