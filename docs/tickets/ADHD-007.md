# ADHD-007: Automatic Time-Log Prompt on Pomodoro Completion

## Summary
When a Pomodoro work session completes and the Focus Panel has an active task, automatically surfaces a one-click time-log prompt pre-filled with the session's project, task, start/end times, and preferred activity type — so the user captures their time without having to remember to navigate to a Timesheet.

## Background / Context
ADHD users who use the Pomodoro technique already have the best possible data for time tracking: they know exactly what they worked on and for how long. Yet the step of opening a Timesheet, finding the right project, and entering the times manually is enough friction to make time logging feel like a second job. The result is that timesheets are either left empty or filled retrospectively from memory — an unreliable process. Connecting the natural Pomodoro completion moment to a pre-filled time-log prompt collapses the friction to a single button click.

## Cognitive Mechanism
Initiation | time blindness | working memory

## Prerequisites
- Focus Panel (`public/js/adhd/focus_panel.js`) must be shipped with:
  - A working Pomodoro timer that calls `_timerComplete()` on session end.
  - An `activeTask` property on the Focus Panel instance (or equivalent: `this.currentTask`, `this.selectedTask`) that holds `{ doctype: "Task", name: "TASK-XXXX", subject: "..." }`.
- ADHD mode toggle (Phase 1, shipped).

## Scope
**Modify:**
- `erpnext/public/js/adhd/focus_panel.js` — add `_showTimeLogPrompt()` and call it from `_timerComplete()`

## What Needs to Be Done

1. **Locate `_timerComplete()` in `focus_panel.js`.** This method is called when the countdown reaches zero. After any existing completion logic (sound, notification), add:
   ```js
   if (this.activeTask && frappe.boot.adhd_mode) {
     this._showTimeLogPrompt();
   }
   ```

2. **Build `_showTimeLogPrompt()`.** Capture the session times at the moment `_timerComplete()` is called (not at prompt render time, because the user may take a moment to see the prompt):
   ```js
   _showTimeLogPrompt() {
     const toTime   = frappe.datetime.now_datetime();  // ISO string "YYYY-MM-DD HH:MM:SS"
     const fromTime = frappe.datetime.add_minutes(toTime, -(this.pomodoroMinutes || 25));
     const hours    = (this.pomodoroMinutes || 25) / 60;
     const task     = this.activeTask;
     const project  = task.project || null;
     const activityType = frappe.boot.adhd_default_activity_type || "Execution";
     this._renderTimeLogBanner({ fromTime, toTime, hours, task, project, activityType });
   }
   ```

