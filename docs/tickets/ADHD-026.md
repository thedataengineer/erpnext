# ADHD-026: Supplier Scorecard "Before You Order" Nudge

## Current implementation record

- **Status:** Planned.
- **Implementation:** No matching implementation or bundle registration exists on `iteration_3`.
- **Verification:** No implementation test exists; original acceptance criteria remain pending.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When ADHD mode is active and a supplier is selected on a new Purchase Order, queries the Supplier Scorecard and displays a non-blocking one-line warning banner below the supplier field if the supplier's total score is below a configurable threshold — giving the user a passive "stop and think" signal without interrupting their flow.

## Background / Context
ERPNext has a Supplier Scorecard module that tracks delivery reliability, quality, and responsiveness, but its data is entirely passive: a user can create a Purchase Order for a chronically late supplier without ever seeing any warning. For ADHD users who are moving quickly through order entry, the risk is particularly high because the impulse to "just place the order and deal with it later" overrides the mental note to check past performance. A one-line ambient nudge — visible at the moment the supplier field is set — converts the Scorecard from a reporting afterthought into a just-in-time decision aid.

## Cognitive Mechanism
Attention switching | working memory | initiation

## Prerequisites
- ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` readable on the client.
- Supplier Scorecard data must exist for the target supplier on the site (the feature degrades gracefully if no scorecard is found — no banner is shown).

## Scope
**Create:**
- `erpnext/buying/doctype/purchase_order/adhd_purchase_order_scorecard.js`

## What Needs to Be Done

1. **Create `adhd_purchase_order_scorecard.js` and register the supplier field trigger:**
   ```js
   frappe.ui.form.on("Purchase Order", {
     supplier(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (!frm.doc.supplier) {
         removeScorecardBanner(frm);
         return;
       }
       fetchAndRenderScorecardNudge(frm, frm.doc.supplier);
     },
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (frm.doc.supplier && frm.doc.__islocal) {
         fetchAndRenderScorecardNudge(frm, frm.doc.supplier);
       }
     },
   });
   ```
   Triggering on the `supplier` field change event means the nudge appears the moment the user picks a supplier, before they proceed to add items.

2. **Implement `fetchAndRenderScorecardNudge(frm, supplierName)`.** Query the Supplier Scorecard doctype:
   ```js
   async function fetchAndRenderScorecardNudge(frm, supplierName) {
     removeScorecardBanner(frm);

     // Fetch the most recent scorecard for this supplier
     let result;
     try {
       result = await frappe.call({
         method: "frappe.client.get_list",
         args: {
           doctype: "Supplier Scorecard",
           filters: { supplier: supplierName },
           fields: ["name", "supplier", "total_score", "status"],
           limit: 1,
           order_by: "modified desc",
         },
       });
     } catch (err) {
       // Fail silently — scorecard is informational only
       console.warn("[ADHD] Scorecard fetch failed:", err);
       return;
     }

     const scorecards = result.message || [];
     if (!scorecards.length) return; // No scorecard exists — show nothing

     const scorecard = scorecards[0];
     const threshold = frappe.boot.adhd_scorecard_threshold || 50; // Configurable via System Settings custom field

     if (scorecard.total_score >= threshold) return; // Score is acceptable — show nothing

     renderScorecardBanner(frm, scorecard, threshold);
   }
   ```

3. **Implement `renderScorecardBanner(frm, scorecard, threshold)`.** Build and inject the warning banner:
   ```js
   function renderScorecardBanner(frm, scorecard, threshold) {
     const score    = Math.round(scorecard.total_score);
     const status   = scorecard.status || "Unknown";
     const scLink   = frappe.utils.get_form_link("Supplier Scorecard", scorecard.name);

     const html = `
       <div class="adhd-scorecard-nudge" role="alert">
         <span class="adhd-scorecard-icon">⚠</span>
         <span class="adhd-scorecard-text">
           <strong>${frappe.utils.escape_html(frm.doc.supplier)}</strong>
           scored <strong>${score}/100</strong> on last scorecard
           (${frappe.utils.escape_html(status.toLowerCase())}).
         </span>
         <a href="${scLink}" class="adhd-scorecard-link" target="_blank">
           View scorecard ↗
         </a>
       </div>
     `;

     const $banner = $(html);

     // Insert directly below the supplier field row
     const $supplierField = $(frm.fields_dict.supplier.wrapper);
     $supplierField.after($banner);
   }
   ```

4. **Implement `removeScorecardBanner(frm)`.** Cleans up on supplier change or clear:
   ```js
   function removeScorecardBanner(frm) {
     $(frm.wrapper).find(".adhd-scorecard-nudge").remove();
   }
   ```

5. **Make the threshold configurable.** The default threshold is 50. Document that a site administrator can add a custom `Int` field named `adhd_scorecard_threshold` to the **System Settings** doctype via Frappe's Customize Form tool, and add it to `frappe.boot` via a `boot_session` hook in ERPNext. Until that custom field exists, the code falls back to `50` via `|| 50`.

6. **CSS in `adhd_mode.scss`:**
   - `.adhd-scorecard-nudge` — `display: flex; align-items: center; gap: 0.5rem; padding: 6px 12px; margin: 4px 0 8px; background: var(--yellow-50); border: 1px solid var(--yellow-300); border-radius: 4px; font-size: 0.82rem;`
   - `.adhd-scorecard-icon` — `font-size: 1rem; flex-shrink: 0;`
   - `.adhd-scorecard-text` — `flex: 1;`
   - `.adhd-scorecard-link` — `white-space: nowrap; color: var(--text-color); text-decoration: underline;`

7. **Include in `hooks.py`** under `app_include_js`.

## How to Test

1. Enable ADHD mode. Ensure at least one Supplier Scorecard exists: navigate to **Buying → Supplier Scorecard**, open or create a scorecard for "Test Supplier A" with `total_score` set to 38 and `status` set to "At Risk".
2. Navigate to **Buying → Purchase Order → New**.
3. In the Supplier field, select "Test Supplier A". Confirm a yellow nudge banner appears directly below the Supplier field reading: "⚠ Test Supplier A scored 38/100 on last scorecard (at risk). View scorecard ↗"
4. Click "View scorecard ↗". Confirm it opens the Supplier Scorecard form in a new tab.
5. Change the supplier to one with no Supplier Scorecard record. Confirm the banner disappears cleanly.
6. Set up a second supplier "Test Supplier B" with a scorecard `total_score` of 72. Select "Test Supplier B" on the Purchase Order. Confirm no nudge banner appears (score above threshold).
7. Clear the Supplier field (set to blank). Confirm the banner disappears.
8. Confirm the banner does not appear on existing (saved) Purchase Orders when revisited in ADHD mode — the `refresh` guard limits banner display to new/local docs only.
9. Disable ADHD mode. Create a new Purchase Order and select the low-scoring supplier. Confirm no banner appears.
10. Confirm no JavaScript console errors at any step, including when no scorecard exists.

## Acceptance Criteria
- [ ] A yellow warning banner appears below the Supplier field when ADHD mode is active, the supplier field is set on a new Purchase Order, and the supplier's scorecard `total_score` is below the threshold (default 50).
- [ ] Banner text includes the supplier name, numeric score, and status label.
- [ ] "View scorecard ↗" link opens the Supplier Scorecard form in a new tab.
- [ ] No banner appears when the supplier's score is at or above the threshold.
- [ ] No banner appears when the supplier has no Supplier Scorecard record.
- [ ] Banner disappears immediately when the supplier field is changed or cleared.
- [ ] Banner does not appear on saved/submitted Purchase Orders on refresh (only on new docs).
- [ ] Banner is absent when ADHD mode is disabled.
- [ ] No JavaScript console errors in any of the above states.

## Dependencies
- **Blocked by:** ADHD mode toggle (shipped); Supplier Scorecard data required for meaningful testing.
- **Blocks:** None

## Complexity
S — Single form script, one async `frappe.client.get_list` call, simple HTML injection below a field. No server endpoint, no DocType changes.

## Phase
Phase 7 — Module-by-Module Expansion
