# ADHD-021: Quotation Expiry Ambient Warning

## Summary
Extends the Phase 3.1 heat-map infrastructure to the Quotation list view and injects a one-line expiry banner on the Quotation form, so users can see at a glance which open quotes are about to go cold.

## Background / Context
A Quotation has a `valid_till` date that, once passed, makes the quote legally stale — but ERPNext gives no visual signal until a user actively opens the document. For ADHD users, time-sensitive documents silently expire because nothing in the list view demands attention. The heat-map pattern from ADHD-006 already solves this for other doctypes; Quotations need the same treatment because they sit at the very top of the Selling chain.

## Cognitive Mechanism
Time blindness | working memory

## Prerequisites
- ADHD-006 (heat-map list view infrastructure in `public/js/adhd/adhd_list_view.js`) must be shipped and the `registerHeatmapDoctype()` API must be stable.
- ADHD-008 (deadline banner pattern in `public/js/adhd/adhd_deadline_banner.js`) must be shipped and `renderDeadlineBanner(frm, dateField, label)` must be exported.

## Scope
**Create:**
- `erpnext/selling/doctype/quotation/adhd_quotation.js`

**Modify:**
- `erpnext/public/js/adhd/adhd_list_view.js` — add a `registerHeatmapDoctype("Quotation", "valid_till")` call inside the existing doctype registration block.

## What Needs to Be Done

1. **Register Quotation with the heat-map infra.** In `adhd_list_view.js`, locate the block where other doctypes (e.g., Sales Order, Purchase Invoice) are registered via `registerHeatmapDoctype`. Add:
   ```js
   registerHeatmapDoctype("Quotation", "valid_till");
   ```
   This single call is sufficient for the list view — the existing infrastructure handles colour coding, tooltip rendering, and the `data-adhd-days-left` attribute.

2. **Create `adhd_quotation.js`.** At the top of the file, guard behind ADHD mode:
   ```js
   frappe.ui.form.on("Quotation", {
     after_load(frm) {
       if (!frappe.boot.adhd_mode) return;
       renderQuotationExpiryBanner(frm);
     },
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       renderQuotationExpiryBanner(frm);
     },
   });
   ```

3. **Implement `renderQuotationExpiryBanner(frm)`.** Import (or inline-call) the `renderDeadlineBanner` function from `adhd_deadline_banner.js`:
   ```js
   function renderQuotationExpiryBanner(frm) {
     // Remove any existing banner to avoid duplicates
     $(frm.wrapper).find(".adhd-deadline-banner").remove();

     if (!frm.doc.valid_till) return;

     // Delegate to the shared deadline banner helper
     // Signature: renderDeadlineBanner(frm, dateFieldValue, humanLabel)
     renderDeadlineBanner(frm, frm.doc.valid_till, "Quotation expires");
   }
   ```
   The shared helper already computes days remaining, chooses red/amber/green styling, and inserts the banner element into the form layout above the first section.

4. **Verify no duplicate banners.** The removal of `.adhd-deadline-banner` at the start of the function (step 3) handles this. Confirm the class name matches what `adhd_deadline_banner.js` emits.

5. **Include the new file in `hooks.py`.** Add `"selling/doctype/quotation/adhd_quotation.js"` to the `app_include_js` list (or the relevant bundle entry point) so it is loaded on the Quotation form. Use the same conditional guard pattern as other ADHD form scripts.

6. **No new server endpoint needed.** All data (`valid_till`) is already present on the loaded document.

## How to Test

1. Open a fresh ERPNext desk with ADHD mode enabled.
2. Navigate to **Selling → Quotations** list view.
3. Confirm that Quotation rows are coloured according to the heat-map rules:
   - Red row background if `valid_till` is today or in the past.
   - Amber row background if `valid_till` is within the next 7 days.
   - No colour change if `valid_till` is more than 7 days away.
4. Hover over a coloured row. Confirm a tooltip appears (e.g., "Expires in 3 days" or "Expired 2 days ago").
5. Open a Quotation where `valid_till` is within 3 days. Confirm a one-line banner appears below the page header and above the first form section, reading something like "⏰ Quotation expires in 3 days (2025-07-15)".
6. Open a Quotation where `valid_till` is more than 14 days away. Confirm no banner is shown.
7. Open a Quotation with no `valid_till` set. Confirm no banner is shown and no JS error appears in the console.
8. Disable ADHD mode. Reload the Quotation list. Confirm no heat-map colours appear. Open a near-expiry Quotation. Confirm the banner is absent.
9. Save a Quotation (without changing `valid_till`). Confirm the banner does not duplicate after the save/refresh cycle.

