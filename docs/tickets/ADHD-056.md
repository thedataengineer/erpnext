# ADHD-056: Asset Capitalization Guided Flow

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Asset Capitalization guided steps in `erpnext/public/js/adhd/adhd_tickets_041_061.js`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When ADHD mode is active on a new Asset Capitalization form, replace the intimidating blank form with a three-step wizard that guides the user through type selection, item entry, and submission, with the full form still accessible via a toggle.

## Background / Context
Asset Capitalization is an infrequent, multi-field form that combines stock items, services, and existing assets into a single target asset. ADHD users face initiation paralysis when confronted with an unfamiliar form that has many sections and no obvious starting point. Without a clear "do this first" cue, users often open the form, feel overwhelmed, and abandon the task — leaving capitalization incomplete and creating asset-register inconsistencies. The friction point is the very first open of a new Asset Capitalization document.

## Cognitive Mechanism
Initiation | Working memory | Attention switching

## Prerequisites
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/assets/doctype/asset_capitalization/adhd_asset_capitalization.js`

## What Needs to Be Done

1. **Create `adhd_asset_capitalization.js`**. Guard with `if (!frappe.boot.adhd_mode) return;` at the top.

2. **Register `frappe.ui.form.on('Asset Capitalization', { refresh(frm) { ... } })`**. In `refresh`:
   a. Only activate the guided flow for **new, unsaved documents** (`frm.doc.__islocal`). If the document is already saved or submitted, render only a read-mode summary and skip the wizard.
   b. Call `renderGuidedFlow(frm)`.

3. **`renderGuidedFlow(frm)`**:
   a. Hide the standard form sections by adding a CSS class to `.form-page` that collapses them: `frm.page.main.addClass('adhd-wizard-mode')`. CSS: `.adhd-wizard-mode .form-layout { display: none; }`.
   b. Inject a `<div id="adhd-cap-wizard">` immediately inside `.page-content` or `.form-page`, above the form layout.
   c. Render the wizard shell:
      ```html
      <div id="adhd-cap-wizard">
        <div class="adhd-step-bar">
          <span class="adhd-step" data-step="1">1 · What are you capitalizing?</span>
          <span class="adhd-step" data-step="2">2 · Add items</span>
          <span class="adhd-step" data-step="3">3 · Confirm &amp; Submit</span>
        </div>
        <div id="adhd-step-content"></div>
        <div class="adhd-wizard-footer">
          <button id="adhd-wizard-back">← Back</button>
          <button id="adhd-wizard-next">Next →</button>
          <a href="#" id="adhd-show-full-form">Show full form</a>
        </div>
      </div>
      ```
   d. Store current step in `frm._adhdWizardStep = 1`. Render step 1.

4. **Step 1 — "What are you capitalizing?"**:
   a. Render three radio/card options:
      - "📦 Stock Items" — sets `frm.set_value('capitalization_method', 'Choose a WIP composite cost center')`... actually: sets `frm.set_value('entry_type', 'Capitalization')` and will use `stock_items` child table.
      - "🔧 Service / Labour" — sets entry type appropriately, will use `service_items` child table.
      - "🏗️ Existing Assets" — will use `asset_items` child table.
   b. Map each choice to the correct `entry_type` field value from `asset_capitalization.json` (check the doctype JSON — likely `'Capitalization'` or `'Decapitalization'`; the three child tables are `stock_items`, `service_items`, `asset_items`). If entry_type is not a distinguishing field, simply track which child table to expose in step 2.
   c. Highlight the selected card. Store choice in `frm._adhdCapType`.
   d. "Next" button disabled until a choice is made.

5. **Step 2 — "Add items"**:
   a. Based on `frm._adhdCapType`, show only the relevant child table section from the ERPNext form.
   b. Re-show only that section: `frm.fields_dict[tableFieldName].wrapper.closest('.form-section').show()`.
   c. Also show the `target_asset` (link field to the Asset being capitalized into) and `company` fields — these are always required.
   d. "Next" disabled until at least one row exists in the chosen child table and `target_asset` is filled.
   e. Validate on Next: `if (!frm.doc.target_asset) { frappe.msgprint('Please select a Target Asset.'); return; }`.

6. **Step 3 — "Confirm & Submit"**:
   a. Render a read-only summary:
      - Target Asset name and code.
      - Number of items added.
      - Total value (sum of `amount` field across the child table rows if available, else "—").
   b. A "Submit" button that calls `frm.savesubmit()`.
   c. A "Save Draft" button that calls `frm.save()`.

7. **"Show full form" link**: on click:
   a. `frm.page.main.removeClass('adhd-wizard-mode')` — reveals the standard form.
   b. `$('#adhd-cap-wizard').hide()`.
   c. Show a "Back to guided flow" link in the dashboard strip.

8. **Step progress indicator**: add `.adhd-step-active` class to the current step span. CSS:
   ```css
   .adhd-step-bar { display: flex; gap: 16px; margin-bottom: 20px; }
   .adhd-step { color: #6c757d; font-size: 0.9rem; }
   .adhd-step-active { color: #2490ef; font-weight: 700; border-bottom: 2px solid #2490ef; }
   .adhd-wizard-mode .form-layout { display: none !important; }
   ```

9. **Bundle**: add `adhd_asset_capitalization.js` to `hooks.py` under `doctype_js["Asset Capitalization"]`.

## How to Test

1. Enable ADHD mode. Navigate to **Assets → Asset Capitalization → New**.
2. Confirm the standard form is hidden and the 3-step wizard is displayed with Step 1 highlighted.
3. Confirm the "Next" button is disabled before selecting a capitalization type.
4. Click "Stock Items". Confirm the card is highlighted and "Next" becomes enabled.
5. Click "Next". Confirm Step 2 is displayed, showing only the `stock_items` child table and `target_asset` + `company` fields.
6. Try clicking "Next" without filling `target_asset`. Confirm a validation message appears.
7. Fill in `target_asset`, `company`, and add one row to the stock items table. Click "Next".
8. Confirm Step 3 shows a summary with the target asset name and item count.
9. Click "Save Draft". Confirm the document saves without submitting.
10. Click "Show full form". Confirm the standard ERPNext Asset Capitalization form is revealed with all sections.
11. Open an existing saved Asset Capitalization. Confirm the wizard is NOT shown (only shows for new documents).
12. Disable ADHD mode. Open a new Asset Capitalization. Confirm the standard form is shown with no wizard.

## Acceptance Criteria
- [ ] Guided 3-step wizard appears for new Asset Capitalization documents in ADHD mode.
- [ ] Standard form is hidden during wizard flow.
- [ ] Step 1 presents three capitalization type options; "Next" is disabled until one is selected.
- [ ] Step 2 shows only the child table relevant to the selected type, plus `target_asset` and `company`.
- [ ] Step 2 validates that `target_asset` is filled before proceeding.
- [ ] Step 3 shows a readable summary with "Submit" and "Save Draft" options.
- [ ] "Show full form" reveals the complete ERPNext form at any step.
- [ ] Wizard does not appear for already-saved or submitted documents.
- [ ] Wizard does not appear when ADHD mode is off.
- [ ] No JS errors during any step transition.

## Dependencies
- Blocks: none
- Blocked by: none (ADHD mode toggle already shipped)

## Complexity
M — multi-step DOM orchestration with form-section show/hide logic; requires reading Asset Capitalization doctype JSON to map child table and field names accurately.

## Phase
Phase 7 — Module-by-Module Expansion
