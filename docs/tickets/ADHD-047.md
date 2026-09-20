# ADHD-047: Activity-Based Timesheet Pre-fill

## Summary
When ADHD mode is active and a new Timesheet is created, automatically pre-fill the first time log row's `activity_type`, `task`, and `project` fields from `localStorage` and route context — eliminating the repetitive manual entry that causes ADHD users to abandon timesheet logging mid-session.

## Background / Context
Timesheet logging in ERPNext is a friction-heavy doctype: every new entry requires the user to select `activity_type` (which they almost always repeat from their last session), then manually link `task` and `project` (which they're often navigating away from to create the timesheet). For ADHD users, this setup cost triggers avoidance — the cognitive tax of typing the same values repeatedly outweighs the perceived benefit, so timesheets either go unlogged or are batch-filled inaccurately from memory later. The friction is highest when the user creates a Timesheet directly from a Task form and ERPNext presents a completely blank form with no context carried over.

## Cognitive Mechanism
Initiation | working memory

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- ADHD-033 must be shipped — the `::after` CSS label pattern for "← last used" indicators must be defined in `adhd_mode.scss`.
- The Timesheet `time_logs` child table must have `activity_type`, `task`, and `project` fields (standard ERPNext fields).

## Scope
**Create:**
- `erpnext/projects/doctype/timesheet/adhd_timesheet.js`

**Modify:**
- `erpnext/hooks.py` — add `adhd_timesheet.js` to `doctype_js` under `"Timesheet"`
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-prefilled` styles if not already defined by ADHD-033

## What Needs to Be Done

1. **Define localStorage keys**:
   ```js
   const LAST_ACTIVITY_KEY = "adhd_last_activity_type";
   ```

2. **Hook into form events** in `adhd_timesheet.js`:
   ```js
   frappe.ui.form.on("Timesheet", {
     onload_post_render(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (!frm.is_new()) return; // Only pre-fill brand-new timesheets
       prefill_timesheet(frm);
     },
     after_save(frm) {
       if (!frappe.boot.adhd_mode) return;
       persist_last_activity(frm);
     },
   });
   ```
   Use `onload_post_render` rather than `refresh` to ensure child table rows are accessible in the DOM before we modify them.

3. **Implement `prefill_timesheet(frm)`**:
   ```js
   function prefill_timesheet(frm) {
     // Ensure at least one row exists in time_logs
     if (!frm.doc.time_logs || frm.doc.time_logs.length === 0) {
       frappe.model.add_child(frm.doc, "Timesheet Detail", "time_logs");
       frm.refresh_field("time_logs");
     }

     const first_row = frm.doc.time_logs[0];

     // 1. Pre-fill activity_type from localStorage
     const last_activity = localStorage.getItem(LAST_ACTIVITY_KEY);
     if (last_activity && !first_row.activity_type) {
       frappe.model.set_value(
         first_row.doctype,
         first_row.name,
         "activity_type",
         last_activity
       );
       mark_prefilled(frm, "time_logs", first_row.name, "activity_type");
     }

     // 2. Pre-fill task and project from navigation context
     detect_task_context(frm, first_row);
   }
   ```

4. **Implement `detect_task_context(frm, row)`**:
   ```js
   function detect_task_context(frm, row) {
     // Detect if the user navigated here from a Task form
     // frappe.route_history stores previous routes as arrays: ["Form", "Task", "TASK-0001"]
     const history = frappe.route_history || [];
     const prev_route = history[history.length - 2]; // entry before current page

     if (
       prev_route &&
       prev_route[0] === "Form" &&
       prev_route[1] === "Task" &&
       prev_route[2]
     ) {
       const task_name = prev_route[2];
       // Fetch the Task to get its project
       frappe.db.get_value("Task", task_name, ["project", "subject"], (task_data) => {
         if (!task_data) return;

         if (!row.task) {
           frappe.model.set_value(row.doctype, row.name, "task", task_name);
           mark_prefilled(frm, "time_logs", row.name, "task");
         }
         if (!row.project && task_data.project) {
           frappe.model.set_value(row.doctype, row.name, "project", task_data.project);
           mark_prefilled(frm, "time_logs", row.name, "project");
         }

         frm.refresh_field("time_logs");
         frappe.show_alert({
           message: `Pre-filled from Task: ${task_data.subject || task_name}`,
           indicator: "blue",
         });
       });
     } else {
       frm.refresh_field("time_logs");
     }
   }
   ```

5. **Implement `mark_prefilled(frm, table_field, row_name, field_name)`**:
   ```js
   function mark_prefilled(frm, table_field, row_name, field_name) {
     // Add a CSS class to the cell so ::after pseudo-element can show "← last used"
     // The grid cell selector follows Frappe's child table DOM structure
     const $grid = $(frm.wrapper).find(`[data-fieldname="${table_field}"]`);
     const $row = $grid.find(`[data-name="${row_name}"]`);
     const $cell = $row.find(`[data-fieldname="${field_name}"]`);
     $cell.addClass("adhd-prefilled");
   }
   ```

6. **Implement `persist_last_activity(frm)`** — runs on every save:
   ```js
   function persist_last_activity(frm) {
     if (!frm.doc.time_logs || frm.doc.time_logs.length === 0) return;
     // Read the activity_type from the first row that has one
     const row_with_activity = frm.doc.time_logs.find((r) => r.activity_type);
     if (row_with_activity) {
       localStorage.setItem(LAST_ACTIVITY_KEY, row_with_activity.activity_type);
     }
   }
   ```

7. **Add CSS** to `adhd_mode.scss` (if not already added by ADHD-033):
   ```scss
   .adhd-prefilled {
     position: relative;

     &::after {
       content: "← last used";
       position: absolute;
       bottom: -14px;
       left: 0;
       font-size: 0.65rem;
       color: var(--blue-500, #3b82f6);
       white-space: nowrap;
       pointer-events: none;
     }
   }
   ```

8. **Register in `hooks.py`**:
   ```python
   doctype_js = {
       "Timesheet": "projects/doctype/timesheet/adhd_timesheet.js",
       # ... existing entries
   }
   ```

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Navigate to a **Task** form (any existing open Task).
3. In the browser console, confirm `frappe.route_history` includes `["Form", "Task", "<task-name>"]` as the second-to-last entry.
4. From the Task form, click the **New Timesheet** button (or navigate to Timesheets → New). Confirm:
   - The first row in `time_logs` is pre-populated with the Task name and its parent Project.
   - A blue alert appears: "Pre-filled from Task: [Task subject]".
   - The `task` and `project` cells show the "← last used" label.
5. Set an `activity_type` (e.g., "Development") on the first row. Save the Timesheet. Confirm `localStorage.getItem("adhd_last_activity_type")` equals "Development" (check in browser console).
6. Create another **New Timesheet** (not from a Task form this time). Confirm the first row's `activity_type` is pre-filled with "Development" and shows the "← last used" label. Confirm `task` and `project` are **not** pre-filled.
7. Change `activity_type` to "Testing" and save. Confirm `localStorage` now stores "Testing".
8. Open an **existing** (not new) Timesheet. Confirm no pre-fill logic runs and existing values are unchanged.
9. **Disable ADHD mode**. Create a New Timesheet. Confirm the first row remains blank with no pre-fill.
10. Check browser console for JavaScript errors on all steps.

## Acceptance Criteria
- [ ] New Timesheets created after navigating from a Task form have `task` and `project` pre-filled on the first `time_logs` row.
- [ ] New Timesheets created without Task context have `activity_type` pre-filled from `localStorage` (if a previous value exists).
- [ ] Pre-filled cells show a "← last used" label via the `.adhd-prefilled` CSS class.
- [ ] `activity_type` is persisted to `localStorage` on every save.
- [ ] Existing (non-new) Timesheets are not modified by pre-fill logic.
- [ ] Logic is inactive when ADHD mode is disabled.
- [ ] No JavaScript errors under normal operation.
- [ ] Pre-fill does not overwrite values already present on the row.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped); ADHD-033 (CSS `::after` pattern)
- **Blocks:** None

## Complexity
S — Client-side JS only; uses `localStorage`, `frappe.db.get_value`, `frappe.model.set_value`, and route history inspection; no new Python or schema changes.

## Phase
Phase 7 — Module-by-Module Expansion
