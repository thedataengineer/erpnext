# ADHD-013: Purchase Workflow Status Panel

## Summary
Inject a compact horizontal step indicator into the Purchase Order form showing exactly where the order sits in its lifecycle and what action to take next.

## Background / Context
A Purchase Order moves through Created → Approved → Receipt Pending → Invoice Pending → Closed, but ERPNext's standard form communicates this only through a status badge and scattered fields. ADHD users lose track of what step comes next, forget whether a receipt has been created, and frequently re-read the form top-to-bottom to orient themselves. The missing "what do I do right now" signal is a classic initiation blocker.

## Cognitive Mechanism
initiation | attention switching | working memory

## Prerequisites
- ADHD mode toggle (shipped) — panel is injected only when ADHD mode is active

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_buying.js` — step indicator logic

**Modify:**
- `erpnext/buying/doctype/purchase_order/purchase_order.js` — call `initPurchaseOrderStatusPanel(frm)` in `refresh` hook

## What Needs to Be Done

1. **Create `erpnext/public/js/adhd/adhd_buying.js`**
   - Export `initPurchaseOrderStatusPanel(frm)`.
   - Early-return if `window.ADHDMode?.isActive()` is falsy or `frm.doctype !== 'Purchase Order'`.

2. **Define the 5 steps as a constant array**
   ```js
   const STEPS = [
     { id: 'created',         label: 'Created' },
     { id: 'approved',        label: 'Approved' },
     { id: 'receipt_pending', label: 'Receipt Pending' },
     { id: 'invoice_pending', label: 'Invoice Pending' },
     { id: 'closed',          label: 'Closed' },
   ];
   ```

3. **Determine the current step from `frm.doc` fields**
   Write `getCurrentStep(doc)` that returns one of the step ids:
   - `doc.docstatus === 0` → `'created'`
   - `doc.docstatus === 1` and `doc.workflow_state` is in `['Pending Approval', 'Waiting for Approval']` → `'approved'` (treat as approval pending; adjust strings to match actual workflow state names in the instance)
   - `doc.docstatus === 1` and `doc.per_received < 100` → `'receipt_pending'`
   - `doc.docstatus === 1` and `doc.per_received >= 100` and `doc.per_billed < 100` → `'invoice_pending'`
   - `doc.status === 'Closed'` or `doc.per_billed >= 100` → `'closed'`

4. **Inject the step indicator HTML**
   Append `<div id="adhd-po-steps">` immediately below the form's title/status area (`frm.layout.wrapper.find('.page-head')`), or use `frm.dashboard.add_section` to place it in the dashboard area.
   - Render one `<div class="adhd-step">` per step, with `adhd-step--active` on the current step and `adhd-step--done` on all prior steps.
   - Connect steps with a thin horizontal rule or CSS flex separator.
   - Active step label is bold and highlighted with `var(--blue-500)`.

5. **Show "Waiting on" when in workflow approval state**
   - If `doc.workflow_state` contains "Approval" or "Pending":
     - Fetch the current workflow approver via `frappe.call('frappe.client.get_value', { doctype: 'Workflow Action', filters: { reference_doctype: 'Purchase Order', reference_name: doc.name }, fieldname: ['user'] })`.
     - Display `<p class="adhd-waiting-on">Waiting on: [Approver Name]</p>` below the step bar.

6. **Render the "Next Action" button**
   Based on `getCurrentStep`:
   - `receipt_pending` → button "Create Purchase Receipt" that calls `frappe.model.open_mapped_doc({ method: 'erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_receipt', frm })`.
   - `invoice_pending` → button "Create Purchase Invoice" that calls `frappe.model.open_mapped_doc({ method: 'erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_invoice', frm })`.
   - Other steps → no extra button (the standard form toolbar is sufficient).
   - Render button as `<button class="btn btn-primary btn-sm adhd-next-action">`.

7. **Cleanup on re-render**
   Before injecting, remove any existing `#adhd-po-steps` element to prevent duplicates on form refresh.

8. **Hook into `purchase_order.js`**
   - Import / require `adhd_buying.js`.
   - In the `refresh(frm)` handler, call `initPurchaseOrderStatusPanel(frm)`.

9. **CSS (in `adhd_mode.scss`)**
   - `.adhd-po-steps` — `display: flex; align-items: center; gap: 0; padding: 10px 16px; background: var(--subtle-fg); border-radius: 6px; margin-bottom: 10px;`
   - `.adhd-step` — `flex: 1; text-align: center; font-size: var(--text-sm); color: var(--text-muted); position: relative;`
   - `.adhd-step--active` — `color: var(--blue-500); font-weight: 700;`
   - `.adhd-step--done` — `color: var(--green-600); text-decoration: line-through;`
   - `.adhd-waiting-on` — `font-size: var(--text-xs); color: var(--text-muted); margin-top: 4px;`

## How to Test

1. Log in with ADHD mode **enabled**.
2. Navigate to **Buying → Purchase Order → New**. Fill in supplier and at least one item. Do **not** save yet.
3. Confirm the step bar shows "Created" highlighted (active) and all other steps muted.
4. Save the PO (docstatus = 0, Draft). Confirm step bar re-renders correctly on refresh.
5. Submit the PO. Confirm step bar moves to "Receipt Pending" as the active step.
6. Confirm a "Create Purchase Receipt" button appears below the step bar.
7. Click "Create Purchase Receipt". Confirm it opens a new Purchase Receipt mapped from this PO.
8. Submit the Purchase Receipt. Reopen the Purchase Order. Confirm `per_received = 100` and step bar shows "Invoice Pending" as active.
9. Confirm "Create Purchase Invoice" button appears.
10. Click "Create Purchase Invoice". Submit the invoice. Reopen the PO. Confirm `per_billed = 100` and step bar shows "Closed".
11. Disable ADHD mode. Open any Purchase Order. Confirm the step bar is **not** present.
12. Open a Sales Order (different doctype). Confirm step bar is not injected there.

## Acceptance Criteria
- [ ] Step bar is injected in Purchase Order forms when ADHD mode is active.
- [ ] Current step is visually highlighted; completed steps are visually distinguished.
- [ ] "Create Purchase Receipt" button appears exactly when `per_received < 100` on a submitted PO.
- [ ] "Create Purchase Invoice" button appears exactly when `per_received >= 100` and `per_billed < 100`.
- [ ] "Waiting on: [Name]" message appears when the PO is in a workflow approval state.
- [ ] Step bar is absent when ADHD mode is disabled.
- [ ] No duplicate step bars on repeated form refreshes.
- [ ] No JS console errors on any Purchase Order lifecycle state.

## Dependencies
- Blocked by: ADHD mode toggle (shipped)
- Blocks: none
- Related: ADHD-016 — add per-feature toggle for this panel

## Complexity
M — requires reading multiple workflow/percentage fields and conditionally rendering action buttons.

## Phase
Phase 4 — Workflow Clarity
