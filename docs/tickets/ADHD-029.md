# ADHD-029: Sales Order Delivery Status Summary

## Summary
On submitted Sales Order forms in ADHD mode, renders a compact per-item "Delivery Status" section showing ordered, delivered, and remaining quantity for each line — plus a "Create Delivery Note" shortcut button if any items are still outstanding.

## Background / Context
After a Sales Order is submitted, the most common question is "what have I shipped and what's still to go?" Answering this in standard ERPNext requires opening the linked Delivery Notes, cross-referencing each one against the SO items, and mentally computing the outstanding quantities — a multi-tab operation. For ADHD users this navigation is a context-switch trap that gets skipped, causing them to either over-deliver, under-deliver, or create duplicate Delivery Notes. A per-item summary directly on the SO form makes the outstanding position immediately visible without leaving the page.

## Cognitive Mechanism
Working memory | attention switching | time blindness

## Prerequisites
- ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` readable on the client.
- ADHD-001 (chain navigator) is complementary but independent — both can coexist on the Sales Order form.

## Scope
**Create:**
- `erpnext/selling/doctype/sales_order/adhd_sales_order.js`

## What Needs to Be Done

1. **Create `adhd_sales_order.js` and register for submitted forms:**
   ```js
   frappe.ui.form.on("Sales Order", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (frm.doc.docstatus !== 1) return; // Only submitted SOs
       renderDeliveryStatusSection(frm);
     },
   });
   ```

2. **Implement `renderDeliveryStatusSection(frm)`.** Reads delivery status directly from the SO items child table — each item row already carries `qty` and `delivered_qty` populated by ERPNext's delivery tracking:
   ```js
   function renderDeliveryStatusSection(frm) {
     // Remove existing panel to avoid duplicates
     $(frm.wrapper).find(".adhd-delivery-status").remove();

     const items = frm.doc.items || [];
     if (!items.length) return;

     const rows = items.map(item => {
       const ordered   = item.qty || 0;
       const delivered = item.delivered_qty || 0;
       const remaining = ordered - delivered;
       return { item_code: item.item_code, item_name: item.item_name,
                ordered, delivered, remaining };
     });

     const anyPending  = rows.some(r => r.remaining > 0);
     const allDelivered = rows.every(r => r.remaining <= 0);

     buildDeliveryPanel(frm, rows, anyPending, allDelivered);
   }
   ```

3. **Implement `buildDeliveryPanel(frm, rows, anyPending, allDelivered)`.** Renders the HTML table and optional shortcut button:
   ```js
   function buildDeliveryPanel(frm, rows, anyPending, allDelivered) {
     const tableRows = rows.map(r => `
       <tr class="${r.remaining <= 0 ? "adhd-delivery-done" : "adhd-delivery-pending"}">
         <td>${frappe.utils.escape_html(r.item_code)}</td>
         <td>${frappe.utils.escape_html(r.item_name || "")}</td>
         <td class="text-right">${r.ordered}</td>
         <td class="text-right">${r.delivered}</td>
         <td class="text-right ${r.remaining > 0 ? "adhd-delivery-remaining-qty" : ""}">
           ${r.remaining > 0 ? r.remaining : "✓"}
         </td>
       </tr>
     `).join("");

     // Create Delivery Note shortcut button (only shown when items remain)
     const createDnButton = anyPending
       ? `<button class="btn btn-sm btn-primary adhd-create-dn-btn">
            + Create Delivery Note
          </button>`
       : "";

     const statusSummary = allDelivered
       ? `<p class="adhd-delivery-all-done">✅ All items fully delivered.</p>`
       : `<table class="adhd-delivery-table table table-condensed">
            <thead>
              <tr>
                <th>Item Code</th><th>Item Name</th>
                <th class="text-right">Ordered</th>
                <th class="text-right">Delivered</th>
                <th class="text-right">Remaining</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>`;

     const html = `
       <div class="adhd-delivery-status">
         <div class="adhd-delivery-header">
           <span class="adhd-delivery-title">Delivery Status</span>
           ${createDnButton}
         </div>
         ${statusSummary}
       </div>
     `;

     const $panel = $(html);

     // Wire the Create Delivery Note button
     $panel.find(".adhd-create-dn-btn").on("click", () => {
       frappe.model.open_mapped_doc({
         method: "erpnext.selling.doctype.sales_order.sales_order.make_delivery_note",
         frm:    frm,
         freeze: true,
       });
     });

     // Insert below the items grid
     const $itemsGrid = $(frm.fields_dict.items.grid.wrapper);
     $itemsGrid.after($panel);
   }
   ```

4. **CSS in `adhd_mode.scss`:**
   - `.adhd-delivery-status` — `margin: 12px 0; padding: 12px 16px; background: var(--subtle-fg); border: 1px solid var(--border-color); border-radius: 4px;`
   - `.adhd-delivery-header` — `display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;`
   - `.adhd-delivery-title` — `font-weight: 700; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em;`
   - `.adhd-delivery-table` — `width: 100%; font-size: 0.83rem;`
   - `.adhd-delivery-done td` — `color: var(--text-muted);`
   - `.adhd-delivery-pending td` — `color: var(--text-color);`
   - `.adhd-delivery-remaining-qty` — `color: var(--orange-500); font-weight: 700;`
   - `.adhd-delivery-all-done` — `color: var(--green-600); font-weight: 600; margin: 0;`

5. **Ensure no conflict with ADHD-001 chain nav.** The delivery status panel is injected after the items grid; the chain nav is injected in the page header. They occupy different DOM zones. No additional coordination is needed.

6. **Include in `hooks.py`** under `app_include_js`.

## How to Test

1. Enable ADHD mode. Create a Sales Order with three items: Widget A qty 10, Widget B qty 5, Widget C qty 8. Submit the SO.
2. Confirm a "Delivery Status" section appears below the items grid showing all three items with Ordered, Delivered (0), and Remaining columns. Confirm all Remaining values are orange-bold.
3. Click **+ Create Delivery Note**. Confirm the Delivery Note creation flow opens with items pre-populated from the SO.
4. On the Delivery Note, deliver Widget A qty 6 and Widget B qty 5. Submit the Delivery Note.
5. Return to the Sales Order. Refresh. Confirm the Delivery Status table updates:
   - Widget A: Ordered 10, Delivered 6, Remaining **4** (orange)
   - Widget B: Ordered 5, Delivered 5, Remaining **✓** (muted)
   - Widget C: Ordered 8, Delivered 0, Remaining **8** (orange)
6. Confirm the "+ Create Delivery Note" button is still present (items still pending).
7. Create a second Delivery Note for Widget A qty 4 and Widget C qty 8. Submit it. Return to the SO. Refresh. Confirm the table shows all items as ✓ and the message "✅ All items fully delivered." appears instead of the table.
8. Confirm the "+ Create Delivery Note" button is absent when all items are delivered.
9. Open a Draft Sales Order (docstatus = 0). Confirm no Delivery Status section appears.
10. Disable ADHD mode. Open the submitted SO. Confirm no Delivery Status section appears.
11. Reload the submitted SO multiple times. Confirm no duplicate sections appear.
12. Confirm the ADHD-001 chain navigator bar and the Delivery Status section do not overlap.

## Acceptance Criteria
- [ ] "Delivery Status" section appears below the items grid on submitted Sales Orders when ADHD mode is active.
- [ ] Table shows per-item Ordered, Delivered, and Remaining quantities drawn from `items.qty` and `items.delivered_qty`.
- [ ] Remaining qty > 0 is highlighted orange bold; fully delivered items show ✓ in muted text.
- [ ] When all items are fully delivered, the table is replaced with "✅ All items fully delivered."
- [ ] A "+ Create Delivery Note" button appears when any items have remaining qty > 0 and correctly invokes the standard Delivery Note mapping.
- [ ] Button is absent when all items are delivered.
- [ ] Section does not appear on Draft SOs (docstatus ≠ 1) or when ADHD mode is disabled.
- [ ] No duplicate sections after multiple form refreshes.
- [ ] No visual overlap with ADHD-001 chain navigator.
- [ ] No JavaScript console errors in any of the above states.

## Dependencies
- **Blocked by:** ADHD mode toggle (shipped)
- **Complementary (not blocking):** ADHD-001 (chain navigator), ADHD-021 (Quotation expiry — parallel Selling ticket)
- **Blocks:** None

## Complexity
S — Single form script, no async fetch needed (data already in `frm.doc.items`), HTML table injection below the items grid.

## Phase
Phase 7 — Module-by-Module Expansion
