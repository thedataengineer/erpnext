# ADHD-041: BOM Tree Breadcrumb Navigator

## Current implementation record

- **Status:** Implemented.
- **Implementation:** `erpnext/public/js/adhd/adhd_tickets_041_061.js` calls whitelisted `erpnext/manufacturing/services/adhd_bom_ancestry.py`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When ADHD mode is active on a BOM form, inject a collapsible sidebar panel showing the ancestry chain ("Finished Product > Assembly A > This BOM") so users instantly know where the current BOM sits in the product hierarchy without mentally reconstructing it.

## Background / Context
Manufacturing BOMs in ERPNext are deeply nested — a single finished product may have 3–4 levels of sub-assemblies, each with its own BOM form. ADHD users lose spatial context when drilling into a sub-assembly: "What product is this BOM actually for?" requires navigating up through parent records, each jump burning working memory. The BOM form itself provides no upward context — only the tree view does, and that's on a separate page. The friction is worst when a user opens a BOM from a search result or a child table link and has no trail back to the finished product.

## Cognitive Mechanism
Working memory | attention switching

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- The `BOM Item` doctype must have `item_code`, `bom_no`, and `docstatus` fields (these are standard ERPNext fields — no migration needed).

## Scope
**Create:**
- `erpnext/manufacturing/services/adhd_bom_ancestry.py` — new whitelisted Python endpoint
- `erpnext/manufacturing/doctype/bom/adhd_bom.js` — new client-side JS for BOM form

**Modify:**
- `erpnext/hooks.py` — add `adhd_bom.js` to `doctype_js` map under `"BOM"`

## What Needs to Be Done

1. **Create the Python ancestry endpoint** (`adhd_bom_ancestry.py`):
   ```python
   import frappe

   @frappe.whitelist()
   def get_bom_ancestry(bom_name, max_depth=3):
       """
       Walks up the BOM tree from bom_name, returning a list of ancestor dicts.
       Each dict: { "bom": <name>, "item": <item_code>, "item_name": <item_name> }
       Ordered from top-level ancestor down to (but not including) bom_name.
       """
       ancestry = []
       current_bom = bom_name
       visited = set()

       for _ in range(max_depth):
           if current_bom in visited:
               break
           visited.add(current_bom)

           # Find a submitted parent BOM that uses current_bom as a component
           parent = frappe.db.get_value(
               "BOM Item",
               {"bom_no": current_bom, "docstatus": 1},
               ["parent", "item_code"],
               as_dict=True,
           )
           if not parent:
               break

           parent_bom_doc = frappe.db.get_value(
               "BOM",
               parent["parent"],
               ["name", "item", "item_name", "docstatus"],
               as_dict=True,
           )
           if not parent_bom_doc or parent_bom_doc.docstatus != 1:
               break

           ancestry.insert(0, {
               "bom": parent_bom_doc.name,
               "item": parent_bom_doc.item,
               "item_name": parent_bom_doc.item_name,
           })
           current_bom = parent_bom_doc.name

       return ancestry
   ```
   - Decorate with `@frappe.whitelist()` so it can be called from the client.
   - Guard against cycles with the `visited` set.
   - Cap recursion at `max_depth` (default 3) to prevent runaway queries.

2. **Create the client JS** (`adhd_bom.js`):
   ```js
   // Guard: only run when ADHD mode is active
   frappe.ui.form.on("BOM", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       render_bom_breadcrumb(frm);
     },
   });

   function render_bom_breadcrumb(frm) {
     // Remove stale panel if re-rendering
     $(frm.wrapper).find(".adhd-bom-breadcrumb").remove();

     frappe.call({
       method: "erpnext.manufacturing.services.adhd_bom_ancestry.get_bom_ancestry",
       args: { bom_name: frm.doc.name },
       callback(r) {
         if (!r.message) return;
         const ancestry = r.message; // array of { bom, item, item_name }
         build_breadcrumb_panel(frm, ancestry);
       },
     });
   }

   function build_breadcrumb_panel(frm, ancestry) {
     // Build crumb HTML — ancestors first, then current BOM (non-linked)
     const crumbs = ancestry.map(
       (a) =>
         `<a class="adhd-bom-crumb" href="/app/bom/${encodeURIComponent(a.bom)}"
             title="${a.bom}">${a.item_name}</a>`
     );
     crumbs.push(
       `<span class="adhd-bom-crumb adhd-bom-crumb--current">${frm.doc.item_name || frm.doc.item}</span>`
     );
     const breadcrumb_html = crumbs.join(
       `<span class="adhd-bom-separator"> › </span>`
     );

     const $panel = $(`
       <div class="adhd-bom-breadcrumb">
         <div class="adhd-bom-breadcrumb__header">
           <span class="adhd-bom-breadcrumb__label">📍 Where does this BOM sit?</span>
           <button class="adhd-bom-breadcrumb__toggle btn btn-xs btn-default">▲ Hide</button>
         </div>
         <div class="adhd-bom-breadcrumb__body">
           ${ancestry.length === 0
             ? '<em class="text-muted">This BOM has no parent — it is a top-level finished product.</em>'
             : breadcrumb_html}
         </div>
       </div>
     `);

     // Collapse/expand toggle
     $panel.find(".adhd-bom-breadcrumb__toggle").on("click", function () {
       const $body = $panel.find(".adhd-bom-breadcrumb__body");
       const collapsed = $body.is(":hidden");
       $body.toggle();
       $(this).text(collapsed ? "▲ Hide" : "▼ Show");
     });

     // Inject above the first form section
     $(frm.wrapper).find(".form-layout").prepend($panel);
   }
   ```

