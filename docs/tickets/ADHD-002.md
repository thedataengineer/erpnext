# ADHD-002: Smart Inbox — "Your Day At a Glance"

## Summary
An opt-in ADHD Workspace homepage that consolidates overdue/due-today items, documents awaiting the user's action, and a "Resume" panel showing the last three edited documents — replacing the need to mentally reconstruct the day's priorities from scattered list views.

## Background / Context
Standard ERPNext presents no unified daily view; users must visit six or more modules to assess their workload. For ADHD users, this fragmentation means the morning starts with a costly mental assembly task before any real work can begin. Task-switching between modules to "check what needs doing" is itself an interruption loop that consumes the limited executive-function budget before noon. The Smart Inbox collapses that survey into a single screen.

## Cognitive Mechanism
Working memory | initiation | attention switching

## Prerequisites
- ADHD-001 (Workflow Wizard — Document Chain Navigator) must be shipped so the "Resume" panel links open documents that also show the chain navigator, giving a coherent experience.
- ADHD mode toggle (`adhd_mode.js`, Phase 1) must be active.

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_smart_inbox.js`
- `erpnext/public/js/adhd/adhd_smart_inbox.html` (Mustache/Jinja template for panel markup)
- `erpnext/adhd_workspace/adhd_workspace.json` (Frappe Workspace definition, or a new custom Page if Workspace JSON is insufficient)

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-inbox-*` styles

## What Needs to Be Done

1. **Create a new Frappe Workspace (or Page).**
   - Name: `"ADHD Inbox"`, icon: `calendar-check`, module: `"ERPNext"`.
   - Set it as the homepage for users who have `adhd_mode` enabled. Hook this via `frappe.boot` post-login redirect: if `frappe.boot.adhd_mode && frappe.boot.desk_settings?.home_page !== "ADHD Inbox"`, redirect with `frappe.set_route("page", "adhd-inbox")`.
   - Export the Workspace JSON to `erpnext/adhd_workspace/adhd_workspace.json` for version control.

2. **Panel 1 — Overdue / Due Today.**
   Build `loadUrgentItems()` which calls a single `frappe.call` to a new whitelisted Python endpoint `erpnext.adhd.get_urgent_items(user)` (see step 6). The endpoint returns a flat list sorted by urgency score. Render as a `<ul class="adhd-inbox-urgent">` where each `<li>` shows: urgency badge (🔴 overdue / 🟡 due today), doctype icon, document name, and counterparty (customer/supplier/assigned-to). Each item is a single `<a>` tag navigating via `frappe.set_route("Form", doctype, name)`.

3. **Panel 2 — Awaiting Your Action.**
   Build `loadActionQueue()` via `frappe.call("erpnext.adhd.get_action_queue", { user: frappe.session.user })`. Returns: open ToDos assigned to current user, documents in the user's approval workflow stage, and Leave Applications pending HR approval (if user has HR role). Render as `.adhd-inbox-action` list with a type badge ("Approval", "ToDo", "Leave") and a single-click action link.

4. **Panel 3 — Resume.**
   Build `loadResumeItems()` reading `localStorage.getItem("adhd_recent_docs")` — a JSON array of `{ doctype, name, title, timestamp }` objects written by a `frappe.ui.form.on("*", { after_save })` listener (max 10 entries, deduplicated by `doctype+name`, sorted by timestamp desc). Display the last 3. Each item shows doctype badge, document title, and time-ago string (`frappe.datetime.prettyDate(timestamp)`). Single-click opens the form.

5. **localStorage writer.** In `adhd_smart_inbox.js`, register a universal after-save hook:
   ```js
   frappe.router.on("change", () => {
     const route = frappe.get_route();
     if (route[0] === "Form" && route[1] && route[2]) {
       const existing = JSON.parse(localStorage.getItem("adhd_recent_docs") || "[]");
       const entry = { doctype: route[1], name: route[2], title: frappe.get_route_str(), timestamp: new Date().toISOString() };
       const updated = [entry, ...existing.filter(e => !(e.doctype === entry.doctype && e.name === entry.name))].slice(0, 10);
       localStorage.setItem("adhd_recent_docs", JSON.stringify(updated));
     }
   });
   ```

