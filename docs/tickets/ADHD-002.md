# ADHD-002: Smart Inbox — "Your Day At a Glance"

## Current implementation record

- **Status:** Implemented.
- **Implementation:** `erpnext/public/js/adhd/adhd_smart_inbox.js` and `erpnext/setup/page/focus_inbox/` (route `focus-inbox`; it was `adhd-inbox`, and the old route still redirects).
- **Verification:** No ticket-specific automated test; site and browser behavior remain unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

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
- `erpnext/setup/workspace/adhd_home/adhd_home.json` (Frappe Workspace definition, or a new custom Page if Workspace JSON is insufficient)

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-inbox-*` styles

## What Needs to Be Done

1. **Create a new Frappe Workspace (or Page).**
   - Name: `"ADHD Inbox"`, icon: `calendar-check`, module: `"ERPNext"`.
   - Set it as the homepage for users who have `adhd_mode` enabled. Hook this via `frappe.boot` post-login redirect: if `frappe.boot.adhd_mode && frappe.boot.desk_settings?.home_page !== "ADHD Inbox"`, redirect with `frappe.set_route("page", "adhd-inbox")`.
   - Export the Workspace JSON to `erpnext/setup/workspace/adhd_home/adhd_home.json` for version control.

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

---

## LLM Implementation Guide

### Codebase Context for the Model

```text
Project: ERPNext (Frappe framework), JavaScript frontend + Python backend.
Key patterns:
- All client scripts use `frappe.ui.form.on("DocType", { hook(frm) {} })`.
- ADHD mode is active when `frappe.boot.adhd_mode === true`.
- `frappe.call({ method, args, callback })` is the standard async API call.
- `frappe.model.add_child(frm.doc, childDoctype, fieldname)` adds child table rows.
- `frm.refresh_field(fieldname)` syncs model → DOM for a field.
- `localStorage.setItem / getItem / removeItem` is used for client-side persistence.
- All JS files are included via `hooks.py` under `app_include_js` or `doctype_js`.
- CSS lives in `erpnext/public/scss/adhd_mode.scss` using CSS custom properties (vars).
- Python whitelisted methods use `@frappe.whitelist()` and are called via dotted module path.
- frappe.db.get_list / frappe.client.get_list return arrays of dicts.
- Frappe dialogs: `new frappe.ui.Dialog({ title, fields, primary_action })`.
```

---

### Prompt Chain (M ticket — 2 steps)

**Step 1 — Scaffold: Page/Workspace structure + panel layout**

```text
You are implementing ADHD-002 for ERPNext: "Smart Inbox — Your Day At a Glance". In this step, scaffold the page/workspace and render the three panel containers. Do NOT fetch real data yet.

--- CODEBASE CONTEXT ---
- ERPNext on Frappe. ADHD mode: `frappe.boot.adhd_mode === true`.
- New Frappe Page: defined in Python under `erpnext/{module}/page/{page_name}/` with `{page_name}.py`, `{page_name}.js`, `{page_name}.json`.
- Alternatively, use a Workspace with a custom page slot.
- `frappe.call({ method, args, callback })` for API calls.
- `localStorage.getItem/setItem` for Resume panel persistence.
- CSS: `erpnext/public/scss/adhd_mode.scss`.
--- END CONTEXT ---

FILES TO CREATE:
1. `erpnext/public/js/adhd/adhd_smart_inbox.js` — main JS
2. `erpnext/public/scss/adhd_mode.scss` additions — `.adhd-inbox-panel`, `.adhd-inbox-row`

WHAT TO BUILD:
- Create a `renderSmartInbox(wrapper)` function that injects three panel `<div>` elements into the given wrapper:
  - Panel 1: `.adhd-panel-overdue` — title "⚠️ Overdue & Due Today"
  - Panel 2: `.adhd-panel-awaiting` — title "⏳ Awaiting Your Action"
  - Panel 3: `.adhd-panel-resume` — title "▶ Resume Where You Left Off"
