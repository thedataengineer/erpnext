# ADHD-033: Cost Center & Accounting Dimension "Last Used" Pre-fill

## Summary
When ADHD mode is active, automatically pre-fill `cost_center` and all active Accounting Dimension fields on new documents with the user's last-used values — eliminating the repetitive lookup that forces ADHD users to re-navigate the same dropdown on every new document.

## Background / Context
ERPNext requires users to manually select a Cost Center and any configured Accounting Dimensions (e.g., Project, Department, Branch) on virtually every accounting document. For ADHD users who work mostly within a single cost center or project, re-entering the same values dozens of times per day creates low-value repetitive friction that interrupts flow and risks omission errors. The friction occurs on any form that contains a `cost_center` field: Journal Entry, Payment Entry, Purchase Invoice, Sales Invoice, Expense Claim, and more.

## Cognitive Mechanism
Initiation | working memory

## Prerequisites
- ADHD-011 (`public/js/adhd/adhd_accounts.js` — must already exist from ADHD-011 so this ticket adds to it rather than creating a competing file).
- ADHD-016 (ADHD Settings Panel — provides the "Clear defaults" UI entry point).

## Scope
**Modify:**
- `erpnext/public/js/adhd/adhd_accounts.js` — add the cost center / dimension pre-fill logic to the existing module.

**No new files created** (per prerequisites, `adhd_accounts.js` is created by ADHD-011).

## What Needs to Be Done

1. **Detect active Accounting Dimensions.** On first load, fetch the list of active Accounting Dimension field names once per session:
   ```js
   let _adhdDimensions = null;   // cached list of fieldnames

   async function getActiveDimensions() {
     if (_adhdDimensions) return _adhdDimensions;
     const res = await frappe.db.get_list("Accounting Dimension", {
       filters: [["disabled", "=", 0]],
       fields: ["fieldname"],
       limit: 50,
     });
     _adhdDimensions = res.map(d => d.fieldname);
     return _adhdDimensions;
   }
   ```

2. **Pre-fill on form load.** Register a global `after_load` hook that fires for every form:
   ```js
   $(document).on("form-load form-refresh", function (e, frm) {
     if (!frappe.boot.adhd_mode) return;
     if (!frm || frm.doc.docstatus !== 0 || !frm.is_new()) return;
     prefillLastUsed(frm);
   });
   ```
   Only fire for new (unsaved) documents (`frm.is_new()` returns truthy). Skip if the document already has values set (e.g., pre-filled from a mapping).

3. **`prefillLastUsed(frm)`.** For each field to pre-fill:
   - Check `frm.fields_dict.hasOwnProperty(fieldname)` — skip if the form doesn't have this field.
   - Check `frm.doc[fieldname]` is blank/null — do not overwrite an already-set value.
   - Read from `localStorage.getItem("adhd_last_" + fieldname)`.
   - If a value exists, call `frm.set_value(fieldname, value)`.
   - After setting, add a `::after` label via a helper (see step 5).
   ```js
   async function prefillLastUsed(frm) {
     const dims = await getActiveDimensions();
     const fields = ["cost_center", ...dims];
     fields.forEach(fieldname => {
       if (!frm.fields_dict[fieldname]) return;
       if (frm.doc[fieldname]) return;  // already has value
       const last = localStorage.getItem(`adhd_last_${fieldname}`);
       if (!last) return;
       frm.set_value(fieldname, last).then(() => {
         markAsLastUsed(frm, fieldname);
       });
     });
   }
   ```

4. **Save last-used values on submit.** Hook into `frappe.ui.form.on` generically using `doctype: "*"` is not supported; instead, patch `frappe.Form.prototype.save`:
   ```js
   const _origSave = frappe.Form.prototype.save;
   frappe.Form.prototype.save = async function (...args) {
     const result = await _origSave.apply(this, args);
     if (frappe.boot.adhd_mode && this.doc.docstatus === 1) {
       saveLastUsed(this);
     }
     return result;
   };

   async function saveLastUsed(frm) {
     const dims = await getActiveDimensions();
     const fields = ["cost_center", ...dims];
     fields.forEach(fieldname => {
       const val = frm.doc[fieldname];
       if (val) localStorage.setItem(`adhd_last_${fieldname}`, val);
     });
   }
   ```
   Note: save on `docstatus === 1` (submit) to capture confirmed choices. Also save on `docstatus === 0` saves by checking that `frm.doc.__unsaved === 0` after save — use `frm.after_save` event as an alternative approach if prototype patching proves fragile.

