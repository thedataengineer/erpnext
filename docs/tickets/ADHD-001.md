# ADHD-001: Workflow Wizard — Document Chain Navigator — DONE

## Summary
A persistent progress bar rendered on key transactional documents (Sales Order, Purchase Invoice, etc.) that shows every step in the document chain, marks completed steps, highlights the current one, and offers a pre-filled "Create Next Step" button — eliminating the cognitive load of remembering what comes next.

## Background / Context
ERPNext's document lifecycle (Quotation → Sales Order → Delivery Note → Sales Invoice → Payment Entry) requires the user to mentally track where they are in the chain, navigate away to create the next document, and manually re-enter fields that could be copied forward. For ADHD users, each navigation hop is a context-switch that burns working memory and risks losing the thread entirely. The friction is highest immediately after saving a document, when the next action is unclear and the temptation to "just check one more thing" is strong.

## Cognitive Mechanism
Working memory | attention switching | initiation

## Prerequisites
- Phase 1 ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and setting `adhd_mode` must be readable via `frappe.boot.adhd_mode` or equivalent.
- No other ticket prerequisites — this is the first Phase 2 deliverable.

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_chain_navigator.js`

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-chain-nav` styles
- `erpnext/hooks.py` — include `adhd_chain_navigator.js` in `app_include_js` (behind ADHD mode guard if bundled conditionally)

## What Needs to Be Done

1. **Define the chain map.** At the top of `adhd_chain_navigator.js`, export a `CHAIN_MAP` constant — a plain object keyed by doctype:
   ```js
   const CHAIN_MAP = {
     "Sales Order": [
       { label: "Quotation",       doctype: "Quotation",       link_field: "prevdoc_docname" },
       { label: "Sales Order",     doctype: "Sales Order",     link_field: null },          // current anchor
       { label: "Delivery Note",   doctype: "Delivery Note",   link_field: "against_sales_order" },
       { label: "Sales Invoice",   doctype: "Sales Invoice",   link_field: "sales_order" },
       { label: "Payment Entry",   doctype: "Payment Entry",   link_field: "reference_name" },
     ],
     "Purchase Order": [ /* analogous chain */ ],
     "Sales Invoice":  [ /* start from Sales Order */ ],
     "Purchase Invoice": [ /* start from Purchase Order */ ],
     "Purchase Receipt": [ /* start from Purchase Order */ ],
     "Delivery Note":  [ /* start from Sales Order */ ],
     "Payment Entry":  [ /* subset */ ],
   };
   ```

2. **Detect completion state per step.** Write `getStepStatus(doc, step)` which returns `"done" | "current" | "pending"`:
   - `"done"` — the linked document name field on the current doc is non-empty **and** the linked doc has `docstatus === 1`, verified via a lightweight `frappe.db.get_value` call (cached per page load).
   - `"current"` — the step's doctype matches `frm.doctype`.
   - `"pending"` — all other cases.

3. **Render the navigator bar.** Write `renderChainNav(frm)`:
   - Build a `<div class="adhd-chain-nav">` containing one `<span class="adhd-chain-step">` per step.
   - Each step span gets a class: `adhd-step--done`, `adhd-step--current`, or `adhd-step--pending`.
   - Done steps show a ✓ checkmark prefix. Current step is bold. Pending steps are muted.
   - Insert the bar using `frm.layout.add_view()` or, if unavailable, prepend to `$(frm.wrapper).find('.page-head')`.

4. **Add the "Create Next Step" button.** After determining the current step index, find the first `"pending"` step. Add a primary button `"Create Next Step → [Label]"` via `frm.add_custom_button`. On click:
   - Call `frappe.model.open_mapped_doc` with the appropriate mapping name (e.g., `"Sales Order-Delivery Note"`) **or** fall back to `frappe.new_doc(nextDoctype, prefillValues)` where `prefillValues` copies `customer`/`supplier`, `company`, `currency`, `items` array, and any other transferable scalar fields defined per chain step in `CHAIN_MAP`.
   - Pass a `freeze: true` argument to prevent double-clicks.

5. **Hook into `Form.after_save` and `Form.refresh`.** Register via:
   ```js
   frappe.ui.form.on("Sales Order", {
     after_save(frm) { renderChainNav(frm); },
     refresh(frm)    { renderChainNav(frm); },
   });
   ```
   Repeat for each doctype in `CHAIN_MAP`. Use a shared helper so the registration loop is a single `Object.keys(CHAIN_MAP).forEach(...)`.