3. **Build `_renderTimeLogBanner(opts)`.** Inject a `<div class="adhd-timelog-prompt">` into the Focus Panel DOM (append to `this.$body` or the panel's main container):
   ```html
   <div class="adhd-timelog-prompt">
     <p class="adhd-timelog-summary">
       Session complete — log <strong>{hours}h</strong> on
       <strong>{task.subject}</strong>?
     </p>
     <div class="adhd-timelog-detail">
       {fromTime} → {toTime} · {activityType}
     </div>
     <div class="adhd-timelog-actions">
       <button class="btn btn-primary btn-sm adhd-timelog-log">Log Time</button>
       <button class="btn btn-default btn-sm adhd-timelog-skip">Skip</button>
     </div>
   </div>
   ```

4. **"Log Time" button handler.** On click:
   - Disable the button immediately to prevent double-submit.
   - Call:
     ```js
     frappe.call({
       method: "erpnext.projects.doctype.timesheet.timesheet.create_timesheet_entry",
       args: {
         employee: frappe.boot.employee_name || null,
         project:  opts.project,
         task:     opts.task.name,
         from_time: opts.fromTime,
         to_time:   opts.toTime,
         hours:     opts.hours,
         activity_type: opts.activityType,
       },
       callback(r) {
         if (r.exc) {
           frappe.show_alert({ message: "Could not log time. " + r.exc, indicator: "red" });
           return;
         }
         frappe.show_alert({ message: `Time logged on ${opts.task.subject}`, indicator: "green" });
         banner.remove();
       },
     });
     ```
   - If `create_timesheet_entry` does not exist as a whitelisted endpoint, use the generic doc creation path:
     ```js
     // Find or create today's Timesheet for the employee, then append a time_log row
     frappe.call({
       method: "frappe.client.get_list",
       args: {
         doctype: "Timesheet",
         filters: { employee: frappe.boot.employee_name, start_date: frappe.datetime.get_today(), docstatus: 0 },
         fields: ["name"],
         limit: 1,
       },
       callback(r) {
         const timesheetName = r.message?.[0]?.name;
         if (timesheetName) {
           appendTimeLogRow(timesheetName, opts);
         } else {
           createTimesheetWithRow(opts);
         }
       },
     });
     ```

5. **`appendTimeLogRow(timesheetName, opts)`.** Use `frappe.call("frappe.client.get", ...)` to fetch the Timesheet doc, push a row to `time_logs`, then `frappe.call("frappe.client.save", ...)`.

6. **`createTimesheetWithRow(opts)`.** Build a new Timesheet doc dict and call `frappe.call("frappe.client.insert", ...)` with a populated `time_logs` array.

7. **"Skip" button handler.** Simply call `banner.remove()`. No time log is created.

8. **Auto-dismiss.** If the prompt is still visible 5 minutes after render (the user walked away), auto-remove it silently. Use `setTimeout(banner.remove.bind(banner), 5 * 60 * 1000)`.

9. **CSS additions in `adhd_mode.scss`:**
   - `.adhd-timelog-prompt` — `background: var(--fg-color); border: 1px solid var(--primary); border-radius: 6px; padding: 12px; margin-top: 10px;`
   - `.adhd-timelog-summary` — `margin: 0 0 4px; font-size: 0.9rem;`
   - `.adhd-timelog-detail` — `font-size: 0.78rem; color: var(--text-muted); margin-bottom: 8px;`
   - `.adhd-timelog-actions` — `display: flex; gap: 8px;`

10. **Guard behind ADHD mode.** `_showTimeLogPrompt` returns immediately if `!frappe.boot.adhd_mode`.

## How to Test

1. Enable ADHD mode. Open the Focus Panel. Select a Task that has a linked Project.
2. Set the Pomodoro to 1 minute (or expose a test mode that fires `_timerComplete()` immediately via browser console: `frappe.focusPanel._timerComplete()`).
3. Complete or manually trigger the timer. Confirm the time-log prompt banner appears inside the Focus Panel.
4. Confirm the prompt shows correct session duration (25 min default / 1 min test), task name, and time range.
5. Click "Log Time". Confirm a success alert appears ("Time logged on [task name]") and the prompt dismisses.
6. Navigate to the Timesheet list. Confirm a Timesheet or Timesheet entry exists for today with the correct task, project, from_time, to_time, and hours.
7. Trigger the timer again. This time click "Skip". Confirm the prompt dismisses with no Timesheet entry created.
8. Trigger the timer with no active task set. Confirm no prompt appears.
9. Trigger the timer and wait 5 minutes without interacting. Confirm the prompt auto-dismisses.
10. Disable ADHD mode. Trigger timer completion. Confirm no prompt appears.

## Acceptance Criteria
- [ ] Time-log prompt appears in the Focus Panel immediately on Pomodoro session completion when a task is active.
- [ ] Prompt displays the correct `from_time`, `to_time`, task name, project, and activity type.
- [ ] Clicking "Log Time" creates a Timesheet Detail entry with the correct fields and shows a green success alert.
- [ ] Clicking "Skip" dismisses the prompt with no Timesheet entry created.
- [ ] The "Log Time" button is disabled after first click to prevent duplicate entries.
- [ ] Prompt auto-dismisses after 5 minutes if the user does not interact.
- [ ] No prompt appears when no task is active in the Focus Panel.
- [ ] No prompt appears when ADHD mode is disabled.
- [ ] No duplicate Timesheet rows are created if the Focus Panel is closed and reopened mid-prompt.

## Dependencies
- **Blocked by:** Focus Panel / Pomodoro (shipped); ADHD mode toggle (Phase 1, shipped)
- **Enhanced by:** ADHD-004 (`CreateTimesheetDetailRecipe` in command bar — shares Timesheet creation logic and may be extracted to a shared utility)
- **Blocks:** None

## Complexity
S — Modifying an existing method in a shipped file; async Timesheet creation has edge cases (find-or-create) but no new endpoints are required.

## Phase
Phase 3 — Ambient Awareness
