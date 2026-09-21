# ADHD-009: Time-Box Suggestions for Hyperfocus-Prone Forms

## Current implementation record

- **Status:** Implemented.
- **Implementation:** `erpnext/public/js/adhd/form_focus.js` and `adhd_timebox_timer.js`.
- **Verification:** No ticket-specific automated test; site and browser behavior remain unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
For a predefined set of "rabbit hole" doctypes (Item, Account, BOM, Print Format, Custom Field), shows a subtle dismissible banner in ADHD mode suggesting a 10-minute time-box, with a button that launches the Pomodoro timer in a 10-minute configuration — helping users enter these detail-heavy forms with a built-in exit strategy.

## Background / Context
Certain ERPNext forms have a gravitational pull for ADHD users: Item (pricing, variants, taxes, suppliers, reorder levels), BOM (nested components), Custom Field (system configuration rabbit holes). A user who opens one of these forms to "just check one thing" may re-emerge 45 minutes later having accomplished something unrelated to their original intent. This is hyperfocus in its most disruptive form — not a lack of attention, but attention locked onto the wrong target. A proactive time-box suggestion at the moment of opening gives the user an explicit choice to constrain their time before the pull sets in.

## Cognitive Mechanism
Hyperfocus | time blindness | initiation

## Prerequisites
- `public/js/adhd/focus_panel.js` (Focus Panel / Pomodoro, shipped) must expose a method to start the timer with a custom duration — e.g., `frappe.focusPanel.startTimer(minutes)` or equivalent.
- ADHD mode toggle (`adhd_mode.js`, Phase 1) must be active.

## Scope
**Modify:**
- `erpnext/public/js/adhd/form_focus.js` — add time-box banner logic to the existing `after_load` (or `refresh`) hook

## What Needs to Be Done

1. **Define the "rabbit hole" doctype list.** Near the top of the relevant section in `form_focus.js`:
   ```js
   const TIMEBOX_DOCTYPES = [
     "Item",
     "Account",
     "BOM",
     "Print Format",
     "Custom Field",
   ];
   const TIMEBOX_MINUTES = 10;
   ```

2. **Register the `refresh` hook for each doctype.** The ticket specifies hooking into the existing `after_load` hook; use whichever is present. If `after_load` is already used by `form_focus.js` for other purposes, append to it rather than replacing it:
   ```js
   TIMEBOX_DOCTYPES.forEach((doctype) => {
     frappe.ui.form.on(doctype, {
       refresh(frm) {
         renderTimeboxBanner(frm);
       },
     });
   });
   ```

3. **Build `renderTimeboxBanner(frm)`.** Guards and per-session dismissal first:
   ```js
   function renderTimeboxBanner(frm) {
     if (!frappe.boot.adhd_mode) return;
     if (frm.is_new()) return;
     const dismissKey = `adhd_timebox_dismissed_${frm.doctype}_${frm.docname}`;
     if (sessionStorage.getItem(dismissKey)) return;
     // Avoid duplicate banners
     frm.layout.$wrapper.find(".adhd-timebox-banner").remove();
     const $banner = $(`
       <div class="adhd-timebox-banner">
         <span class="adhd-timebox-icon">⏱️</span>
         <span class="adhd-timebox-msg">
           Heads up: this form has a lot of options.
           Consider a ${TIMEBOX_MINUTES}-min time-box.
         </span>
         <button class="btn btn-xs btn-default adhd-timebox-start">
           Start ${TIMEBOX_MINUTES}-min timer
         </button>
         <button class="adhd-timebox-dismiss" aria-label="Dismiss">✕</button>
       </div>
     `);
     $banner.find(".adhd-timebox-start").on("click", () => {
       startPomodoro(TIMEBOX_MINUTES);
       sessionStorage.setItem(dismissKey, "1");
       $banner.remove();
     });
     $banner.find(".adhd-timebox-dismiss").on("click", () => {
       sessionStorage.setItem(dismissKey, "1");
       $banner.remove();
     });
     frm.layout.$wrapper.prepend($banner);
   }
   ```

4. **Build `startPomodoro(minutes)`.** Attempt to call the Focus Panel's public API:
   ```js
   function startPomodoro(minutes) {
     if (frappe.focusPanel && typeof frappe.focusPanel.startTimer === "function") {
       frappe.focusPanel.startTimer(minutes);
       frappe.show_alert({ message: `${minutes}-min timer started`, indicator: "blue" });
       return;
     }
     // Fallback: open Focus Panel if not already open, then start timer
     if (frappe.focusPanel && typeof frappe.focusPanel.open === "function") {
       frappe.focusPanel.open();
       setTimeout(() => frappe.focusPanel.startTimer?.(minutes), 300);
     } else {
       frappe.show_alert({ message: "Open the Focus Panel to start your timer", indicator: "blue" });
     }
   }
   ```

