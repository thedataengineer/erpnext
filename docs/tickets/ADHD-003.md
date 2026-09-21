# ADHD-003: Mandatory Field Wizard — Guided Save

## Current implementation record

- **Status:** Implemented.
- **Implementation:** `erpnext/public/js/adhd/adhd_form_wizard.js`, imported by the bundle.
- **Verification:** `node --test erpnext/tests/adhd_form_wizard.test.js`; browser behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

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

---

## LLM Implementation Guide

### Codebase Context for the Model

```text
Project: ERPNext (Frappe framework), JavaScript frontend + Python backend.
Key patterns:
- All client scripts use `frappe.ui.form.on("DocType", { hook(frm) {} })`.
- ADHD mode is active when `frappe.boot.adhd_mode === true`.
- `frappe.call({ method, args, callback })` is the standard async API call.
- `frappe.model.add_child(frm.doc, childDoctype, fieldname)` adds child table rows.
- `frm.refresh_field(fieldname)` syncs model → DOM for a field.
- `localStorage.setItem / getItem / removeItem` is used for client-side persistence.
- All JS files are included via `hooks.py` under `app_include_js` or `doctype_js`.
- CSS lives in `erpnext/public/scss/adhd_mode.scss` using CSS custom properties (vars).
- Python whitelisted methods use `@frappe.whitelist()` and are called via dotted module path.
- frappe.db.get_list / frappe.client.get_list return arrays of dicts.
- Frappe dialogs: `new frappe.ui.Dialog({ title, fields, primary_action })`.
```

---

### Single-prompt implementation (S ticket)

This ticket is simple enough for a single prompt. One JS file, no backend changes.

---

### Prompt for Claude (Anthropic)

```text
I'm building ADHD-003 "Mandatory Field Wizard — Guided Save" for ERPNext. The feature intercepts a save attempt, finds missing required fields, focuses them one at a time, and auto-saves when all are filled.

Codebase context:
- ERPNext on Frappe. ADHD mode: `frappe.boot.adhd_mode === true`.
- `frappe.validated` is set to `false` client-side to cancel a save from a `validate` hook.
- `frm.scroll_to_field(fieldname)` scrolls to and focuses a field.
- `frm.get_field(fieldname)` returns the field object; `.df.reqd` is truthy if required.
- `frm.doc[fieldname]` is the current value (falsy if empty).
- `FIELD_HELP` dict in `form_focus.js` maps fieldname → helpful hint string (assume it already exists as `window.ADHD_FIELD_HELP`).
- `frm.save()` triggers a save programmatically.
- Client hook for save interception: `frappe.ui.form.on("*", { validate(frm) {} })` — the wildcard `"*"` catches all doctypes.

Single file to create: `erpnext/public/js/adhd/adhd_form_wizard.js`.

Please implement:

1. **`getMissingRequiredFields(frm)`** — returns an array of fieldnames where `frm.get_field(f).df.reqd && !frm.doc[f]`. Skip hidden fields and child table fields.

2. **`focusNextMissingField(frm, fields, index)`** — scrolls to `fields[index]`, shows a floating banner `<div class="adhd-field-wizard-banner">` near the field with:
   - The field label.
   - A hint from `window.ADHD_FIELD_HELP[fieldname]` (or generic "This field is required").
   - Text: "Missing field X of Y".
   - A "Next missing field →" button that calls `focusNextMissingField(frm, fields, index + 1)`.
   - A "Skip for now" button that dismisses the banner.

3. **Validate hook on wildcard**: `frappe.ui.form.on("*", { validate(frm) { ... } })`:
   - Guard: `if (!frappe.boot.adhd_mode) return;`
   - Call `getMissingRequiredFields(frm)`.
   - If missing fields exist: set `frappe.validated = false`, call `focusNextMissingField(frm, missingFields, 0)`.
   - Add a one-time `after_save` hook that, when all required fields are now filled, removes the banner.

4. **Auto-save**: when the user fills the last required field and clicks "Next →" (which finds no more missing fields), automatically call `frm.save()`.

5. **CSS** (add to `adhd_mode.scss`): `.adhd-field-wizard-banner` — positioned absolutely near the active field, z-index above form, with a close (×) button.

Also add `adhd_form_wizard.js` to `hooks.py` → `app_include_js`.

Think through: how do you position the banner near the focused field without knowing its exact DOM position ahead of time? Use `$(frm.get_field(fieldname).wrapper).offset()` as the anchor.

Verify before finishing:
- [ ] `getMissingRequiredFields` skips hidden and child-table fields
- [ ] Banner shows "Missing field X of Y" with correct count
- [ ] "Next missing field →" advances to the next field
- [ ] Auto-save fires when last missing field is filled
- [ ] Feature is inert when `frappe.boot.adhd_mode !== true`
- [ ] `adhd_form_wizard.js` in hooks.py
```

---

### Prompt for GPT-4o (OpenAI)