6. **Python endpoint `erpnext/adhd/get_urgent_items.py` (or inline in `erpnext/adhd/api.py`).**
   - Whitelisted with `@frappe.whitelist()`.
   - Queries: open Sales Orders with `delivery_date <= today`, open Sales Invoices with `due_date <= today`, open Purchase Orders with `schedule_date <= today`, open Tasks with `exp_end_date <= today` assigned to the current user.
   - Adds an `urgency_score`: overdue = 10 + days_overdue, due today = 5.
   - Returns JSON list sorted by `urgency_score` descending, limited to 20 rows.

7. **Refresh button and auto-refresh.** Add a "↻ Refresh" button in the page header. Also auto-refresh Panel 1 and 2 every 5 minutes using `setInterval` (clear on page unmount via `frappe.router.on("change", clearInterval)`).

8. **Empty states.** Each panel must show a friendly empty state:
   - Panel 1: "🎉 Nothing overdue or due today."
   - Panel 2: "✅ No pending approvals or todos."
   - Panel 3: "Open any document to start tracking your session."

9. **Guard behind ADHD mode.** If `!frappe.boot.adhd_mode`, render nothing and redirect to the standard desk.

## How to Test

1. Enable ADHD mode. Log out and log back in. Confirm the browser lands on the ADHD Inbox page rather than the standard desk.
2. Create a Sales Order with `delivery_date = yesterday`. Reload the inbox. Confirm the order appears in Panel 1 with a 🔴 badge.
3. Create a Task assigned to your user with `exp_end_date = today`. Confirm it appears in Panel 1 with a 🟡 badge.
4. Create a ToDo assigned to your user. Confirm it appears in Panel 2 with a "ToDo" badge.
5. Open three different form documents (e.g., a Customer, an Item, a Sales Order) and save each. Return to the inbox. Confirm all three appear in Panel 3 in reverse-chronological order.
6. Click any item in Panel 1. Confirm navigation opens the correct form at a single click.
7. Disable ADHD mode. Reload. Confirm the ADHD Inbox page either disappears from nav or redirects to the standard home.
8. Wait 5 minutes (or shorten the interval in dev) and confirm Panels 1 and 2 refresh without a page reload.
9. Resolve the overdue Sales Order (submit/cancel). Refresh the inbox. Confirm it no longer appears in Panel 1.

## Acceptance Criteria
- [ ] Landing page after login is the ADHD Inbox when ADHD mode is enabled.
- [ ] Panel 1 lists all overdue and due-today documents across Sales Order, Purchase Order, Sales Invoice, Task — sorted by urgency score.
- [ ] Overdue items carry a 🔴 badge; due-today items carry a 🟡 badge.
- [ ] Panel 2 lists all open ToDos and approval-queue items assigned to the current user.
- [ ] Panel 3 shows the last 3 edited documents pulled from localStorage; items are single-click navigable.
- [ ] Every item in all three panels opens the correct form on a single click.
- [ ] Each panel has a functional empty state message when no items qualify.
- [ ] Panels 1 and 2 auto-refresh every 5 minutes.
- [ ] The page does not appear or redirect when ADHD mode is disabled.
- [ ] No console errors on page load or refresh.

## Dependencies
- **Blocked by:** ADHD-001 (for resume panel coherence), ADHD mode toggle (Phase 1, shipped)
- **Blocks:** None directly; foundational for user orientation in subsequent Phase 2 tickets

## Complexity
M — Three data sources with different query shapes, a Python endpoint, localStorage state management, and Workspace/Page registration; no novel architectural risk.

## Phase
Phase 2 — Core Workflow Clarity
