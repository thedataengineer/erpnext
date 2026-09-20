# ADHD-044: Job Card Time-Logging Shortcut

## Summary
When ADHD mode is active on a Job Card form, show a prominent "Start Work" / "Stop Work" toggle button above the standard fields so workers can log time with a single tap per direction — removing the cognitive burden of manually filling `from_time`, `to_time`, and `time_in_mins` fields in the child table.

## Background / Context
The Job Card `time_logs` child table requires the user to add a row, set `from_time`, complete work, return to the form, set `to_time`, and calculate or manually enter `time_in_mins`. For ADHD users, this multi-step table interaction is a significant friction point — it requires remembering to log start time before beginning, and accurately recalling elapsed time if they forgot. The biggest failure mode: they finish the operation without ever having started a timer, then have to guess how long the job took. This ticket replaces that flow with a single button in each direction.

## Cognitive Mechanism
Initiation | working memory | time blindness

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- Focus Panel Pomodoro (shipped) can be used as a reference implementation for `localStorage`-based timer patterns.
- The Job Card `time_logs` child table must have `from_time`, `to_time`, `time_in_mins`, and `completed_qty` fields (standard ERPNext fields).

## Scope
**Create:**
- `erpnext/manufacturing/doctype/job_card/adhd_job_card.js`