6. **Guard behind ADHD mode.** At the top of every public function, check:
   ```js
   if (!frappe.boot.adhd_mode) return;
   ```

7. **CSS in `adhd_mode.scss`:**
   - `.adhd-chain-nav` — `display: flex; gap: 0.5rem; align-items: center; padding: 6px 12px; background: var(--fg-color); border-bottom: 1px solid var(--border-color); font-size: 0.8rem;`
   - `.adhd-step--done` — `color: var(--green-500); font-weight: 500;`
   - `.adhd-step--current` — `font-weight: 700; text-decoration: underline;`
   - `.adhd-step--pending` — `color: var(--text-muted);`
   - Arrow separator `›` between steps via CSS `::after` pseudo-element.

8. **Avoid duplicate renders.** Before inserting, check for an existing `.adhd-chain-nav` on the form wrapper and remove it first.

## How to Test

1. Open a fresh ERPNext desk. Confirm ADHD mode is enabled (User Settings → ADHD Mode → On).
2. Navigate to **Sales Order** list. Open any submitted Sales Order that has a linked Delivery Note.
3. Verify a horizontal step bar appears below the page header: `Quotation › [Sales Order] › Delivery Note › Sales Invoice › Payment Entry`.
4. Confirm the "Sales Order" step is bold and underlined; "Delivery Note" shows a ✓; "Sales Invoice" and "Payment Entry" are muted grey.
5. Click "Create Next Step → Sales Invoice". Confirm the new Sales Invoice form opens with `customer`, `company`, `currency`, and `items` pre-filled from the source Sales Order.
6. Save and submit the Sales Invoice. Return to the original Sales Order. Refresh. Confirm "Sales Invoice" now shows ✓.
7. Disable ADHD mode. Reload the same Sales Order. Confirm the navigator bar is absent.
8. Open a **Purchase Order** form. Confirm a separate correct chain renders (Purchase Order → Purchase Receipt → Purchase Invoice → Payment Entry).
9. Open a **Payment Entry** linked to a Sales Invoice. Confirm the bar renders with all prior steps marked ✓ and no "Create Next Step" button (no pending steps remain).

## Acceptance Criteria
- [x] Chain navigator bar appears on all seven doctypes listed in `CHAIN_MAP` when ADHD mode is active.
- [x] Completed steps (docstatus = 1 and link field populated) display a ✓ and the `adhd-step--done` style.
- [x] Current document step is visually distinct (bold + underline) with `adhd-step--current`.
- [x] Pending steps are rendered in muted colour with `adhd-step--pending`.
- [x] "Create Next Step" button appears when at least one pending step exists; it is absent when all steps are complete.
- [x] Clicking "Create Next Step" opens the correct next doctype with all transferable fields pre-filled (customer/supplier, company, currency, items).
- [x] Navigator bar is absent on all doctypes when ADHD mode is disabled.
- [x] No duplicate bars appear after multiple saves on the same form.
- [x] No JavaScript console errors on any of the seven target doctypes.

## Dependencies
- **Blocks:** ADHD-023 (Sales Order Interruption Restore), ADHD-031 (Bank Recon Progress Saver)
- **Blocked by:** None (Phase 1 ADHD mode toggle already shipped)

## Complexity
M — Multiple doctypes, async link-status checks, and field-mapping logic per chain step; no new server endpoints required.

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

### Prompt Chain (M ticket — 2 steps)

**Step 1 — Scaffold: CHAIN_MAP + DOM renderer**

