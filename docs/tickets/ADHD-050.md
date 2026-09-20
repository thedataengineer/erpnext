# ADHD-050: Task Dependency "Blocked By" Inline Warning

## Summary
When ADHD mode is active on a Task form and the task has incomplete blocking tasks in its `depends_on` child table, inject a prominent warning banner listing those blocking tasks with clickable links — preventing ADHD users from starting work they'll have to abandon when they discover the block mid-execution.

## Background / Context
ERPNext's Task form has a `depends_on` child table that links to prerequisite tasks, but there is zero visual warning when those prerequisites are incomplete. An ADHD user opens a task, reads the description, gets energised to start — and only discovers mid-execution that a dependency wasn't met, forcing a frustrating context switch back to a blocking task. This "starting a blocked task" failure pattern is especially costly for ADHD: the hyperfocus that made them productive is interrupted, task-switching cost is high, and the discovery of the block often triggers RSD (the frustration of wasted effort). Surfacing the block immediately on form load prevents the false start entirely.

## Cognitive Mechanism
Working memory | initiation | RSD (rejection-sensitive dysphoria)

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- The Task `depends_on` child table (doctype: `Task Depends On`) must have a `task` link field pointing to the blocking Task (standard ERPNext field).
- The Task doctype must have a `status` field (standard).

## Scope
**Create:**
- `erpnext/projects/doctype/task/adhd_task.js`

