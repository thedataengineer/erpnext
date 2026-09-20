# ADHD-027: Purchase Receipt "Expected vs Received" Diff

## Summary
On submitted Purchase Receipt forms in ADHD mode, injects a "What's still open?" summary table below the items grid showing ordered qty, received qty for this receipt, and still-pending qty per item — so the user never needs to open the source Purchase Order to know what remains.

## Background / Context
After saving a Purchase Receipt, the natural next question is "did everything arrive, or do I need to follow up on the rest?" Answering it requires navigating to the originating Purchase Order, scrolling to the items table, and mentally subtracting delivered quantities from ordered quantities — a three-step, multi-tab process. For ADHD users this navigation is frequently abandoned, meaning partial deliveries go untracked until a downstream problem (short production run, invoice mismatch) surfaces the gap. Surfacing the diff directly on the receipt form eliminates all navigation.

## Cognitive Mechanism
Working memory | attention switching | time blindness

## Prerequisites
- ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` readable on the client.
- The Purchase Receipt must have a `purchase_order` reference field populated (standard ERPNext field for receipts created from POs).

## Scope
**Create:**
- `erpnext/buying/doctype/purchase_receipt/adhd_purchase_receipt.js`

## What Needs to Be Done

1. **Create `adhd_purchase_receipt.js` and register for submitted forms:**
   ```js
   frappe.ui.form.on("Purchase Receipt", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       // Only render on submitted (docstatus === 1) receipts
       if (frm.doc.docstatus !== 1) return;
       renderOpenQtyDiff(frm);
     },
   });
   ```

2. **Implement `renderOpenQtyDiff(frm)`.** Determine the source PO name and fetch its item quantities:
   ```js
   async function renderOpenQtyDiff(frm) {
     // Remove existing panel to prevent duplicates
     $(frm.wrapper).find(".adhd-receipt-diff").remove();

     // Find the PO reference — may be on the receipt header or on individual items
     const poName = frm.doc.purchase_order
       || (frm.doc.items && frm.doc.items[0] && frm.doc.items[0].purchase_order);

     if (!poName) return; // Receipt not linked to a PO — nothing to diff

     let poItems;
     try {
       const result = await frappe.call({
         method: "frappe.client.get",
         args: { doctype: "Purchase Order", name: poName },
       });
       poItems = (result.message && result.message.items) || [];
     } catch (err) {
       console.warn("[ADHD] Could not load PO for diff:", err);
       return;
     }

     if (!poItems.length) return;

     buildAndInjectDiffPanel(frm, poItems);
   }
   ```

3. **Implement `buildAndInjectDiffPanel(frm, poItems)`.** Cross-references PO items against the current receipt's items:
   ```js
   function buildAndInjectDiffPanel(frm, poItems) {
     // Map PO items by item_code for O(1) lookup
     const poMap = {};
     poItems.forEach(row => {
       if (!poMap[row.item_code]) {
         poMap[row.item_code] = { ordered: 0, received: 0, item_name: row.item_name };
       }
       poMap[row.item_code].ordered   += row.qty || 0;
       poMap[row.item_code].received  += row.received_qty || 0;
     });

     // Build diff rows — only show items that have a pending qty > 0
     const diffRows = [];
     Object.entries(poMap).forEach(([itemCode, data]) => {
       const pending = data.ordered - data.received;
       diffRows.push({
         item_code:  itemCode,
         item_name:  data.item_name,
         ordered:    data.ordered,
         received:   data.received,
         pending:    pending,
         complete:   pending <= 0,
       });
     });

     const allComplete = diffRows.every(r => r.complete);

     const rows = diffRows.map(r => `
       <tr class="${r.complete ? "adhd-diff-complete" : "adhd-diff-pending"}">
         <td>${frappe.utils.escape_html(r.item_code)}</td>
         <td>${frappe.utils.escape_html(r.item_name || "")}</td>
         <td class="text-right">${r.ordered}</td>
         <td class="text-right">${r.received}</td>
         <td class="text-right ${r.pending > 0 ? "adhd-diff-open-qty" : ""}">
           ${r.pending > 0 ? r.pending : "✓"}
         </td>
       </tr>
     `).join("");

     const poLink = frappe.utils.get_form_link("Purchase Order", frm.doc.purchase_order
       || (frm.doc.items[0] && frm.doc.items[0].purchase_order));

     const html = `
       <div class="adhd-receipt-diff">
         <div class="adhd-receipt-diff-header">
           <span class="adhd-diff-title">What's Still Open?</span>
           <a href="${poLink}" class="adhd-diff-po-link" target="_blank">
             View PO ↗
           </a>
         </div>
         ${allComplete
           ? '<p class="adhd-diff-all-done">✅ All items fully received.</p>'
           : `<table class="adhd-diff-table table table-condensed">
               <thead>
                 <tr>
                   <th>Item Code</th><th>Item Name</th>
                   <th class="text-right">Ordered</th>
                   <th class="text-right">Received</th>
                   <th class="text-right">Still Pending</th>
                 </tr>
               </thead>
               <tbody>${rows}</tbody>
             </table>`
         }
       </div>
     `;

     // Insert below the items grid
     const $itemsGrid = $(frm.fields_dict.items.grid.wrapper);
     $itemsGrid.after($(html));
   }
   ```

4. **CSS in `adhd_mode.scss`:**
   - `.adhd-receipt-diff` — `margin: 12px 0; padding: 12px 16px; background: var(--subtle-fg); border: 1px solid var(--border-color); border-radius: 4px;`
   - `.adhd-receipt-diff-header` — `display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;`
   - `.adhd-diff-title` — `font-weight: 700; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em;`
   - `.adhd-diff-po-link` — `font-size: 0.8rem; color: var(--text-muted); text-decoration: underline;`
   - `.adhd-diff-table` — `width: 100%; font-size: 0.83rem;`
   - `.adhd-diff-pending td` — `color: var(--text-color);`
   - `.adhd-diff-complete td` — `color: var(--text-muted);`
   - `.adhd-diff-open-qty` — `color: var(--orange-500); font-weight: 700;`
   - `.adhd-diff-all-done` — `color: var(--green-600); font-weight: 600; margin: 0;`

5. **Include in `hooks.py`** under `app_include_js`.

## How to Test

1. Enable ADHD mode. Create a Purchase Order with three items: Item A qty 10, Item B qty 5, Item C qty 8. Submit the PO.
2. From the PO, click **Make → Purchase Receipt**. Receive partial quantities: Item A qty 6, Item B qty 5, Item C qty 3. Submit the Purchase Receipt.
3. Confirm a "What's Still Open?" section appears below the items grid on the submitted Purchase Receipt.
4. Confirm the table shows:
   - Item A: Ordered 10, Received 6, Still Pending **4** (orange, bold)
   - Item B: Ordered 5, Received 5, Still Pending **✓** (muted)
   - Item C: Ordered 8, Received 3, Still Pending **5** (orange, bold)
5. Confirm "View PO ↗" link opens the source Purchase Order in a new tab.
6. Create a second Purchase Receipt for the same PO receiving the remaining Item A qty 4 and Item C qty 5. Submit it. Open it. Confirm the diff shows all items as ✓ and the "✅ All items fully received." message appears instead of the table.
7. Open a Purchase Receipt that was not created from a Purchase Order (i.e., no `purchase_order` field set). Confirm no diff panel appears and no JS error is thrown.
8. Open a Draft Purchase Receipt (docstatus = 0). Confirm no diff panel appears.
9. Disable ADHD mode. Open a submitted Purchase Receipt. Confirm no diff panel appears.
10. Reload a submitted receipt with the diff panel. Confirm no duplicate panel appears.

## Acceptance Criteria
- [ ] "What's Still Open?" diff panel appears below the items grid on submitted Purchase Receipts in ADHD mode.
- [ ] Panel shows Ordered, Received, and Still Pending qty for each item from the source Purchase Order.
- [ ] Pending qty > 0 is highlighted in orange bold; fully received items show ✓ in muted text.
- [ ] When all items are fully received, the table is replaced with a "✅ All items fully received." message.
- [ ] "View PO ↗" link correctly navigates to the source Purchase Order.
- [ ] Panel does not appear on receipts with no PO reference, on Draft receipts, or when ADHD mode is off.
- [ ] No duplicate panels appear after multiple refreshes.
- [ ] No JavaScript console errors in any of the above states.

## Dependencies
- **Blocked by:** ADHD mode toggle (shipped)
- **Blocks:** ADHD-028 (Purchase Invoice Three-Way Match — complementary, same module)

## Complexity
S — Single form script, one `frappe.client.get` call, HTML table injection. No server endpoint, no DocType changes.

## Phase
Phase 7 — Module-by-Module Expansion