## Acceptance Criteria
- [ ] Quotation list rows are heat-map coloured by `valid_till` proximity when ADHD mode is active.
- [ ] Red colouring applies when `valid_till` is today or past; amber when within 7 days; no colour otherwise.
- [ ] A tooltip on coloured rows states the number of days until/since expiry.
- [ ] A deadline banner appears on the Quotation form when `valid_till` is within the configured warning threshold.
- [ ] No banner appears when `valid_till` is absent or beyond the threshold.
- [ ] No duplicate banners appear after multiple saves/refreshes.
- [ ] All heat-map and banner behaviour is absent when ADHD mode is disabled.
- [ ] No JavaScript console errors on the Quotation list or form.

## Dependencies
- **Blocked by:** ADHD-006 (heat-map infra), ADHD-008 (deadline banner pattern)
- **Blocks:** None directly; ADHD-029 (Sales Order Delivery Status) is a parallel Selling-module ticket.

## Complexity
S — Entirely additive; delegates all logic to pre-built ADHD-006 and ADHD-008 helpers. Two file changes, zero new server endpoints.

## Phase
Phase 7 — Module-by-Module Expansion

---

## LLM Implementation Guide

### Codebase Context

```
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- Client scripts: frappe.ui.form.on("DocType", { hook(frm) {} })
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Async API: frappe.call({ method, args, callback }) or await frappe.call(...)
- Child tables: frappe.model.add_child(frm.doc, childDoctype, fieldname)
- DOM sync: frm.refresh_field(fieldname)
- Persistence: localStorage.setItem/getItem/removeItem
- Include files: hooks.py under app_include_js or doctype_js
- CSS: erpnext/public/scss/adhd_mode.scss with CSS custom properties
- Python API: @frappe.whitelist(), called via dotted module path
- List queries: frappe.db.get_list / frappe.client.get_list return arrays of dicts
- Dialogs: new frappe.ui.Dialog({ title, fields, primary_action })
- Currency format: frappe.format(value, { fieldtype: "Currency" })

Prerequisite context:
- ADHD-006 introduced adhd_list_view.js with a registerHeatmapDoctype(doctype, dateField) helper.
- ADHD-008 introduced adhd_deadline_banner.js with renderDeadlineBanner(frm, dateValue, labelText).
```

---

### Claude Prompt

```text
You are implementing ADHD-021: Quotation Expiry Ambient Warning for ERPNext's ADHD Mode.

Context:
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- Client scripts: frappe.ui.form.on("DocType", { hook(frm) {} })
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Async API: frappe.call({ method, args, callback }) or await frappe.call(...)
- Child tables: frappe.model.add_child(frm.doc, childDoctype, fieldname)
- DOM sync: frm.refresh_field(fieldname)
- Persistence: localStorage.setItem/getItem/removeItem
- Include files: hooks.py under app_include_js or doctype_js
- CSS: erpnext/public/scss/adhd_mode.scss with CSS custom properties
- Python API: @frappe.whitelist(), called via dotted module path
- List queries: frappe.db.get_list / frappe.client.get_list return arrays of dicts
- Dialogs: new frappe.ui.Dialog({ title, fields, primary_action })
- Currency format: frappe.format(value, { fieldtype: "Currency" })
- ADHD-006 introduced registerHeatmapDoctype(doctype, dateField) in adhd_list_view.js
- ADHD-008 introduced renderDeadlineBanner(frm, dateValue, labelText) in adhd_deadline_banner.js

Task:
1. In adhd_list_view.js, call registerHeatmapDoctype("Quotation", "valid_till") so the list view
   heat-colours rows by proximity to expiry.
2. Create selling/doctype/quotation/adhd_quotation.js with:
   - frappe.ui.form.on("Quotation", { refresh(frm) { ... } })
   - ADHD mode guard at the top of the handler
   - Call renderDeadlineBanner(frm, frm.doc.valid_till, "Quotation expires") imported from adhd_deadline_banner.js

Think step by step:
- Where exactly in adhd_list_view.js should the registerHeatmapDoctype call be placed (after existing registrations)?
- What import/require pattern does this codebase use for shared ADHD helpers?
- What edge cases exist if valid_till is null or the doc is already submitted?

Produce the final code for both files with inline comments explaining each decision.
```

