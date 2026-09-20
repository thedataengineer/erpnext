# ADHD-038: Putaway Rule "Why Here?" Inline Explanation

## Summary
When ADHD mode is active on a Stock Entry where rows have been auto-assigned by a putaway rule, add a "?" icon next to each assigned `t_warehouse` field that opens a plain-English tooltip-modal explaining why that location was chosen — eliminating the confusion of silently re-routed stock.

## Background / Context
ERPNext's putaway rules can automatically reassign the target warehouse on a Stock Entry based on capacity, item category, or custom strategies. For ADHD users, this silent re-routing is deeply disorienting: the warehouse they expected to see has been replaced with one they don't recognise, with no explanation. The natural response is to override it (incorrectly) or spend minutes investigating the Putaway Rule list. The "Why Here?" icon replaces that investigation with a one-click answer directly on the form.

## Cognitive Mechanism
Attention switching | working memory | RSD (rejection-sensitive dysphoria from "the system changed something on me")

## Prerequisites
- ADHD-035 (`erpnext/stock/doctype/stock_entry/adhd_stock_entry.js` — must exist; this ticket adds the putaway explanation feature to that same file).

## Scope
**Modify:**
- `erpnext/stock/doctype/stock_entry/adhd_stock_entry.js` — add putaway explanation logic to the existing module.

## What Needs to Be Done

1. **Detect putaway-assigned rows.** A Stock Entry items row has been putaway-assigned when `row.putaway_rule` is non-empty. Hook into both `refresh` and `after_save` to scan all rows:
   ```js
   frappe.ui.form.on("Stock Entry", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       // existing preview logic from ADHD-035 ...
       decoratePutawayRows(frm);
     },
     after_save(frm) {
       if (!frappe.boot.adhd_mode) return;
       decoratePutawayRows(frm);
     },
   });
   frappe.ui.form.on("Stock Entry Detail", {
     putaway_rule(frm, cdt, cdn) {
       if (!frappe.boot.adhd_mode) return;
       const row = locals[cdt][cdn];
       if (row.putaway_rule) decorateSingleRow(frm, row);
     },
   });
   ```

2. **`decoratePutawayRows(frm)`.** Iterates `frm.doc.items` and calls `decorateSingleRow` for each row with a non-empty `putaway_rule`:
   ```js
   function decoratePutawayRows(frm) {
     (frm.doc.items || []).forEach(row => {
       if (row.putaway_rule) decorateSingleRow(frm, row);
     });
   }
   ```

3. **`decorateSingleRow(frm, row)`.** Finds the rendered grid row's `t_warehouse` cell and injects the "?" icon:
   ```js
   function decorateSingleRow(frm, row) {
     const $gridRow = frm.fields_dict.items.grid.grid_rows_by_docname[row.name]
                       ?.row_check?.$input?.closest("tr") ||
                      $(`[data-name="${row.name}"]`);
     if (!$gridRow.length) return;

     // Find the t_warehouse cell by data-fieldname
     const $warehouseCell = $gridRow.find('[data-fieldname="t_warehouse"]');
     if (!$warehouseCell.length) return;

     // Avoid duplicate icons
     if ($warehouseCell.find(".adhd-putaway-why").length) return;

     const $icon = $(`
       <span class="adhd-putaway-why" title="Why was this warehouse assigned?"
             style="cursor:pointer; margin-left:6px; color:var(--text-muted);
                    font-size:0.85rem; vertical-align:middle;">
         ⓘ
       </span>
     `);
     $warehouseCell.append($icon);

     $icon.on("click", function (e) {
       e.stopPropagation();
       openPutawayExplanation(row);
     });
   }
   ```

