# ADHD-Friendly ERPNext: Product Roadmap

> **Status**: Living document. Last updated after Phase 1 merge.
> **Audience**: Contributors, maintainers, and product stakeholders.
> **Scope**: Everything beyond Phase 1 (shipped) and the Conversational CRM bar (in-flight).

---

## Table of Contents

1. [Problem Framing](#1-problem-framing)
2. [What Has Already Shipped](#2-what-has-already-shipped)
3. [Gap Analysis](#3-gap-analysis)
4. [Phased Roadmap](#4-phased-roadmap)
   - [Phase 2 — Reduce Initiation Cost](#phase-2--reduce-initiation-cost)
   - [Phase 3 — Build Time Awareness Into the UI](#phase-3--build-time-awareness-into-the-ui)
   - [Phase 4 — Tame Complexity in High-Friction Modules](#phase-4--tame-complexity-in-high-friction-modules)
   - [Phase 5 — Personalisation and Adaptive Scaffolding](#phase-5--personalisation-and-adaptive-scaffolding)
5. [Definition of Done](#5-definition-of-done)
6. [Risks and Anti-Patterns](#6-risks-and-anti-patterns)

---

## 1. Problem Framing

ERPNext is powerful and comprehensive, and those two facts are exactly what make it hostile to ADHD users. Below is a direct mapping of the six core ADHD cognitive challenges to the places in ERPNext where they hurt most.

### 1.1 Working Memory Overload

**What it is**: ADHD working memory is genuinely impaired — roughly equivalent to someone with two fewer working memory slots than a neurotypical adult. Holding context while navigating is physiologically harder, not a preference.

**Where ERPNext hits hardest**:
- **Sales Order → Sales Invoice → Payment Entry** chain: three separate form submissions, each requiring re-entry of the same party, project, and cost center fields that were already on the previous document. The link from parent to child is implicit, not displayed.
- **Purchase workflow** (`Purchase Requisition → Purchase Order → Purchase Receipt → Purchase Invoice`): a four-step chain where any missed step causes downstream validation failures with no plain-language explanation of what went wrong or what to do next.
- **Journal Entry**: up to 20+ line items, each requiring a ledger account, cost center, and debit/credit amount. No running total. No indication that the entry is unbalanced until submit.
- **BOM / Manufacturing Workorder**: nested BOM trees with sub-assemblies mean users must hold the entire tree topology in mind while building operations.

### 1.2 Attention Switching Cost

**What it is**: Task-switching is disproportionately expensive for ADHD brains. Every modal, notification, required field that blocks submission, or breadcrumb hop that navigates away forces a context switch that can cost several minutes of re-orientation.

**Where ERPNext hits hardest**:
- **Mandatory field blocking**: ERPNext shows all mandatory fields (often 10–20) at once and blocks save. Users who reach a field they don't know get stuck mid-record — then wander into a search for the answer and lose the form context.
- **List view → form → back to list**: Frappe navigates back to page 1 of the list view after every save. If a user is triaging 40 open Sales Orders, every single record forces a re-scroll and re-filter.
- **Notification overload**: the default ERPNext notification system fires for workflow transitions, mentions, assignments, and system events simultaneously. Each notification is a potential attention hijack.
- **Report drill-down**: reports open in new tabs or navigate away, breaking the train of thought.

### 1.3 Task Initiation Paralysis

**What it is**: Starting a task — especially an ambiguous or multi-step one — is a disproportionate barrier. The brain delays because it cannot immediately map "what I need to do" to "which button to click."

**Where ERPNext hits hardest**:
- **Empty workspace**: after login the default workspace is a wall of shortcuts and charts with no answer to "what should I do right now?"
- **Month-end accounting close**: the sequence (reconcile bank → review debtors → post provisions → close period → run P&L) is undocumented in the UI. Every step requires navigating to a different module from scratch.
- **Onboarding new vendors**: involves creating a `Supplier`, filling mandatory bank details, setting payment terms, linking an address, and creating a `Supplier Group` — none of which is surfaced as a checklist.
- **Employee onboarding in HR**: `Employee` → `Employee Education` → `Employee Address` → `Salary Structure Assignment` → `Leave Allocation` is a 5-step workflow with no wizard.

### 1.4 Time Blindness

**What it is**: ADHD impairs prospective memory (remembering to do things at a future time) and the subjective sense of time passing. "I'll do it in five minutes" reliably becomes two hours.

**Where ERPNext hits hardest**:
- **Due dates on Sales Orders, Tasks, Purchase Orders**: they exist as fields but there is no ambient UI element that communicates urgency or impending breach without the user actively running a report.
- **Timesheet logging** (`projects/doctype/timesheet`): must be created manually, requires knowing the Activity Type and Project, and is almost never completed accurately because the prompt comes too late.
- **Payment due dates**: a Sales Invoice's payment terms generate a `Payment Schedule` child table, but nothing in the standard UI sends a pre-due nudge or shows overdue status prominently in context.
- **Leave applications and payroll deadlines**: HR module due dates are invisible unless a report is run.

### 1.5 Hyperfocus Traps

**What it is**: ADHD hyperfocus locks attention onto one task to the exclusion of everything else. In software, this manifests as spending an hour configuring a BOM instead of the ten minutes of actual work that was needed.

**Where ERPNext hits hardest**:
- **Item master configuration**: `Item` form has 12+ tabs (General, Attributes, Variants, Sales, Purchase, Accounting, Manufacturing, Quality, Reorder, Website, Variants, History). It is a rabbit hole. Users fall in while trying to add one item.
- **Chart of Accounts / accounting configuration**: infinitely deep tree of ledger accounts. Easy to spend hours restructuring it.
- **Report configuration and custom Print Formats**: the Jinja templating and field configuration is an inviting technical challenge that pulls users away from operational tasks.

### 1.6 Rejection Sensitivity (RSD)

**What it is**: Many ADHD users experience Rejection Sensitive Dysphoria — error messages and blocking validations feel sharper and more distressing than they do for neurotypical users.

**Where ERPNext hits hardest**:
- **Validation error dialogs**: "Please fill in all mandatory fields" with a red list, no guidance on what the fields mean or how to find the right value.
- **Submit-blocked workflows**: a document cannot be submitted because a linked document upstream isn't submitted yet. The error names the technical doctype, not the workflow step.
- **Permission errors**: "Not permitted" with no explanation of why, or who to ask.
- **Frappe validation exceptions** that surface as unformatted stack traces in some edge cases.

---

## 2. What Has Already Shipped

*Phase 1 — Foundation layer, merged to `develop`.*

| Feature | File | What it does |
|---|---|---|
| ADHD Mode toggle | `public/js/adhd/adhd_mode.js` | `Alt+A` toggles body class + `data-adhd-mode`; persisted in `localStorage`; navbar 🧠 button |
| Focus Panel | `public/js/adhd/focus_panel.js` | Slide-out panel with 25-min Pomodoro (work/break cycles) + priority task list from ERPNext `Task` doctype |
| Task Kanban | `public/js/adhd/task_kanban.js` | Drag-drop board (To Do → In Progress → Review → Done), project filter, search, quick-add |
| Form Focus | `public/js/adhd/form_focus.js` | Per-field help tooltips for ~25 known fields; color-coded breadcrumb for 9 doctypes; 60-second autosave |
| ADHD Notifications | `public/js/adhd/adhd_notifications.js` | Timed, non-intrusive nudges |

*In-flight — branch ready, not yet merged.*

| Feature | Files | What it does |
|---|---|---|
| Conversational CRM command bar | `public/js/assistant/`, `erpnext/assistant/` | `Cmd/Ctrl+K` opens a natural-language input; voice support; context-aware pre-fill from current page; local Ollama inference; draft preview before any save; 1,071 lines of tests |

---

## 3. Gap Analysis

Phase 1 nailed the foundation: the toggle infrastructure is solid, the Pomodoro and Kanban address focus and task management, and the command bar (in-flight) directly attacks initiation paralysis for CRM. What's still missing falls into five categories.

### 3.1 "What do I do next?" is still unanswered

The Focus Panel shows tasks but doesn't contextualise them inside ERPNext's own workflows. A user who finishes a task still has to know independently that the next step is submitting a Purchase Order or reconciling a bank statement. There is no "next action" suggestion tied to the state of ERPNext documents.

**Specific gaps:**
- No guided workflow for Sales Order → Invoice → Payment chain
- No guided workflow for month-end close sequence in Accounts
- No progress indicator on multi-step document chains
- No "smart inbox" that surfaces what is genuinely overdue or blocked

### 3.2 Time blindness has no in-UI remedy

The Pomodoro timer helps with work session time awareness, but nothing addresses *task deadline* time awareness. Overdue tasks, due invoices, expiring quotations, and missed payment schedules are invisible unless a report is run.

**Specific gaps:**
- No ambient due-date urgency in list views or workspaces
- No automatic time-log prompt when Pomodoro completes and a task was active
- Timesheet creation is still 100% manual
- No "payment due in 3 days" nudge surfaced contextually on the `Sales Invoice` form

### 3.3 Form complexity is barely touched

`form_focus.js` adds tooltips to ~25 fields and autosaves. But the fundamental problem — too many fields visible at once, too many mandatory fields with no guidance — is untouched.

**Specific gaps:**
- No progressive disclosure: all fields are still visible simultaneously
- No "just the essentials" mode that hides optional fields by default
- Field tooltip coverage is ~25 of hundreds of fields across all doctypes
- Mandatory field blocking is unchanged: submit still fails with a red list, not a guided flow
- The `Journal Entry` balance indicator doesn't exist
- No contextual next-step suggestion at the bottom of submitted forms

### 3.4 High-friction modules are entirely unaddressed

The command bar is CRM-only (Leads, Opportunities). Accounts, Buying, HR, and Manufacturing are zero-percent covered by any ADHD affordance beyond the global form tooltips.

**Specific gaps:**
- `Payment Entry` form: no guided matching of invoices to payment
- `Bank Reconciliation Tool`: no step-by-step guidance
- `Purchase Order`: no "where is this in the approval chain" visibility
- `Salary Structure` / `Leave Allocation`: no HR onboarding wizard
- `Work Order` / `BOM`: no hyperfocus-trap warning or time-box suggestion

### 3.5 Personalisation is nonexistent

The entire ADHD mode is binary (on/off). Different ADHD users have different profiles: some have severe time blindness but good working memory; some hyperfocus constantly but rarely miss deadlines. There is no way to tune which affordances are active.

**Specific gaps:**
- No per-feature toggle (e.g. "I want the Pomodoro but not the task nudges")
- No "ADHD Profile" that remembers which modules a user works in most
- No learning loop: the system doesn't adjust based on which tooltips the user actually reads
- No keyboard shortcut reference panel

---

## 4. Phased Roadmap

### Phase 2 — Reduce Initiation Cost

**Theme**: Make it obvious what to do next, at every point in the UI. Attack task-initiation paralysis and working-memory overload in the workflows users hit every day.

**Why this phase first**: Phases 1 + in-flight handle focus *during* work. Phase 2 handles the harder problem: *starting* work. Initiation paralysis is the most reported ADHD blocker in productivity software, and it compounds every other phase — if users can't start, nothing else matters. It also has a high surface-area-to-effort ratio: guided checklists and next-step prompts are relatively low-complexity to build but produce immediate, observable relief.

---

#### 2.1 Workflow Wizard: Document Chain Navigator

**Problem**: The Sales Order → Delivery Note → Sales Invoice → Payment Entry chain, and the Purchase Requisition → Purchase Order → Purchase Receipt → Purchase Invoice chain, are invisible as sequences. Each step requires independent navigation.

**Feature**: A persistent "chain progress bar" that appears on any document that is part of a known workflow chain. Shows all steps, marks completed ones, highlights the current step, and provides a single "Create Next Step" button that pre-fills the downstream document with all transferable fields.

The progress bar is rendered server-side (Python, hooked into `Form.after_save`) and requires no new doctype — it reads `docstatus` and linked `name` fields that already exist.

**Complexity**: M

**Scope**: `selling/`, `buying/`, `accounts/` — Sales Order, Purchase Order, Sales Invoice, Purchase Invoice, Purchase Receipt, Delivery Note, Payment Entry.

---

#### 2.2 Smart Inbox: "Your Day At a Glance"

**Problem**: The default ERPNext workspace after login gives no answer to "what should I do right now?" Charts and module shortcuts require the user to already know what they're looking for.

**Feature**: An opt-in ADHD Workspace (settable as homepage via `User > Default Workspace`) that renders three panels:
1. **Overdue / Due Today**: tasks, Sales Orders with delivery today, invoices due today, purchase orders pending approval — all in one list, sorted by urgency.
2. **Awaiting Your Action**: documents in your queue (assigned to you, pending your approval, or in a workflow state that requires your action).
3. **Resume**: the last 3 documents you were editing, with a "continue" button that opens the form at the last edited field (stored in `localStorage`).

Each item has a single-click action. No navigation required.

**Complexity**: M

**Scope**: Cross-module. Reads from `Task`, `ToDo`, `Sales Order`, `Purchase Order`, `Sales Invoice`, `Leave Application`.

---

#### 2.3 Mandatory Field Wizard: Guided Save

**Problem**: ERPNext blocks save with a red list of missing mandatory fields. Users who hit an unknown field stop dead. The error is a wall, not a guide.

**Feature**: Intercept the mandatory-field validation failure. Instead of a blocking dialog, enter a "guided save" mode: focus the first missing required field, show a plain-English explanation drawn from the same `FIELD_HELP` dictionary that already exists in `form_focus.js` (extended), and show "next missing field →" navigation. The form only needs one field resolved at a time. Save runs again automatically when all required fields are filled.

No new backend required. Intercept `frappe.validated` on the client side.

**Complexity**: S

**Scope**: All forms (global, in `adhd_mode.js` or a new `adhd_form_wizard.js`).

---

#### 2.4 Extend Command Bar Beyond CRM

**Problem**: The conversational command bar (in-flight) only handles CRM records (Lead, Opportunity, Contact, CRM Note). Users in Accounts, Projects, and Buying have the same initiation problem.

**Feature**: Extend the existing `assistant/recipes.py` recipe system with recipes for:
- **Task creation**: "add task: review Q3 budget for project Alpha, high priority" → `Task` draft
- **Expense claim**: "I spent 2400 on taxi to client site today" → `Expense Claim` draft
- **Purchase Request**: "we need 50 units of Item X by next Friday" → `Material Request` draft
- **Time log**: "I just spent 90 minutes on the website redesign project" → `Timesheet Detail` draft

Each recipe follows the same confirm-before-save contract already established. Tests extend `test_crm.py` conventions.

**Complexity**: M (per recipe: S; adding 4 recipes is M total)

**Scope**: `erpnext/assistant/recipes.py`, `erpnext/assistant/test_*.py`.

---

#### 2.5 Keyboard Shortcut Reference Panel

**Problem**: ADHD users benefit disproportionately from keyboard shortcuts (no navigation, no attention switching) but have to memorise them or hunt documentation. There is no discoverable in-app reference.

**Feature**: `Alt+?` opens a modal (or Focus Panel tab) showing all ADHD-mode shortcuts plus the top 20 ERPNext shortcuts, grouped by context (Global, List View, Form, ADHD Mode). Searchable. Dismissible with `Escape`.

**Complexity**: S

**Scope**: `public/js/adhd/adhd_mode.js` + new `adhd_help.js`.

---

### Phase 3 — Build Time Awareness Into the UI

**Theme**: Make time visible, ambient, and non-intrusive. Attack time blindness without creating notification fatigue.

**Why this phase after Phase 2**: Phase 2 ensures users can start and progress through workflows. Phase 3 then adds the temporal layer: deadlines, elapsed time, automatic time logging. Without Phase 2's "what do I do next" scaffolding, time-awareness features land on a user who doesn't know where they are — they'd just be more anxiety-inducing. The correct order is: orientation first, then time pressure.

---

#### 3.1 Ambient Due-Date Heat Map on List Views

**Problem**: Due dates exist as fields but are invisible until the user opens each record. A list of 40 Sales Orders gives no at-a-glance urgency signal.

**Feature**: When ADHD mode is active, list views for `Sales Order`, `Purchase Order`, `Task`, `Sales Invoice`, `Leave Application`, and `Issue` inject a coloured left-border indicator into each row:
- Red: overdue
- Amber: due within 2 days
- Green: due within 7 days
- No border: due later or no due date

The colour is computed client-side from the `delivery_date`, `due_date`, or `expected_end_date` column already present in list results. No new API call required.

**Complexity**: S

**Scope**: `public/js/adhd/` — new `adhd_list_view.js` hooked into `frappe.views.ListView`.

---

#### 3.2 Automatic Time-Log Prompt on Pomodoro Completion

**Problem**: Timesheets are the most-abandoned feature in ERPNext for ADHD users. The cognitive overhead of creating a `Timesheet` record — choosing Activity Type, Project, Task, and duration — is too high after the fact.

**Feature**: When a Pomodoro work session completes and the Focus Panel has an active task, show a one-click time-log prompt:
- Pre-fills `Project` and `Task` from the active Focus Panel task
- Pre-fills `from_time` / `to_time` from the Pomodoro start/end
- Pre-fills `Activity Type` from a user preference (settable once in ADHD settings)
- One "Log Time" button creates the `Timesheet Detail` via `frappe.call`
- One "Skip" button dismisses without logging

Builds on the already-existing `FocusPanel._timerComplete()` hook in `focus_panel.js`.

**Complexity**: S

**Scope**: `public/js/adhd/focus_panel.js`, `projects/doctype/timesheet/`.

---

#### 3.3 Contextual Due-Date Nudges on Document Forms

**Problem**: When a user opens a `Sales Invoice`, `Purchase Order`, or `Task`, there is no ambient signal about whether that document's deadline is approaching or breached.

**Feature**: When ADHD mode is active, inject a non-blocking banner at the top of relevant forms showing:
- For `Sales Invoice`: "Payment due in X days" (computed from `payment_schedule` child table) or "OVERDUE by X days" in red
- For `Sales Order`: "Delivery due in X days" or overdue
- For `Task`: "Task deadline: tomorrow" or overdue
- For `Purchase Order`: "Expected delivery: X days" if `schedule_date` is set

Banner is a single line, dismissible per-session, not per-record. Styled with the ADHD mode CSS variables already in place.

**Complexity**: S

**Scope**: `public/js/adhd/form_focus.js` or a new `adhd_deadline_banner.js`.

---

#### 3.4 Time-Box Suggestions for Hyperfocus-Prone Forms

**Problem**: `Item` master (12 tabs), `Chart of Accounts`, `BOM`, and custom Print Format configuration are rabbit holes. ADHD users fall in and lose 90 minutes on configuration instead of 10 minutes on data entry.

**Feature**: For a predefined set of "rabbit hole" doctypes (`Item`, `Account`, `BOM`, `Print Format`, `Custom Field`), show a subtle, dismissible banner when ADHD mode is active:

> "Heads up: this form has a lot of options. Consider setting a 10-min time-box before diving in."

Include a "Start 10-min timer" button that fires the Pomodoro timer in break-length mode (10 min). After the timer ends, show: "Time's up — did you get what you needed? You can always come back."

**Complexity**: S

**Scope**: `public/js/adhd/form_focus.js`.

---

#### 3.5 Payment Schedule Digest

**Problem**: The `Payment Schedule` child table on `Sales Invoice` shows raw dates and amounts but no sense of "what do I need to collect this week?"

**Feature**: Add a collapsible "Payment Summary" section to the ADHD Focus Panel that shows:
- Total outstanding receivables
- Payments due this week, broken out by customer
- Payments overdue, broken out by customer
- Each line has a "Create Payment Entry" shortcut

Data is fetched from the `Payment Schedule` child table and `Sales Invoice.outstanding_amount` via a single `frappe.call` to a new lightweight API endpoint in `accounts/services/`.

**Complexity**: M

**Scope**: `public/js/adhd/focus_panel.js`, new `erpnext/accounts/services/adhd_payment_digest.py`.

---

### Phase 4 — Tame Complexity in High-Friction Modules

**Theme**: Apply targeted cognitive scaffolding inside the three modules with the steepest ADHD learning cliffs: Accounts, Buying, and HR. Each gets a focused "essential workflow" overlay, not a redesign.

**Why this phase after Phase 3**: Phases 2–3 address global friction. Phase 4 is module-specific surgery. By this point, users have orientation (Phase 2) and time awareness (Phase 3). What remains is the deep-module complexity that blocks them from doing their actual job. This is higher-effort because it requires module-specific domain knowledge, hence it comes after the high-leverage global work.

---

#### 4.1 Accounts: Journal Entry Balance Indicator

**Problem**: `Journal Entry` requires a balanced debit/credit total. Users submit and get a validation error. There is no live feedback as they type.

**Feature**: When ADHD mode is active and the current form is `Journal Entry`, inject a live balance meter below the `Accounts` child table:
- Shows "Debit: ₹X | Credit: ₹Y | Difference: ₹Z"
- Difference cell turns green when balanced, red when not
- Updates in real-time on each cell edit (hook `frm.get_field('accounts').grid` datatable change event)
- A small "Balanced ✓" indicator appears in the form's status bar when ready to submit

**Complexity**: S

**Scope**: `accounts/doctype/journal_entry/`, new `public/js/adhd/adhd_accounts.js`.

---

#### 4.2 Accounts: Month-End Close Checklist

**Problem**: The month-end accounting close sequence (bank reconciliation → debtors aging review → provisions → period close → P&L) is undocumented in the UI. Every step requires navigating to a different module.

**Feature**: A "Month-End Close" checklist accessible from the Accounts workspace and the Focus Panel. The checklist is a server-rendered ordered list of steps, each with:
- A plain-English description of what the step is and why it matters
- A direct link to the relevant tool (`Bank Reconciliation Tool`, `General Ledger`, `Period Closing Voucher`)
- A checkbox that persists in `User > User Settings` (JSON field) for the current month
- An estimated time for each step (e.g., "~15 min")

Steps auto-check if ERPNext can detect completion (e.g., if a `Period Closing Voucher` exists for the current period, that step is auto-checked).

**Complexity**: M

**Scope**: `accounts/workspace/`, new `erpnext/accounts/services/adhd_month_end.py`, `public/js/adhd/`.

---

#### 4.3 Buying: Purchase Workflow Status Panel

**Problem**: A Purchase Order in ERPNext can be in one of ~6 states (Draft, Submitted, partially received, fully received, billed, closed). The form header shows one status badge. Nothing shows what the next required action is, who it's waiting on, or what's blocking it.

**Feature**: When ADHD mode is active on a `Purchase Order` form, inject a compact "Where is this?" status summary:
- A horizontal step indicator: `Created → Approved → Receipt Pending → Invoice Pending → Closed`
- Current step highlighted
- "Waiting on: [Approver Name]" if the document is in a workflow approval state
- "Next action: [Create Purchase Receipt]" button if goods haven't been received yet
- "Next action: [Create Purchase Invoice]" button if receipt is done but invoice isn't

Reads from existing `workflow_state`, `per_received`, `per_billed` fields on the `Purchase Order` doctype.

**Complexity**: M

**Scope**: `buying/doctype/purchase_order/`, `public/js/adhd/adhd_buying.js`.

---

#### 4.4 HR: Employee Onboarding Wizard

**Problem**: Onboarding a new employee requires creating 5+ separate documents in sequence (`Employee`, `Employee Education`, `Employee Address`, `Salary Structure Assignment`, `Leave Allocation`). There is no checklist or wizard. Every step requires separate navigation.

**Feature**: An "Onboard New Employee" wizard accessible from the HR workspace. A multi-step form (5 steps, one screen each) that:
- Collects information for all 5 documents
- Saves each document in sequence on "Next"
- Shows a progress bar (Step 2 of 5)
- On completion, shows a summary card: "John Smith is onboarded. Here's what was created:" with links
- Provides "Skip" on optional steps (Education, Address) with a "Complete later" reminder added to the user's ToDo

**Complexity**: L (involves multiple doctypes, validation sequencing, and rollback if a step fails)

**Scope**: New `hr/page/employee_onboarding_wizard/` or a dedicated Frappe `Page` doctype, `public/js/adhd/adhd_hr.js`.

---

#### 4.5 Field Help Coverage: Systematic Expansion

**Problem**: `form_focus.js` currently covers ~25 fields. ERPNext has hundreds of commonly used fields across `Sales Invoice`, `Purchase Order`, `Payment Entry`, `Salary Slip`, `Work Order`, `BOM`, and `Stock Entry`. The tooltip coverage is cosmetically present but practically thin.

**Feature**: A structured expansion of `FIELD_HELP` in `form_focus.js` to cover the top 10 most-used fields in each of these 8 doctypes (80 additional entries). Each entry is written in plain English, max 15 words, no jargon. The entries are contributed as a separate file `adhd_field_help.js` to make them easier to review, translate, and extend.

Additionally, add a "What is this field?" fallback: if a field has no entry in `FIELD_HELP` but has a `description` set on the `DocField` record, surface that description as the tooltip automatically.

**Complexity**: S (content work + one backend API call to fetch `DocField.description`)

**Scope**: `public/js/adhd/form_focus.js`, new `public/js/adhd/adhd_field_help.js`.

---

### Phase 5 — Personalisation and Adaptive Scaffolding

**Theme**: ADHD is not one thing. Make the system learn the user's specific profile and let them tune which supports are active. Add the feedback loops that turn a tool into a habit.

**Why this phase last**: Personalisation requires data. Phases 2–4 generate behavioral signals (which tooltips are hovered, which wizard steps get skipped, which nudges are dismissed). Phase 5 consumes those signals to close the loop. Building personalisation before the underlying features exist produces nothing to personalise.

---

#### 5.1 ADHD Settings Panel

**Problem**: ADHD mode is binary. Users who want the Kanban but not the nudges, or who want time-boxing warnings but not the Pomodoro, have no control.

**Feature**: An "ADHD Mode Settings" panel accessible from the navbar toggle (long-press or right-click the 🧠 button). Exposes toggles for each individual feature:
- Pomodoro timer
- Task Kanban
- Due-date heat maps on list views
- Time-boxing warnings
- Contextual form banners (due dates, "what's next")
- Mandatory field wizard
- Auto time-log prompt
- Payment digest

Settings are stored in `localStorage` under namespaced keys. The `ADHDMode` class reads each setting before activating the corresponding feature.

**Complexity**: S

**Scope**: `public/js/adhd/adhd_mode.js`, new `public/js/adhd/adhd_settings.js`.

---

#### 5.2 Friction Logger: Anonymous Behavioral Signal Collection

**Problem**: We are guessing at where the friction is. We need data. Which fields cause hover-and-pause? Which forms are abandoned? Which wizard steps are skipped?

**Feature**: A lightweight, opt-in, privacy-respecting friction logger. When enabled (explicit opt-in only, default off), logs:
- Field name + doctype when a user hovers an `adhd-field-help` tooltip for >2 seconds
- Form name + time-to-save for forms where ADHD mode is active
- Which wizard steps are skipped (no PII, just step index + doctype)
- Which command bar intents are most commonly used

Data is stored in a new `ADHD Usage Log` doctype (server-side) and aggregated in a private report visible only to system managers. No field values are ever logged — only field names and interaction patterns.

**Complexity**: M

**Scope**: New `erpnext/adhd_usage_log/` doctype, `public/js/adhd/adhd_telemetry.js`.

---

#### 5.3 Personalized "Focus Suggestions"

**Problem**: The Smart Inbox (Phase 2.2) is static — it shows the same categories to everyone. An accounts user shouldn't see HR leave applications. A sales user doesn't need to see purchase orders.

**Feature**: The Smart Inbox learns from the modules the user actually opens over 30 days. After enough data, it ranks the inbox sections by the user's actual workflow, hides sections from modules the user has never opened, and surfaces "you usually do X around this time of week" prompts based on historical patterns.

Uses only client-side `localStorage` history, no server-side ML. A simple frequency counter per module per day-of-week is sufficient.

**Complexity**: M

**Scope**: `public/js/adhd/adhd_smart_inbox.js` (from Phase 2.2).

---

#### 5.4 "Done Well" Positive Reinforcement

**Problem**: RSD (rejection sensitivity dysphoria) means that error messages hit harder and positive feedback is rarer than it should be. ERPNext gives no positive feedback on task completion — a submitted invoice produces the same flat UI as before it was submitted.

**Feature**: When ADHD mode is active and a document is submitted (or a task is moved to Done in the Kanban), show a brief, unobtrusive "well done" moment:
- A 1.5-second subtle animation (confetti? a soft pulse? configurable)
- A plain-text message: "Sales Invoice SI-0042 submitted." — nothing effusive, just confirmation
- For Kanban task completion: a small ✓ checkmark animation on the card before it slides to Done

The animation is pure CSS, respects `prefers-reduced-motion`. The message uses the same `frappe.show_alert` infrastructure already in use.

**Complexity**: S

**Scope**: `public/js/adhd/adhd_mode.js`, CSS animations in ADHD stylesheet.

---

#### 5.5 Contributor Toolkit: ADHD Feature Test Harness

**Problem**: As the codebase grows, there is no standard way for contributors to test ADHD-mode features. Every feature currently has to manually toggle ADHD mode and interact with real ERPNext data.

**Feature**: A test harness module (`public/js/adhd/adhd_test_utils.js`) that:
- Provides `erpnext.adhd.test.enable()` and `erpnext.adhd.test.disable()` for use in Cypress/Playwright tests
- Provides fixture helpers that create minimal test data for each ADHD-adjacent workflow (a `Task` with a due date, a `Sales Invoice` with a payment schedule, etc.)
- Documents the test conventions in `docs/adhd_testing.md`

Also: all existing ADHD JS classes should have a `getState()` or `inspect()` method that returns current internal state as a plain object, for test assertions.

**Complexity**: M

**Scope**: `public/js/adhd/adhd_test_utils.js`, `docs/adhd_testing.md`.

---

## 5. Definition of Done

"ADHD-friendly ERPNext" is done when the following criteria are met. These are observable and, where possible, measurable.

| # | Criterion | How to observe |
|---|---|---|
| 1 | **A new user can complete their first Sales Order → Invoice → Payment cycle without leaving the form or consulting external documentation.** | Usability test: recruit 5 ADHD-identified users with no prior ERPNext experience. Measure time-to-first-payment with ADHD mode on vs off. Target: ADHD-mode users complete in ≤2× the time of experienced neurotypical users (currently the ratio is ~5–8×). |
| 2 | **Every mandatory field on every Tier-1 doctype has a plain-English tooltip.** | Automated: run a script against all `DocField` records for `Sales Invoice`, `Purchase Invoice`, `Sales Order`, `Purchase Order`, `Payment Entry`, `Journal Entry`, `Task`, `Employee` where `reqd=1`. Assert that `FIELD_HELP` contains an entry for each. Zero uncovered required fields. |
| 3 | **A user can log their time against a project without navigating away from their current task.** | Walkthrough test: user completes a Pomodoro with an active task. The time-log prompt appears. User logs time in ≤3 clicks. |
| 4 | **No document workflow chain requires a user to hold more than one step in working memory at a time.** | Design audit: for each known chain (Sales, Buying, HR onboarding), the chain navigator or wizard is present and shows "you are here" + "next step" at each step. Auditor should be able to traverse each chain without opening any ERPNext documentation. |
| 5 | **ADHD mode produces no degradation in performance.** | Automated performance test: measure page load, list view render, and form render with and without ADHD mode. ADHD mode overhead ≤50ms p95. |
| 6 | **The system produces zero blocking error dialogs for expected workflow states.** | Audit the 10 most common validation errors in ERPNext (identify from GitHub issues and forum). Each must be replaced or supplemented with a guided resolution path when ADHD mode is on. |
| 7 | **A user can describe their task in plain English and create any of the 8 core record types (Task, Expense, Purchase Request, Time Log, Lead, Opportunity, Contact, CRM Note) without touching a form.** | Acceptance test: run the command bar with each of the 8 record types. Assert that the draft card is correct, the confirm flow saves the record, and no required field is left blank by the assistant. |

---

## 6. Risks and Anti-Patterns

These are the ways this project reliably goes wrong. Each one has already killed a similar initiative elsewhere.

### 6.1 Building for a stereotype, not a person

**Risk**: Designing "ADHD mode" based on a cartoon of ADHD (fidgeting, easily distracted, can't focus) produces a patronising, brightly-coloured interface with big buttons and confetti that insults the users it's meant to help.

**What to avoid**: Gamification for its own sake. Infantilising copy ("Great job! 🎉 You submitted an invoice!"). Color-coding everything. Features that reduce perceived complexity by hiding information (progressive disclosure is fine; hiding things the user actually needs is not).

**What to do instead**: Ground every feature in a specific cognitive mechanism (working memory, initiation, time perception). If you can't name the mechanism, don't ship the feature.

---

### 6.2 Notification theater

**Risk**: Adding more nudges and reminders to a system that already over-notifies doesn't help ADHD users — it trains them to ignore all notifications, including important ones.

**What to avoid**: Notification-based solutions to any problem that can be solved with ambient UI. "Send a reminder email" is almost never the right answer.

**What to do instead**: Make important information *visible in the place where the user is already looking* (the form, the list row, the Focus Panel). Notifications should be reserved for asynchronous events the user cannot see from their current screen.

---

### 6.3 Feature sprawl without depth

**Risk**: Shipping a tooltip for every field, a nudge for every module, a progress bar for every workflow, without making any single one of them genuinely reliable. ADHD users notice and disengage from inconsistency faster than neurotypical users.

**What to avoid**: Partial implementations. A tooltip on half the fields is worse than no tooltips — it creates a false expectation, then fails it. A chain navigator that works for Sales but not Buying is noise.

**What to do instead**: Prioritise depth over breadth. Pick one module (Sales) and make it complete before touching the next. The roadmap above is ordered by cognitive impact but should be executed with this discipline within each phase.

---

### 6.4 Making ADHD mode a visual skin

**Risk**: CSS changes (reduced clutter, different colors, larger text) are easy to ship and easy to measure. They produce screenshots that look different. They do not address working memory overload, initiation paralysis, or time blindness.

**What to avoid**: Measuring progress by the number of visual changes. A dark-themed ADHD mode with rounded corners is not ADHD-friendly.

**What to do instead**: Gate each feature on a cognitive problem statement. "This feature reduces working memory load because X" or "this feature reduces initiation cost by Y." If neither statement is true, the feature is cosmetic.

---

### 6.5 Opt-in as a barrier

**Risk**: Requiring users to discover, enable, and configure ADHD mode before getting any benefit means most ADHD users never experience it. ADHD users are disproportionately likely to never find the settings page.

**What to avoid**: Deep settings menus. Features that require multi-step configuration before they activate. "Enable this in Settings > User > Preferences > Advanced > ADHD Mode."

**What to do instead**: Phase 1's `Alt+A` toggle is right. The ADHD Settings Panel (Phase 5.1) should be accessible from the toggle button itself, not from a settings page. The Smart Inbox (Phase 2.2) should be available as a one-click option the first time a user enables ADHD mode, not buried later.

---

### 6.6 Ignoring the confirmation cost of LLM drafts

**Risk**: The command bar's "confirm before save" design is correct. The risk is that future contributors, under pressure to make the assistant "smarter," bypass the confirmation step for "simple" records. This removes the most important safety net for ADHD users, who are more likely to commit to an action before reading it carefully.

**What to avoid**: Auto-save on high-confidence extractions. "Just save it, they can fix it later." One-click confirmation without a preview.

**What to do instead**: The confirm-before-save contract is inviolable. Every assistant-created record must be previewed before saving, always, regardless of confidence score. The preview card must show every field that will be written.

---

### 6.7 Building without ADHD users in the loop

**Risk**: This entire roadmap is authored by people making inferences about ADHD. Inferences are often wrong. The biggest risk to the project is that we build the wrong things confidently.

**What to do**: Establish a standing group of at least 5 self-identified ADHD users of ERPNext who are willing to do 30-minute feedback sessions before each phase ships. Every phase gate requires at least one round of user feedback. The friction logger (Phase 5.2) is not a substitute for talking to people — it is a supplement.

---

*End of roadmap. Next review after Phase 2 ships.*