3. **Register the JS in `hooks.py`** — add to the `doctype_js` dict:
   ```python
   doctype_js = {
       "BOM": "manufacturing/doctype/bom/adhd_bom.js",
       # ... existing entries ...
   }
   ```
   If `doctype_js` does not already exist or uses a list format, follow the existing convention in `hooks.py`.

4. **Add CSS** to `erpnext/public/scss/adhd_mode.scss`:
   ```scss
   .adhd-bom-breadcrumb {
     background: var(--fg-color);
     border: 1px solid var(--border-color);
     border-radius: var(--border-radius);
     margin: 8px 0 12px;
     font-size: 0.82rem;

     &__header {
       display: flex;
       justify-content: space-between;
       align-items: center;
       padding: 6px 12px;
       border-bottom: 1px solid var(--border-color);
     }
     &__label { font-weight: 600; color: var(--text-color); }
     &__body { padding: 8px 12px; }
   }

   .adhd-bom-crumb {
     color: var(--primary);
     text-decoration: none;
     &:hover { text-decoration: underline; }
     &--current { font-weight: 700; color: var(--text-color); }
   }
   .adhd-bom-separator { color: var(--text-muted); margin: 0 4px; }
   ```

5. **Register the whitelist method** — ensure `adhd_bom_ancestry.py` is importable. Either place it in a `services/` sub-folder (create `__init__.py` if needed) or directly under `erpnext/manufacturing/`. The module path passed to `frappe.call` must exactly match the Python dotted path.

## How to Test

1. Start from a clean ERPNext desk. Ensure ADHD mode is **enabled** (User Settings → ADHD Mode → On).
2. Navigate to **BOM** list. Open a submitted BOM that is a component inside another BOM (i.e., it appears as a BOM Item row in a parent BOM).
3. Verify the breadcrumb panel appears above the first form section, showing the path "Finished Product Name › This BOM Name" (or deeper if 2–3 levels exist).
4. Click the ancestor link (e.g., "Finished Product Name"). Confirm it opens the parent BOM in the same tab.
5. Return to the child BOM. Click "▲ Hide" — confirm the breadcrumb body collapses. Click "▼ Show" — confirm it expands again.
6. Open a **top-level BOM** (one that is not a component in any other BOM). Confirm the panel shows "This BOM has no parent — it is a top-level finished product."
7. Open a BOM that is nested 3 or more levels deep. Confirm only 3 levels of ancestry appear (depth cap).
8. **Disable ADHD mode**. Reload the same BOM. Confirm the breadcrumb panel is completely absent.
9. Open the browser console. Confirm no JavaScript errors on any step above.
10. Run `bench --site [site] execute erpnext.manufacturing.services.adhd_bom_ancestry.get_bom_ancestry --args '{"bom_name": "[valid_bom_name]"}'` and confirm a list is returned without errors.

## Acceptance Criteria
- [ ] Breadcrumb panel renders on BOM form when ADHD mode is active and the BOM has at least one submitted parent.
- [ ] Each ancestor in the breadcrumb is a clickable link that opens the parent BOM form.
- [ ] Current BOM is shown as a non-linked, bold label at the end of the chain.
- [ ] Depth is capped at 3 ancestor levels; no more than 3 links appear regardless of actual tree depth.
- [ ] Top-level BOMs (no parent) display the "no parent" message rather than an empty panel.
- [ ] Collapse/expand toggle works correctly and persists state within the page session.
- [ ] Panel is completely absent when ADHD mode is disabled.
- [ ] No duplicate panels appear after form refresh or save-and-reload.
- [ ] No JavaScript or Python console errors under normal operation.
- [ ] `get_bom_ancestry` handles circular BOM references (same BOM appearing twice) without infinite looping.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped)
- **Blocks:** None directly; feeds into a future "BOM where-used" rollup ticket

