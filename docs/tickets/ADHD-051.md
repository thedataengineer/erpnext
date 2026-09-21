# ADHD-051: Issue SLA Countdown on Form and List

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Issue countdown in `erpnext/public/js/adhd/adhd_tickets_041_061.js`; list urgency in `adhd_list_view.js`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Display a live SLA countdown timer on the Issue form and color-coded row borders in the Issue list so support agents always know exactly how much time remains before a breach.

## Background / Context
ADHD brains struggle with abstract deadlines — an SLA breach can creep up invisibly while attention is elsewhere. ERPNext shows `response_by` and `resolution_by` as static date fields, giving no ambient urgency signal. An agent can stare at an Issue without realizing it breaches in 20 minutes. The friction point is the gap between knowing a deadline exists and *feeling* how close it is.

## Cognitive Mechanism
Time blindness | Working memory | Attention switching

## Prerequisites
- ADHD-006 (heat-map list-view infrastructure must be in place — provides the row-border coloring pattern and the `adhdListView` helper used here)
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/support/doctype/issue/adhd_issue.js`
- **Modify** `public/js/adhd/adhd_list_view.js` — add Issue doctype to the heat-map registry

## What Needs to Be Done

1. **Create `adhd_issue.js`** and register it as a client-script extension loaded only when `frappe.boot.adhd_mode` is truthy (check at the top of the file; return early if not).

2. **In `frappe.ui.form.on('Issue', { refresh(frm) { ... } })`**, add a `refresh` handler that:
   a. Reads `frm.doc.response_by` and `frm.doc.resolution_by` (ISO datetime strings).
   b. Picks the *earlier* of the two that is not yet in the past (prefer `response_by` if the issue is not yet responded to, i.e. `frm.doc.first_responded_on` is blank; otherwise use `resolution_by`).
   c. Calls a helper `renderSlaCountdown(frm, targetDatetime)`.

3. **`renderSlaCountdown(frm, targetDatetime)`**:
   a. Remove any existing `#adhd-sla-countdown` node to avoid duplicates on refresh.
   b. Compute `msRemaining = new Date(targetDatetime) - Date.now()`.
   c. Format as `"Xh Ym remaining"` (if positive) or `"BREACHED Xh Ym ago"` (if negative). Use `Math.floor` for hours, `Math.abs(ms) % 3600000 / 60000` for minutes.
   d. Choose a CSS class: `adhd-sla-green` (>25% of original window remaining), `adhd-sla-amber` (<25%), `adhd-sla-red` (breached). Compute the original window from `frm.doc.creation` to `targetDatetime`.
   e. Inject a `<div id="adhd-sla-countdown" class="adhd-sla-badge adhd-sla-{color}">SLA: {text}</div>` immediately after the form title using `frm.dashboard.set_headline_alert()` or by prepending to `.form-page` — prefer `frm.dashboard.set_headline_alert(html)` so it sits in the standard dashboard strip.
   f. Store the interval ID on `frm._adhdSlaInterval`. Clear any previous interval before setting a new one (`clearInterval(frm._adhdSlaInterval)`).
   g. Start a `setInterval` of 60 000 ms that re-runs steps b–e in place (update the text node directly, no full re-render).

4. **Clear the interval on form unload**: add an `onload_post_render` or `before_load` handler that calls `clearInterval(frm._adhdSlaInterval)` when the form is torn down. Use `frappe.router.on('change', ...)` or the `frm.events` `before_load` hook.

5. **CSS** (add to `public/css/adhd.css` or inline via `frappe.dom.set_style`):
   ```css
   .adhd-sla-badge { font-weight: 600; padding: 4px 10px; border-radius: 4px; font-size: 0.85rem; }
   .adhd-sla-green  { background: #d4edda; color: #155724; }
   .adhd-sla-amber  { background: #fff3cd; color: #856404; }
   .adhd-sla-red    { background: #f8d7da; color: #721c24; }
   ```

6. **Modify `adhd_list_view.js`** — in the Issue entry of the heat-map registry:
   a. `dateField`: use `resolution_by` (or `response_by` if `first_responded_on` is blank — for list view simplicity, always use `resolution_by`).
   b. Threshold logic: red = `resolution_by < now`, amber = `resolution_by < now + 0.25 * window`, green = everything else. Because window calculation requires `creation`, store `creation` in the list's `add_fields` array.
   c. Compute `windowMs = new Date(doc.resolution_by) - new Date(doc.creation)`.
   d. `remaining = new Date(doc.resolution_by) - Date.now()`.
   e. Percent = `remaining / windowMs`.
   f. Apply `adhd-row-red / adhd-row-amber / adhd-row-green` border classes to the `$row` element exactly as done for other doctypes in ADHD-006.
   g. Register a 60-second `setInterval` on the list page that re-evaluates all visible rows (mirror the pattern already used for Sales Order in ADHD-006).

7. **Bundle registration**: ensure `adhd_issue.js` is listed in `hooks.py` under `doctype_js` for `Issue`, conditionally (follow the existing ADHD pattern).

## How to Test

1. Start from a clean ERPNext desk with ADHD mode **enabled**.
2. Open **Support → Issue**. Create a new Issue linked to a Service Level Agreement whose `response_by` is 30 minutes from now.
3. Save the Issue. Confirm a green badge reading "SLA: ~0h 30m remaining" appears in the form dashboard strip.
4. Temporarily set the system clock or the `resolution_by` field value to 5 minutes from now (edit directly in the database or use a very short SLA). Reload the form. Confirm badge turns **amber**.
5. Set `resolution_by` to 2 minutes in the past. Reload. Confirm badge shows **red** and reads "BREACHED Xh Ym ago".
6. Leave the form open for 60 seconds without refreshing. Confirm the countdown text updates without a full page reload.
7. Navigate to **Issue List** view. Confirm rows color their left border: green/amber/red according to the same thresholds.
8. Disable ADHD mode via the toggle. Reload form and list. Confirm no badge and no colored borders appear.
9. Open an Issue where `first_responded_on` is filled. Confirm the badge switches to tracking `resolution_by`, not `response_by`.

## Acceptance Criteria
- [ ] SLA countdown badge appears in the Issue form dashboard strip when ADHD mode is on.
- [ ] Badge is green (>25% window remaining), amber (<25%), or red (breached).
- [ ] Badge text updates every 60 seconds without a page reload.
- [ ] No interval leak: navigating away and back does not create duplicate intervals.
- [ ] Issue list rows show red/amber/green left-border coloring matching the same thresholds.
- [ ] When ADHD mode is off, no badge or border coloring is shown.
- [ ] No console errors when `resolution_by` is null (badge simply does not render).

## Dependencies
- Blocked by: ADHD-006 (heat-map infrastructure)
- Blocks: none

## Complexity
S — purely client-side date arithmetic and DOM injection with a setInterval; no new server APIs required.

## Phase
Phase 7 — Module-by-Module Expansion
