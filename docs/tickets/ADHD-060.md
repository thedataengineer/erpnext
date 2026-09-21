# ADHD-060: Quality Inspection "Pass/Fail at a Glance" on Source Document

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Source-document QI banners in `erpnext/public/js/adhd/adhd_tickets_041_061.js`, calling whitelisted `erpnext/stock/adhd_quality.py`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Inject a compact QI result banner on Purchase Receipts, Delivery Notes, and Stock Entries that have a linked Quality Inspection, showing pass/fail status and out-of-spec reading count without requiring the user to open the QI separately.

## Background / Context
ERPNext requires a Quality Inspection for many stock transactions, but the result of that QI is only visible by opening the QI document — the source document (Purchase Receipt, Delivery Note, Stock Entry) shows only a link to the QI, not its outcome. ADHD users frequently click "Submit" on the source document without checking the QI status, either because they forget or because opening a second form breaks their flow. A failed QI on a submitted Purchase Receipt creates costly receiving errors. The friction is the cognitive switch required to open the QI, read the result, switch back, and continue — a sequence that is easily interrupted.

## Cognitive Mechanism
Attention switching | Working memory | Initiation

## Prerequisites
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/quality_management/doctype/quality_inspection/adhd_qi_banner.js` — injected into source doctypes
- The same JS file handles all three source doctypes (Purchase Receipt, Delivery Note, Stock Entry) using a shared helper and three `frappe.ui.form.on` registrations.

## What Needs to Be Done

1. **Create `adhd_qi_banner.js`**. Guard with `if (!frappe.boot.adhd_mode) return;` at the top.

2. **Define a shared helper `fetchAndRenderQIBanner(frm, qiFieldName)`**:
   a. `qiFieldName` is the name of the link field on the source doctype that holds the QI name (e.g. `'quality_inspection'` on Purchase Receipt Item rows, or a header-level field — verify against doctype JSONs).
   b. **Important**: Quality Inspection links may be at the **item row level** (child table) rather than at the header. Check `purchase_receipt.json`, `delivery_note.json`, and `stock_entry.json` for where `quality_inspection` field exists. If it is on child rows, collect all unique non-null QI names from all rows: `const qiNames = [...new Set(frm.doc.items.map(r => r.quality_inspection).filter(Boolean))]`.
   c. If `qiNames` is empty (or no QI link field exists on this document), remove any existing banner and return.
   d. Call `frappe.call` to fetch QI results:
      ```js
      frappe.call({
        method: 'frappe.client.get_list',
        args: {
          doctype: 'Quality Inspection',
          filters: [['name', 'in', qiNames]],
          fields: ['name', 'status', 'item_code', 'readings'],
          limit: qiNames.length + 1,
        },
        callback(r) {
          renderQIBanner(frm, r.message || []);
        }
      });
      ```
   e. Alternatively, if `readings` is a child table and not returned by `get_list`, use a separate call: `frappe.call({ method: 'erpnext.quality_management.doctype.quality_inspection.quality_inspection.get_quality_inspections', args: { names: qiNames } })` — but only if such a method exists. Prefer the simpler `get_list` approach first.

3. **Count out-of-spec readings**:
   a. For each QI in the results, count readings where `status = 'Rejected'` (check `quality_inspection_reading.json` for the status field name — it may be `status` or a calculated field).
   b. Alternatively, use the top-level `status` field on the QI itself (`'Accepted'` or `'Rejected'`).
   c. For the banner, use QI-level `status` as primary signal and out-of-spec reading count as supplementary detail.

4. **`renderQIBanner(frm, qiResults)`**:
   a. Remove any existing `#adhd-qi-banner`.
   b. Determine overall status:
      - If any QI has `status = 'Rejected'`: overall = FAILED.
      - If all QIs have `status = 'Accepted'`: overall = PASSED.
      - If any QI has `status = 'Pending'` or is missing: overall = PENDING.
   c. Build HTML by case:
      - **PASSED**: `<div id="adhd-qi-banner" class="adhd-qi-pass">✓ QI: PASSED</div>`
      - **FAILED**: count total out-of-spec readings across all QIs. `<div id="adhd-qi-banner" class="adhd-qi-fail">✗ QI: FAILED — {X} reading(s) out of spec</div>`
      - **PENDING**: `<div id="adhd-qi-banner" class="adhd-qi-pending">⏳ QI: Pending inspection</div>`
   d. If multiple QIs (multiple items), show a compact multi-line version listing each item's QI status.
   e. Inject via `frm.dashboard.set_headline_alert(html)`.