5. **Post-timer completion nudge.** Hook into the existing Pomodoro `_timerComplete()` callback (via a separate listener, not by modifying `focus_panel.js` again in this ticket — ADHD-007 already does that). Instead, add a `focuspanel:timercomplete` custom DOM event listener in `form_focus.js`:
   ```js
   document.addEventListener("focuspanel:timercomplete", () => {
     const route = frappe.get_route();
     if (route[0] === "Form" && TIMEBOX_DOCTYPES.includes(route[1])) {
       frappe.show_alert({
         message: "Time's up — did you get what you needed?",
         indicator: "orange",
       }, 10);  // auto-dismiss after 10 seconds
     }
   });
   ```
   Note: `focus_panel.js` must emit `document.dispatchEvent(new CustomEvent("focuspanel:timercomplete"))` inside `_timerComplete()`. If this event is not yet emitted, add `document.dispatchEvent(new CustomEvent("focuspanel:timercomplete"))` to `_timerComplete()` as part of this ticket (one-line addition to `focus_panel.js`).

6. **CSS additions in `adhd_mode.scss`:**
   ```scss
   .adhd-timebox-banner {
     display: flex;
     align-items: center;
     gap: 8px;
     padding: 8px 14px;
     background: var(--purple-50, #f9f0ff);
     border-left: 4px solid var(--purple-400, #b37feb);
     border-radius: 4px;
     font-size: 0.84rem;
     margin-bottom: 8px;
     color: var(--text-color);
   }
   .adhd-timebox-icon { font-size: 1rem; flex-shrink: 0; }
   .adhd-timebox-msg  { flex: 1; }
   .adhd-timebox-dismiss {
     background: none; border: none; cursor: pointer;
     opacity: 0.5; font-size: 0.9rem;
     &:hover { opacity: 1; }
   }
   ```

7. **Guard all logic behind ADHD mode.** `renderTimeboxBanner` returns at the top if `!frappe.boot.adhd_mode`. The `focuspanel:timercomplete` listener also early-returns if `!frappe.boot.adhd_mode`.

8. **Avoid rendering on list views.** The hook is only on form `refresh`; no action is needed for list views for this ticket.

## How to Test

1. Enable ADHD mode. Open any existing Item record (not a new one). Confirm a purple-border banner appears at the top: "Heads up: this form has a lot of options. Consider a 10-min time-box."
2. Confirm the banner has both a "Start 10-min timer" button and a ✕ dismiss button.
3. Click "Start 10-min timer". Confirm the Focus Panel opens (or becomes visible) and a 10-minute countdown begins. Confirm the banner dismisses.
4. Navigate away and return to the same Item. Confirm the banner does not reappear within the same session.
5. Open a new browser session. Open the same Item. Confirm the banner reappears.
6. Open a different Item (different `docname`). Confirm a fresh banner appears even in the same session (dismissal is per-document, not per-doctype).
7. Click ✕ on the banner. Confirm it dismisses without starting a timer.
8. Start the 10-min timer via the banner button. Wait for the timer to complete (or trigger `_timerComplete()` via console). While still on an Item form, confirm a "Time's up — did you get what you needed?" alert appears.
9. Open an Account record. Confirm the same banner appears. Repeat for BOM, Print Format, Custom Field.
10. Disable ADHD mode. Open an Item. Confirm no banner appears.
11. Open a new (unsaved) Item. Confirm no banner appears.
12. Open a Sales Order (not in `TIMEBOX_DOCTYPES`). Confirm no banner appears and no console errors.

## Acceptance Criteria
- [ ] Time-box banner appears on Item, Account, BOM, Print Format, and Custom Field forms when ADHD mode is active and the document is not new.
- [ ] Banner text reads: "Heads up: this form has a lot of options. Consider a 10-min time-box."
- [ ] "Start 10-min timer" button launches the Focus Panel Pomodoro at 10 minutes and dismisses the banner.
- [ ] ✕ button dismisses the banner without starting the timer.
- [ ] Banner does not reappear for the same document within the same browser session after dismissal.
- [ ] Banner does reappear for the same document in a new browser session.
- [ ] After a timed session completes while on a `TIMEBOX_DOCTYPES` form, a "Time's up" alert appears.
- [ ] No banner appears on new (unsaved) documents.
- [ ] No banner appears when ADHD mode is disabled.
- [ ] No banner appears on doctypes not in `TIMEBOX_DOCTYPES`.
- [ ] No console errors on any tested form.

## Dependencies
- **Blocked by:** Focus Panel / Pomodoro (shipped); ADHD mode toggle (Phase 1, shipped)
- **Requires minor addition to `focus_panel.js`:** emit `focuspanel:timercomplete` custom DOM event inside `_timerComplete()` (one-line change, can be bundled with ADHD-007 if done in the same sprint)
- **Blocks:** None

## Complexity
S — Modifications to an existing file with a clear hook point; timer integration relies on a well-defined public API; post-completion nudge is a simple alert with no state.

## Phase
Phase 3 — Ambient Awareness