```text
## Task
Implement ADHD-003: Mandatory Field Wizard — Guided Save for ERPNext/Frappe.

## Codebase Context
- Frappe validate hook: `frappe.ui.form.on("*", { validate(frm) {} })` — wildcard catches all doctypes.
- Cancel save: set `frappe.validated = false` inside the validate hook.
- Field access: `frm.get_field(fieldname)` → `.df.reqd`, `.df.hidden`, `.df.fieldtype`.
- Current value: `frm.doc[fieldname]`.
- Scroll + focus: `frm.scroll_to_field(fieldname)`.
- Field hints: `window.ADHD_FIELD_HELP[fieldname]` (string or undefined).
- Programmatic save: `frm.save()`.
- ADHD mode: `frappe.boot.adhd_mode === true`.

## File to Create
`erpnext/public/js/adhd/adhd_form_wizard.js`

## Implementation Requirements

### getMissingRequiredFields(frm)
- Iterate `frm.meta.fields` array.
- Include field if: `df.reqd === 1` AND `!frm.doc[df.fieldname]` AND `!df.hidden` AND `df.fieldtype !== "Table"`.
- Return array of fieldname strings.

### focusNextMissingField(frm, fields, index)
- If `index >= fields.length`: call `frm.save()` and return.
- Call `frm.scroll_to_field(fields[index])`.
- Remove any existing `.adhd-field-wizard-banner`.
- Inject `.adhd-field-wizard-banner` div anchored near `$(frm.get_field(fields[index]).wrapper)`.
- Banner content: field label, hint from `window.ADHD_FIELD_HELP`, "Field index+1 of fields.length", "Next →" button, "Skip" button.
- "Next →" click: call `focusNextMissingField(frm, fields, index + 1)`.
- "Skip" click: remove banner, do not save.

### Validate Hook
```js
frappe.ui.form.on("*", {
  validate(frm) {
    if (!frappe.boot.adhd_mode) return;
    const missing = getMissingRequiredFields(frm);
    if (missing.length) {
      frappe.validated = false;
      focusNextMissingField(frm, missing, 0);
    }
  }
});
```

### CSS addition to adhd_mode.scss
`.adhd-field-wizard-banner`: absolute position, box-shadow, z-index: 1000, close button.

## Acceptance Checklist
- [ ] getMissingRequiredFields skips hidden fields and Table fieldtype
- [ ] Banner shows "Field X of Y" with correct count
- [ ] "Next →" advances correctly; auto-saves when no more missing fields
- [ ] "Skip" dismisses banner without saving
- [ ] frappe.validated = false cancels the save
- [ ] ADHD guard present in validate hook
- [ ] CSS in adhd_mode.scss
- [ ] adhd_form_wizard.js in hooks.py
```

---

### Prompt for Gemini 1.5 Pro (Google)

```text
Implement ADHD-003: Mandatory Field Wizard — Guided Save for ERPNext. Follow each step.

## Context
- Frappe wildcard validate hook: `frappe.ui.form.on("*", { validate(frm) {} })`.
- Cancel save: `frappe.validated = false` inside validate.
- `frm.meta.fields` — array of field descriptors with `fieldname`, `reqd`, `hidden`, `fieldtype`, `label`.
- `frm.doc[fieldname]` — current field value.
- `frm.scroll_to_field(fieldname)` — scrolls to and focuses field.
- `window.ADHD_FIELD_HELP` — map of fieldname → hint string.
- `frm.save()` — triggers programmatic save.
- File: `erpnext/public/js/adhd/adhd_form_wizard.js`.

## Step-by-Step

### Step 1: Define `getMissingRequiredFields(frm)`
- Filter `frm.meta.fields` for: `df.reqd === 1` AND `!frm.doc[df.fieldname]` AND `!df.hidden` AND `df.fieldtype !== "Table"`.
- Return array of `df.fieldname` strings.

### Step 2: Define `focusNextMissingField(frm, fields, index)`
- If `index >= fields.length`: call `frm.save()` and `return`.
- Call `frm.scroll_to_field(fields[index])`.
- Remove any existing `$('.adhd-field-wizard-banner')`.
- Create banner HTML with: field label (`frm.get_field(fields[index]).df.label`), hint from `window.ADHD_FIELD_HELP[fields[index]] || "This field is required"`, count text `"Field ${index+1} of ${fields.length}"`.
- Add "Next missing field →" button: on click, call `focusNextMissingField(frm, fields, index + 1)`.
- Add "Skip for now" button: on click, remove banner.
- Append banner to `$(frm.get_field(fields[index]).wrapper)`.

### Step 3: Register Validate Hook
```js
frappe.ui.form.on("*", {
  validate(frm) {
    if (!frappe.boot.adhd_mode) return;
    const missing = getMissingRequiredFields(frm);
    if (missing.length) {
      frappe.validated = false;
      focusNextMissingField(frm, missing, 0);
    }
  }
});
```

### Step 4: CSS in `adhd_mode.scss`
Add `.adhd-field-wizard-banner` styles: position relative, border-left with `--adhd-warning` var, padding, background white, z-index 100.

### Step 5: Update `hooks.py`
Add `"erpnext/public/js/adhd/adhd_form_wizard.js"` to `app_include_js`.

## Verify Before Submitting
- [ ] getMissingRequiredFields skips hidden and Table fields
- [ ] Banner shows correct field count ("X of Y")
- [ ] Hint falls back to "This field is required" if ADHD_FIELD_HELP has no entry
- [ ] Auto-save fires when index >= fields.length
- [ ] Skip button removes banner without triggering save
- [ ] frappe.validated = false when missing fields found
- [ ] ADHD guard in validate hook
- [ ] adhd_form_wizard.js in hooks.py
```

---

### Self-Validation Prompt

```text
Review the ADHD-003 implementation and answer:

1. Does `getMissingRequiredFields` correctly exclude fields with `df.fieldtype === "Table"` and `df.hidden === 1`?
2. When the user clicks "Next →" on the last missing field, does the code call `frm.save()` rather than showing an error?
3. Is there a guard to remove any existing `.adhd-field-wizard-banner` before injecting a new one (preventing banner duplication)?
4. Does the banner display "Field X of Y" where X is 1-indexed (not 0-indexed)?
5. Is `frappe.validated = false` set before calling `focusNextMissingField` (ensuring the save is actually cancelled)?
6. Is the entire feature behind `if (!frappe.boot.adhd_mode) return;`?
7. Does the "Skip for now" button remove the banner WITHOUT triggering any save?
8. Is `adhd_form_wizard.js` added to `hooks.py`?

Fix any issues before delivering.
```
