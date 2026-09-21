# ADHD-046: Project Health Snapshot

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Project health metrics in `erpnext/public/js/adhd/adhd_tickets_041_061.js`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When ADHD mode is active on a Project form, inject a compact "Project Health" card showing four key metrics — overdue tasks, unassigned tasks, percent complete, and days to deadline — so the user can assess project status in one glance without drilling into the task list.

## Background / Context
ERPNext's Project form shows a task list and a `percent_complete` field, but assessing project health requires the user to scan the task list for overdue items, count unassigned tasks, check the end date, and do mental arithmetic. For ADHD users, this multi-field scan is fragmented and unreliable — items get missed, urgency signals are lost in the noise, and returning to a project after an interruption means rebuilding the mental model from scratch. The friction is highest when managing multiple concurrent projects, where "is this project in trouble?" needs to be answerable in seconds.

## Cognitive Mechanism
Working memory | attention switching | time blindness

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- The Task doctype must have `project`, `status`, `exp_end_date`, and `assigned_to` (or `_assign`) fields (standard ERPNext fields).
- The Project doctype must have `percent_complete` and `expected_end_date` fields (standard ERPNext fields).

## Scope
**Create:**
- `erpnext/projects/doctype/project/adhd_project.js`

**Modify:**
- `erpnext/hooks.py` — add `adhd_project.js` to `doctype_js` under `"Project"`
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-project-health` styles

## What Needs to Be Done

1. **Hook into form events** in `adhd_project.js`:
   ```js
   frappe.ui.form.on("Project", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (frm.is_new()) return;
       render_project_health(frm);
     },
   });
   ```

2. **Implement `render_project_health(frm)`**:
   ```js
   function render_project_health(frm) {
     $(frm.wrapper).find(".adhd-project-health").remove();

     const today = frappe.datetime.get_today();
     const deadline = frm.doc.expected_end_date;
     const percent_complete = frm.doc.percent_complete || 0;

     // Days to deadline calculation
     let days_to_deadline_html;
     if (deadline) {
       const days = frappe.datetime.get_diff(deadline, today);
       if (days < 0) {
         days_to_deadline_html = `<span class="adhd-health-metric adhd-health-metric--danger">${Math.abs(days)} days overdue</span>`;
       } else if (days <= 7) {
         days_to_deadline_html = `<span class="adhd-health-metric adhd-health-metric--warning">${days} days left</span>`;
       } else {
         days_to_deadline_html = `<span class="adhd-health-metric">${days} days left</span>`;
       }
     } else {
       days_to_deadline_html = `<span class="adhd-health-metric adhd-health-metric--muted">No deadline set</span>`;
     }

     // Build a placeholder card, then populate counts asynchronously
     const $card = $(`
       <div class="adhd-project-health">
         <div class="adhd-project-health__title">🏥 Project Health</div>
         <div class="adhd-project-health__metrics">
           <div class="adhd-health-col" id="adhd-overdue-col">
             <div class="adhd-health-label">Overdue Tasks</div>
             <div class="adhd-health-value" id="adhd-overdue-val">…</div>
           </div>
           <div class="adhd-health-col" id="adhd-unassigned-col">
             <div class="adhd-health-label">Unassigned Tasks</div>
             <div class="adhd-health-value" id="adhd-unassigned-val">…</div>
           </div>
           <div class="adhd-health-col">
             <div class="adhd-health-label">% Complete</div>
             <div class="adhd-health-value">${Math.round(percent_complete)}%</div>
           </div>
           <div class="adhd-health-col">
             <div class="adhd-health-label">Deadline</div>
             <div class="adhd-health-value">${days_to_deadline_html}</div>
           </div>
         </div>
       </div>
     `);

     $(frm.wrapper).find(".form-layout").prepend($card);
     fetch_task_counts(frm, today);
   }
   ```

3. **Implement `fetch_task_counts(frm, today)`** — two parallel `frappe.call` invocations:
   ```js
   function fetch_task_counts(frm, today) {
     // Overdue tasks: not completed and exp_end_date < today
     frappe.call({
       method: "frappe.client.get_list",
       args: {
         doctype: "Task",
         filters: [
           ["project", "=", frm.doc.name],
           ["status", "not in", ["Completed", "Cancelled"]],
           ["exp_end_date", "<", today],
         ],
         fields: ["name"],
         limit: 500,
       },
       callback(r) {
         const count = (r.message || []).length;
         const $val = $("#adhd-overdue-val");
         $val.text(count);
         if (count > 0) {
           $val.addClass("adhd-health-metric--danger");
           // Make it a clickable link to the task list
           $val.wrapInner(
             `<a href="/app/task?project=${encodeURIComponent(frm.doc.name)}&status=Open&exp_end_date=Before Today"></a>`
           );
         }
       },
     });

     // Unassigned tasks: _assign is null/empty and not completed
     frappe.call({
       method: "frappe.client.get_list",
       args: {
         doctype: "Task",
         filters: [
           ["project", "=", frm.doc.name],
           ["status", "not in", ["Completed", "Cancelled"]],
           ["_assign", "is", "not set"],
         ],
         fields: ["name"],
         limit: 500,
       },
       callback(r) {
         const count = (r.message || []).length;
         const $val = $("#adhd-unassigned-val");
         $val.text(count);
         if (count > 0) {
           $val.addClass("adhd-health-metric--warning");
           $val.wrapInner(
             `<a href="/app/task?project=${encodeURIComponent(frm.doc.name)}&_assign=&status=Open"></a>`
           );
         }
       },
     });
   }
   ```

4. **Add CSS** to `adhd_mode.scss`:
   ```scss
   .adhd-project-health {
     background: var(--fg-color);
     border: 1px solid var(--border-color);
     border-radius: var(--border-radius);
     padding: 12px 16px;
     margin-bottom: 14px;

     &__title {
       font-weight: 700;
       font-size: 0.85rem;
       margin-bottom: 10px;
       color: var(--text-color);
     }

     &__metrics {
       display: grid;
       grid-template-columns: repeat(4, 1fr);
       gap: 12px;
       @media (max-width: 600px) { grid-template-columns: repeat(2, 1fr); }
     }
   }

   .adhd-health-col {
     text-align: center;
   }
   .adhd-health-label {
     font-size: 0.72rem;
     color: var(--text-muted);
     margin-bottom: 4px;
     text-transform: uppercase;
     letter-spacing: 0.04em;
   }
   .adhd-health-value {
     font-size: 1.4rem;
     font-weight: 700;
     color: var(--text-color);

     a { color: inherit; text-decoration: underline dotted; }
   }

   .adhd-health-metric {
     &--danger { color: var(--red-500, #ef4444); }
     &--warning { color: var(--yellow-600, #ca8a04); }
     &--muted   { color: var(--text-muted); font-size: 0.85rem; font-weight: 400; }
   }
   ```

5. **Register in `hooks.py`**:
   ```python
   doctype_js = {
       "Project": "projects/doctype/project/adhd_project.js",
       # ... existing entries
   }
   ```

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Open a Project that has at least 2 Tasks with `exp_end_date` in the past and `status = Open`, and at least 1 Task with no `_assign` value.
3. Confirm the "🏥 Project Health" card appears at the top of the Project form with four metric tiles.
4. Verify "Overdue Tasks" count matches the number of non-completed Tasks with `exp_end_date < today` (verify by running a Task list filtered manually).
5. Verify "Unassigned Tasks" count matches the number of non-completed Tasks with no assignee.
6. Verify "% Complete" shows `frm.doc.percent_complete` rounded to the nearest integer.
7. Verify "Days Left" tile shows the correct number of days between today and `expected_end_date`. If `expected_end_date` is past, confirm it shows red "X days overdue". If within 7 days, confirm it shows orange. If no deadline, confirm "No deadline set."
8. Click the overdue count. Confirm it links to the Task list filtered for that project and overdue tasks.
9. Click the unassigned count. Confirm it links to the Task list filtered for that project and unassigned tasks.
10. Open a **new (unsaved) Project**. Confirm the health card does not appear.
11. **Disable ADHD mode**. Reload the Project. Confirm the health card is absent.
12. Check browser console for JavaScript errors.

## Acceptance Criteria
- [ ] Health card appears on saved Project forms when ADHD mode is active.
- [ ] Overdue count correctly reflects non-completed tasks with `exp_end_date < today`.
- [ ] Overdue count shown in red when > 0; clicking it links to filtered Task list.
- [ ] Unassigned count correctly reflects non-completed tasks with no `_assign` value.
- [ ] Unassigned count shown in orange when > 0; clicking it links to filtered Task list.
- [ ] % Complete reflects `frm.doc.percent_complete` rounded to whole number.
- [ ] Days-to-deadline tile is red when deadline has passed, orange when ≤ 7 days away, neutral otherwise.
- [ ] "No deadline set" message shown when `expected_end_date` is blank.
- [ ] Health card absent on new/unsaved Projects.
- [ ] Health card absent when ADHD mode is disabled.
- [ ] No duplicate health cards appear after form refresh.
- [ ] No JavaScript errors.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped)
- **Blocks:** None

## Complexity
S — Client-side JS with two lightweight `frappe.call` list queries; straightforward DOM injection; no new Python or schema changes.

## Phase
Phase 7 — Module-by-Module Expansion
