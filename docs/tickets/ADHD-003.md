# ADHD-003: Mandatory Field Wizard — Guided Save

## Summary
Intercepts ERPNext's blocking mandatory-field error and replaces it with a step-by-step guided save mode that focuses each missing field in turn, displays a plain-English hint, and automatically retriggers save when all required fields are filled.

## Background / Context
The default ERPNext save failure presents a red-bordered list of field names — often using internal API names like `cost_center` or `expense_claim_type` — with no explanation and no clear path forward. For ADHD users, this wall of errors is a hard stop that collapses motivation and triggers avoidance. The cognitive cost of figuring out what each field means and where it is on the form is high enough that many incomplete documents simply get abandoned. The Guided Save mode turns that wall into a one-at-a-time guided flow.

## Cognitive Mechanism
Initiation | working memory | RSD (rejection-sensitive dysphoria triggered by error states)

## Prerequisites
- `public/js/adhd/form_focus.js` must already export a `FIELD_HELP` dictionary mapping `fieldname → plain-English description string`. This is noted as already shipped.
- ADHD-010 (Field Help Coverage expansion) should ideally be complete first to maximise hint coverage, but is not a hard blocker — the wizard degrades gracefully to showing the field label when no hint is available.
- ADHD mode toggle (`adhd_mode.js`, Phase 1) must be active.

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_form_wizard.js`

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-wizard-*` styles
- `erpnext/hooks.py` — include `adhd_form_wizard.js` in `app_include_js`

## What Needs to Be Done

1. **Intercept the validation failure.** Frappe fires `frappe.validated = false` on the client when mandatory fields are empty. Hook into this by overriding `frappe.ui.form.Form.prototype.save` after the file loads:
   ```js
   const _originalSave = frappe.ui.form.Form.prototype.save;
   frappe.ui.form.Form.prototype.save = function (...args) {
     if (!frappe.boot.adhd_mode) return _originalSave.apply(this, args);
     const missing = this.get_missing_mandatory_fields();  // returns array of { fieldname, label }
     if (missing && missing.length > 0) {
       startGuidedSave(this, missing);
       return;
     }
     return _originalSave.apply(this, args);
   };
   ```
   If `get_missing_mandatory_fields` is not a public API, iterate `frm.fields` and collect those where `df.reqd && !frm.doc[df.fieldname]`.

2. **Build `startGuidedSave(frm, missingFields)`.** Store state in a module-level object `wizardState = { frm, fields: missingFields, index: 0 }`.

3. **Show the wizard overlay.** Inject a `<div class="adhd-wizard-banner">` at the top of the form (prepend to `frm.layout.$wrapper`) containing:
   - Title: `"Let's fill in the missing details — [index] of [total]"`
   - Field name (human label) in bold.
   - Hint text: `FIELD_HELP[fieldname] || df.label || fieldname` in a `<p class="adhd-wizard-hint">`.
   - "Next missing field →" button (shown only when there are more fields after the current one).
   - "Skip this field" link (moves index forward without filling).
   - "Cancel guided save" link (dismisses the wizard, restores normal behaviour).

4. **Focus the field.** Call `frm.scroll_to_field(fieldname)` then `frm.get_field(fieldname).$input.focus()` with a 150 ms delay (to allow scroll animation to complete).

5. **Watch for field completion.** Attach a `change` listener on the current field's input. When the value becomes non-empty, advance `wizardState.index`. If more fields remain, update the banner and focus the next field. If all fields are filled, auto-dismiss the banner and call `_originalSave.apply(frm, args)`.

6. **"Next missing field →" button handler.** Re-run step 5's advance logic immediately, even if the current field is still empty (for cases where the user filled a field outside the wizard's focus).

7. **Progress indicator.** Use a slim `<progress>` element (`class="adhd-wizard-progress"`) above the banner title showing `index / total`. Update it as each field is completed.

8. **CSS in `adhd_mode.scss`:**
   - `.adhd-wizard-banner` — `background: var(--yellow-highlight, #fffbe6); border-left: 4px solid var(--yellow-500); padding: 10px 16px; border-radius: 4px; margin-bottom: 8px;`
   - `.adhd-wizard-hint` — `color: var(--text-muted); font-size: 0.85rem; margin-top: 4px;`
   - `.adhd-wizard-progress` — `width: 100%; height: 4px; accent-color: var(--primary);`

9. **Cleanup.** On wizard cancel or completion, remove the `.adhd-wizard-banner` element and detach all change listeners to avoid memory leaks. Use a named function so `removeEventListener` works cleanly.

10. **Guard behind ADHD mode.** The interceptor returns immediately to normal flow if `!frappe.boot.adhd_mode`.

## How to Test

1. Enable ADHD mode. Open a new Sales Invoice form. Do not fill in "Customer" or "Posting Date". Click Save.
2. Confirm the standard red error list does **not** appear. Instead confirm the ADHD wizard banner appears at the top of the form.
3. Confirm the banner reads something like "Let's fill in the missing details — 1 of 2" and focuses the "Customer" field (first missing mandatory field).
4. Confirm a plain-English hint is displayed beneath the field name.
5. Type a customer name and select from the autocomplete. Confirm the wizard automatically advances to the next missing field ("Posting Date") without requiring a button click.
6. Fill in the Posting Date. Confirm the wizard banner disappears and the document saves automatically.
7. Open a new Expense Claim. Leave "Employee" and "Expense Claim Type" blank. Click Save. Confirm guided save activates. Click "Next missing field →" without filling in "Employee". Confirm the wizard jumps to the next field.
8. Click "Cancel guided save". Confirm the banner dismisses and the standard save behaviour resumes (including the normal red mandatory error on next save attempt).
9. Disable ADHD mode. Attempt the same incomplete save. Confirm the standard red mandatory error list appears as normal.

## Acceptance Criteria
- [ ] Attempting to save a form with missing mandatory fields in ADHD mode activates guided save mode instead of showing the default red error list.
- [ ] The wizard banner shows the current field index and total count (e.g., "1 of 3").
- [ ] Each missing field receives keyboard focus and the form scrolls to it.
- [ ] A plain-English hint is displayed for every field that has an entry in `FIELD_HELP`; the field label is shown as fallback.
- [ ] Filling a focused field automatically advances the wizard to the next missing field.
- [ ] A progress indicator updates as fields are completed.
- [ ] When all missing fields are filled, the banner dismisses and save triggers automatically.
- [ ] "Skip this field" advances the wizard without filling the current field.
- [ ] "Cancel guided save" dismisses the wizard cleanly without side effects.
- [ ] Guided save is completely absent (falls back to default behaviour) when ADHD mode is disabled.
- [ ] No memory leaks: event listeners are removed after wizard completes or is cancelled.

## Dependencies
- **Blocked by:** `form_focus.js` FIELD_HELP dict (shipped); ADHD mode toggle (Phase 1, shipped)
- **Enhanced by:** ADHD-010 (Field Help Coverage expansion) — not a hard blocker
- **Blocks:** None

## Complexity
S — Client-side only; no new server endpoints; hooks into an existing Frappe prototype method with a clear intercept point.

## Phase
Phase 2 — Core Workflow Clarity