**Modify:**
- `erpnext/hooks.py` — add `adhd_job_card.js` to `doctype_js` under `"Job Card"`
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-time-toggle` styles

## What Needs to Be Done

1. **Define localStorage key helpers**:
   ```js
   const TIMER_KEY = (job_card_name) => `adhd_timer_${job_card_name}`;
   ```
   The stored value is a JSON string: `{ "start": "<ISO timestamp>" }`.

2. **Hook into form events** in `adhd_job_card.js`:
   ```js
   frappe.ui.form.on("Job Card", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       // Only show on saved (not new) Job Cards that are not Completed/Submitted
       if (frm.is_new() || frm.doc.status === "Completed") return;
       render_time_toggle(frm);
     },
   });
   ```

3. **Implement `render_time_toggle(frm)`**:
   ```js
   function render_time_toggle(frm) {
     $(frm.wrapper).find(".adhd-time-toggle").remove();

     const stored = localStorage.getItem(TIMER_KEY(frm.doc.name));
     const is_running = Boolean(stored);
     const start_time = stored ? JSON.parse(stored).start : null;

     let elapsed_text = "";
     let interval_id = null;

     const $widget = $(`
       <div class="adhd-time-toggle ${is_running ? "adhd-time-toggle--running" : ""}">
         <button class="btn btn-primary adhd-time-toggle__btn" id="adhd-timer-btn">
           ${is_running ? "⏹ Stop Work" : "▶ Start Work"}
         </button>
         <span class="adhd-time-toggle__elapsed" id="adhd-timer-elapsed">
           ${is_running ? "Calculating..." : ""}
         </span>
       </div>
     `);

     $(frm.wrapper).find(".form-layout").prepend($widget);

     // If already running, start the live elapsed counter
     if (is_running && start_time) {
       tick_elapsed(start_time);
       interval_id = setInterval(() => tick_elapsed(start_time), 1000);
     }

     $widget.find("#adhd-timer-btn").on("click", function () {
       if (!localStorage.getItem(TIMER_KEY(frm.doc.name))) {
         // START
         const now = frappe.datetime.now_datetime();
         localStorage.setItem(TIMER_KEY(frm.doc.name), JSON.stringify({ start: now }));
         $(this).text("⏹ Stop Work");
         $widget.addClass("adhd-time-toggle--running");
         interval_id = setInterval(() => tick_elapsed(now), 1000);
         frappe.show_alert({ message: "Timer started.", indicator: "green" });
       } else {
         // STOP
         clearInterval(interval_id);
         const start = JSON.parse(localStorage.getItem(TIMER_KEY(frm.doc.name))).start;
         localStorage.removeItem(TIMER_KEY(frm.doc.name));
         commit_time_log(frm, start);
         $(this).text("▶ Start Work");
         $widget.removeClass("adhd-time-toggle--running");
         $("#adhd-timer-elapsed").text("");
       }
     });

     function tick_elapsed(start) {
       const diff_secs = frappe.datetime.get_minute_diff(frappe.datetime.now_datetime(), start) * 60;
       const h = Math.floor(diff_secs / 3600);
       const m = Math.floor((diff_secs % 3600) / 60);
       const s = Math.floor(diff_secs % 60);
       $("#adhd-timer-elapsed").text(
         `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
       );
     }
   }
   ```

4. **Implement `commit_time_log(frm, start_iso)`**:
   ```js
   function commit_time_log(frm, start_iso) {
     const end_iso = frappe.datetime.now_datetime();
     const time_in_mins = frappe.datetime.get_minute_diff(end_iso, start_iso);

     if (time_in_mins < 0.5) {
       frappe.show_alert({ message: "Session too short to log (< 30 seconds).", indicator: "orange" });
       return;
     }

     // Add a new row to time_logs child table
     const child = frappe.model.add_child(frm.doc, "Job Card Time Log", "time_logs");
     frappe.model.set_value(child.doctype, child.name, "from_time", start_iso);
     frappe.model.set_value(child.doctype, child.name, "to_time", end_iso);
     frappe.model.set_value(child.doctype, child.name, "time_in_mins", time_in_mins);

     frm.refresh_field("time_logs");
     frm.save().then(() => {
       frappe.show_alert({
         message: `Time logged: ${Math.round(time_in_mins)} minutes.`,
         indicator: "green",
       });
     });
   }
   ```
   - Uses `frappe.model.add_child` (consistent with existing ERPNext child table patterns).
   - Calls `frm.save()` after adding the row so the record is persisted immediately.
   - Guards against accidental sub-30-second logs.

5. **Add CSS** to `adhd_mode.scss`:
   ```scss
   .adhd-time-toggle {
     display: flex;
     align-items: center;
     gap: 14px;
     padding: 10px 16px;
     background: var(--fg-color);
     border: 2px solid var(--primary);
     border-radius: var(--border-radius);
     margin-bottom: 14px;

     &--running {
       border-color: var(--red-500, #ef4444);
       background: var(--red-50, #fef2f2);
     }

     &__btn {
       min-width: 130px;
       font-weight: 600;
     }

     &__elapsed {
       font-size: 1.1rem;
       font-variant-numeric: tabular-nums;
       font-weight: 700;
       color: var(--text-color);
     }
   }
   ```

6. **Register in `hooks.py`**:
   ```python
   doctype_js = {
       "Job Card": "manufacturing/doctype/job_card/adhd_job_card.js",
       # ... existing entries
   }
   ```

7. **Handle stale timers**: On `refresh`, if a timer key exists in `localStorage` but the Job Card `status` is `"Completed"` or `"Submitted"`, remove the stale key and show no widget.

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Open a submitted Job Card that is not yet Completed.
3. Confirm a "▶ Start Work" button appears at the top of the form.
4. Click "Start Work". Confirm the button changes to "⏹ Stop Work", the widget background turns light red, and an elapsed time counter (HH:MM:SS) starts incrementing.
5. Wait at least 60 seconds. Click "Stop Work". Confirm:
   - The `time_logs` child table gains a new row with correct `from_time`, `to_time`, and `time_in_mins` values.
   - The form saves automatically.
   - A green alert "Time logged: X minutes" appears.
6. Reload the page. Confirm no stale timer is running (button shows "▶ Start Work").
7. Click "Start Work" again. Without stopping, **close and reopen the browser tab**. Confirm the timer resumes from the original start time (because the start is persisted in `localStorage`).
8. Stop the timer after the tab reload. Confirm the total elapsed time includes the time before the tab was closed.
9. Start the timer on a Job Card, then without stopping it open a **different** Job Card. Confirm the second Job Card has its own independent timer state.
10. Click Start and then Stop within 30 seconds. Confirm the orange "Session too short" alert appears and no row is added to `time_logs`.
11. **Disable ADHD mode**. Reload a Job Card. Confirm the button widget is absent.

## Acceptance Criteria
- [ ] "▶ Start Work" button appears at top of Job Card form when ADHD mode is active and the card is not Completed.
- [ ] Clicking "Start Work" stores `from_time` in `localStorage` and starts a live HH:MM:SS counter.
- [ ] Widget styling changes visually (red border/background) while a timer is running.
- [ ] Clicking "Stop Work" adds a row to `time_logs` with correct `from_time`, `to_time`, and `time_in_mins`.
- [ ] Form saves automatically after Stop Work is clicked.
- [ ] Timer persists across page reloads via `localStorage`.
- [ ] Sessions under 30 seconds produce an orange alert and no `time_logs` row.
- [ ] Multiple Job Cards can each hold independent timer state.
- [ ] Widget is absent when ADHD mode is disabled.
- [ ] Widget is absent on completed Job Cards.
- [ ] No duplicate widgets appear after multiple form refreshes.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped); Focus Panel Pomodoro (reference implementation for localStorage timer pattern)
- **Blocks:** None

## Complexity
S — Pure client-side JS with `localStorage`; uses existing `frappe.model.add_child` pattern; no new Python or schema changes.

## Phase
Phase 7 — Module-by-Module Expansion