- Each panel has a `.adhd-panel-body` div where rows will be injected.
- Add a loading skeleton (three grey bars) inside each panel body as placeholder.
- Wire the page/workspace entry point to call `renderSmartInbox` when ADHD mode is on.
- In CSS: panels in a responsive flex/grid layout, mobile-first.

Stop here — data fetching is Step 2.
```

**Step 2 — Wire Logic: Data fetching + Resume persistence**

```text
Continuing ADHD-002. The three panel containers are rendered. Now fetch real data and populate them.

--- CODEBASE CONTEXT ---
- `frappe.call({ method: "frappe.client.get_list", args: { doctype, filters, fields, order_by, limit }, callback })` fetches lists.
- Doctypes to query: Task, ToDo, Sales Order, Purchase Order, Sales Invoice, Leave Application.
- For "Overdue/Due Today": filter by `due_date <= today` and `status != "Closed"/"Completed"`.
- For "Awaiting Action": filter `workflow_state` for states that block on the current user.
- Resume panel: read `localStorage.getItem("adhd_resume_docs")` — a JSON array of `{ doctype, docname, title, timestamp }` objects. Write on every form open via a separate hook in `adhd_mode.js`.
- `frappe.utils.get_form_link(doctype, name)` generates a clickable form link.
--- END CONTEXT ---

FILES TO MODIFY:
- `erpnext/public/js/adhd/adhd_smart_inbox.js`

WHAT TO ADD:
- `fetchOverdueDocs()` — calls `frappe.client.get_list` for Task (due_date, status) and Sales Invoice (due_date, outstanding_amount > 0). Renders each as a `.adhd-inbox-row` with a link and due-date badge.
- `fetchAwaitingAction()` — calls `frappe.client.get_list` for Sales Order and Purchase Order filtered by `workflow_state IN ("Pending Approval", "To Receive")`. Renders similarly.
- `loadResumeDocs()` — reads `localStorage.getItem("adhd_resume_docs")`, parses JSON, renders last 5 entries with timestamps. Provides a "Clear" button that calls `localStorage.removeItem("adhd_resume_docs")`.
- Call all three functions after `renderSmartInbox` completes. Replace loading skeletons with real rows.

ACCEPTANCE CRITERIA:
- [ ] Panel 1 shows Tasks and Sales Invoices overdue or due today.
- [ ] Panel 2 shows Sales Orders and Purchase Orders awaiting action.
- [ ] Panel 3 reads from `localStorage` key `adhd_resume_docs` and shows last 5 entries.
- [ ] "Clear" button on Resume panel calls `localStorage.removeItem("adhd_resume_docs")`.
- [ ] Each row links to the document via `frappe.utils.get_form_link`.
- [ ] All panels show "Nothing here 🎉" when empty.
- [ ] Feature is inert when `frappe.boot.adhd_mode !== true`.
- [ ] Page/workspace registered and accessible from the nav.
```

---

### Prompt for Claude (Anthropic)

```text
I'm building ADHD-002 "Smart Inbox — Your Day At a Glance" for ERPNext. This is a new page/workspace that shows three panels to help ADHD users orient themselves at the start of their day.

Codebase context:
- ERPNext on Frappe framework. ADHD mode: `frappe.boot.adhd_mode === true`.
- `frappe.call({ method: "frappe.client.get_list", args: { doctype, filters, fields, limit }, callback })` for data.
- `localStorage.getItem/setItem/removeItem` for client-side persistence.
- `frappe.utils.get_form_link(doctype, name)` for document links.
- CSS: `erpnext/public/scss/adhd_mode.scss`.
- JS included via `hooks.py` → `app_include_js`.

Please implement:

**`erpnext/public/js/adhd/adhd_smart_inbox.js`** containing:
- `renderSmartInbox(wrapper)` — creates three panels inside wrapper:
  1. "⚠️ Overdue & Due Today" — fetches Tasks with `due_date <= today` and status not Closed/Completed, plus Sales Invoices with `due_date <= today` and `outstanding_amount > 0`. Use `frappe.client.get_list`.
  2. "⏳ Awaiting Your Action" — fetches Sales Orders and Purchase Orders with `workflow_state IN ("Pending Approval", "To Receive")`.
  3. "▶ Resume Where You Left Off" — reads `localStorage.getItem("adhd_resume_docs")` (JSON array of `{ doctype, docname, title, timestamp }`), shows last 5 with timestamps and a "Clear" button.