## Complexity
M — Requires a new whitelisted Python endpoint with recursive DB traversal, a new JS file with collapsible UI, and CSS additions; no schema changes needed but multi-level query logic needs careful cycle-guard testing.

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
- List queries: frappe.db.get_list returns arrays of dicts
- Dialogs: new frappe.ui.Dialog({ title, fields, primary_action })
- Currency format: frappe.format(value, { fieldtype: "Currency" })
```

---

### Prompt Chain (M — 2 steps)

**Step 1 — Python backend**

```text
You are implementing ADHD-041 for ERPNext (Frappe framework). Your task is to write the Python backend service.

File: erpnext/manufacturing/services/adhd_bom_ancestry.py

Requirements:
- Expose a single @frappe.whitelist() function: get_bom_ancestry(item_code, max_depth=3)
- Perform a recursive query on "BOM Item" to find parent BOMs that reference item_code.
- Each level: frappe.db.get_list("BOM Item", filters={"item_code": <item>}, fields=["parent", "item_code"])
  then resolve the parent BOM's item_code via frappe.db.get_value("BOM", parent, "item")
- Use a visited set to detect cycles; stop recursion when visited or depth >= max_depth.
- Return a list of dicts: [{"bom": str, "item_code": str, "item_name": str, "depth": int}, ...]
  ordered from the deepest ancestor down to the immediate parent.
- Handle empty results gracefully (return []).

Write only the Python file content. Include the import block (import frappe). Add a module-level docstring.
```

**Step 2 — JavaScript frontend**

```text
You are implementing ADHD-041 for ERPNext (Frappe framework). The Python backend is done; now write the client script.

File: erpnext/manufacturing/doctype/bom/adhd_bom.js

Requirements:
- Hook into frappe.ui.form.on("BOM", { refresh(frm) { ... } })
- Guard: if (!frappe.boot.adhd_mode) return;
- After form load, call frappe.call({ method: "erpnext.manufacturing.services.adhd_bom_ancestry.get_bom_ancestry", args: { item_code: frm.doc.item }, callback(r) { ... } })
- Render a collapsible sidebar breadcrumb panel:
  - Container: <div class="adhd-bom-breadcrumb-panel"> injected into frm.sidebar (use frm.sidebar.$sidebar or $(frm.sidebar.wrapper))
  - Each ancestor renders as <a href="/app/bom/<bom_name>" class="adhd-bom-ancestor-link"> showing item_name at depth indentation
  - A toggle button collapses/expands the panel, persisting state in localStorage key "adhd_bom_breadcrumb_open"
  - If ancestry is empty, show a small muted note "No parent BOMs found"
- Do not re-render if panel already exists (check by ID "adhd-bom-breadcrumb").

Write only the JS file. Use vanilla Frappe JS patterns, no extra libraries.
```

---

### GPT-4o Prompt (Step 1 — Python)

```text
## Task
Write erpnext/manufacturing/services/adhd_bom_ancestry.py for ERPNext.

## Function Signature
@frappe.whitelist()
def get_bom_ancestry(item_code, max_depth=3):

## Logic
1. Initialize result=[], visited=set(), depth=0.
2. Recursive helper find_parents(item_code, depth):
   a. If depth >= max_depth: return
   b. Query frappe.db.get_list("BOM Item", filters={"item_code": item_code}, fields=["parent","item_code"])
   c. For each row, if row.parent not in visited:
      - visited.add(row.parent)
      - Get parent BOM item_code and item_name via frappe.db.get_value("BOM", row.parent, ["item","item_name"])
      - Append {"bom": row.parent, "item_code": item_code_of_parent, "item_name": item_name_of_parent, "depth": depth} to result
      - Recurse: find_parents(item_code_of_parent, depth+1)
3. Call find_parents(item_code, 0). Return result sorted by depth descending.

## Constraints
- Import frappe only.
- Add module docstring.
- Return [] on exception, log with frappe.log_error.
```

---

### GPT-4o Prompt (Step 2 — JavaScript)

```text
## Task
Write erpnext/manufacturing/doctype/bom/adhd_bom.js for ERPNext.

## Hooks
frappe.ui.form.on("BOM", { refresh(frm) { ... } })

## Render Logic
1. Guard: if (!frappe.boot.adhd_mode) return;
2. Remove existing panel: $("#adhd-bom-breadcrumb").remove();
3. frappe.call to erpnext.manufacturing.services.adhd_bom_ancestry.get_bom_ancestry with args.item_code = frm.doc.item
4. In callback(r):
   a. Build HTML: <div id="adhd-bom-breadcrumb" class="adhd-bom-breadcrumb-panel">
   b. Render toggle button and collapsible <ul> of ancestors as <a> links to /app/bom/<bom>
   c. Indent each item by depth * 12px padding-left
   d. If r.message is empty, show <p class="text-muted small">No parent BOMs found</p>
