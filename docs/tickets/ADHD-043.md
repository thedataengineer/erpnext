# ADHD-043: Production Plan Demand Summary Banner

## Summary
When ADHD mode is active on a Production Plan form, inject a compact summary bar above the items table showing total items, source Sales Orders, combined quantity, and earliest planned start date — computed client-side from already-loaded data so the user gets an instant demand overview without opening a report.

## Background / Context
A Production Plan in ERPNext aggregates demand from multiple Sales Orders or Material Requests into a single manufacturing plan. Before the user can understand the scope of what they're planning, they must mentally scan a child table that may span dozens of rows, mentally summing quantities and noting the earliest date. For ADHD users, this tabular scanning is exhausting — the table format provides no summary, so the user repeatedly re-reads rows to verify they haven't missed anything. The friction peaks when returning to an in-progress Production Plan after an interruption: "Wait, how many items am I planning again?"

## Cognitive Mechanism
Working memory | time blindness

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- The Production Plan doctype must have `po_items` and `mr_items` child tables with `item_code`, `qty`, `sales_order`, and `planned_start_date` fields (standard ERPNext fields).

## Scope
**Create:**
- `erpnext/manufacturing/doctype/production_plan/adhd_production_plan.js`

**Modify:**
- `erpnext/hooks.py` — add `adhd_production_plan.js` to `doctype_js` under `"Production Plan"`
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-plan-summary` styles

## What Needs to Be Done

1. **Hook into form events** in `adhd_production_plan.js`:
   ```js
   frappe.ui.form.on("Production Plan", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       render_plan_summary(frm);
     },
     after_save(frm) {
       if (!frappe.boot.adhd_mode) return;
       render_plan_summary(frm);
     },
   });
   ```
   Also re-render on child table changes by hooking `po_items_add`, `po_items_remove`, `mr_items_add`, `mr_items_remove`.

2. **Implement `render_plan_summary(frm)`**:
   ```js
   function render_plan_summary(frm) {
     // Remove stale banner
     $(frm.wrapper).find(".adhd-plan-summary").remove();

     const po_items = frm.doc.po_items || [];
     const mr_items = frm.doc.mr_items || [];
     const all_items = [...po_items, ...mr_items];

     if (all_items.length === 0) return; // Nothing to summarise yet

     // Count unique item codes
     const unique_items = new Set(all_items.map((r) => r.item_code)).size;

     // Count unique source Sales Orders (only from po_items)
     const unique_sales_orders = new Set(
       po_items.map((r) => r.sales_order).filter(Boolean)
     ).size;

     // Sum total quantity
     const total_qty = all_items.reduce((sum, r) => sum + (r.qty || 0), 0);

     // Find the earliest planned_start_date across both tables
     const dates = all_items
       .map((r) => r.planned_start_date)
       .filter(Boolean)
       .sort();
     const earliest_date = dates.length
       ? frappe.datetime.str_to_user(dates[0])
       : "—";

     // Build source description
     const source_text =
       unique_sales_orders > 0
         ? `${unique_sales_orders} Sales Order${unique_sales_orders > 1 ? "s" : ""}`
         : mr_items.length > 0
         ? "Material Requests"
         : "manual entry";

     const $banner = $(`
       <div class="adhd-plan-summary">
         <span class="adhd-plan-summary__chip">
           📦 <strong>${unique_items}</strong> item type${unique_items !== 1 ? "s" : ""}
         </span>
         <span class="adhd-plan-summary__sep">·</span>
         <span class="adhd-plan-summary__chip">
           🛒 Sourced from <strong>${source_text}</strong>
         </span>
         <span class="adhd-plan-summary__sep">·</span>
         <span class="adhd-plan-summary__chip">
           🔢 Total qty: <strong>${frappe.format(total_qty, { fieldtype: "Float" })}</strong>
         </span>
         <span class="adhd-plan-summary__sep">·</span>
         <span class="adhd-plan-summary__chip">
           📅 Target start: <strong>${earliest_date}</strong>
         </span>
       </div>
     `);

     // Inject above the po_items child table
     const $po_section = $(frm.wrapper).find('[data-fieldname="po_items"]');
     if ($po_section.length) {
       $po_section.before($banner);
     } else {
       $(frm.wrapper).find(".form-layout").prepend($banner);
     }
   }
   ```

3. **Add CSS** to `adhd_mode.scss`:
   ```scss
   .adhd-plan-summary {
     display: flex;
     flex-wrap: wrap;
     align-items: center;
     gap: 6px 4px;
     padding: 8px 14px;
     background: var(--blue-50, #eff6ff);
     border: 1px solid var(--blue-200, #bfdbfe);
     border-radius: var(--border-radius);
     font-size: 0.83rem;
     margin-bottom: 10px;

     &__chip {
       white-space: nowrap;
       color: var(--text-color);
     }
     &__sep {
       color: var(--text-muted);
       font-weight: 700;
     }
   }
   ```

4. **Register in `hooks.py`**:
   ```python
   doctype_js = {
       "Production Plan": "manufacturing/doctype/production_plan/adhd_production_plan.js",
       # ... existing entries
   }
   ```

5. **No API call is required** — all data is already present in `frm.doc.po_items` and `frm.doc.mr_items` when the form loads. The summary is recomputed entirely on the client side.

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Navigate to **Production Plan** list. Open an existing Production Plan that has items in `po_items`.
3. Confirm the summary banner appears above the `po_items` child table showing correct counts for: item types, Sales Orders, total quantity, and earliest planned start date.
4. Verify the displayed values match what you see in the `po_items` child table (manually sum a few rows to cross-check total qty).
5. Add a new row to `po_items` with a qty of 10. **Save** the form. Confirm the total qty in the banner increases by 10.
6. Remove a row from `po_items`. **Save**. Confirm the banner updates accordingly.
7. Open a Production Plan whose `po_items` is empty but `mr_items` has rows. Confirm the banner shows "Material Requests" as the source and uses `mr_items` for its totals.
8. Open a completely empty Production Plan (no items in either table). Confirm **no banner** appears.
9. **Disable ADHD mode**. Reload a Production Plan with items. Confirm the banner is absent.
10. Check browser console for JavaScript errors on all steps above.

## Acceptance Criteria
- [ ] Summary banner appears above `po_items` when ADHD mode is active and at least one item row exists.
- [ ] Item count reflects unique `item_code` values across both `po_items` and `mr_items`.
- [ ] Sales Order count reflects unique, non-null `sales_order` values in `po_items`.
- [ ] Total quantity is the arithmetic sum of all `qty` values across both child tables.
- [ ] Earliest planned start date is the minimum non-null `planned_start_date` across both child tables.
- [ ] Banner updates after save when item rows are added or removed.
- [ ] Banner is absent when both child tables are empty.
- [ ] Banner is absent when ADHD mode is disabled.
- [ ] No API calls are made — all data sourced from `frm.doc` in-memory.
- [ ] No JavaScript errors under normal operation.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped)
- **Blocks:** None

## Complexity
S — Entirely client-side; reads `frm.doc` in-memory; no new Python, no API calls, no schema changes.

## Phase
Phase 7 — Module-by-Module Expansion
