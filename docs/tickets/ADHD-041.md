# ADHD-041: BOM Tree Breadcrumb Navigator

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