5. **"← last used" visual label.** `markAsLastUsed(frm, fieldname)`:
   ```js
   function markAsLastUsed(frm, fieldname) {
     const $wrapper = $(frm.fields_dict[fieldname]?.wrapper);
     if (!$wrapper.length) return;
     $wrapper.find(".adhd-last-used-tag").remove();  // idempotent
     $wrapper.append(
       `<span class="adhd-last-used-tag" style="
         font-size:0.65rem; color:var(--text-muted);
         position:absolute; right:4px; bottom:2px;
         pointer-events:none;">← last used</span>`
     );
     $wrapper.css("position", "relative");
     // Remove the tag when user changes the value
     frm.fields_dict[fieldname].$input?.one("change", () => {
       $wrapper.find(".adhd-last-used-tag").remove();
     });
   }
   ```

6. **"Clear defaults" entry point (ADHD-016 integration).** Expose a globally-callable function:
   ```js
   window.adhdClearLastUsedDefaults = async function () {
     const dims = await getActiveDimensions();
     ["cost_center", ...dims].forEach(fn => localStorage.removeItem(`adhd_last_${fn}`));
     frappe.show_alert({ message: "ADHD cost center & dimension defaults cleared.", indicator: "blue" });
   };
   ```
   ADHD-016 settings panel calls `window.adhdClearLastUsedDefaults()` via its "Clear defaults" button.

7. **Guard: do not pre-fill on child tables or non-accounting forms.** Add a check — if `frm.meta.istable === 1` return early.

## How to Test

1. Open ERPNext with ADHD mode enabled.
2. Open a new **Journal Entry**. Confirm `cost_center` is blank (no prior saved state).
3. Set `cost_center` to "Main - COMP", fill in other required fields, and submit the document.
4. Open a new **Journal Entry** again. Confirm `cost_center` is pre-filled with "Main - COMP" and a small "← last used" label appears near the field.
5. Manually change `cost_center` to a different value. Confirm the "← last used" tag disappears immediately.
6. Open a new **Purchase Invoice** (a different doctype). Confirm `cost_center` is also pre-filled from the saved last-used value.
7. If an Accounting Dimension (e.g., "Project") is active, confirm it is also pre-filled on new documents after a prior submission where it was set.
8. Open an **existing submitted** document. Confirm its `cost_center` is not altered.
9. Navigate to ADHD Settings Panel (ADHD-016). Click "Clear defaults." Confirm a flash message appears. Open a new Journal Entry — confirm `cost_center` is now blank.
10. Disable ADHD mode. Open a new Journal Entry. Confirm no pre-fill occurs.

## Acceptance Criteria
- [ ] `cost_center` is pre-filled on all new documents where the field exists and no value is already set.
- [ ] All active Accounting Dimension fields are pre-filled in the same way.
- [ ] "← last used" label appears next to each pre-filled field and disappears when the user edits the value.
- [ ] Last-used values are updated in localStorage after each successful document save.
- [ ] Pre-fill does not overwrite values already set on the document (e.g., from a mapping or a prior workflow).
- [ ] Existing submitted documents are unaffected.
- [ ] "Clear defaults" function (`adhdClearLastUsedDefaults`) removes all stored values and shows a confirmation alert.
- [ ] No pre-fill occurs when ADHD mode is disabled.
- [ ] No JavaScript console errors on any accounting form.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD-011 (adhd_accounts.js file must exist); ADHD-016 (settings panel "Clear defaults" button must call `adhdClearLastUsedDefaults`).

## Complexity
S — Pure localStorage read/write with a single async dimension fetch; logic hooks into existing form lifecycle events with no server endpoints.

## Phase
Phase 7 — Module-by-Module Expansion