```text
You are implementing ADHD-001 for ERPNext (Frappe framework). Your task in this step is to scaffold the file and render the chain navigation bar — do NOT wire up the "Create Next Step" button logic yet.

--- CODEBASE CONTEXT ---
Project: ERPNext (Frappe framework), JavaScript frontend + Python backend.
- All client scripts use `frappe.ui.form.on("DocType", { hook(frm) {} })`.
- ADHD mode guard: `if (!frappe.boot.adhd_mode) return;`
- CSS lives in `erpnext/public/scss/adhd_mode.scss` using CSS custom properties.
- JS files included via `hooks.py` → `app_include_js`.
- `frappe.model.open_mapped_doc({ method, frm })` opens a pre-filled child doc.
--- END CONTEXT ---

FILES TO CREATE/MODIFY:
1. CREATE `erpnext/public/js/adhd/adhd_chain_navigator.js`
2. MODIFY `erpnext/public/scss/adhd_mode.scss` — add `.adhd-chain-nav` block
3. MODIFY `erpnext/hooks.py` — add `adhd_chain_navigator.js` to `app_include_js`

WHAT TO BUILD:
- At the top of the JS file, define `const CHAIN_MAP` — a plain object keyed by doctype. Include all 7 doctypes: "Quotation", "Sales Order", "Delivery Note", "Sales Invoice", "Payment Entry", "Purchase Order", "Purchase Invoice". Each entry is an array of step objects: `{ label, doctype, link_field }`.
- Define `function getStepStatus(doc, step)` — returns `"done"`, `"current"`, or `"pending"` based on whether the step's doctype matches `frm.doctype` and whether linked docs exist via `doc[step.link_field]`.
- Define `function renderChainNav(frm)` — injects a `<div class="adhd-chain-nav">` above `frm.layout.wrapper` with one `.adhd-chain-step` span per step, each with its status class applied.
- Register hooks for all 7 doctypes: on `refresh`, call `renderChainNav(frm)` only when `frappe.boot.adhd_mode === true`.
- In `adhd_mode.scss`, add `.adhd-chain-nav` styles: flex row, `.adhd-chain-step` with status-based border/background using ADHD CSS vars (`--adhd-success`, `--adhd-warning`, `--adhd-muted`).

Do NOT implement the "Create Next Step" button click handler yet — that is Step 2.
```

**Step 2 — Wire Logic: Create Next Step button + mapping**

```text
Continuing ADHD-001. The scaffold from Step 1 is in place: `adhd_chain_navigator.js` renders the `.adhd-chain-nav` bar with step statuses. Now wire the interactive logic.

--- CODEBASE CONTEXT ---
- `frappe.model.open_mapped_doc({ method: "erpnext.path.to.map_method", frm })` pre-fills and opens a new document.
- Each step in CHAIN_MAP may have an optional `map_method` string for ERPNext's standard mapping methods (e.g. `"erpnext.selling.doctype.sales_order.sales_order.make_delivery_note"`).
- `frappe.boot.adhd_mode === true` guards all ADHD features.
--- END CONTEXT ---

FILES TO MODIFY:
- `erpnext/public/js/adhd/adhd_chain_navigator.js` (from Step 1)

WHAT TO ADD:
- In `renderChainNav(frm)`, add a "Create Next Step →" button inside the `.adhd-chain-nav` div. The button should appear only when the current step is not the last step in the chain.
- On button click: look up the next pending step in CHAIN_MAP for `frm.doctype`, then call `frappe.model.open_mapped_doc({ method: step.map_method, frm })` to open the pre-filled document.
- If `step.map_method` is not defined, fall back to `frappe.new_doc(step.doctype)`.
- Ensure the button is disabled (not hidden) if the current doc is not yet saved (`frm.doc.__islocal`).

ACCEPTANCE CRITERIA — verify each before finishing:
- [ ] CHAIN_MAP covers all 7 doctypes: Quotation, Sales Order, Delivery Note, Sales Invoice, Payment Entry, Purchase Order, Purchase Invoice.
- [ ] `getStepStatus(doc, step)` correctly returns "done", "current", or "pending".
- [ ] `renderChainNav(frm)` injects `.adhd-chain-nav` above the form layout.
- [ ] "Create Next Step" button calls `frappe.model.open_mapped_doc` with the correct map_method.
- [ ] All 7 doctype hooks registered in the same file.
- [ ] Feature is completely inert when `frappe.boot.adhd_mode !== true`.
- [ ] `.adhd-chain-nav` and `.adhd-chain-step` CSS classes defined in `adhd_mode.scss`.
- [ ] `adhd_chain_navigator.js` is listed in `hooks.py` → `app_include_js`.
```

---

### Prompt for Claude (Anthropic)

