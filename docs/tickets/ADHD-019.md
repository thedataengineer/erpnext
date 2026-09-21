# ADHD-019: "Done Well" Positive Reinforcement

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Completion feedback in `erpnext/public/js/adhd/adhd_mode.js` and ADHD styles.
- **Verification:** `node --test erpnext/tests/adhd_tickets_011_020.test.js` provides structural coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Show a brief, unobtrusive confirmation animation and plain-text message when a document is submitted or a Kanban task is completed, providing the positive closure signal that ADHD users often miss from silent saves.

## Background / Context
ERPNext's submission confirmation is a barely-visible status badge change — blink and you miss it. ADHD users frequently re-check whether they actually submitted a document because the feedback loop is so weak. The absence of a satisfying "done" signal is a known ADHD pain point: without it, task completion feels ambiguous, leading to repeated checking, re-opens, and time lost to uncertainty. A single soft pulse and a one-line message closes the loop cleanly without interrupting flow.

## Cognitive Mechanism
working memory | RSD (Rejection Sensitive Dysphoria — positive confirmation counters the fear of having done it wrong)

## Prerequisites
- ADHD mode toggle (shipped) — reinforcement fires only when ADHD mode is active

## Scope
**Modify:**
- `erpnext/public/js/adhd/adhd_mode.js` — hook form submit and Kanban task-done events; fire reinforcement
- `erpnext/public/scss/adhd_mode.scss` — pulse animation and reduced-motion variant

## What Needs to Be Done

1. **Hook the form submission event in `adhd_mode.js`**
   ```js
   frappe.ui.form.on('*', {
     after_submit(frm) {
       if (!window.ADHDMode?.isActive()) return;
       showDoneWell(`${frm.doc.doctype} ${frm.doc.name} submitted.`);
     }
   });
   ```
   Use the `after_submit` hook (fires after the server confirms submission, not just the button click).

2. **Hook Kanban task "Done" column drop**
   - Locate the Kanban board's card drag-drop completion event. In Frappe's Kanban implementation, this is typically a `kanban_board.on('card_moved')` or equivalent custom event fired on the board element.
   - Alternatively, hook `frappe.ui.kanban.KanbanBoard.prototype.on_card_move` via prototype patching or event delegation.
   - When a card is dropped into a column whose `column_name` matches the board's `is_done_column` (or the user-configured done column), call `showDoneWell(`Task "${card.title}" moved to Done.`)`.

3. **Implement `showDoneWell(message)`**
   - Call `frappe.show_alert({ message, indicator: 'green' }, 2)` — this uses the existing `frappe.show_alert` infrastructure with a 2-second auto-dismiss.
   - Additionally, apply the pulse animation: `document.body.classList.add('adhd-done-pulse'); setTimeout(() => document.body.classList.remove('adhd-done-pulse'), 600);`
   - The `adhd-done-pulse` class triggers the CSS animation (see step 4).
   - Ensure `showDoneWell` is a no-op if `ADHDSettings.get('done_well')` is `false` (add this feature key to ADHD-016's registry with `defaultOn: true`).

4. **CSS pulse animation (in `adhd_mode.scss`)**
   ```scss
   @keyframes adhd-pulse {
     0%   { box-shadow: 0 0 0 0 rgba(var(--green-rgb, 34, 197, 94), 0.4); }
     70%  { box-shadow: 0 0 0 12px rgba(var(--green-rgb, 34, 197, 94), 0); }
     100% { box-shadow: 0 0 0 0 rgba(var(--green-rgb, 34, 197, 94), 0); }
   }

   .adhd-done-pulse {
     animation: adhd-pulse 0.6s ease-out;
   }

   @media (prefers-reduced-motion: reduce) {
     .adhd-done-pulse {
       animation: none;
     }
   }
   ```
   Apply the animation to `body` or to the page's main content wrapper (`#page-container` or `.main-section`) to keep it subtle.

5. **Kanban card ✓ animation**
   - On task-done card move, also add class `adhd-card-done` to the Kanban card element.
   - CSS:
     ```scss
     @keyframes adhd-card-check {
       0%   { opacity: 1; transform: scale(1); }
       40%  { opacity: 1; transform: scale(1.05); }
       100% { opacity: 0.6; transform: scale(1); }
     }

     .adhd-card-done {
       animation: adhd-card-check 0.4s ease-out forwards;
     }

     @media (prefers-reduced-motion: reduce) {
       .adhd-card-done { animation: none; }
     }
     ```
   - Remove the class after the animation ends (`animationend` event) to keep the DOM clean.

6. **Message format**
   - For document submission: `"${frm.doc.doctype} ${frm.doc.name} submitted."` — always plain text, no markdown.
   - For Kanban: `"Task "${cardTitle}" done."` — use the card's `title` or `subject` field.
   - Do **not** include user names or monetary values in the message.

7. **`frappe.show_alert` options**
   - Duration: 2 seconds (`frappe.show_alert(..., 2)`).
   - Indicator colour: `'green'`.
   - Ensure it does not stack with other in-progress alerts (check if `frappe.show_alert` handles this internally; if not, debounce `showDoneWell` with a 500 ms trailing edge).

## How to Test

1. Log in with ADHD mode **enabled**.
2. Navigate to **Accounts → Sales Invoice → New**. Create a minimal valid Sales Invoice.
3. Click "Submit". Confirm:
   - A green alert appears at the top of the screen with text matching `"Sales Invoice SI-XXXX submitted."` and auto-dismisses within 2 seconds.
   - A subtle pulse animation plays on the page (visible as a brief green glow).
4. Immediately re-check the alert does not reappear or linger after 2 seconds.
5. Open the **Task** Kanban board (Project → [any project] → Kanban view, or standalone Task list in Kanban mode).
6. Drag a task card from any column to the "Done" (or configured completion) column.
7. Confirm:
   - A green alert appears: `"Task "[task name]" done."`.
   - The card briefly scales up and fades slightly (✓ animation) before settling.
8. In browser DevTools, set `prefers-reduced-motion: reduce` via the Rendering panel. Repeat steps 3 and 6. Confirm no CSS animations play (alert text still appears).
9. Disable ADHD mode. Submit another document. Confirm no alert or animation fires.
10. Re-enable ADHD mode. Open ADHD Settings Panel. Toggle off "Done Well". Submit a document. Confirm reinforcement does not fire.

## Acceptance Criteria
- [ ] `frappe.show_alert` fires with the correct message and 'green' indicator on form submission when ADHD mode is active.
- [ ] Green pulse animation plays on submission (on body or main content wrapper).
- [ ] Kanban card shows a brief scale/fade animation when moved to Done.
- [ ] Alert auto-dismisses within 2 seconds.
- [ ] `prefers-reduced-motion: reduce` disables all CSS animations while keeping the text alert.
- [ ] No reinforcement fires when ADHD mode is disabled.
- [ ] ADHD-016 "Done Well" toggle suppresses reinforcement when off.
- [ ] No console errors on document submission or Kanban move.

## Dependencies
- Blocked by: ADHD mode toggle (shipped)
- Blocks: none
- Related: ADHD-016 — add `done_well` to the feature registry

## Complexity
S — event hooks on existing Frappe events + CSS animations; no server-side work.

## Phase
Phase 5 — Personalisation & Observability
