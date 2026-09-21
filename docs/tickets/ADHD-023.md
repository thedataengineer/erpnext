# ADHD-023: Sales Order Interruption Restore

## Current implementation record

- **Status:** Planned.
- **Implementation:** No matching implementation or bundle registration exists on `iteration_3`.
- **Verification:** No implementation test exists; original acceptance criteria remain pending.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

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

Specifics for this ticket:
- localStorage key pattern: adhd_draft_${doctype}___new__
- Snapshot target doctypes: ["Sales Order", "Quotation"]
- SNAPSHOT_FIELDS map: { "Sales Order": ["customer","delivery_date","items"], "Quotation": ["customer","valid_till","items"] }
- setInterval every 30 000 ms; clear on form submit or discard
- Restore banner shows "Unsaved draft found" with Restore and Discard buttons
- Restoring scalar fields: frm.set_value(field, value)
- Restoring child table rows: frappe.model.add_child then assign fields, then frm.refresh_field
```

---

### Claude Prompt (Step 1 of 2)

```text
You are implementing ADHD-023 Step 1: the draft snapshot engine for ERPNext ADHD Mode.

Context:
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Persistence: localStorage.setItem/getItem/removeItem
- Child table rows are plain JS objects in frm.doc.<fieldname> (array)

Task — create public/js/adhd_draft_recovery.js with:

1. A SNAPSHOT_FIELDS constant:
   { "Sales Order": ["customer","delivery_date","items"], "Quotation": ["customer","valid_till","items"] }

2. A function startDraftSnapshot(frm) that:
   - Returns immediately if !frappe.boot.adhd_mode
   - Returns if frm.doc.docstatus !== 0 (only draft docs)
   - Every 30 s (setInterval), collects scalar fields + full items array from frm.doc
   - Serialises to JSON and stores in localStorage with key adhd_draft_${frm.doctype}___new__
   - Stores the interval ID on frm._adhd_draft_interval so it can be cleared

3. A function clearDraftSnapshot(frm) that:
   - Clears the interval via frm._adhd_draft_interval
   - Removes the localStorage key

4. Export (or attach to window) both functions.

Think through: what happens if items is an empty array, and how to safely JSON.stringify child table rows
that may contain circular Frappe model references. Strip non-data keys (doctype, name, idx, etc. are fine
to keep; avoid __proto__ issues).

Output the complete adhd_draft_recovery.js file.
```

---

### Claude Prompt (Step 2 of 2)

```text
You are implementing ADHD-023 Step 2: the restore banner for Sales Order and Quotation forms.

Prerequisite: adhd_draft_recovery.js from Step 1 exports startDraftSnapshot(frm) and clearDraftSnapshot(frm).

Context:
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- frm.set_value(fieldname, value) for scalar fields
- frappe.model.add_child(frm.doc, childDoctype, fieldname) to add child rows, then assign fields
- frm.refresh_field(fieldname) to sync DOM after child table changes
- frappe.show_alert({ message, indicator }) for non-blocking notices

Task — in the existing hooks for Sales Order and Quotation (or create new files if needed):

1. On the `refresh` hook:
   a. Call startDraftSnapshot(frm).
   b. Check localStorage for key adhd_draft_${frm.doctype}___new__.
   c. If a snapshot exists AND frm.doc.__islocal (new unsaved doc), inject a banner:
      "Unsaved draft found — [Restore] [Discard]"
   d. "Restore" button: parse JSON snapshot, set scalar fields via frm.set_value,
      rebuild items child table via frappe.model.add_child, then frm.refresh_field("items"),
      then clearDraftSnapshot(frm) and remove banner.
   e. "Discard" button: clearDraftSnapshot(frm) and remove banner.

2. On the `after_save` hook: call clearDraftSnapshot(frm).

3. On the `on_submit` hook: call clearDraftSnapshot(frm).

Provide code for both the Sales Order and Quotation form hooks (they can share a helper function).
Output complete file contents.
```

---

### GPT-4o Prompt (Step 1 of 2)

```text
## Task: ADHD-023 Step 1 — Draft Snapshot Engine

### Codebase Context
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Persistence: localStorage.setItem / getItem / removeItem
- frm.doc.<childFieldname> is a plain JS array of row objects

### Requirements
- [ ] Create `public/js/adhd_draft_recovery.js`
- [ ] SNAPSHOT_FIELDS = { "Sales Order": ["customer","delivery_date","items"], "Quotation": ["customer","valid_till","items"] }
- [ ] startDraftSnapshot(frm): guard adhd_mode + docstatus===0, setInterval 30s, localStorage key `adhd_draft_${frm.doctype}___new__`
- [ ] Store interval ID on frm._adhd_draft_interval
- [ ] clearDraftSnapshot(frm): clearInterval + removeItem
- [ ] Safely serialise child table rows — strip Frappe internal keys starting with "__"
- [ ] Attach both functions to window.adhdDraftRecovery or export them

### Output
Complete file with inline comments.
```

---

### GPT-4o Prompt (Step 2 of 2)

```text
## Task: ADHD-023 Step 2 — Restore Banner