5. **CSS**:
   ```css
   .adhd-qi-pass    { background: #d4edda; color: #155724; font-weight: 600; padding: 4px 12px; border-radius: 4px; }
   .adhd-qi-fail    { background: #f8d7da; color: #721c24; font-weight: 600; padding: 4px 12px; border-radius: 4px; }
   .adhd-qi-pending { background: #e2e3e5; color: #383d41; font-weight: 600; padding: 4px 12px; border-radius: 4px; }
   ```

6. **Register for all three doctypes**:
   ```js
   ['Purchase Receipt', 'Delivery Note', 'Stock Entry'].forEach(dt => {
     frappe.ui.form.on(dt, {
       refresh(frm) { fetchAndRenderQIBanner(frm, 'quality_inspection'); }
     });
   });
   ```
   The `qiFieldName` may differ per doctype — parameterise if needed.

7. **Re-render on QI field change**: if the QI link can change while the form is open (e.g. user sets it on an item row), also hook `frappe.ui.form.on('{ChildDoctype}', { quality_inspection(frm) { fetchAndRenderQIBanner(frm, 'quality_inspection'); } })`.

8. **Bundle**: add `adhd_qi_banner.js` to `hooks.py` under `doctype_js` for all three doctypes:
   ```python
   doctype_js = {
     'Purchase Receipt': 'path/to/adhd_qi_banner.js',
     'Delivery Note':    'path/to/adhd_qi_banner.js',
     'Stock Entry':      'path/to/adhd_qi_banner.js',
   }
   ```

## How to Test

1. Enable ADHD mode. Create an Item with Quality Inspection criteria set up (Inspection Required on Purchase).
2. Create a **Purchase Receipt** for that item. Confirm the QI link field is present on the item row.
3. Open the linked QI. Set all readings as "Accepted" and submit the QI.
4. Return to the Purchase Receipt. Confirm a **green** banner reads "✓ QI: PASSED".
5. Create a new Purchase Receipt with the same item. Open the QI, set one reading as "Rejected", submit.
6. Return to the Purchase Receipt. Confirm a **red** banner reads "✗ QI: FAILED — 1 reading(s) out of spec".
7. Create a Purchase Receipt where the QI exists but has not been submitted yet (status = Pending).
8. Return to the Purchase Receipt. Confirm a **grey** banner reads "⏳ QI: Pending inspection".
9. Open a **Delivery Note** and **Stock Entry** with QI links. Confirm banners render correctly on both.
10. Open a Purchase Receipt with no QI link. Confirm no banner appears.
11. Disable ADHD mode. Open any source document with a QI link. Confirm no banner.

## Acceptance Criteria
- [ ] Green "✓ QI: PASSED" banner shown when all linked QIs are accepted.
- [ ] Red "✗ QI: FAILED — X reading(s) out of spec" banner shown when any QI is rejected.
- [ ] Grey "⏳ QI: Pending" banner shown when QI is not yet completed.
- [ ] Banner renders correctly on Purchase Receipt, Delivery Note, and Stock Entry.
- [ ] No banner when no QI is linked to the document.
- [ ] Banner is absent when ADHD mode is off.
- [ ] No JS errors when QI results are missing or empty.
- [ ] Only one `frappe.call` per form refresh (batch-fetch all QIs, no per-row calls).

## Dependencies
- Blocks: none
- Blocked by: none (ADHD mode toggle already shipped)

## Complexity
S — one `frappe.call` per refresh with a filter on QI names, shared helper across three doctypes, DOM injection.

## Phase
Phase 7 — Module-by-Module Expansion