- Each row is a `.adhd-inbox-row` div with a clickable link from `frappe.utils.get_form_link` and a status badge.
- Empty state: show "Nothing here 🎉" per panel.

**`erpnext/public/scss/adhd_mode.scss` additions:**
- `.adhd-smart-inbox` wrapper: responsive flex/grid, 3 columns on desktop, single column mobile.
- `.adhd-inbox-panel`: card style with header and body.
- `.adhd-inbox-row`: flex row with link on left, badge on right.

**`erpnext/hooks.py`:** add `adhd_smart_inbox.js` to `app_include_js`.

Think about: how to avoid the page feeling overwhelming — panels should load with a skeleton before data arrives. Walk me through your approach before writing code, then produce the complete implementation.

Verify before finishing:
- [ ] All three panels present with correct data sources
- [ ] Resume panel uses localStorage key `adhd_resume_docs`
- [ ] Empty states handled gracefully
- [ ] Fully inert when ADHD mode is off
```

---

### Prompt for GPT-4o (OpenAI)

```text
## Task
Implement ADHD-002: Smart Inbox "Your Day At a Glance" for ERPNext/Frappe.

## Codebase Context
- Frappe client API: `frappe.call({ method: "frappe.client.get_list", args: { doctype, filters, fields, limit }, callback })`.
- ADHD mode guard: `frappe.boot.adhd_mode === true`.
- localStorage persistence: `localStorage.getItem/setItem/removeItem("adhd_resume_docs")`.
- Resume data shape: JSON array of `{ doctype, docname, title, timestamp }`.
- Document links: `frappe.utils.get_form_link(doctype, name)`.
- CSS: `erpnext/public/scss/adhd_mode.scss`.

## Files to Create/Modify
1. **CREATE** `erpnext/public/js/adhd/adhd_smart_inbox.js`
2. **MODIFY** `erpnext/public/scss/adhd_mode.scss`
3. **MODIFY** `erpnext/hooks.py` — add to `app_include_js`

## Panel Specifications

### Panel 1 — Overdue & Due Today
- Sources: Task (`due_date`, `status`), Sales Invoice (`due_date`, `outstanding_amount`)
- Filters: `due_date <= frappe.datetime.get_today()`, status not in ["Closed", "Completed"]
- Fields to show: name, subject/title, due_date

### Panel 2 — Awaiting Your Action
- Sources: Sales Order, Purchase Order
- Filters: `workflow_state in ["Pending Approval", "To Receive"]`
- Fields: name, customer/supplier, workflow_state

### Panel 3 — Resume Where You Left Off
- Read from `localStorage.getItem("adhd_resume_docs")` → parse JSON
- Show last 5 entries with relative timestamps
- "Clear" button: `localStorage.removeItem("adhd_resume_docs")`

## Acceptance Checklist
- [ ] Three panels render correctly with data from correct sources
- [ ] Panel 1 uses Task + Sales Invoice with due_date filter
- [ ] Panel 2 uses Sales Order + Purchase Order with workflow_state filter
- [ ] Panel 3 reads localStorage key `adhd_resume_docs`, shows last 5
- [ ] "Clear" button removes localStorage key
- [ ] Each panel shows "Nothing here 🎉" when empty
- [ ] Loading skeleton shown before data arrives
- [ ] Feature fully inert when `frappe.boot.adhd_mode` is false
- [ ] hooks.py updated
```

---

### Prompt for Gemini 1.5 Pro (Google)

```text
Implement ADHD-002: Smart Inbox "Your Day At a Glance" for ERPNext. Follow each step.