### Codebase Context
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- startDraftSnapshot(frm) and clearDraftSnapshot(frm) from adhd_draft_recovery.js (Step 1)
- frm.set_value(fieldname, value) for scalar restore
- frappe.model.add_child(frm.doc, childDoctype, fieldname) for child rows
- frm.refresh_field(fieldname)
- frm.doc.__islocal is true for new unsaved documents

### Requirements
- [ ] On refresh: call startDraftSnapshot(frm); check localStorage for snapshot
- [ ] Show banner only when snapshot exists AND frm.doc.__islocal
- [ ] Banner contains "Restore" and "Discard" buttons with id="adhd-draft-banner"
- [ ] Restore: set scalar fields, rebuild items child table, clearDraftSnapshot, remove banner
- [ ] Discard: clearDraftSnapshot, remove banner
- [ ] after_save + on_submit hooks both call clearDraftSnapshot(frm)
- [ ] Works for both "Sales Order" and "Quotation" (shared helper function)

### Output
Complete code for both doctype hooks.
```

---

### Gemini 1.5 Pro Prompt (Step 1 of 2)

```text
Implement ADHD-023 Step 1: Draft Snapshot Engine for ERPNext ADHD Mode.

Codebase context:
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- localStorage.setItem/getItem/removeItem for persistence
- frm.doc.<field> contains child table as array of row objects

Step 1 — Create public/js/adhd_draft_recovery.js:
  a. Define SNAPSHOT_FIELDS = { "Sales Order": ["customer","delivery_date","items"], "Quotation": ["customer","valid_till","items"] }.
  b. Implement startDraftSnapshot(frm):
     - Return if !frappe.boot.adhd_mode or frm.doc.docstatus !== 0.
     - Every 30 000 ms, collect scalar fields + items array from frm.doc per SNAPSHOT_FIELDS.
     - Serialize to JSON; store at key adhd_draft_${frm.doctype}___new__.
     - Save interval ID to frm._adhd_draft_interval.
  c. Implement clearDraftSnapshot(frm):
     - clearInterval(frm._adhd_draft_interval).
     - localStorage.removeItem(key).
  d. Attach both to window so other files can call them.

Step 2 — Serialisation safety:
  When building the snapshot, filter child table row keys to exclude those starting with "__" to avoid Frappe internals.

Step 3 — Verify:
  - startDraftSnapshot is idempotent (clears old interval before starting new one).
  - Empty items array serialises without error.

Output the complete file.
```

---

### Gemini 1.5 Pro Prompt (Step 2 of 2)

```text
Implement ADHD-023 Step 2: Restore Banner for Sales Order and Quotation.

Prerequisite: window.adhdDraftRecovery.startDraftSnapshot(frm) and clearDraftSnapshot(frm) exist from Step 1.

Codebase context:
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- frm.set_value(fieldname, value), frappe.model.add_child, frm.refresh_field
- frm.doc.__islocal === true for new unsaved docs

Step 1 — refresh hook for Sales Order and Quotation:
  a. Call startDraftSnapshot(frm).
  b. Read localStorage key adhd_draft_${frm.doctype}___new__.
  c. If snapshot found AND frm.doc.__islocal, inject banner with id="adhd-draft-banner":
     "Unsaved draft found — [Restore] [Discard]".

Step 2 — Restore button click:
  a. Parse snapshot JSON.
  b. Set each scalar field via frm.set_value.
  c. For items: clear existing rows, add new rows via frappe.model.add_child, assign fields.
  d. frm.refresh_field("items").
  e. clearDraftSnapshot(frm), remove banner.

Step 3 — Discard button click:
  clearDraftSnapshot(frm), remove banner.

Step 4 — after_save and on_submit hooks:
  Call clearDraftSnapshot(frm) in both.

Step 5 — Verify:
  - Banner not shown on existing saved docs (frm.doc.__islocal guard).
  - No duplicate banners on re-render.
  - Works identically for Sales Order and Quotation via shared helper.

Output complete file(s).
```

---

### Prompt Chain

This is an **M (medium) ticket** — use a 2-step chain:
1. Run Step 1 prompt to generate `adhd_draft_recovery.js`.
2. Run Step 2 prompt (paste Step 1 output as context) to generate the form hooks.
Then run the self-validation prompt on the combined output.

---

### Self-Validation Prompt

```text
Review the following code for ADHD-023 (Sales Order Interruption Restore).

Check each item and respond PASS or FAIL + reason:

1. adhd_draft_recovery.js is created at public/js/adhd_draft_recovery.js
2. SNAPSHOT_FIELDS covers ["customer","delivery_date","items"] for Sales Order and ["customer","valid_till","items"] for Quotation
3. Snapshot is taken every 30 seconds via setInterval
4. localStorage key is adhd_draft_${frm.doctype}___new__
5. Interval ID is stored on frm._adhd_draft_interval and cleared by clearDraftSnapshot
6. Child table rows are serialised safely (Frappe "__" keys stripped)
7. Restore banner appears only when a snapshot exists AND frm.doc.__islocal
8. Restore correctly rebuilds scalar fields and items child table
9. Discard removes snapshot and banner without restoring
10. after_save and on_submit both call clearDraftSnapshot

[Paste generated code here]
```
