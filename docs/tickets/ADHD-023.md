# ADHD-023: Sales Order Interruption Restore

## Summary
Auto-saves Sales Order and Quotation form state (including items, taxes, and sales team rows) to localStorage every 30 seconds when ADHD mode is active, and offers a "Resume it?" banner on the next visit so interrupted drafts are never silently lost.

## Background / Context
ADHD users are uniquely vulnerable to mid-task interruptions: a phone call, a browser crash, or a sudden context-switch can wipe out 20 minutes of Sales Order data entry before the user remembers to save. ERPNext does have server-side drafts, but only after the document has been saved once and given a server-side name. Untitled, unsaved forms — the most fragile state — have no recovery path. This ticket creates a client-side safety net that auto-snapshots field values and child-table rows into localStorage, then surfaces a one-click restore on the next form open.

## Cognitive Mechanism
Working memory | initiation | attention switching

## Prerequisites
- ADHD-002 (Smart Inbox Resume panel) must be shipped; the Resume panel's UI pattern is the model for the "resume it?" banner.
- ADHD-001 (chain navigator) must be shipped; `adhd_draft_recovery.js` must not conflict with the chain nav bar injected into the same form header area. Both can coexist if the draft-recovery banner sits above the chain nav or in a distinct wrapper.
- ADHD mode toggle must be shipped and `frappe.boot.adhd_mode` readable on the client.

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_draft_recovery.js`

**Modify:**
- `erpnext/public/js/adhd/adhd_smart_inbox.js` — import and call `checkAndOfferDraftRestore(frm)` from the Resume panel's form load hook so the two recovery surfaces share a single banner slot.

## What Needs to Be Done

1. **Define target doctypes and storage key schema.** At the top of `adhd_draft_recovery.js`:
   ```js
   const RECOVERY_DOCTYPES = ["Sales Order", "Quotation"];
   const storageKey = (doctype, name) => `adhd_draft_${doctype}_${name}`;
   // For new/unsaved docs, use a sentinel name
   const NEW_DOC_NAME = "__new__";
   ```

2. **Define which fields to snapshot.** Create a `SNAPSHOT_FIELDS` map per doctype:
   ```js
   const SNAPSHOT_FIELDS = {
     "Sales Order": {
       scalars: ["customer", "delivery_date", "po_no", "currency",
                 "selling_price_list", "company", "order_type"],
       childTables: ["items", "taxes", "sales_team"],
     },
     "Quotation": {
       scalars: ["quotation_to", "party_name", "transaction_date",
                 "valid_till", "currency", "selling_price_list", "company"],
       childTables: ["items", "taxes"],
     },
   };
   ```

3. **Implement the auto-save loop.** Write `startDraftAutosave(frm)`:
   ```js
   function startDraftAutosave(frm) {
     if (!frappe.boot.adhd_mode) return;
     if (!RECOVERY_DOCTYPES.includes(frm.doctype)) return;

     // Clear any existing interval on this form instance
     if (frm._adhd_autosave_interval) clearInterval(frm._adhd_autosave_interval);

     frm._adhd_autosave_interval = setInterval(() => {
       // Only snapshot Draft documents (docstatus === 0)
       if (frm.doc.docstatus !== 0) {
         clearInterval(frm._adhd_autosave_interval);
         return;
       }
       snapshotForm(frm);
     }, 30_000); // 30 seconds
   }
   ```

4. **Implement `snapshotForm(frm)`.** Captures scalar fields and child-table rows:
   ```js
   function snapshotForm(frm) {
     const config = SNAPSHOT_FIELDS[frm.doctype];
     if (!config) return;

     const snapshot = {
       doctype:   frm.doctype,
       savedAt:   new Date().toISOString(),
       docName:   frm.doc.name || NEW_DOC_NAME,
       scalars:   {},
       childTables: {},
     };

     config.scalars.forEach(field => {
       snapshot.scalars[field] = frm.doc[field];
     });

     config.childTables.forEach(table => {
       snapshot.childTables[table] = (frm.doc[table] || []).map(row => {
         // Shallow clone each row, dropping internal Frappe metadata keys
         const clean = {};
         Object.entries(row).forEach(([k, v]) => {
           if (!k.startsWith("_") && k !== "docstatus" && k !== "parent") {
             clean[k] = v;
           }
         });
         return clean;
       });
     });

     try {
       localStorage.setItem(
         storageKey(frm.doctype, snapshot.docName),
         JSON.stringify(snapshot)
       );
     } catch (e) {
       // localStorage quota exceeded — fail silently
       console.warn("[ADHD] Draft autosave failed (storage quota?):", e);
     }
   }
   ```

5. **Implement `checkAndOfferDraftRestore(frm)`.** Called on form load for new documents:
   ```js
   function checkAndOfferDraftRestore(frm) {
     if (!frappe.boot.adhd_mode) return;
     if (!RECOVERY_DOCTYPES.includes(frm.doctype)) return;
     if (!frm.doc.__islocal) return; // Only offer restore for brand-new forms

     const key = storageKey(frm.doctype, NEW_DOC_NAME);
     const raw = localStorage.getItem(key);
     if (!raw) return;

     let snapshot;
     try { snapshot = JSON.parse(raw); } catch { return; }

     const savedAt = new Date(snapshot.savedAt);
     const ageStr  = frappe.datetime.prettyDate(snapshot.savedAt); // e.g., "2 hours ago"

     showRestoreBanner(frm, snapshot, ageStr, key);
   }
   ```

6. **Implement `showRestoreBanner(frm, snapshot, ageStr, key)`.** Renders the banner with Restore and Discard actions:
   ```js
   function showRestoreBanner(frm, snapshot, ageStr, key) {
     // Remove any existing banner first
     $(frm.wrapper).find(".adhd-restore-banner").remove();

     const banner = $(`
       <div class="adhd-restore-banner">
         <span class="adhd-restore-text">
           📋 You have an unsaved ${snapshot.doctype} from ${ageStr}. Resume it?
         </span>
         <button class="btn btn-xs btn-primary adhd-restore-btn">Restore</button>
         <button class="btn btn-xs btn-default adhd-discard-btn">Discard</button>
       </div>
     `);

     banner.find(".adhd-restore-btn").on("click", () => {
       restoreDraft(frm, snapshot);
       localStorage.removeItem(key);
       banner.remove();
     });

     banner.find(".adhd-discard-btn").on("click", () => {
       localStorage.removeItem(key);
       banner.remove();
     });

     // Insert above the form layout, below the chain nav bar if present
     const target = $(frm.wrapper).find(".adhd-chain-nav").length
       ? $(frm.wrapper).find(".adhd-chain-nav")
       : $(frm.wrapper).find(".page-body .form-layout");
     banner.insertBefore(target.first());
   }
   ```

7. **Implement `restoreDraft(frm, snapshot)`.** Re-populates scalar fields and child tables:
   ```js
   function restoreDraft(frm, snapshot) {
     // Restore scalar fields
     Object.entries(snapshot.scalars || {}).forEach(([field, value]) => {
       if (value !== undefined && value !== null) {
         frappe.model.set_value(frm.doctype, frm.doc.name, field, value);
       }
     });

     // Restore child table rows
     Object.entries(snapshot.childTables || {}).forEach(([table, rows]) => {
       // Clear existing rows
       frm.doc[table] = [];
       frm.fields_dict[table] && frm.fields_dict[table].grid.df.fields && rows.forEach(rowData => {
         const newRow = frappe.model.add_child(frm.doc, table);
         Object.entries(rowData).forEach(([k, v]) => { newRow[k] = v; });
       });
     });

     frm.refresh();
     frappe.show_alert({ message: `${snapshot.doctype} draft restored.`, indicator: "green" });
   }
   ```

8. **Hook into form events.** At the bottom of `adhd_draft_recovery.js`, register for each target doctype:
   ```js
   RECOVERY_DOCTYPES.forEach(doctype => {
     frappe.ui.form.on(doctype, {
       after_load(frm) {
         startDraftAutosave(frm);
         checkAndOfferDraftRestore(frm);
       },
       after_save(frm) {
         // Once saved, remove the __new__ draft (now has a server name)
         localStorage.removeItem(storageKey(frm.doctype, NEW_DOC_NAME));
       },
       on_submit(frm) {
         clearInterval(frm._adhd_autosave_interval);
         localStorage.removeItem(storageKey(frm.doctype, frm.doc.name));
       },
     });
   });
   ```

9. **CSS in `adhd_mode.scss`:**
   - `.adhd-restore-banner` — `display: flex; align-items: center; gap: 0.75rem; padding: 8px 16px; background: var(--yellow-100); border-bottom: 1px solid var(--yellow-300); font-size: 0.85rem;`
   - `.adhd-restore-text` — `flex: 1;`

10. **Include in `hooks.py`** under `app_include_js`.

## How to Test

1. Enable ADHD mode. Navigate to **Selling → Sales Order → New**.
2. Fill in: Customer, Delivery Date, and add two items with qty and rate. Do not save.
3. Wait 35 seconds. Open the browser's DevTools → Application → localStorage. Confirm a key `adhd_draft_Sales Order___new__` exists and contains a JSON snapshot with the customer name and item rows.
4. Close the browser tab (or navigate away without saving). Open a new **Sales Order → New** form.
5. Confirm the restore banner appears: "📋 You have an unsaved Sales Order from X minutes ago. Resume it?"
6. Click **Restore**. Confirm all scalar fields (Customer, Delivery Date) are repopulated. Confirm both item rows are restored with correct qty and rate.
7. Open another **Sales Order → New**. Click **Discard** on the banner. Confirm the banner disappears and the form remains blank. Confirm the localStorage key is gone.
8. Save an existing Sales Order (server-saved). Confirm no restore banner appears on it (the banner only targets new/unsaved forms).
9. Submit a Sales Order. Confirm the autosave interval stops (no new localStorage writes for that doc after submission).
10. Disable ADHD mode. Open a new Sales Order, fill fields, wait 35 seconds. Confirm no localStorage key is written.
11. Confirm the restore banner and the ADHD-001 chain nav bar do not overlap; the banner sits above the chain nav.

## Acceptance Criteria
- [ ] Auto-save writes a localStorage snapshot every 30 seconds for new/unsaved Sales Orders and Quotations when ADHD mode is active.
- [ ] Snapshot includes all configured scalar fields and all rows from `items`, `taxes`, and `sales_team` child tables.
- [ ] A restore banner appears on new form load when a snapshot exists in localStorage.
- [ ] Clicking Restore repopulates all scalar fields and child-table rows correctly.
- [ ] Clicking Discard removes the localStorage key and the banner without altering the form.
- [ ] Saving a form removes the `__new__` localStorage key for that doctype.
- [ ] Submitting a form clears the autosave interval and the localStorage key.
- [ ] No auto-save writes occur when ADHD mode is disabled.
- [ ] Restore banner does not appear on existing (server-saved) document loads.
- [ ] Banner and chain nav bar do not visually overlap.
- [ ] No JavaScript console errors in any of the above states.

## Dependencies
- **Blocked by:** ADHD-002 (Smart Inbox Resume panel pattern), ADHD-001 (chain navigator — must not conflict)
- **Blocks:** None

## Complexity
M — Multiple doctypes, localStorage read/write, child-table serialisation/deserialisation, interval management, and collision-avoidance with the chain nav bar. No new server endpoints.

## Phase
Phase 7 — Module-by-Module Expansion
