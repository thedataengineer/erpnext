# ADHD-024: Installation Note Checklist

## Current implementation record

- **Status:** Implemented (2026-09-21). See `docs/adhd_mode_features.md` for where it lives and how it differs from this ticket.
- **Implementation:** No matching implementation or bundle registration exists on `iteration_3`.
- **Verification:** No implementation test exists; original acceptance criteria remain pending.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Injects a "Confirmed installed?" checkbox column into the Installation Note items grid when ADHD mode is active, converting a blank, ambiguous form into a concrete, completable checklist that confirms each item has been physically installed.

## Background / Context
An Installation Note is created from a Delivery Note to record that delivered items have been installed at the customer site. The default form shows the same sparse items grid as the Delivery Note — serial numbers, quantities — with no indication of which items still need action. For ADHD users, an undifferentiated list of rows with no checkboxes creates "completion uncertainty": it is impossible to feel done because there is no visual signal of progress or remaining work. A simple per-row checkbox resolves this immediately.

## Cognitive Mechanism
Initiation | working memory | attention switching

## Prerequisites
- ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` readable on the client.

## Scope
**Create:**
- `erpnext/selling/doctype/installation_note/adhd_installation_note.js`

## What Needs to Be Done

1. **Create `adhd_installation_note.js` and guard behind ADHD mode:**
   ```js
   frappe.ui.form.on("Installation Note", {
     after_load(frm) {
       if (!frappe.boot.adhd_mode) return;
       injectInstalledCheckboxColumn(frm);
     },
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       injectInstalledCheckboxColumn(frm);
     },
   });
   ```

2. **Implement `injectInstalledCheckboxColumn(frm)`.** Use `grid.add_custom_column` — the Frappe API for injecting a column into an existing child-table grid without modifying the DocType definition:
   ```js
   function injectInstalledCheckboxColumn(frm) {
     const grid = frm.fields_dict.items && frm.fields_dict.items.grid;
     if (!grid) return;

     // Avoid duplicate injection
     const existingColumns = grid.get_columns ? grid.get_columns() : [];
     if (existingColumns.some(c => c.fieldname === "adhd_confirmed_installed")) return;

     grid.add_custom_column({
       fieldname: "adhd_confirmed_installed",
       fieldtype: "Check",
       label:     "Confirmed Installed?",
       width:     120,
       // in_list_view: 1 ensures the column is visible in the grid view
       in_list_view: 1,
     });

     grid.refresh();
   }
   ```
   Note: `add_custom_column` is a client-side-only column. Its value is **not** persisted to the database — it exists purely as a session-state checklist aid. If server-side persistence is required in a future ticket, a DocType customisation adding a `Check` field to `Installation Note Item` would be needed. Document this limitation in a code comment.

3. **Visual confirmation on all-checked state.** After the grid renders, attach a `change` listener to checkboxes to detect when all rows are checked:
   ```js
   function attachCompletionListener(frm) {
     const grid = frm.fields_dict.items && frm.fields_dict.items.grid;
     if (!grid || !grid.wrapper) return;

     $(grid.wrapper).on("change", "input[data-fieldname='adhd_confirmed_installed']", () => {
       const total   = (frm.doc.items || []).length;
       const checked = $(grid.wrapper)
         .find("input[data-fieldname='adhd_confirmed_installed']:checked").length;

       if (total > 0 && checked === total) {
         showInstallationCompleteToast();
       }
     });
   }

   function showInstallationCompleteToast() {
     frappe.show_alert({
       message: "✅ All items confirmed installed!",
       indicator: "green",
     }, 5);
   }
   ```
   Call `attachCompletionListener(frm)` after `injectInstalledCheckboxColumn(frm)` in both `after_load` and `refresh` handlers.

4. **Add a "X / Y installed" progress counter** above the grid. Render a small status line that updates dynamically:
   ```js
   function renderProgressCounter(frm) {
     // Remove existing counter
     $(frm.wrapper).find(".adhd-install-progress").remove();

     const total = (frm.doc.items || []).length;
     if (total === 0) return;

     const counter = $(`
       <div class="adhd-install-progress">
         <span class="adhd-install-count">0 / ${total} installed</span>
       </div>
     `);

     // Insert above the items grid
     const gridWrapper = $(frm.fields_dict.items.grid.wrapper);
     counter.insertBefore(gridWrapper);

     // Update count on checkbox change
     $(frm.fields_dict.items.grid.wrapper).on(
       "change",
       "input[data-fieldname='adhd_confirmed_installed']",
       () => {
         const checked = $(frm.fields_dict.items.grid.wrapper)
           .find("input[data-fieldname='adhd_confirmed_installed']:checked").length;
         counter.find(".adhd-install-count").text(`${checked} / ${total} installed`);
       }
     );
   }
   ```
   Call `renderProgressCounter(frm)` in both event handlers, after `injectInstalledCheckboxColumn`.

5. **CSS in `adhd_mode.scss`:**
   - `.adhd-install-progress` — `padding: 4px 8px; font-size: 0.8rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.5rem;`
   - `.adhd-install-count` — `font-weight: 600;`

6. **Include in `hooks.py`** under `app_include_js`.

## How to Test

1. Enable ADHD mode. Navigate to **Selling → Delivery Notes**. Open a submitted Delivery Note.
2. Click **Make → Installation Note**. Confirm the Installation Note form opens pre-filled from the Delivery Note.
3. Look at the `items` child-table grid. Confirm a new column "Confirmed Installed?" with checkboxes appears as the last column. Confirm all other standard columns (item code, serial no, qty) are still present and correctly ordered.
4. Confirm a "0 / N installed" counter appears above the items grid.
5. Check the first row's checkbox. Confirm the counter updates to "1 / N installed".
6. Check all rows. Confirm a green toast appears: "✅ All items confirmed installed!"
7. Save the Installation Note. Reload the form. Confirm the checkbox column is still present (re-injected on refresh). Note: checkbox values will not be persisted to the server (document this to the tester).
8. Open an Installation Note when ADHD mode is disabled. Confirm no "Confirmed Installed?" column appears and no progress counter is shown.
9. Create an Installation Note manually (not from a Delivery Note) with no items. Confirm no progress counter appears (total = 0 guard) and no JS errors.
10. Confirm no duplicate checkbox columns appear after multiple form refreshes.

## Acceptance Criteria
- [ ] A "Confirmed Installed?" checkbox column appears in the Installation Note `items` grid when ADHD mode is active.
- [ ] Standard grid columns (item code, item name, serial no, qty, uom) remain visible and correctly ordered.
- [ ] A "X / N installed" counter appears above the items grid and updates in real time as checkboxes are toggled.
- [ ] A green success toast fires when all row checkboxes are checked.
- [ ] No duplicate checkbox columns appear after multiple saves or form refreshes.
- [ ] The checkbox column is absent when ADHD mode is disabled.
- [ ] No JavaScript console errors on the Installation Note form in any of the above states.

## Dependencies
- **Blocked by:** ADHD mode toggle (shipped)
- **Blocks:** None

## Complexity
S — Single form script, client-side grid column injection, no server endpoint, no DocType modification.

## Phase
Phase 7 — Module-by-Module Expansion