## Context
- ERPNext on Frappe. ADHD guard: `if (!frappe.boot.adhd_mode) return;`
- List API: `frappe.call({ method: "frappe.client.get_list", args: { doctype, filters, fields, limit_page_length: 10 }, callback })`
- Links: `frappe.utils.get_form_link(doctype, name)` returns an `<a>` tag string.
- Resume localStorage key: `"adhd_resume_docs"` — stores JSON array of `{ doctype, docname, title, timestamp }`.
- CSS: `erpnext/public/scss/adhd_mode.scss`.

## Step-by-Step

### Step 1: Create `erpnext/public/js/adhd/adhd_smart_inbox.js`

1. Export `function renderSmartInbox(wrapper)`.
2. Inject `<div class="adhd-smart-inbox">` into wrapper with three child divs: `.adhd-panel-overdue`, `.adhd-panel-awaiting`, `.adhd-panel-resume`. Each has a `<h4>` title and a `.adhd-panel-body`.
3. Show loading skeleton (3 grey bars via CSS class `.adhd-skeleton`) in each panel body.

### Step 2: Implement `fetchOverdueDocs(panelEl)`
- Call `frappe.client.get_list` for Task: fields `["name","subject","due_date","status"]`, filters `[["due_date","<=",frappe.datetime.get_today()],["status","not in",["Closed","Completed"]]]`.
- Also call for Sales Invoice: fields `["name","customer","due_date","outstanding_amount"]`, filters `[["due_date","<=",today],["outstanding_amount",">",0]]`.
- Merge results; render each as `.adhd-inbox-row`; replace skeleton. Show "Nothing here 🎉" if empty.

### Step 3: Implement `fetchAwaitingAction(panelEl)`
- Call `frappe.client.get_list` for Sales Order and Purchase Order, filter `workflow_state in ["Pending Approval","To Receive"]`.
- Render rows similarly.

### Step 4: Implement `loadResumeDocs(panelEl)`
- Read `localStorage.getItem("adhd_resume_docs")`; parse JSON (handle null/malformed gracefully).
- Render last 5 entries as `.adhd-inbox-row` with `frappe.utils.get_form_link` and relative timestamp.
- Add "Clear" button: on click `localStorage.removeItem("adhd_resume_docs")` then re-render empty state.

### Step 5: Add CSS to `adhd_mode.scss`
- `.adhd-smart-inbox`: CSS grid, 3 columns ≥992px, 1 column below.
- `.adhd-inbox-panel`: card with border, padding, header background.
- `.adhd-inbox-row`: flex, space-between, `gap: 8px`.
- `.adhd-skeleton`: grey animated shimmer.

### Step 6: Update `hooks.py`
Add `"erpnext/public/js/adhd/adhd_smart_inbox.js"` to `app_include_js`.

## Verify Before Submitting
- [ ] Three panels render with correct data sources
- [ ] Panel 1: Task + Sales Invoice, due_date filter
- [ ] Panel 2: Sales Order + Purchase Order, workflow_state filter
- [ ] Panel 3: localStorage `adhd_resume_docs`, last 5, Clear button
- [ ] Empty states show "Nothing here 🎉"
- [ ] Skeleton shown before data loads
- [ ] ADHD guard present
- [ ] CSS added, hooks.py updated
```

---

### Self-Validation Prompt

```text
Review the ADHD-002 implementation and answer:

1. Does Panel 1 fetch from both Task AND Sales Invoice — not just one?
2. Does Panel 2 filter `workflow_state` rather than just `status`?
3. Does the Resume panel handle `localStorage.getItem("adhd_resume_docs")` returning `null` without throwing?
4. Does the "Clear" button call `localStorage.removeItem` with the exact key `"adhd_resume_docs"`?
5. Are loading skeletons replaced (not just hidden) when real data arrives?
6. Does each panel display an empty-state message when its data array is length 0?
7. Is there an ADHD mode guard at the entry point that prevents any rendering when `frappe.boot.adhd_mode` is falsy?
8. Is `adhd_smart_inbox.js` added to `hooks.py`?

Fix any issues before delivering.
```