5. Inject into frm.sidebar.$sidebar.prepend(html)
6. Read localStorage key "adhd_bom_breadcrumb_open" to set initial open/closed state.
7. Toggle button writes state back to localStorage on click.

## Constraints
- No jQuery plugins. Use frappe.call, standard DOM methods.
- Guard re-render with ID check before frappe.call.
```

---

### Gemini 1.5 Pro Prompt (Step 1 — Python)

```text
Implement get_bom_ancestry for ADHD-041 in ERPNext.

File: erpnext/manufacturing/services/adhd_bom_ancestry.py

Step-by-step:
1. Import frappe at the top. Add a module docstring.
2. Decorate function with @frappe.whitelist().
3. Define get_bom_ancestry(item_code, max_depth=3).
4. Inside, define a nested recursive function _walk(item_code, depth, visited, result).
5. In _walk:
   - If depth >= max_depth or item_code in visited: return
   - visited.add(item_code)
   - rows = frappe.db.get_list("BOM Item", filters={"item_code": item_code}, fields=["parent"])
   - For each row: fetch bom_item = frappe.db.get_value("BOM", row["parent"], ["item","item_name"], as_dict=True)
   - Append {"bom": row["parent"], "item_code": bom_item.item, "item_name": bom_item.item_name, "depth": depth}
   - Recurse _walk(bom_item.item, depth+1, visited, result)
6. Call _walk(item_code, 0, set(), result=[]).
7. Return result sorted by depth descending.
8. Wrap in try/except; on error call frappe.log_error and return [].

Verification checklist:
- [ ] @frappe.whitelist() present
- [ ] Cycle guard via visited set
- [ ] max_depth respected
- [ ] Returns list of dicts with keys: bom, item_code, item_name, depth
- [ ] try/except wraps all logic
```

---

### Gemini 1.5 Pro Prompt (Step 2 — JavaScript)

```text
Implement the BOM breadcrumb sidebar panel for ADHD-041 in ERPNext.

File: erpnext/manufacturing/doctype/bom/adhd_bom.js

Step-by-step:
1. Open frappe.ui.form.on("BOM", { refresh(frm) { ... } }).
2. First line inside refresh: if (!frappe.boot.adhd_mode) return;
3. Remove stale panel: frm.sidebar.$sidebar.find("#adhd-bom-breadcrumb").remove();
4. Call frappe.call({ method: "erpnext.manufacturing.services.adhd_bom_ancestry.get_bom_ancestry", args: { item_code: frm.doc.item }, callback(r) { renderPanel(frm, r.message || []); } });
5. Define renderPanel(frm, ancestors):
   a. Build outer div#adhd-bom-breadcrumb.adhd-bom-breadcrumb-panel
   b. Add a <button class="adhd-bom-toggle">▶ Ancestors</button>
   c. Add a <ul class="adhd-bom-list" style="display:none">
   d. For each ancestor: <li><a href="/app/bom/{bom}" style="padding-left:{depth*12}px">{item_name}</a></li>
   e. If ancestors.length === 0: show <p class="text-muted small">No parent BOMs found</p>
6. Prepend panel into frm.sidebar.$sidebar.
7. On toggle button click: toggle display of .adhd-bom-list, write "adhd_bom_breadcrumb_open" to localStorage.
8. On init: read localStorage key and set initial display state of list.

Verification checklist:
- [ ] ADHD mode guard is first line
- [ ] Panel removed before re-render
- [ ] frappe.call uses correct dotted module path
- [ ] Ancestors render as clickable <a> links
- [ ] localStorage state persists collapse toggle
- [ ] Empty-state message shown when no ancestors
```

---

### Self-Validation Prompt

```text
Review the two files generated for ADHD-041:
1. erpnext/manufacturing/services/adhd_bom_ancestry.py
2. erpnext/manufacturing/doctype/bom/adhd_bom.js

Check each item and respond PASS or FAIL with a one-line reason:

Python:
- [ ] @frappe.whitelist() decorator present on get_bom_ancestry
- [ ] Recursive walk uses a visited set for cycle detection
- [ ] max_depth parameter is respected and defaults to 3
- [ ] Return value is a list of dicts with keys: bom, item_code, item_name, depth
- [ ] try/except present; error logged with frappe.log_error

JavaScript:
- [ ] frappe.boot.adhd_mode guard is the first check inside refresh
- [ ] Stale panel removed by ID before frappe.call
- [ ] frappe.call method path is "erpnext.manufacturing.services.adhd_bom_ancestry.get_bom_ancestry"
- [ ] Each ancestor renders as an <a> tag linking to /app/bom/<bom_name>
- [ ] Depth indentation applied via padding-left: depth * 12px
- [ ] Collapse toggle state written/read from localStorage key "adhd_bom_breadcrumb_open"
- [ ] Empty-state message shown when r.message is empty
```