4. **`openPutawayExplanation(row)`.** Fetches the Putaway Rule and renders a modal:
   ```js
   async function openPutawayExplanation(row) {
     const ruleData = await frappe.db.get_value("Putaway Rule", row.putaway_rule, [
       "name", "warehouse", "item", "item_group", "capacity",
       "stock_capacity", "strategy", "disable", "company",
     ]);
     const rule = ruleData?.message || {};

     // Build plain-English explanation
     const strategyLabel = buildStrategyLabel(rule);

     const dialog = new frappe.ui.Dialog({
       title: "Why was this warehouse assigned?",
       size: "small",
     });
     $(dialog.$wrapper.find(".modal-body")).html(`
       <div class="adhd-putaway-explanation">
         <p>
           Putaway rule <strong>${frappe.utils.escape_html(row.putaway_rule)}</strong>
           assigned <strong>${frappe.utils.escape_html(row.t_warehouse)}</strong>
           as the target warehouse for this item.
         </p>
         <p>${strategyLabel}</p>
         ${rule.capacity ? `<p>📦 Configured capacity: <strong>${rule.capacity}</strong> units.</p>` : ""}
         <p style="margin-top:12px;">
           <a href="/app/putaway-rule/${frappe.utils.escape_html(row.putaway_rule)}"
              target="_blank" rel="noopener noreferrer">
             View Putaway Rule ›
           </a>
         </p>
       </div>
     `);
     dialog.show();
   }
   ```

5. **`buildStrategyLabel(rule)`.** Returns a plain-English sentence:
   ```js
   function buildStrategyLabel(rule) {
     if (rule.strategy === "Capacity Based") {
       return `This rule uses <em>capacity-based</em> allocation — the warehouse was selected
               because it has available space within its configured capacity limit.`;
     }
     if (rule.item) {
       return `This rule applies specifically to item
               <strong>${frappe.utils.escape_html(rule.item)}</strong>.`;
     }
     if (rule.item_group) {
       return `This rule applies to all items in the item group
               <strong>${frappe.utils.escape_html(rule.item_group)}</strong>.`;
     }
     return `This rule assigns stock to this warehouse based on your configured putaway strategy.`;
   }
   ```

6. **CSS:**
   ```css
   .adhd-putaway-why:hover { color: var(--primary); }
   .adhd-putaway-explanation p { margin-bottom: 8px; font-size: 0.9rem; line-height: 1.5; }
   ```

7. **Re-decorate after grid refresh.** The items grid re-renders on row add/remove. Hook the grid's `refresh` event:
   ```js
   frm.fields_dict.items.grid.wrapper.on("change", () => {
     setTimeout(() => decoratePutawayRows(frm), 300);
   });
   ```

## How to Test

1. Open ERPNext with ADHD mode enabled.
2. Ensure at least one active Putaway Rule exists (Stock → Putaway Rule). Create one if needed: set it to apply to a specific item and warehouse.
3. Navigate to **Stock → Stock Entry → New**. Set `Stock Entry Type` = "Material Receipt".
4. Add an item covered by the putaway rule. Click "Apply Putaway Rule" or save the document — ERPNext will auto-assign `t_warehouse` from the rule and populate `putaway_rule` on the row.
5. Confirm a small ⓘ icon appears to the right of the `t_warehouse` value in the items grid row.
6. Hover over the ⓘ icon. Confirm the title tooltip reads "Why was this warehouse assigned?".
7. Click the ⓘ icon. Confirm a modal opens with:
   - The putaway rule name in bold.
   - The assigned warehouse name in bold.
   - A plain-English explanation of the strategy (capacity-based, item-specific, or item-group).
   - A "View Putaway Rule ›" link that opens the rule in a new tab.
8. Close the modal. Add another item row with no putaway rule. Confirm no ⓘ icon appears on that row.
9. Disable ADHD mode. Reload the Stock Entry. Confirm no ⓘ icons appear anywhere.

## Acceptance Criteria
- [ ] ⓘ icon appears next to `t_warehouse` on every items row where `putaway_rule` is non-empty.
- [ ] No icon appears on rows where `putaway_rule` is blank.
- [ ] Clicking the icon opens a modal with the putaway rule name, assigned warehouse, and strategy explanation.
- [ ] Strategy explanation text correctly reflects the rule's `strategy` field (capacity-based, item-specific, item-group, or generic fallback).
- [ ] "View Putaway Rule ›" link opens the correct rule document in a new browser tab.
- [ ] No duplicate icons after form refresh or row updates.
- [ ] Icons do not appear when ADHD mode is disabled.
- [ ] No JavaScript console errors on the Stock Entry form.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD-035 (`adhd_stock_entry.js` must be created first, as this ticket adds to that file).

## Complexity
S — Small addition to an existing file: one async `db.get_value` call, a modal render, and a delegated DOM event; all logic fits within 80 lines.

## Phase
Phase 7 — Module-by-Module Expansion