---

### GPT-4o Prompt

```text
## Task: ADHD-021 — Quotation Expiry Ambient Warning

### Codebase Context
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- Client scripts: frappe.ui.form.on("DocType", { hook(frm) {} })
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Async API: frappe.call({ method, args, callback }) or await frappe.call(...)
- DOM sync: frm.refresh_field(fieldname)
- Include files: hooks.py under app_include_js or doctype_js
- CSS: erpnext/public/scss/adhd_mode.scss with CSS custom properties
- ADHD-006: registerHeatmapDoctype(doctype, dateField) lives in adhd_list_view.js
- ADHD-008: renderDeadlineBanner(frm, dateValue, labelText) lives in adhd_deadline_banner.js

### Requirements
- [ ] Add `registerHeatmapDoctype("Quotation", "valid_till")` call inside `adhd_list_view.js`
- [ ] Create new file `selling/doctype/quotation/adhd_quotation.js`
- [ ] Register `frappe.ui.form.on("Quotation", { refresh(frm) {} })`
- [ ] Guard with `if (!frappe.boot.adhd_mode) return;`
- [ ] Call `renderDeadlineBanner(frm, frm.doc.valid_till, "Quotation expires")`
- [ ] Handle null/empty `valid_till` gracefully (skip banner if not set)
- [ ] Do not re-render banner if it already exists in DOM

### Constraints
- No new dependencies; reuse existing ADHD helpers only
- Follow existing file naming conventions in erpnext/selling/doctype/
- Single-prompt implementation (S ticket)

### Output
Provide complete file contents for both modified/created files with inline comments.
```

---

### Gemini 1.5 Pro Prompt

```text
You are implementing ADHD-021 (Quotation Expiry Ambient Warning) for ERPNext ADHD Mode. Follow these steps exactly.

Codebase context:
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- Client scripts: frappe.ui.form.on("DocType", { hook(frm) {} })
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Async API: frappe.call({ method, args, callback }) or await frappe.call(...)
- DOM sync: frm.refresh_field(fieldname)
- Include files: hooks.py under app_include_js or doctype_js
- CSS: erpnext/public/scss/adhd_mode.scss with CSS custom properties
- registerHeatmapDoctype(doctype, dateField) is defined in adhd_list_view.js (ADHD-006)
- renderDeadlineBanner(frm, dateValue, labelText) is defined in adhd_deadline_banner.js (ADHD-008)

Step 1 — Edit adhd_list_view.js:
  Add the line `registerHeatmapDoctype("Quotation", "valid_till");` after the existing registerHeatmapDoctype calls.

Step 2 — Create selling/doctype/quotation/adhd_quotation.js:
  a. At the top, add a reference comment linking to adhd_deadline_banner.js.
  b. Register frappe.ui.form.on("Quotation", { refresh(frm) {} }).
  c. First line of the handler: if (!frappe.boot.adhd_mode) return;
  d. Guard: if (!frm.doc.valid_till) return;
  e. Call renderDeadlineBanner(frm, frm.doc.valid_till, "Quotation expires").

Step 3 — Verify:
  - Confirm no duplicate banner can be injected (check for existing element before render).
  - Confirm the file path matches ERPNext conventions: erpnext/selling/doctype/quotation/adhd_quotation.js.

Output the complete contents of both files.
```

---

### Prompt Chain

This is an **S (small) ticket** — implement with a single prompt. Use any one of the three prompts above, then run the self-validation prompt below on the output.

---

### Self-Validation Prompt

```text
Review the following code generated for ADHD-021 (Quotation Expiry Ambient Warning).

Check for each item and respond with PASS or FAIL + reason:

1. adhd_list_view.js contains registerHeatmapDoctype("Quotation", "valid_till")
2. adhd_quotation.js registers frappe.ui.form.on("Quotation", { refresh(frm) {} })
3. ADHD mode guard `if (!frappe.boot.adhd_mode) return;` is the first statement in the handler
4. renderDeadlineBanner is called with (frm, frm.doc.valid_till, "Quotation expires")
5. Null/empty valid_till is handled — banner is skipped if the field is not set
6. No new external libraries are introduced
7. File path is erpnext/selling/doctype/quotation/adhd_quotation.js

[Paste generated code here]
```
