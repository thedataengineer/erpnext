# ADHD-018: Personalized Focus Suggestions

## Summary
The Smart Inbox learns which modules the user actually visits and surfaces "you usually do X around this time" prompts to reduce the daily initiation cost of figuring out where to start.

## Background / Context
Opening ERPNext each morning presents ADHD users with an undifferentiated workspace full of modules they may never use, burying the 2–3 modules they open every day. Time blindness compounds this: users who always process invoices on Monday mornings may forget that pattern and drift toward low-priority tasks. By tracking module visit frequency client-side and reordering the Smart Inbox accordingly, the system meets users where their existing habits already are.

## Cognitive Mechanism
initiation | time blindness | attention switching

## Prerequisites
- ADHD-002 (Smart Inbox) — this ticket adds learning and personalisation on top of the existing Smart Inbox component; it must exist first

## Scope
**Modify:**
- `erpnext/public/js/adhd/adhd_smart_inbox.js` — add frequency tracking, inbox reordering, and time-of-week prompt logic

## What Needs to Be Done

1. **Define the frequency store structure**
   Storage key: `adhd_module_freq_{username}` in `localStorage`.
   Value: a JSON object with the shape:
   ```json
   {
     "Accounts": { "0": 0, "1": 3, "2": 1, "3": 0, "4": 2, "5": 0, "6": 0 },
     "HR":        { "0": 0, "1": 1, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0 }
   }
   ```
   Keys are day-of-week integers (0 = Sunday, 6 = Saturday). Values are visit counts.

2. **Record a module visit**
   - In `adhd_smart_inbox.js`, hook into the inbox module card click event (or `frappe.router.on('change')` route change event).
   - When a route change is detected, extract the top-level module from the route path (e.g. `/accounts/sales-invoice` → `"Accounts"`).
   - Call `recordVisit(moduleName)`:
     ```js
     function recordVisit(moduleName) {
       const store = loadStore();
       const dow = new Date().getDay().toString();
       if (!store[moduleName]) store[moduleName] = {};
       store[moduleName][dow] = (store[moduleName][dow] || 0) + 1;
       saveStore(store);
     }
     ```

3. **Compute module rank for the current day-of-week**
   - `getRankedModules()` returns module names sorted descending by `store[module][currentDow]`.
   - Only modules with at least one recorded visit are included.

4. **Reorder Smart Inbox sections by rank**
   - On Smart Inbox render, call `getRankedModules()`.
   - For modules in the ranked list, set their inbox section's CSS `order` property: rank 0 → `order: 1`, rank 1 → `order: 2`, etc.
   - Modules with zero visits remain in their default order at the end.
   - Apply a subtle "📌 Your top module today" badge to the top-ranked section.

5. **Hide unvisited modules**
   - After 30 days, modules with total visits across all days equal to zero are collapsed by default (not deleted; a "Show all modules" toggle reveals them).
   - "30 days" threshold: count the number of distinct session dates recorded. Store `adhd_session_dates` as a Set serialised in localStorage; add today's date on first visit.
   - Collapse: set `display: none` on the section; add it to a hidden list accessible via the toggle button.

6. **Render the time-of-week prompt**
   - At Smart Inbox open, compute the top-2 modules for the current day-of-week.
   - If the top module has been visited on this day-of-week ≥ 3 times (strong pattern), show a dismissable banner:
     `<div class="adhd-suggestion-banner">📅 You usually work on [Module] on [Day name]. Start there?</div>`
   - Banner contains a direct link to the module workspace.
   - On dismiss (×), store a dismissal flag `adhd_suggestion_dismissed_{YYYY_MM_DD}` so it does not reappear the same day.
   - Show at most one prompt per day.

7. **"Show all modules" toggle**
   - Render a `<button class="adhd-show-all">Show all modules</button>` at the bottom of the inbox.
   - On click, make all hidden sections visible and apply `display: flex` (or whatever the inbox uses).

8. **Privacy / data boundary**
   - All data stays in `localStorage`. No `frappe.call` is made. No module names are sent to the server.
   - Include a "Clear usage history" link in the ADHD Settings Panel (add a call to `clearStore()` in `adhd_settings.js`).

## How to Test

1. Log in with ADHD mode **enabled**. Open the Smart Inbox.
2. Click the "Accounts" module link. Then click "HR". Navigate away and return to the inbox.
3. Open browser DevTools → Application → Local Storage. Confirm `adhd_module_freq_{user}` key exists with visit counts for "Accounts" and "HR" under today's day-of-week.
4. Click "Accounts" two more times (total 3 visits today). Reload the page. Confirm the Accounts section appears first in the inbox (highest rank for today).
5. Confirm a "📌 Your top module today" badge appears on the Accounts section.
6. Confirm a suggestion banner appears: "You usually work on Accounts on [today's day name]. Start there?" (requires ≥ 3 visits on the same day-of-week).
7. Dismiss the banner (×). Reload. Confirm it does not reappear on the same calendar day.
8. In ADHD Settings Panel, click "Clear usage history". Confirm `adhd_module_freq_{user}` is deleted from localStorage and the inbox reverts to default order.
9. Simulate 30+ distinct session dates by directly editing `adhd_session_dates` in localStorage to include 30 past dates. Reload. Confirm modules with zero visits are hidden and a "Show all modules" button appears.
10. Click "Show all modules". Confirm all sections become visible.

## Acceptance Criteria
- [ ] Module visit frequency is recorded in localStorage on each navigation.
- [ ] Smart Inbox sections are reordered by frequency for the current day-of-week.
- [ ] Top-ranked section displays a "Your top module today" badge.
- [ ] Time-of-week suggestion banner appears when a module has ≥ 3 visits on the current day-of-week.
- [ ] Banner is dismissed per calendar day and does not reappear that day.
- [ ] Modules with zero visits after 30 session dates are hidden by default.
- [ ] "Show all modules" toggle reveals hidden sections.
- [ ] "Clear usage history" removes all tracking data from localStorage.
- [ ] No network requests are made for frequency tracking.

## Dependencies
- Blocked by: ADHD-002 (Smart Inbox must exist)
- Blocks: none
- Related: ADHD-016 — "Clear usage history" action in settings panel

## Complexity
M — requires client-side frequency tracking, DOM reordering, and multi-condition suggestion logic; no server work.

## Phase
Phase 5 — Personalisation & Observability