```text
I'm building an ADHD-friendly feature for ERPNext called the "Document Chain Navigator" (ticket ADHD-001). I need your help writing the full implementation across three files.

Here's the codebase context you need:
- ERPNext runs on the Frappe framework. Client scripts use `frappe.ui.form.on("DocType", { hook(frm) {} })`.
- ADHD mode guard: `if (!frappe.boot.adhd_mode) return;`
- `frappe.model.open_mapped_doc({ method, frm })` opens a pre-filled next document.
- CSS lives in `erpnext/public/scss/adhd_mode.scss` using CSS custom properties like `--adhd-success`, `--adhd-warning`, `--adhd-muted`.
- JS included via `hooks.py` → `app_include_js`.

What I need you to build:

**File 1: `erpnext/public/js/adhd/adhd_chain_navigator.js`**
- A `CHAIN_MAP` constant covering 7 doctypes: Quotation, Sales Order, Delivery Note, Sales Invoice, Payment Entry, Purchase Order, Purchase Invoice. Each step has `{ label, doctype, link_field, map_method }`.
- `getStepStatus(doc, step)` → returns "done", "current", or "pending".
- `renderChainNav(frm)` → injects a `<div class="adhd-chain-nav">` above `frm.layout.wrapper` with one `.adhd-chain-step` per step and a "Create Next Step →" button.
- The button calls `frappe.model.open_mapped_doc` with the appropriate `map_method`, or falls back to `frappe.new_doc(step.doctype)`. Button is disabled if `frm.doc.__islocal`.
- Register `refresh` hooks for all 7 doctypes.

**File 2: `erpnext/public/scss/adhd_mode.scss` (additions only)**
- `.adhd-chain-nav`: flex row, gap, padding.
- `.adhd-chain-step`: status classes `.done`, `.current`, `.pending` using `--adhd-success`, `--adhd-warning`, `--adhd-muted` CSS vars.

**File 3: `erpnext/hooks.py` (addition only)**
- Add `adhd_chain_navigator.js` to the `app_include_js` list.

Think through the `getStepStatus` logic carefully — a step is "done" if it's before the current doctype in the chain, "current" if it matches `frm.doctype`, and "pending" otherwise.

Before finishing, verify:
- [ ] CHAIN_MAP covers all 7 doctypes
- [ ] `getStepStatus` returns correct values for done/current/pending
- [ ] Button is disabled (not hidden) on unsaved docs
- [ ] Feature is inert when `frappe.boot.adhd_mode !== true`
- [ ] CSS classes defined in `adhd_mode.scss`
- [ ] `hooks.py` updated
```

---

### Prompt for GPT-4o (OpenAI)

```text
## Task
Implement ADHD-001: Document Chain Navigator for ERPNext/Frappe.

## Codebase Context
- Framework: ERPNext on Frappe. Client scripts: `frappe.ui.form.on("DocType", { hook(frm) {} })`.
- ADHD mode check: `frappe.boot.adhd_mode === true`.
- Map docs: `frappe.model.open_mapped_doc({ method: "dotted.path.method", frm })`.
- CSS: `erpnext/public/scss/adhd_mode.scss`, uses CSS vars `--adhd-success`, `--adhd-warning`, `--adhd-muted`.
- JS inclusion: `hooks.py` → `app_include_js` list.

## Files to Create/Modify
1. **CREATE** `erpnext/public/js/adhd/adhd_chain_navigator.js`
2. **MODIFY** `erpnext/public/scss/adhd_mode.scss` — append `.adhd-chain-nav` styles
3. **MODIFY** `erpnext/hooks.py` — append to `app_include_js`

## Implementation Requirements

### CHAIN_MAP constant
Plain JS object keyed by doctype. Cover all 7: Quotation, Sales Order, Delivery Note, Sales Invoice, Payment Entry, Purchase Order, Purchase Invoice. Each step: `{ label, doctype, link_field, map_method }`.

### getStepStatus(doc, step)
Returns `"done"` | `"current"` | `"pending"`. Logic: step index < current index → done; step index === current index → current; otherwise → pending.

### renderChainNav(frm)
- Inject `<div class="adhd-chain-nav">` above `frm.layout.wrapper`.
- Render one `.adhd-chain-step` span per step with status class.
- Add "Create Next Step →" button; on click: `frappe.model.open_mapped_doc` or `frappe.new_doc` fallback.
- Disable button if `frm.doc.__islocal === true`.

### Hooks
Register `refresh` event on all 7 doctypes. Guard with `if (!frappe.boot.adhd_mode) return;`.

## Acceptance Checklist
- [ ] CHAIN_MAP has all 7 doctypes
- [ ] getStepStatus returns correct status values
- [ ] renderChainNav injects `.adhd-chain-nav` above form wrapper
- [ ] "Create Next Step" uses open_mapped_doc with correct method
- [ ] Button disabled on unsaved docs (`frm.doc.__islocal`)
- [ ] All 7 refresh hooks registered
- [ ] Feature fully inert when ADHD mode is off
- [ ] `.adhd-chain-nav` + `.adhd-chain-step` CSS in adhd_mode.scss
- [ ] hooks.py updated with new JS file
```

