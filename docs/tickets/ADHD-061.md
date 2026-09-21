# ADHD-061: Subcontracting Order Chain Status Panel

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Subcontracting progress and standard mapping actions in `erpnext/public/js/adhd/adhd_tickets_041_061.js`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Inject a horizontal chain status indicator on the Subcontracting Order form in ADHD mode, showing the current stage in the subcontracting workflow and providing a context-sensitive "Next action" button to drive the process forward.

## Background / Context
Subcontracting involves a sequential multi-step process: create the order, send raw materials, wait for production, receive finished goods, and close. ERPNext's Subcontracting Order form shows status and percentage fields but gives no visual picture of where in the chain the order sits. ADHD users frequently lose track of which step was last completed — "Did I send the materials? Did I already create the receipt?" — and either duplicate work or leave the order stranded mid-chain. The friction is that the form is data-dense but lacks a single "you are here" landmark.

## Cognitive Mechanism
Working memory | Attention switching | Initiation

## Prerequisites
- ADHD mode toggle (shipped)
- ADHD-013 (Purchase Order Status Panel — follow this pattern for the horizontal chain indicator HTML/CSS and "Next action" button logic)

## Scope
Files to create or modify:
- **Create** `erpnext/subcontracting/doctype/subcontracting_order/adhd_subcontracting_order.js`

## What Needs to Be Done

1. **Create `adhd_subcontracting_order.js`**. Guard with `if (!frappe.boot.adhd_mode) return;` at the top.

2. **Register `frappe.ui.form.on('Subcontracting Order', { refresh(frm) { ... } })`**. On refresh, call `renderSubconChain(frm)`.

3. **Determine current chain state** from `frm.doc` fields:
   | State | Condition |
   |-------|-----------|
   | `po_created` | `frm.doc.docstatus === 1` |
   | `materials_sent` | `frm.doc.per_sent_qty > 0` |
   | `wip` | `frm.doc.per_sent_qty >= 100` (all materials sent; production in progress) |
   | `receipt_pending` | `frm.doc.per_sent_qty >= 100` AND no linked Subcontracting Receipt (check `frm.doc.per_received_qty === 0`) |
   | `closed` | `frm.doc.status === 'Closed'` OR `frm.doc.per_received_qty >= 100` |

   States are exclusive and evaluated top-to-bottom (closed takes priority). The active state is the highest one that matches.

4. **`renderSubconChain(frm)`**:
   a. Remove any existing `#adhd-subcon-chain` element.
   b. Define the five chain steps as an ordered array:
      ```js
      const steps = [
        { key: 'po_created',      label: 'PO Created' },
        { key: 'materials_sent',  label: 'Materials Sent' },
        { key: 'wip',             label: 'Work in Progress' },
        { key: 'receipt_pending', label: 'Receipt Pending' },
        { key: 'closed',          label: 'Closed' },
      ];
      ```
   c. Determine `activeIndex` from the state logic in step 3. All steps at index ≤ `activeIndex` are "complete"; the step at `activeIndex` is "active"; steps after are "upcoming".
   d. Build HTML following the ADHD-013 pattern:
      ```html
      <div id="adhd-subcon-chain" class="adhd-chain-panel">
        <div class="adhd-chain-steps">
          {steps.map((s, i) => `
            <div class="adhd-chain-step adhd-chain-${i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'upcoming'}">
              <div class="adhd-chain-dot"></div>
              <div class="adhd-chain-label">${s.label}</div>
            </div>
            ${i < steps.length - 1 ? '<div class="adhd-chain-connector"></div>' : ''}
          `).join('')}
        </div>
        <div class="adhd-chain-next-action" id="adhd-subcon-next-action"></div>
      </div>
      ```
   e. Inject the panel using `frm.dashboard.add_comment(html, 'blue', true)` or by prepending to `.form-page` — follow the exact injection method used in ADHD-013.

5. **"Next action" button logic** — inject a `<button>` into `#adhd-subcon-next-action` based on state:
   | State | Button label | Action |
   |-------|-------------|--------|
   | `po_created` | "Send Materials" | `frappe.set_route('Form', 'Stock Entry', 'new-stock-entry-1')` with `stock_entry_type = 'Send to Subcontractor'` and `subcontracting_order = frm.doc.name` pre-filled — use `frappe.model.open_mapped_doc` if ERPNext has a mapped method, otherwise navigate with query params |
   | `materials_sent` | "Send Remaining Materials" (if `per_sent_qty < 100`) or no button | Same as above |
   | `wip` (materials fully sent, no receipt) | "Create Receipt" | `frappe.model.open_mapped_doc({ method: 'erpnext.subcontracting.doctype.subcontracting_order.subcontracting_order.make_subcontracting_receipt', frm })` — verify this method exists in `subcontracting_order.py`; if not, use `frappe.set_route('Form', 'Subcontracting Receipt', 'new-...')` |
   | `receipt_pending` | "Create Receipt" | Same as wip |
   | `closed` | No button — show "✓ Complete" text | None |

