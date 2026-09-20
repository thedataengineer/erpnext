# ADHD-006: Ambient Due-Date Heat Map on List Views

## Summary
When ADHD mode is active, injects a coloured left-border indicator into list view rows for Sales Order, Purchase Order, Task, Sales Invoice, Leave Application, and Issue — red for overdue, amber for due within two days, green for due within seven days — computed purely client-side from existing date columns with no additional API calls.

## Background / Context
ERPNext's list views display due dates as plain text in a column that is easy to overlook, especially when scanning a long list. ADHD users frequently miss deadlines not because they forgot the work exists, but because the date information doesn't register visually during a quick scan. A colour-coded left border turns the list into a priority heat map that can be read peripherally, enabling faster triage without a dedicated mental pass over the date column.

## Cognitive Mechanism
Attention switching | time blindness

## Prerequisites
- ADHD mode toggle (`adhd_mode.js`, Phase 1) must be active.
- No other ticket prerequisites — this is self-contained and data is already present in rendered rows.

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_list_view.js`

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-heat-*` styles
- `erpnext/hooks.py` — include `adhd_list_view.js` in `app_include_js`

## What Needs to Be Done

1. **Define the doctype → date-field mapping.** At the top of `adhd_list_view.js`:
   ```js
   const DATE_FIELD_MAP = {
     "Sales Order":        "delivery_date",
     "Purchase Order":     "schedule_date",
     "Task":               "exp_end_date",
     "Sales Invoice":      "due_date",
     "Leave Application":  "to_date",
     "Issue":              "response_by",
   };
   ```

2. **Define urgency thresholds.** Write `getUrgencyClass(dateStr)`:
   ```js
   function getUrgencyClass(dateStr) {
     if (!dateStr) return null;
     const today = frappe.datetime.get_today();  // returns YYYY-MM-DD
     const diff = frappe.datetime.get_diff(dateStr, today);  // positive = future
     if (diff < 0)  return "adhd-heat--overdue";
     if (diff <= 2) return "adhd-heat--soon";
     if (diff <= 7) return "adhd-heat--upcoming";
     return null;
   }
   ```

3. **Hook into `frappe.views.ListView`.** Use Frappe's `frappe.views.ListView.prototype.render_list` override or, preferably, the `list_view_refresh` event if exposed. A safer cross-version approach is to observe DOM mutations on the list wrapper using a `MutationObserver`:
   ```js
   function attachHeatMap(listview) {
     const wrapper = listview.wrapper || listview.$result;
     if (!wrapper) return;
     const observer = new MutationObserver(() => applyHeat(listview));
     observer.observe(wrapper[0] || wrapper, { childList: true, subtree: false });
     applyHeat(listview);  // run immediately for rows already rendered
   }
   ```

4. **`applyHeat(listview)`.** Iterate over rendered list rows:
   ```js
   function applyHeat(listview) {
     if (!frappe.boot.adhd_mode) return;
     const doctype = listview.doctype;
     const dateField = DATE_FIELD_MAP[doctype];
     if (!dateField) return;
     listview.data.forEach((row, i) => {
       const $row = listview.$result.find(`[data-name="${row.name}"]`);
       if (!$row.length) return;
       const cls = getUrgencyClass(row[dateField]);
       // Remove previous heat classes before re-applying
       $row.removeClass("adhd-heat--overdue adhd-heat--soon adhd-heat--upcoming");
       if (cls) $row.addClass(cls);
     });
   }
   ```
   Note: `listview.data` contains the raw fetched row objects; the date field should be present if it is included in the list view's fields. If it is not present by default, add it to the list via the doctype's `List Settings` or programmatically via `listview.fields`.

