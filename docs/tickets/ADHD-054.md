# ADHD-054: Asset Creation Prompt on Purchase Invoice Submit

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Purchase Invoice fixed-asset prompt in `erpnext/public/js/adhd/adhd_tickets_041_061.js`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When a Purchase Invoice containing fixed-asset items is submitted in ADHD mode, show a non-blocking banner prompting the user to create Asset records immediately, preventing the common failure of submitting and forgetting.

## Background / Context
In ERPNext, submitting a Purchase Invoice for a fixed asset does not automatically create an Asset record — the user must separately navigate to and complete that flow. ADHD users frequently submit the invoice, feel the relief of task completion, and switch contexts entirely, never creating the Asset. Depreciation then starts accruing from the wrong date or not at all, creating accounting errors that surface weeks later and are difficult to trace. The friction point is the moment *after* PI submission, when the Asset creation step becomes invisible.

## Cognitive Mechanism
Working memory | Initiation | Time blindness

## Prerequisites
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/accounts/doctype/purchase_invoice/adhd_fixed_asset_prompt.js`

## What Needs to Be Done

1. **Create `adhd_fixed_asset_prompt.js`**. Guard with `if (!frappe.boot.adhd_mode) return;` at the top.

2. **Register `frappe.ui.form.on('Purchase Invoice', { after_save(frm) { ... } })`**. This hook fires after every save including submission. Check `frm.doc.docstatus === 1` to confirm submission (as opposed to a normal save of a draft).

3. **Detect fixed-asset items**:
   a. Iterate `frm.doc.items` (the child table array).
   b. For each row, check `row.is_fixed_asset === 1` (this is a checkbox field on Purchase Invoice Item).
   c. Collect the list of such rows: `const fixedAssetRows = frm.doc.items.filter(r => r.is_fixed_asset);`.
   d. If `fixedAssetRows.length === 0`, return immediately — no banner needed.

4. **Check whether Assets already exist** (avoid duplicate prompts on re-load of an already-processed PI):
   a. Call `frappe.call({ method: 'frappe.client.get_count', args: { doctype: 'Asset', filters: { purchase_invoice: frm.doc.name } }, callback(r) { if (r.message > 0) return; /* assets exist, skip */ renderAssetPrompt(frm, fixedAssetRows); } })`.

5. **`renderAssetPrompt(frm, rows)`**:
   a. Remove any existing `#adhd-asset-prompt` element.
   b. Build a list of item names: `rows.map(r => r.item_name || r.item_code).join(', ')`.
   c. Build HTML:
      ```html
      <div id="adhd-asset-prompt" class="adhd-asset-banner">
        🏗️ This invoice includes fixed assets: <strong>{itemList}</strong>.
        Create Asset records now?
        <button id="adhd-create-assets-btn">Create Assets</button>
        <button id="adhd-asset-dismiss-btn">Dismiss</button>
      </div>
      ```
   d. Inject using `frm.dashboard.set_headline_alert(html)`.
   e. Bind `#adhd-create-assets-btn` click:
      - Call `frm.cscript.make_asset()` if it exists (standard ERPNext PI method to trigger asset creation), OR use `frappe.set_route('Form', 'Asset', 'new-asset-1')` with query params pre-filled — check `purchase_invoice/purchase_invoice.js` for the existing "Make Asset" button handler and replicate its call exactly.
      - The cleanest approach: `frm.trigger('make_asset')` (if the standard custom button trigger name is `make_asset`) or `frappe.model.open_mapped_doc({ method: 'erpnext.accounts.doctype.purchase_invoice.purchase_invoice.make_asset', frm })`.
      - Remove the banner after click.
   f. Bind `#adhd-asset-dismiss-btn` click: remove the banner.

6. **CSS**:
   ```css
   .adhd-asset-banner { background: #fff3cd; color: #856404; font-weight: 500; padding: 6px 12px; border-radius: 4px; display: flex; align-items: center; gap: 8px; }
   .adhd-asset-banner button { margin-left: 6px; }
   ```

7. **Bundle**: add `adhd_fixed_asset_prompt.js` to `hooks.py` under `doctype_js["Purchase Invoice"]`.

## How to Test

1. Enable ADHD mode. Go to **Accounts → Purchase Invoice → New**.
2. Add a supplier. Add an item that has `is_fixed_asset = 1` on its Item master (e.g. a Laptop or a Vehicle). Fill in all required fields.
3. Save the draft. Confirm **no banner** appears (banner only fires post-submission).
4. Submit the invoice. Confirm an amber banner appears: "🏗️ This invoice includes fixed assets: [item name]. Create Asset records now? | Create Assets | Dismiss".
5. Click **Dismiss**. Confirm banner disappears cleanly.
6. Reload the submitted PI. Confirm the banner does **not** reappear (because no Assets exist yet — it should reappear; see note below). Actually, reload should show it again until assets are created. Confirm this behaviour.
7. Click **Create Assets**. Confirm the user is navigated to the Asset creation form (or the standard mapped-doc flow opens) with `purchase_invoice` pre-filled.
8. Complete and submit the Asset record. Navigate back to the PI. Reload. Confirm **no banner** appears (assets now exist).
9. Create a PI with only non-fixed-asset items. Submit. Confirm no banner appears.
10. Disable ADHD mode. Create and submit a PI with a fixed-asset item. Confirm no banner appears.

## Acceptance Criteria
- [ ] Banner appears after submission of a PI containing one or more items with `is_fixed_asset = 1`.
- [ ] Banner lists the fixed-asset item names.
- [ ] "Create Assets" button initiates the Asset creation flow with the PI pre-linked.
- [ ] "Dismiss" removes the banner without further action.
- [ ] Banner does not appear if Asset records already exist for this PI.
- [ ] Banner does not appear for PIs with no fixed-asset items.
- [ ] Banner does not appear when ADHD mode is off.
- [ ] No JS errors in the console.

## Dependencies
- Blocks: none
- Blocked by: none (ADHD mode toggle already shipped)

## Complexity
S — one `frappe.call` for the asset count check, DOM injection, and reuse of an existing mapped-doc flow.

## Phase
Phase 7 — Module-by-Module Expansion