6. **`per_sent_qty` vs `per_received_qty`**: these are percentage fields (0–100). Read directly from `frm.doc.per_sent_qty` and `frm.doc.per_received_qty`. If `null`, treat as 0.

7. **Linked Subcontracting Receipt check** (for the `receipt_pending` vs `wip` distinction): call `frappe.call({ method: 'frappe.client.get_count', args: { doctype: 'Subcontracting Receipt', filters: { subcontracting_order: frm.doc.name, docstatus: ['!=', 2] } }, callback(r) { /* if > 0, state = receipt_exists; re-render */ } })`. This is the only async call needed. Make it before rendering the panel, then render synchronously once the count is known.

8. **CSS** (reuse ADHD-013 classes if they exist; otherwise define):
   ```css
   .adhd-chain-panel { padding: 12px; margin-bottom: 16px; }
   .adhd-chain-steps { display: flex; align-items: center; gap: 0; }
   .adhd-chain-step  { display: flex; flex-direction: column; align-items: center; min-width: 100px; }
   .adhd-chain-dot   { width: 16px; height: 16px; border-radius: 50%; background: #dee2e6; }
   .adhd-chain-connector { flex: 1; height: 3px; background: #dee2e6; }
   .adhd-chain-done .adhd-chain-dot      { background: #28a745; }
   .adhd-chain-done .adhd-chain-connector { background: #28a745; }
   .adhd-chain-active .adhd-chain-dot    { background: #007bff; box-shadow: 0 0 0 3px rgba(0,123,255,0.3); }
   .adhd-chain-label { font-size: 0.75rem; margin-top: 4px; text-align: center; }
   .adhd-chain-done .adhd-chain-label    { color: #28a745; font-weight: 600; }
   .adhd-chain-active .adhd-chain-label  { color: #007bff; font-weight: 700; }
   .adhd-chain-upcoming .adhd-chain-label { color: #6c757d; }
   .adhd-chain-next-action { margin-top: 12px; text-align: center; }
   ```

9. **Bundle**: add `adhd_subcontracting_order.js` to `hooks.py` under `doctype_js["Subcontracting Order"]`.

## How to Test

1. Enable ADHD mode. Go to **Subcontracting → Subcontracting Order → New**. Fill required fields and save as draft.
2. Confirm chain panel does NOT appear on a draft document (docstatus = 0). The panel should only activate after submission.
3. Submit the Subcontracting Order. Confirm the chain panel appears with "PO Created" highlighted (active/blue dot) and a "Send Materials" button.
4. Click "Send Materials". Confirm navigation to a new Stock Entry pre-filled with `stock_entry_type = 'Send to Subcontractor'` and the SO name.
5. Complete and submit the Stock Entry. Return to the Subcontracting Order. Reload. Confirm `per_sent_qty` has increased. If partial, confirm "Materials Sent" is active with a "Send Remaining Materials" button.
6. Send all remaining materials (per_sent_qty = 100). Reload the SO. Confirm "Work in Progress" or "Receipt Pending" is the active state and "Create Receipt" button appears.
7. Click "Create Receipt". Confirm navigation to a new Subcontracting Receipt linked to this SO.
8. Submit the Subcontracting Receipt. Return to the SO. Reload. Confirm "Closed" step is active and no button appears, replaced by "✓ Complete".
9. Close the SO manually. Confirm the chain shows "Closed" as active.
10. Disable ADHD mode. Open the SO. Confirm no chain panel.

## Acceptance Criteria
- [ ] Chain panel shows five steps: PO Created → Materials Sent → Work in Progress → Receipt Pending → Closed.
- [ ] Current state is highlighted (blue active dot) based on `per_sent_qty`, `per_received_qty`, and `status` fields.
- [ ] Completed steps are visually distinguished (green dot/line) from upcoming steps (grey).
- [ ] "Send Materials" button appears when `per_sent_qty = 0` (or < 100) and the order is submitted.
- [ ] "Create Receipt" button appears when materials are fully sent and no Subcontracting Receipt exists yet.
- [ ] "✓ Complete" text (no button) shown when the order is closed or fully received.
- [ ] Panel does not appear on draft documents.
- [ ] Panel is absent when ADHD mode is off.
- [ ] No JS errors in any state.
- [ ] Exactly one async `frappe.call` per refresh (for the Subcontracting Receipt count).

## Dependencies
- Blocked by: ADHD-013 (PO Status Panel — read its implementation first to match the chain panel pattern and reuse CSS)
- Blocks: none

## Complexity
M — requires reading `per_sent_qty`/`per_received_qty` field semantics, one async receipt-count check, a multi-step state machine, and careful alignment with ADHD-013's visual pattern.

## Phase
Phase 7 — Module-by-Module Expansion