**Modify:**
- `erpnext/hooks.py` — add `adhd_task.js` to `doctype_js` under `"Task"`
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-blocked-by` styles

## What Needs to Be Done

1. **Hook into form events** in `adhd_task.js`:
   ```js
   frappe.ui.form.on("Task", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       if (frm.is_new()) return;
       check_blocking_tasks(frm);
     },
   });
   ```

2. **Implement `check_blocking_tasks(frm)`**:
   ```js
   function check_blocking_tasks(frm) {
     $(frm.wrapper).find(".adhd-blocked-by").remove();

     // Read depends_on child table rows
     const depends_on = frm.doc.depends_on || [];
     if (depends_on.length === 0) return; // No dependencies — nothing to check

     // Collect the names of all blocking tasks
     const blocking_task_names = depends_on
       .map((row) => row.task)
       .filter(Boolean);

     if (blocking_task_names.length === 0) return;

     // Fetch the status of each blocking task in one get_list call
     frappe.call({
       method: "frappe.client.get_list",
       args: {
         doctype: "Task",
         filters: [
           ["name", "in", blocking_task_names],
           ["status", "not in", ["Completed", "Cancelled"]],
         ],
         fields: ["name", "subject", "status"],
         limit: blocking_task_names.length,
       },
       callback(r) {
         const incomplete_tasks = r.message || [];
         if (incomplete_tasks.length === 0) return; // All dependencies met

         render_blocked_banner(frm, incomplete_tasks);
       },
     });
   }
   ```

3. **Implement `render_blocked_banner(frm, incomplete_tasks)`**:
   ```js
   function render_blocked_banner(frm, incomplete_tasks) {
     const count = incomplete_tasks.length;
     const task_links = incomplete_tasks
       .map(
         (t) =>
           `<a class="adhd-blocked-by__link"
               href="/app/task/${encodeURIComponent(t.name)}"
               target="_blank"
               title="Status: ${t.status}">${t.subject || t.name}</a>`
       )
       .join(", ");

     const $banner = $(`
       <div class="adhd-blocked-by">
         <div class="adhd-blocked-by__header">
           <span class="adhd-blocked-by__icon">🚧</span>
           <span class="adhd-blocked-by__title">
             This task is blocked by
             <strong>${count} incomplete task${count !== 1 ? "s" : ""}</strong>.
             Complete ${count !== 1 ? "these" : "this"} first:
           </span>
         </div>
         <div class="adhd-blocked-by__list">
           ${task_links}
         </div>
         <div class="adhd-blocked-by__hint">
           Clicking a task above opens it in a new tab.
         </div>
       </div>
     `);

     // Inject above the first form section, below the page header
     $(frm.wrapper).find(".form-layout").prepend($banner);
   }
   ```

4. **Add CSS** to `adhd_mode.scss`:
   ```scss
   .adhd-blocked-by {
     background: var(--red-50, #fef2f2);
     border: 2px solid var(--red-400, #f87171);
     border-radius: var(--border-radius);
     padding: 12px 16px;
     margin-bottom: 14px;

     &__header {
       display: flex;
       align-items: flex-start;
       gap: 8px;
       margin-bottom: 8px;
     }

     &__icon {
       font-size: 1.2rem;
       flex-shrink: 0;
       margin-top: 1px;
     }

     &__title {
       font-size: 0.9rem;
       font-weight: 600;
       color: var(--red-700, #b91c1c);
       line-height: 1.4;
     }

     &__list {
       display: flex;
       flex-wrap: wrap;
       gap: 6px;
       margin-left: 28px; // Align with text after icon
       margin-bottom: 6px;
     }

     &__link {
       display: inline-block;
       padding: 3px 10px;
       background: var(--red-100, #fee2e2);
       border: 1px solid var(--red-300, #fca5a5);
       border-radius: 4px;
       font-size: 0.82rem;
       font-weight: 500;
       color: var(--red-700, #b91c1c);
       text-decoration: none;
       cursor: pointer;

       &:hover {
         background: var(--red-200, #fecaca);
         text-decoration: underline;
       }
     }

     &__hint {
       font-size: 0.72rem;
       color: var(--red-400, #f87171);
       margin-left: 28px;
     }
   }
   ```

5. **Register in `hooks.py`**:
   ```python
   doctype_js = {
       "Task": "projects/doctype/task/adhd_task.js",
       # ... existing entries
   }
   ```

6. **Refresh the banner** automatically if the user updates the `depends_on` table: hook the `depends_on_remove` and child field events to re-trigger `check_blocking_tasks(frm)` after a save:
   ```js
   frappe.ui.form.on("Task", {
     after_save(frm) {
       if (!frappe.boot.adhd_mode) return;
       check_blocking_tasks(frm);
     },
   });
   ```

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Create two Tasks: **Task A** (status = Open) and **Task B** (status = Open). Set Task B's `depends_on` to include Task A.
3. Open **Task B**. Confirm the red "🚧 This task is blocked by 1 incomplete task. Complete this first:" banner appears with a chip link to Task A.
4. Click the Task A chip. Confirm Task A opens in a **new browser tab**.
5. Return to Task B. Confirm the banner is still present.
6. Navigate to Task A. Set its status to **Completed**. Save.
7. Return to Task B. **Reload the page**. Confirm the blocked banner is **gone** (all dependencies now complete).
8. Add **two** blocking tasks to a Task's `depends_on` table (both Incomplete). Open the Task. Confirm the banner says "blocked by 2 incomplete tasks" with links to both.
9. Open a Task that has `depends_on` rows but **all** blocking tasks are Completed. Confirm no banner appears.
10. Open a Task with an **empty** `depends_on` table. Confirm no banner appears.
11. Open a **new (unsaved)** Task. Confirm no banner appears.
12. **Disable ADHD mode**. Open the same blocked Task. Confirm the banner is absent.
13. Check browser console for JavaScript errors on all steps.
14. Verify only one `frappe.call` fires (not one per dependency row) — check the Network tab for a single `get_list` request.

## Acceptance Criteria
- [ ] Warning banner renders on Task form when ADHD mode is active and at least one `depends_on` task is not Completed or Cancelled.
- [ ] Banner correctly lists the names/subjects of only incomplete blocking tasks (completed blockers are excluded).
- [ ] Each blocking task name is a clickable chip that opens the task in a new tab.
- [ ] Banner accurately reflects the count ("1 incomplete task" vs. "2 incomplete tasks").
- [ ] Banner is absent when all `depends_on` tasks are Completed or Cancelled.
- [ ] Banner is absent when `depends_on` table is empty.
- [ ] Banner is absent on new (unsaved) Tasks.
- [ ] Banner is absent when ADHD mode is disabled.
- [ ] Dependency status is fetched in a single batched `frappe.call` (not one per row).
- [ ] No duplicate banners appear after multiple form refreshes.
- [ ] No JavaScript errors.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped)
- **Blocks:** None

## Complexity
S — Client-side JS; reads `frm.doc.depends_on` in-memory then makes a single batched `frappe.call` to check statuses; DOM injection with link chips; no new Python or schema changes.

## Phase
Phase 7 — Module-by-Module Expansion