---

### Prompt for Gemini 1.5 Pro (Google)

```text
You are implementing ticket ADHD-001 (Document Chain Navigator) for ERPNext. Follow these steps exactly.

## Context
- ERPNext uses Frappe framework. Client JS: `frappe.ui.form.on("DocType", { refresh(frm) {} })`.
- ADHD guard: `if (!frappe.boot.adhd_mode) return;` at top of every handler.
- `frappe.model.open_mapped_doc({ method, frm })` opens a mapped/pre-filled document.
- CSS file: `erpnext/public/scss/adhd_mode.scss`. CSS vars available: `--adhd-success`, `--adhd-warning`, `--adhd-muted`.
- JS files registered in `erpnext/hooks.py` under `app_include_js`.

## Step-by-Step Implementation

### Step 1 — Create `erpnext/public/js/adhd/adhd_chain_navigator.js`
1. Define `const CHAIN_MAP` covering 7 doctypes: Quotation, Sales Order, Delivery Note, Sales Invoice, Payment Entry, Purchase Order, Purchase Invoice. Each step: `{ label, doctype, link_field, map_method }`.
2. Define `function getStepStatus(frm, step, stepIndex, currentIndex)` returning `"done"`, `"current"`, or `"pending"`.
3. Define `function renderChainNav(frm)`:
   - Find the chain for `frm.doctype` in CHAIN_MAP; if none, return early.
   - Remove any existing `.adhd-chain-nav` to avoid duplicates.
   - Build HTML: one `.adhd-chain-step[data-status]` span per step.
   - Append "Create Next Step →" `<button class="btn btn-xs btn-primary adhd-chain-btn">`.
   - Insert the nav div before `$(frm.layout.wrapper).find('.form-page')`.
   - Wire button click: call `frappe.model.open_mapped_doc` with the next step's `map_method`. Fallback: `frappe.new_doc(nextStep.doctype)`. Disable if `frm.doc.__islocal`.
4. Register `frappe.ui.form.on(doctype, { refresh(frm) { if (!frappe.boot.adhd_mode) return; renderChainNav(frm); } })` for all 7 doctypes.

### Step 2 — Append to `erpnext/public/scss/adhd_mode.scss`
Add styles for `.adhd-chain-nav` (display:flex, gap, padding) and `.adhd-chain-step` with modifier classes `.done`, `.current`, `.pending` referencing CSS vars.

### Step 3 — Update `erpnext/hooks.py`
Add `"erpnext/public/js/adhd/adhd_chain_navigator.js"` to the `app_include_js` list.

## Verify Before Submitting
- [ ] CHAIN_MAP covers all 7 doctypes
- [ ] getStepStatus returns "done"/"current"/"pending" correctly
- [ ] renderChainNav removes existing nav before re-rendering
- [ ] Button disabled when `frm.doc.__islocal`
- [ ] open_mapped_doc called with correct method string
- [ ] All 7 doctype hooks registered
- [ ] ADHD guard present in every hook handler
- [ ] CSS classes added to adhd_mode.scss
- [ ] hooks.py updated
```

---

### Self-Validation Prompt

```text
Review the ADHD-001 implementation you just wrote and answer each question:

1. Does CHAIN_MAP include entries for all 7 doctypes: Quotation, Sales Order, Delivery Note, Sales Invoice, Payment Entry, Purchase Order, Purchase Invoice?
2. Does `getStepStatus` correctly handle the case where `frm.doctype` is the last step in a chain (no "Create Next Step" should appear)?
3. Is there a guard against duplicate `.adhd-chain-nav` divs being injected on repeated `refresh` calls?
4. Is the "Create Next Step" button disabled (not hidden) when `frm.doc.__islocal === true`?
5. Does the CSS in `adhd_mode.scss` use CSS custom properties (`--adhd-*`) rather than hard-coded colors?
6. Is the entire feature completely inert (no DOM changes, no errors) when `frappe.boot.adhd_mode` is falsy?
7. Is `adhd_chain_navigator.js` added to `app_include_js` in `hooks.py`?

Fix any issues found before delivering the final code.
```