5. **Ensure the date field is fetched.** In the `frappe.views.ListView` setup, if the date field for the current doctype is not in `listview.fields`, push it:
   ```js
   frappe.router.on("change", () => {
     frappe.after_ajax(() => {
       const lv = frappe.views.list_view;
       if (!lv || !frappe.boot.adhd_mode) return;
       const df = DATE_FIELD_MAP[lv.doctype];
       if (df && !lv.fields.includes(df)) {
         lv.fields.push(df);
       }
       attachHeatMap(lv);
     });
   });
   ```

6. **CSS in `adhd_mode.scss`:**
   ```scss
   .list-row {
     &.adhd-heat--overdue  { border-left: 4px solid var(--red-500);    }
     &.adhd-heat--soon     { border-left: 4px solid var(--yellow-500);  }
     &.adhd-heat--upcoming { border-left: 4px solid var(--green-500);   }
   }
   ```
   Ensure specificity is high enough to override any existing border-left from themes by targeting `.list-row.adhd-heat--*` (combined selector, no descendant).

7. **Closed/submitted rows.** Skip applying any heat class to rows where `docstatus === 2` (cancelled) or, for Sales Order/Purchase Invoice, where `status === "Closed"` or `"Paid"`. Add a `docstatus` and `status` check inside `getUrgencyClass` or in the `applyHeat` loop.

8. **ADHD mode guard.** Wrap the `frappe.router.on("change", ...)` handler with an early return if `!frappe.boot.adhd_mode`. Disconnect the `MutationObserver` on route change to prevent cross-page leaks.

## How to Test

1. Enable ADHD mode. Navigate to the Sales Order list. Ensure there is at least one Sales Order with `delivery_date` in the past (overdue), one due tomorrow, and one due in 5 days.
2. Confirm the overdue row has a red left border; tomorrow's row has an amber/yellow border; the 5-day row has a green border; rows with no due date or due in 8+ days have no coloured border.
3. Repeat steps 1–2 for: Purchase Order (using `schedule_date`), Task (using `exp_end_date`), Sales Invoice (using `due_date`).
4. Submit / close a Sales Order that was overdue. Reload the list. Confirm it no longer shows a red border.
5. Disable ADHD mode. Reload the Sales Order list. Confirm no coloured borders appear on any row.
6. Re-enable ADHD mode. Navigate to a doctype not in `DATE_FIELD_MAP` (e.g., Item). Confirm no heat-map styles are applied and no console errors appear.
7. Filter the Sales Order list to show a subset of records. Confirm heat-map colours are still applied correctly to the filtered rows.
8. Open the browser console while on the list view. Confirm no errors or repeated DOM mutation warnings during normal scrolling or filter changes.

## Acceptance Criteria
- [ ] Red left border (`adhd-heat--overdue`) appears on rows where the doctype's date field is in the past.
- [ ] Amber/yellow border (`adhd-heat--soon`) appears on rows due within 0–2 days.
- [ ] Green border (`adhd-heat--upcoming`) appears on rows due within 3–7 days.
- [ ] No coloured border appears on rows with no due date or due 8+ days out.
- [ ] Closed, cancelled, or fully paid documents do not receive heat-map styling.
- [ ] Heat map applies correctly on: Sales Order, Purchase Order, Task, Sales Invoice, Leave Application, Issue.
- [ ] No heat-map styling appears on any doctype not in `DATE_FIELD_MAP`.
- [ ] All borders are absent when ADHD mode is disabled.
- [ ] MutationObserver is cleaned up on route change (no console warnings about disconnected observers).
- [ ] No console errors during normal list browsing, filtering, or sorting.

## Dependencies
- **Blocked by:** ADHD mode toggle (Phase 1, shipped)
- **Blocks:**
  - ADHD-021 (Quotation Expiry heat map — extends this file and `DATE_FIELD_MAP`)
  - ADHD-030 (Opportunity Staleness heat map — extends this file)
  - ADHD-034 (Reorder Level heat map — extends this file)

## Complexity
S — Client-side DOM manipulation; no server calls; uses existing row data; primary risk is Frappe version compatibility of the list view hook point.

## Phase
Phase 3 — Ambient Awareness
