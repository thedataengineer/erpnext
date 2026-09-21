# ADHD-052: Warranty Claim "What's Covered" Inline Check

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Warranty coverage banner in `erpnext/public/js/adhd/adhd_tickets_041_061.js`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
On a Warranty Claim form in ADHD mode, display a one-line banner that immediately tells the agent whether the item is still under warranty, eliminating the need to manually cross-reference dates.

## Background / Context
Processing a warranty claim requires comparing `complaint_date` against `warranty_expiry_date` — a trivial calculation that nonetheless requires the agent to consciously hold three pieces of data in working memory simultaneously. ADHD brains frequently drop one variable, leading to incorrect coverage decisions or the need to re-open the form multiple times. The friction point is the Warranty Claim form, which shows the dates in separate fields with no visual synthesis.

## Cognitive Mechanism
Working memory | Attention switching

## Prerequisites
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/support/doctype/warranty_claim/adhd_warranty_claim.js`

## What Needs to Be Done

1. **Create `adhd_warranty_claim.js`**. At the top, return early if `!frappe.boot.adhd_mode`.

2. **Register a `frappe.ui.form.on('Warranty Claim', { ... })` handler** with hooks: `refresh`, `item_code`, `warranty_expiry_date`, `complaint_date`.

3. **In the shared helper `renderWarrantyBanner(frm)`**:
   a. Remove any existing `#adhd-warranty-banner` element.
   b. Read `frm.doc.warranty_expiry_date` (date string `YYYY-MM-DD`) and `frm.doc.complaint_date` (date string).
   c. If either field is blank, do nothing and return.
   d. Parse both as `new Date(...)`. Compare: `isExpired = complaintDate > warrantyExpiry`.
   e. If **not expired**:
      - Format the expiry date as a human-readable string using `frappe.datetime.str_to_user(frm.doc.warranty_expiry_date)`.
      - Build HTML: `<div id="adhd-warranty-banner" class="adhd-warranty-valid">✓ Warranty valid until {date} — COVERED</div>`
   f. If **expired**:
      - Compute days overdue: `Math.floor((complaintDate - warrantyExpiry) / 86400000)`.
      - Build HTML: `<div id="adhd-warranty-banner" class="adhd-warranty-expired">✗ Warranty expired {X} days ago — NOT COVERED</div>`
   g. Inject the banner using `frm.dashboard.set_headline_alert(html)` so it appears in the standard dashboard strip above the form fields.

4. **CSS** (inline via `frappe.dom.set_style` or in `adhd.css`):
   ```css
   .adhd-warranty-valid   { background: #d4edda; color: #155724; font-weight: 600; padding: 4px 12px; border-radius: 4px; }
   .adhd-warranty-expired { background: #f8d7da; color: #721c24; font-weight: 600; padding: 4px 12px; border-radius: 4px; }
   ```

5. **No API call is needed** — `warranty_expiry_date` and `complaint_date` are both standard fields already present on the Warranty Claim doctype. Confirm field names in `erpnext/support/doctype/warranty_claim/warranty_claim.json` before finalising (the spec uses `warranty_expiry_date` and `complaint_date`; adjust if the JSON uses different names).

6. **Bundle**: add `adhd_warranty_claim.js` to `hooks.py` under `doctype_js["Warranty Claim"]`.

## How to Test

1. Enable ADHD mode. Open **Support → Warranty Claim → New**.
2. Set `item_code` to any item. Set `complaint_date` to today. Set `warranty_expiry_date` to a date **3 months from today**. Save.
3. Confirm a **green** banner reads "✓ Warranty valid until [date] — COVERED".
4. Change `warranty_expiry_date` to a date **30 days in the past**. Tab out.
5. Confirm the banner updates immediately to a **red** banner reading "✗ Warranty expired 30 days ago — NOT COVERED".
6. Clear `warranty_expiry_date`. Confirm banner disappears (no error).
7. Disable ADHD mode. Reload. Confirm no banner appears.
8. Open an existing submitted Warranty Claim. Confirm banner still renders (read-only form is fine).

## Acceptance Criteria
- [ ] Green "COVERED" banner shown when `complaint_date` ≤ `warranty_expiry_date`.
- [ ] Red "NOT COVERED" banner shown with days-overdue count when `complaint_date` > `warranty_expiry_date`.
- [ ] Banner updates reactively when `warranty_expiry_date` or `complaint_date` field value changes.
- [ ] No banner shown when either date field is empty.
- [ ] No API call made — all data read from `frm.doc`.
- [ ] No banner when ADHD mode is off.
- [ ] No JS errors in the browser console.

## Dependencies
- Blocks: none
- Blocked by: none (ADHD mode toggle already shipped)

## Complexity
S — pure client-side date comparison and DOM injection; no server round-trips.

## Phase
Phase 7 — Module-by-Module Expansion
