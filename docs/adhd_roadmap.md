# ADHD-Friendly ERPNext: Product Roadmap

> **Status**: Historical product roadmap. Implementation status is maintained in `docs/adhd_mode_features.md` and each `docs/tickets/ADHD-*.md` file.
> **Audience**: Contributors, maintainers, and product stakeholders.
> **Scope**: Original product rationale and proposed sequencing. Sections 3-7 describe proposals, not current implementation state.
> **Last reconciled**: 2026-09-21 on `iteration_3`.

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

The original Phase 1 features remain in `erpnext/public/js/adhd/`. Current work extends beyond this roadmap:

- ADHD-001 through ADHD-013 and ADHD-015 through ADHD-020 have implementations on `iteration_3`.
- ADHD-021 through ADHD-030 remain planned.
- ADHD-031 through ADHD-061 include implemented, partial, and blocked states. See `docs/adhd_mode_features.md` for the ticket-by-ticket catalog.
- ADHD-014 and ADHD-057 through ADHD-059 are blocked because HRMS is absent.
- ADHD-038 is schema-limited, ADHD-045 is blocked by current Plant Floor structure, and ADHD-048 is partial because CRM Note is a child DocType.
- There is no ADHD-062 ticket file.

Client features load through imports in `erpnext/public/js/erpnext.bundle.js`. Server-backed features use whitelisted modules under Accounts, Manufacturing, Stock, and the ADHD usage-log DocType.

---

## 3. Gap Analysis

This section records the analysis that produced the ticket backlog. It is retained for business context and must not be used as a status report. Several gaps below now have implementations; others remain planned or blocked. Use `docs/adhd_mode_features.md` for current state.

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

**Why this phase first**: At roadmap authoring time, Phase 1 and the command bar handled focus *during* work. Phase 2 targeted the harder problem: *starting* work. Current status is recorded in the feature catalog.

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

**Original problem**: The conversational command bar initially handled CRM records only. ADHD-004 now adds Task, Expense Claim, Material Request, and Timesheet recipes; the remaining text preserves the original proposal.

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

---

## 7. Module-by-Module Feature Expansion

> This section applies targeted ADHD scaffolding to each ERPNext module that is not already fully addressed by Phases 2–5. For each module, the dominant cognitive friction is identified first; features follow from that diagnosis. Features already covered in the phased roadmap (Document Chain Navigator, Smart Inbox, Mandatory Field Wizard, JE Balance Indicator, Month-End Close Checklist, PO Status Panel, Employee Onboarding Wizard, Pomodoro time-log, due-date heat maps, conversational command bar, contextual deadline banners, Payment Schedule Digest, time-box warnings) are not repeated here — they are referenced where relevant.

---

### 7.1 Selling

**Core ADHD friction in this module**: The Sales module's dominant problem is chain amnesia — the Quotation → Sales Order → Delivery Note → Sales Invoice → Payment Entry sequence is long enough that users lose their place between sessions, and re-entering a half-finished Sales Order after an interruption costs significant working memory reconstruction. A secondary problem is the `Sales Order` form's conditional mandatory fields: `delivery_date` is mandatory only when `order_type` is "Sales," which causes a confusing late-stage block. Third: the `Customer` form's tabs (Contacts, Addresses, Credit Limits, Sales Team, Accounting, Portal, Tax, Loyalty) are a hyperfocus trap with no urgency — every tab looks equally important.

> Note: The Document Chain Navigator (Phase 2.1) already addresses the chain progress bar and "Create Next Step" button. The features below are additive.

#### Quotation Expiry Ambient Warning
**Problem**: `Quotation.valid_till` exists as a field but there is no ambient signal that a quotation is about to expire, causing lost deals because the sales rep forgot to follow up.
**Feature**: When ADHD mode is active and a `Quotation` list view or form is open, inject a yellow "Expiring in X days" badge next to `valid_till` on the form and as a left-border heat-map color in the list view (building on the Phase 3.1 heat-map infrastructure already defined for `Sales Order`). Extend `adhd_list_view.js` to include `Quotation` in the heat-map doctype set, using `valid_till` as the date field. On the form, hook `frm.after_load` in a new `selling/doctype/quotation/adhd_quotation.js` file that reads `frm.doc.valid_till` and renders a one-line banner using the same `adhd_deadline_banner.js` pattern from Phase 3.3.
**Complexity**: S
**Cognitive mechanism addressed**: time blindness

#### Customer "Essentials Only" Tab
**Problem**: Opening a `Customer` form to check a credit limit or payment terms requires navigating 9 tabs, most of which are irrelevant to the immediate task.
**Feature**: When ADHD mode is active on a `Customer` form, inject a persistent "Essentials" sidebar section (rendered via `frm.add_custom_button` group or a custom HTML section in the form layout) that surfaces the four fields sales reps actually need mid-workflow: `credit_limit`, `payment_terms`, primary `contact_email` (from the first row of the `Contacts` child table), and `outstanding_amount` (fetched via `frappe.call` to `frappe.client.get_value` on `Customer`). One glance answers "can I take this order?" without touching any tab. No new doctype required; reads existing fields and the `dynamic_links`-based contact query already used by `customer.js`.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, attention switching

#### Sales Order Interruption Restore
**Problem**: An interrupted Sales Order — partially filled, not yet saved — is lost when the browser tab closes or the user navigates away. ADHD users are more likely to be interrupted mid-form and more likely to lose the thread on return.
**Feature**: Extend the Phase 2.2 Smart Inbox "Resume" panel to specifically handle `Sales Order` and `Quotation` draft state. When ADHD mode is active, auto-save the form's current field values (including child table rows from `items`, `taxes`, `sales_team`) to `localStorage` every 30 seconds under a key of `adhd_draft_${doctype}_${name}`. When the user returns to a new `Sales Order`, show a banner: "You have an unsaved Sales Order from [time]. Resume it?" with a "Restore" button that re-populates the form and a "Discard" button. This extends the 60-second autosave in `form_focus.js` (which saves to the server) with a client-side pre-save recovery path for Draft documents that haven't been named yet.
**Complexity**: M
**Cognitive mechanism addressed**: working memory, initiation

#### Installation Note Checklist
**Problem**: `Installation Note` is a rarely-used but operationally important document (marks that goods were delivered and installed). It has a free-text `remarks` field and an `items` child table, but no structured checklist for confirming what was actually installed. Sales coordinators either skip it or fill it in from memory days later, producing inaccurate records.
**Feature**: When creating an `Installation Note` from a `Delivery Note` (the standard flow via `Make > Installation Note`), inject a pre-populated item checklist in ADHD mode: each row in the `items` child table gets a "Confirmed installed?" checkbox rendered via a custom `in_list_view` HTML column (added client-side via `grid.add_custom_column` in a new `selling/doctype/installation_note/adhd_installation_note.js`). Checking each row is the primary UI affordance; the standard quantity and serial number fields remain. This converts a blank form into a concrete, completable checklist — the lowest-initiation-cost state for an ADHD brain.
**Complexity**: S
**Cognitive mechanism addressed**: initiation, working memory

---

### 7.2 Buying

**Core ADHD friction in this module**: The Buying module's dominant problem is approval-state opacity — a `Purchase Order` can be waiting on an approver for days while the requester has no idea whether it's been seen, rejected, or forgotten. The resulting anxiety and follow-up behavior (opening the document repeatedly to check) is a classic ADHD attention trap. A secondary problem is `Request for Quotation` (RFQ): the workflow of creating an RFQ, sending it to multiple suppliers, receiving `Supplier Quotation` responses, and comparing them requires holding multi-vendor state in working memory across days or weeks.

> Note: The PO "Where is this?" status panel (Phase 4.3) already addresses approval-chain visibility for `Purchase Order`. The features below address the gaps it doesn't cover.

#### RFQ Multi-Supplier Comparison Card
**Problem**: After receiving `Supplier Quotation` responses to an RFQ, the user must open each quotation individually to compare prices, delivery dates, and payment terms — there is no side-by-side view.
**Feature**: On a submitted `Request for Quotation` form, when ADHD mode is active, inject a "Compare Responses" button (via `frm.add_custom_button`) that opens a compact modal table showing all linked `Supplier Quotation` records side by side: columns are supplier name, `rate` (from `items` child table, first item), `valid_till`, and `payment_terms`. Each row has a "Select" button that navigates to that `Supplier Quotation` with a pre-clicked "Create Purchase Order" action. The data is fetched via a single `frappe.call` to a new `buying/services/adhd_rfq_compare.py` endpoint that queries `Supplier Quotation` filtered by `request_for_quotation = frm.docname`. This replaces a multi-tab, multi-scroll comparison workflow with a single modal.
**Complexity**: M
**Cognitive mechanism addressed**: working memory, attention switching

#### Supplier Scorecard "Before You Order" Nudge
**Problem**: The `Supplier Scorecard` module exists but is consulted by almost no one because it requires deliberate navigation. ADHD users order from underperforming suppliers repeatedly because the scorecard is invisible at the point of decision.
**Feature**: When ADHD mode is active and a user sets the `supplier` field on a new `Purchase Order` form, query the `Supplier Scorecard` doctype for that supplier via `frappe.call`. If a scorecard exists and `total_score` is below a configurable threshold (default: 50), show a non-blocking one-line banner below the `supplier` field: "⚠ [Supplier Name] scored 38/100 on last scorecard (delivery reliability: poor). View scorecard?" with a link. If no scorecard exists, no banner appears. This puts performance data into the decision moment, not a separate report.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, attention switching

#### Purchase Receipt "Expected vs Received" Diff
**Problem**: When creating a `Purchase Receipt` from a `Purchase Order`, the `items` child table is pre-populated with ordered quantities. If partial delivery arrives, the user manually reduces quantities — but there is no visual confirmation of what's still outstanding after save.
**Feature**: On a submitted `Purchase Receipt` form in ADHD mode, inject a "What's still open?" summary below the `items` grid: a compact table showing each item from the originating `Purchase Order` with three columns — Ordered, Received (this receipt), Still Pending. Values come from the `Purchase Order`'s `per_received` field and the child table `items.qty` vs `items.received_qty`. Rendered via `frm.set_df_property` on a `HTML` type field appended to the form layout in `buying/doctype/purchase_receipt/adhd_purchase_receipt.js`. Eliminates the need to open the originating `Purchase Order` to check outstanding quantity — a classic attention-switching trip.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, attention switching

#### Purchase Invoice Three-Way Match Indicator
**Problem**: Matching a `Purchase Invoice` to a `Purchase Order` and `Purchase Receipt` (three-way match) is a compliance requirement, but ERPNext shows `po_no` and `purchase_receipt` as link fields with no visual confirmation that the amounts reconcile. Discrepancies are caught only at submit, as a blocking error.
**Feature**: When ADHD mode is active on a `Purchase Invoice` form and both `po_no` and a `purchase_receipt` reference are present, run a client-side comparison of `net_total` against the PO's `net_total` and the receipt's `net_total`. Show a compact "Match Status" badge next to the `grand_total` field: green "✓ Matched" if within a tolerance, amber "⚠ Variance: ₹X" if within 5%, red "✗ Mismatch" if diverging more than 5%. Computed purely client-side from data already on the form — `frm.doc.net_total`, `frm.doc.po_detail` linked values fetched via `frappe.model.get_value`. Converts a submit-time wall into an ambient pre-submit signal.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, RSD (prevents surprise blocking errors)

---

### 7.3 Accounts

**Core ADHD friction in this module**: Accounts is the highest-friction module in ERPNext for ADHD users, and the friction is almost entirely initiation-based. Every major Accounts task — month-end close, bank reconciliation, payment matching — requires the user to already know the correct sequence, navigate to the right tool, and hold multi-step state in mind. There are no guardrails, no progress indicators, and no plain-English summaries of what state the books are in. The `Bank Reconciliation Tool` is particularly hostile: it is a stateful multi-step process with no saved progress, so an interruption forces the user to restart from scratch.

> Note: JE Balance Indicator (Phase 4.1) and Month-End Close Checklist (Phase 4.2) already address `Journal Entry` and the close sequence. Payment Schedule Digest (Phase 3.5) addresses receivables. The features below address the remaining gaps.

#### Bank Reconciliation Progress Saver
**Problem**: The `Bank Reconciliation Tool` (`accounts/page/bank_reconciliation/`) is a stateless page — selecting the bank account, date range, and checking off matched transactions is lost if the user navigates away or gets interrupted.
**Feature**: When ADHD mode is active and the user is on the `Bank Reconciliation Tool` page, persist the current reconciliation state (selected `bank_account`, `from_date`, `to_date`, and the set of transaction IDs the user has already checked off) to `localStorage` under the key `adhd_bank_recon_${bank_account}_${from_date}`. On page load, if a saved state exists for the same bank account and date range, restore the checked-off state automatically and show a banner: "Resumed your reconciliation session from [time]. X of Y transactions matched." Requires no backend change — the `Bank Reconciliation Tool` already fetches all transactions on load; the saved state is applied as a post-render DOM patch in a new `accounts/page/bank_reconciliation/adhd_bank_recon.js` file.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, initiation

#### Payment Entry Invoice Shortlist
**Problem**: The `Payment Entry` form requires the user to manually click "Get Outstanding Invoices" and then select from a flat list of potentially dozens of invoices. For a customer with 30+ open invoices, matching payment to invoice requires holding the right invoice in mind while scrolling through an undifferentiated list.
**Feature**: When ADHD mode is active on a `Payment Entry` form and `party` is set, automatically call `frappe.call('erpnext.accounts.doctype.payment_entry.payment_entry.get_outstanding_reference_documents', ...)` on `party` field change (before the user clicks "Get Outstanding Invoices"). Display the results not as a flat table but as a prioritized shortlist:
1. Invoices due today or overdue (sorted by `due_date` ascending)
2. Invoices due this week
3. All other invoices (collapsed, expandable)

Each invoice in the shortlist shows: invoice number, due date, outstanding amount, and a one-click "Apply full payment" toggle. The existing `references` child table is populated from the user's selections. This converts an undifferentiated list into a decision queue with a clear starting point.
**Complexity**: M
**Cognitive mechanism addressed**: working memory, initiation, time blindness

#### Cost Center & Accounting Dimension "Last Used" Pre-fill
**Problem**: `cost_center` and accounting dimension fields (`project`, `department`, custom dimensions) must be filled on nearly every Accounts transaction. For users who work primarily in one cost center or project, re-entering these on every `Journal Entry`, `Payment Entry`, and `Sales Invoice` is pure repetitive overhead.
**Feature**: Track the last-used value of `cost_center` and each active `Accounting Dimension` field per user, stored in `localStorage` under keys like `adhd_last_cost_center` and `adhd_last_dim_${fieldname}`. On form load in ADHD mode, if these fields are blank on a new document, pre-fill them with the last-used values and mark them visually with a subtle "← last used" label (a CSS `::after` pseudo-element on the field wrapper). The user can override freely. Stored values are updated on every successful form save. A small "Clear defaults" link appears in the ADHD settings panel (Phase 5.1). Implementation: hook `frm.after_load` in a global `adhd_accounts.js` for doctypes that include `cost_center` as a field, detected via `frm.fields_dict.hasOwnProperty('cost_center')`.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, initiation

#### Period Closing Readiness Dashboard
**Problem**: Before running `Period Closing Voucher`, the user must ensure all transactions are posted, bank is reconciled, and there are no unsubmitted drafts. This pre-close check is invisible — there is no tool that shows "you are not ready to close because X."
**Feature**: Add a "Close Readiness" section to the Month-End Close Checklist (Phase 4.2) that renders a live status check panel. On demand (one button click, not auto-polling), it runs a server-side `adhd_period_close_check` API that checks: (1) count of Draft `Journal Entry` records in the period, (2) count of unreconciled bank transactions (from `Bank Transaction` doctype, `status != 'Reconciled'`), (3) count of unsubmitted `Purchase Invoice` and `Sales Invoice` in the period. Returns a plain-language readiness summary: "3 issues to resolve before closing" with direct links. Each resolved issue updates the count in real time when the user returns to the checklist.
**Complexity**: M
**Cognitive mechanism addressed**: initiation, working memory

---

### 7.4 Stock / Inventory

**Core ADHD friction in this module**: Stock's ADHD problem is invisible consequence — every Stock Entry, Stock Reconciliation, or Delivery Note changes the valuation and quantity of items, but the form gives no feedback about what will happen to stock levels until after submission. A user creating a `Material Transfer` entry has to hold the current stock level of both source and destination warehouses in mind, neither of which is shown on the form. The `Item` master's 12-tab layout is the canonical hyperfocus trap (already called out in Section 1.5 and addressed by Phase 3.4's time-box warning).

#### Stock Entry "Before / After" Preview
**Problem**: Before submitting a `Stock Entry` (Material Issue, Transfer, Receipt, Manufacture), the user cannot see what the resulting stock levels will be at the affected warehouses.
**Feature**: When ADHD mode is active on a `Stock Entry` form in Draft state, inject a "Stock Impact Preview" collapsible section below the `items` child table. When expanded, it shows a table: Item | Warehouse | Current Qty | Change | After Submit. Current quantities are fetched via a single `frappe.call` to `frappe.client.get_list` on `Bin` filtered by `item_code in [items]` and `warehouse in [warehouses]`. The Change column reads from the `items` child table. This is a read-only display computed client-side; no backend changes required. Renders in a new `stock/doctype/stock_entry/adhd_stock_entry.js`.
**Complexity**: M
**Cognitive mechanism addressed**: working memory

#### Reorder Level "Almost There" Ambient Indicator
**Problem**: `Item` records have `reorder_level` and `reorder_qty` configured, and ERPNext has an auto-reorder mechanism — but the signal that a reorder is needed only appears as a system-generated `Material Request`, buried in a queue. The Item master itself shows no ambient stock health signal.
**Feature**: In the `Item` list view, when ADHD mode is active, extend the Phase 3.1 heat-map infrastructure to include a stock health indicator. For each `Item` row, fetch `actual_qty` from the `Bin` doctype for the user's default warehouse (stored in `User > Default Warehouse` if set, otherwise the first warehouse). Color the row border: red if `actual_qty <= reorder_level`, amber if `actual_qty <= reorder_level * 1.25`, no color otherwise. The fetch is batched — a single API call for all visible items on the page — in `adhd_list_view.js`. Hovering the border shows a tooltip: "Stock: X units | Reorder at: Y."
**Complexity**: M
**Cognitive mechanism addressed**: time blindness, working memory

#### Batch & Serial Lookup Inline
**Problem**: When filling `batch_no` or `serial_no` on a `Stock Entry` or `Delivery Note` items row, the user must know or look up the available batch numbers — the standard field is a generic Link field with no context about which batches have sufficient stock, which are expiring soon, or which are already allocated.
**Feature**: When ADHD mode is active and the user clicks into a `batch_no` cell in any items child table (detected via `grid.on('before_field_edit', ...)`), replace the standard link field popup with a compact batch picker that shows: Batch ID | Manufacturing Date | Expiry Date | Available Qty. Rows are sorted by expiry date ascending (FEFO order). One-click selection fills the cell. Data fetched from `Batch` doctype filtered by `item_code = row.item_code` joined with `Bin` for available qty. Implemented in a new `stock/doctype/stock_entry/adhd_batch_picker.js` (reusable across `Delivery Note`, `Purchase Receipt` items grids).
**Complexity**: M
**Cognitive mechanism addressed**: working memory, attention switching

#### Putaway Rule "Why Here?" Inline Explanation
**Problem**: When `Stock Entry`'s putaway rules assign a target warehouse to an item, the user sees only the warehouse name in the `t_warehouse` cell. There is no explanation of why that warehouse was chosen (which putaway rule fired, what capacity logic was applied), making it feel arbitrary and eroding trust.
**Feature**: When ADHD mode is active and a `Stock Entry` items row has been auto-populated by putaway (detectable by the presence of `putaway_rule` on the row), show a small "?" icon next to `t_warehouse`. Clicking it opens a tooltip-modal with a plain-English explanation: "Putaway rule '[Rule Name]' assigned this location because [capacity_based / strategy / item_category rule description]." The data comes from the `Putaway Rule` doctype linked via `putaway_rule` on the items row. Implemented client-side in `adhd_stock_entry.js`.
**Complexity**: S
**Cognitive mechanism addressed**: RSD (removes "why did it do that?" anxiety), working memory

---

### 7.5 Manufacturing

**Core ADHD friction in this module**: Manufacturing's dominant ADHD problem is depth — `BOM`, `Work Order`, `Job Card`, and `Production Plan` form a nested, interdependent hierarchy where the user must hold both the tree topology (which sub-assembly is a component of which BOM) and the operational timeline (which operations are in which sequence) in mind simultaneously. The `Plant Floor` view is a positive exception — it is visual and state-based — but it is only accessible after Work Orders are created, which requires navigating the BOM → Work Order path first.

#### BOM Tree Breadcrumb Navigator
**Problem**: Nested BOMs (sub-assemblies that are themselves BOMs) have no visual tree browser. A user editing a 3-level-deep sub-assembly BOM has no way to see where it sits in the parent BOM without opening a separate report (`BOM Explorer`).
**Feature**: When ADHD mode is active on a `BOM` form, inject a collapsible "Where does this BOM sit?" breadcrumb panel in the form sidebar. On load, query parent BOMs via `frappe.call` to a new lightweight endpoint `manufacturing/services/adhd_bom_ancestry.py` that does a recursive query on `BOM Item` (filtering `item_code = frm.doc.item` and `docstatus = 1`) up to 3 levels. Returns an ancestry chain: `Finished Product > Assembly A > This BOM`. Rendered as a clickable breadcrumb — each ancestor is a link that opens the parent BOM in a side panel (or new tab, user-configurable). Depth-limited to 3 levels to avoid the recursion becoming its own rabbit hole.
**Complexity**: M
**Cognitive mechanism addressed**: working memory

#### Work Order "What to Do Next" Status Prompt
**Problem**: A `Work Order` moves through states (`Draft → Submitted → In Process → Completed`), but the form header shows only the current state badge. A user returning to a Work Order after an interruption cannot immediately tell what the next action is.
**Feature**: When ADHD mode is active on a `Work Order` form, inject a one-line "Next action" prompt below the document title, driven by the current document state and field values:
- `Draft` → "Submit this Work Order to start production"
- `Submitted`, `produced_qty = 0` → "Create Job Cards to begin operations" (with a direct button)
- `In Process`, open Job Cards exist → "X of Y Job Cards are open — [View Open Job Cards]"
- `In Process`, all Job Cards complete → "All operations done — click Finish to close the Work Order" (with a direct button)
- `Completed` → "Work Order complete. [Create Stock Entry to transfer finished goods]"

Logic reads `frm.doc.status`, `frm.doc.produced_qty`, and a `frappe.call` count of open `Job Card` records linked to this Work Order. Rendered in a new `manufacturing/doctype/work_order/adhd_work_order.js`.
**Complexity**: S
**Cognitive mechanism addressed**: initiation, working memory

#### Production Plan Demand Summary Banner
**Problem**: A `Production Plan` aggregates demand from `Sales Order` and `Material Request` records into planned production quantities. The plan form shows a child table of items with quantities, but no banner telling the user "you are planning to fulfill X Sales Orders for Y customers, total value ₹Z." Without this summary, the scope of the plan is invisible until the user manually adds it up.
**Feature**: When ADHD mode is active and a `Production Plan` is loaded, inject a compact summary bar above the `po_items` child table: "Planning [X] items across [Y] Sales Orders | Total qty: [Z] | Target start: [earliest `planned_start_date`]." Computed client-side from the child table data already loaded in `frm.doc.po_items` and `frm.doc.mr_items`. No API call required. Implemented in a new `manufacturing/doctype/production_plan/adhd_production_plan.js`.
**Complexity**: S
**Cognitive mechanism addressed**: working memory

#### Job Card Time-Logging Shortcut
**Problem**: `Job Card` has a `time_logs` child table for recording actual operation time, but filling it requires expanding the child table, adding a row, setting `from_time`, `to_time`, and `time_in_mins` manually. Operators on the shop floor skip this because the form friction is too high relative to the benefit they perceive.
**Feature**: When ADHD mode is active on a `Job Card` form, show a prominent "Start Work" / "Stop Work" toggle button at the top of the form (above the standard fields). Pressing "Start Work" records `from_time = now()` in `localStorage` and changes the button to "Stop Work" (with elapsed time counting up). Pressing "Stop Work" computes `time_in_mins` and creates a new row in the `time_logs` child table via `frappe.model.add_child`, then saves. One button press to start, one to stop. The mechanism is identical to the Pomodoro timer but without a fixed duration. Implemented in `manufacturing/doctype/job_card/adhd_job_card.js`.
**Complexity**: S
**Cognitive mechanism addressed**: initiation, time blindness

---

### 7.6 Projects

**Core ADHD friction in this module**: The Projects module is structurally well-suited to ADHD (visual task states, clear ownership) — but its friction point is granularity mismatch. Tasks on a project can span days or weeks, but the actual work happens in 25–90 minute blocks that never get logged. The `Timesheet` → `Timesheet Detail` structure is too formal for moment-to-moment logging. The Phase 2.4 command bar already covers Task creation and Time Log via natural language. The Phase 3.2 Pomodoro time-log already handles logging from a Pomodoro session. The remaining gaps are about making the Project form itself more navigable.

> Note: Automatic time-log on Pomodoro completion (Phase 3.2) and Task creation via command bar (Phase 2.4) already address the biggest friction points in this module. The features below address what's left.

#### Project Health Snapshot
**Problem**: The `Project` form shows a progress percentage and a Gantt/Kanban/List view selector, but there is no at-a-glance summary of project health — how many tasks are overdue, how many are unassigned, and whether the project's `expected_end_date` is at risk.
**Feature**: When ADHD mode is active on a `Project` form, inject a compact "Project Health" card in the form sidebar (or as a collapsible section at the top) showing four metrics: Overdue tasks (count, link), Unassigned tasks (count, link), % complete (already exists as `percent_complete`, just surfaced more prominently), and Days to deadline (computed from `expected_end_date`). Each metric is a live count fetched via `frappe.call('frappe.client.get_list', {doctype: 'Task', filters: ...})` on form load. Red if overdue count > 0. The intent is to answer "is this project in trouble?" in one glance, without opening the task list.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, time blindness

#### Activity-Based Timesheet Pre-fill
**Problem**: Creating a `Timesheet` requires knowing the `Activity Type` — a required Link field that many users leave blank or default to the wrong value. There is no suggestion mechanism.
**Feature**: When ADHD mode is active and the user creates a new `Timesheet` form, check `localStorage` for `adhd_last_activity_type`. If found, pre-fill `activity_type` on the first `time_logs` child table row. Additionally, if the user came from a `Task` form (detectable via `frappe.get_route()` or `document.referrer`), pre-fill `task` and `project` from that Task's fields. A small "← from last task" label marks auto-filled fields (same CSS pattern as Section 7.3's cost center pre-fill). Updates the stored `adhd_last_activity_type` on each save. Targets the "I know what I did, I just can't remember the field names" failure mode.
**Complexity**: S
**Cognitive mechanism addressed**: initiation, working memory

---

### 7.7 CRM

**Core ADHD friction in this module**: The command bar addresses record-creation initiation. Follow-up burden remains: remembering to follow up on an Opportunity that went quiet, identifying stale Opportunities, and tracking commitments across a pipeline.

> Historical note: This section predates the implemented ADHD-004 recipes. Use the feature catalog for current status.

#### Opportunity Staleness Indicator
**Problem**: An `Opportunity` that has had no activity (no CRM Note, no status change, no linked `Quotation`) in more than N days is effectively stalled — but the Opportunity list view shows it identically to an active one. Sales reps with ADHD miss stalled deals because there is no ambient urgency signal.
**Feature**: Extend the Phase 3.1 heat-map infrastructure to the `Opportunity` list view. Compute "days since last activity" client-side by comparing `modified` (last doc modification timestamp, already in list view data) to `today`. Color the row border: red if >14 days, amber if >7 days, no color if ≤7 days. Threshold configurable in ADHD settings (Phase 5.1) under the key `adhd_crm_stale_days`. A hovering tooltip reads "No activity for X days." Implemented by extending `adhd_list_view.js` to add `Opportunity` to the heat-map doctype set, using `modified` rather than a due-date field.
**Complexity**: S
**Cognitive mechanism addressed**: time blindness

#### CRM Note "Promised Action" Extractor
**Problem**: CRM Notes are free-text entries in the `CRM Note` child table (or the newer `CRMNOTE` doctype). Sales reps write things like "promised to send proposal by Friday" or "follow up after their board meeting in March" in the note body — and then never act on it because there is no extraction of the commitment into a trackable task.
**Feature**: When ADHD mode is active and a CRM Note is saved (hook `on_submit` or `after_save` on the `CRMNOTE` doctype, or the `CRM Note` child table save event in `Opportunity`), run a simple client-side pattern match against the note text looking for commitment language: "follow up", "promised", "will send", "call on", "meeting on", "by [day/date]". If a match is found, show a non-intrusive banner: "Sounds like you made a commitment. Create a Task?" with a pre-filled `Task` creation shortcut (title auto-extracted from the matched text, `due_date` extracted if a date is present). The user can dismiss or confirm. Pattern matching is a lightweight `RegExp` in `adhd_crm.js` — no NLP, no server call for the detection phase. The Task creation reuses the Phase 2.4 command bar's `Task` recipe.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, time blindness

#### Pipeline Stage Progress Bar on Opportunity
**Problem**: `Opportunity.stage` is a Select field with values that vary by `opportunity_type`, but the form shows it as a plain dropdown with no visual representation of how far through the pipeline this deal is.
**Feature**: When ADHD mode is active on an `Opportunity` form, replace (or augment) the `stage` dropdown with a horizontal stage progress bar. The stages are fetched from the `CRM Stage` doctype (if using the newer CRM module) or derived from the `Select` field options. The current stage is highlighted; completed stages are filled; future stages are empty. Clicking a stage in the bar sets it (same as the dropdown). This is purely a rendering enhancement — no new data, no new doctype. The `stage` dropdown is hidden when the bar is shown; unhidden on ADHD mode toggle. Implemented in `crm/doctype/crm_deal/adhd_crm.js` or `crm/doctype/opportunity/adhd_opportunity.js`.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, attention switching

---

### 7.8 Support

**Core ADHD friction in this module**: The Support module's ADHD problem is SLA drift — `Issue` records have SLA policies that define response and resolution deadlines, but those deadlines are buried in the `SLA` child section of the Issue form. A support agent with ADHD is at high risk of SLA breach not from negligence but from time blindness: they worked on the issue, got pulled into something else, and when they returned had no ambient signal that the SLA clock was about to expire.

#### Issue SLA Countdown on Form and List
**Problem**: `Issue.response_by` and `Issue.resolution_by` contain the SLA deadline timestamps, but they are displayed as plain datetime fields with no urgency styling.
**Feature**: When ADHD mode is active, apply two changes:
1. **List view**: extend the Phase 3.1 heat-map infrastructure to `Issue`, using `resolution_by` as the date field. Red border if `resolution_by < now`, amber if `< now + 2h`, no color otherwise. (SLA deadlines are time-precise, not date-only, so the comparison uses full datetime — adjust `adhd_list_view.js` to handle ISO datetime strings in addition to date strings.)
2. **Form view**: inject a persistent SLA status strip below the form title showing "SLA: Response [✓ done / in X hours / BREACHED]" and "Resolution: [in X hours / BREACHED]", computed from `frm.doc.response_by`, `frm.doc.resolution_by`, `frm.doc.first_responded_on`, and `frm.doc.resolution_date`. Updated in real-time via a 60-second `setInterval` while the form is open. Implemented in `support/doctype/issue/adhd_issue.js`.
**Complexity**: S
**Cognitive mechanism addressed**: time blindness

#### Warranty Claim "What's Covered" Inline Check
**Problem**: When creating a `Warranty Claim`, the agent must check whether the `Serial No` is under active warranty — which requires opening the `Serial No` form, finding the `warranty_expiry_date` field, and manually comparing to today's date. This is a 3-step context switch for a yes/no question.
**Feature**: When ADHD mode is active on a `Warranty Claim` form and `serial_no` is set, immediately query `frappe.client.get_value('Serial No', frm.doc.serial_no, ['warranty_expiry_date', 'item_name', 'item_code'])` and inject a one-line banner below the `serial_no` field: "✓ Under warranty until [date]" (green) or "✗ Warranty expired on [date]" (red) or "No warranty date recorded" (neutral). This eliminates the context switch. The banner appears within the form in the place the agent is already focused.
**Complexity**: S
**Cognitive mechanism addressed**: attention switching, working memory

#### Issue Reply Draft Autosave
**Problem**: Support agents drafting a reply to a customer in the `Issue` comment box are at high risk of losing their draft if they get interrupted — click somewhere else, navigate away, or accidentally close the tab. The standard Frappe comment box has no autosave.
**Feature**: When ADHD mode is active and the user has typed more than 50 characters into the `Issue` timeline comment box (the `<div contenteditable>` rendered by Frappe's Communication section), auto-save the draft content to `localStorage` under the key `adhd_issue_draft_${frm.doc.name}`. On next load of the same Issue form, if a draft exists, show a banner: "You have an unsaved reply draft. Restore?" with Restore / Discard buttons. Hook implemented via a MutationObserver or `input` event on the comment box element in `adhd_issue.js`. Clears the saved draft on successful submission of the comment.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, RSD (prevents losing a reply you worked hard to write)

---

### 7.9 Assets

**Core ADHD friction in this module**: The Assets module is low-frequency and therefore highly prone to initiation paralysis — users open it so rarely that the workflow is never automatic. The dominant pain point is asset capitalization: converting a `Purchase Invoice` or `Purchase Receipt` into an `Asset` requires knowing that capitalization must be triggered manually via the `Asset Capitalization` doctype, which most users never discover. Depreciation is the secondary problem: the schedule exists as a child table but the user has no ambient signal that a depreciation entry is due.

#### Asset Creation Prompt on Invoice Submit
**Problem**: When a `Purchase Invoice` for a capitalisable item (where the `Item` has `is_fixed_asset = 1`) is submitted, ERPNext does not automatically prompt the user to create an `Asset`. The user must know to navigate to `Assets > Asset` independently.
**Feature**: When ADHD mode is active and a `Purchase Invoice` is submitted where any line item has `is_fixed_asset = 1`, show a non-blocking post-submit banner: "[X] item(s) on this invoice are fixed assets. Create Asset records now?" with a single "Create Assets" button that navigates to the `Asset` list filtered by `purchase_invoice = frm.doc.name` (or opens the Make > Asset flow if no assets exist yet). Logic is client-side in `accounts/doctype/purchase_invoice/adhd_purchase_invoice.js`: on `frm.refresh()` after submit, check `frm.doc.items.filter(r => r.is_fixed_asset)`. If any exist and no linked `Asset` records are found via a `frappe.call` count query, show the banner.
**Complexity**: S
**Cognitive mechanism addressed**: initiation

#### Depreciation Due Ambient Indicator
**Problem**: `Asset.schedules` (the `Asset Depreciation Schedule` child table) contains the dates of each upcoming depreciation entry. Whether this month's depreciation has been booked is invisible unless the user opens the Asset form and scans the child table.
**Feature**: When ADHD mode is active, add `Asset` to the Phase 3.1 heat-map list view, using the next unbooked `schedule_date` from the `Asset Depreciation Schedule` child table as the date signal. Amber border if a depreciation entry is due within 7 days; red if overdue. The next scheduled date is not in the standard list view columns — add it via a `frappe.call` fetch for the visible page's assets in `adhd_list_view.js`. On the `Asset` form itself, inject a one-line nudge if the current month has an unbooked depreciation: "Depreciation due this month — [Book Depreciation Entry]" linking to the standard `Book Asset Depreciation` button's action.
**Complexity**: M
**Cognitive mechanism addressed**: time blindness

#### Asset Capitalization Guided Flow
**Problem**: `Asset Capitalization` is the correct doctype for capitalizing multiple items into a single fixed asset (e.g., assembling a server from multiple purchased components). It requires the user to know the doctype exists, navigate to it, and correctly fill `target_asset`, `target_qty`, `target_valuation_rate`, and the `asset_items` child table — all without guidance. Most ADHD users skip it and create incomplete assets.
**Feature**: On the `Asset` form, when ADHD mode is active and the asset's `gross_purchase_amount` appears to be composed of multiple purchase invoices (detected by more than one `Asset Movement Item` row linked to the asset), show a low-priority nudge: "This asset may have multiple cost components. Use Asset Capitalization to consolidate them — [Learn more]" with a link that opens a 3-step mini-wizard modal:
1. Select source assets/items to capitalize
2. Review combined valuation
3. Confirm and create `Asset Capitalization` document

This is a wizard (Complexity L), but the detection nudge itself (Complexity S) should be shipped first as a standalone feature even without the wizard.
**Complexity**: L (full wizard); S (nudge only — ship this first)
**Cognitive mechanism addressed**: initiation, working memory

---

### 7.10 HR & Payroll

**Core ADHD friction in this module**: HR's ADHD problem is deadline clustering — payroll, leave allocation, and attendance regularization all have monthly hard deadlines that cluster at the same time and are invisible until they become urgent. The Employee Onboarding Wizard (Phase 4.4) addresses the onboarding flow. The remaining friction is in the recurring monthly HR cycle: processing salary slips, approving leave applications, and regularizing attendance before payroll cut-off.

> Note: Employee Onboarding Wizard is specified in Phase 4.4. These features address the recurring HR cycle, not onboarding.

#### Payroll Cycle Checklist
**Problem**: Running payroll in ERPNext requires: (1) marking attendance or importing it, (2) processing leave applications, (3) running `Process Payroll` to create `Salary Slip` records in Draft, (4) reviewing and submitting each Salary Slip, (5) creating a `Bank Salary` or `Payment Entry`. None of this sequence is documented in the UI, and step 4 (reviewing individual salary slips) is where most ADHD payroll processors get stuck — they submit 3 of 20, get distracted, and submit the rest two weeks late.
**Feature**: A "Run Payroll" checklist page (a new Frappe `Page` or a dedicated section in the HR workspace), analogous to the Month-End Close Checklist (Phase 4.2), showing the payroll cycle as an ordered checklist for the current month:
1. Attendance finalized (auto-checks if no `Attendance` records in status `Draft` exist for the month)
2. Leave applications processed (auto-checks if no pending `Leave Application` in `Open` status)
3. Salary Slips generated (links to `Process Payroll`)
4. Salary Slips reviewed (progress bar: X of Y submitted)
5. Payment processed (links to Bank Salary)

Step 4 shows a mini-table of unsubmitted Salary Slips with employee name, net pay, and a "Review & Submit" link each. Backed by a new `hr/services/adhd_payroll_status.py` endpoint.
**Complexity**: M
**Cognitive mechanism addressed**: initiation, time blindness, working memory

#### Leave Application "Balance at a Glance"
**Problem**: When approving or creating a `Leave Application`, neither the approver nor the employee can immediately see the applicant's remaining leave balance without navigating to `Leave Allocation` or running the Leave Balance report. This is a 2-step context switch for a number that should be on the form.
**Feature**: When ADHD mode is active on a `Leave Application` form and both `employee` and `leave_type` are set, inject a one-line leave balance display below the `leave_type` field: "Remaining [Leave Type] balance: X days." Fetched via `frappe.call('hrms.hr.doctype.leave_application.leave_application.get_leave_balance_on', {employee, date, leave_type})` — this Python method already exists in `hrms`. Display updates when either `employee` or `leave_type` changes. For the approver view, also show "Approved this year: Y days" (fetched from the same endpoint). Eliminates the context switch that consistently causes approvers to defer approval.
**Complexity**: S
**Cognitive mechanism addressed**: attention switching, working memory

#### Expense Claim "Receipt Attached?" Ambient Check
**Problem**: `Expense Claim` submissions are frequently returned by approvers because attachments (receipts) are missing. The submitter adds rows to the `expenses` child table, fills the amounts, and submits — forgetting the attachment until the rejection arrives. RSD makes the rejection worse.
**Feature**: When ADHD mode is active on an `Expense Claim` form in Draft state, check whether any file is attached via `frappe.call('frappe.client.get_list', {doctype: 'File', filters: {attached_to_doctype: 'Expense Claim', attached_to_name: frm.doc.name}})`. If `expenses` child table has rows but no file is attached, show a persistent amber banner: "No receipt attached — approvers usually require one. [Attach Receipt]" that links to the standard attachment button. Banner dismisses automatically when a file is attached (re-check on `frm.reload_doc`). Prevents the rejection before it happens — addressing the RSD trigger at its source.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, RSD

#### Shift Management "Who's Missing?" Alert
**Problem**: `Shift Type` and `Shift Assignment` define who should be working when, and `Attendance` records whether they showed up. But the discrepancy — people assigned to a shift who have no `Attendance` record for the day — is invisible to the HR manager until they run a report.
**Feature**: On the HR workspace, add an "Attendance Gap" widget (rendered as a workspace shortcut card, visible only in ADHD mode) that shows a count: "X employees assigned to today's shift have no attendance record." Clicking it opens the `Attendance` list filtered to show the gap. The count is fetched from a new lightweight `hr/services/adhd_attendance_gap.py` endpoint that computes `Shift Assignment` records for today minus existing `Attendance` records for today. Renders via the workspace `Custom Blocks` API. Low-complexity implementation; high operational value for managers who otherwise discover the gap at payroll time.
**Complexity**: M
**Cognitive mechanism addressed**: time blindness

---

### 7.11 Quality Management

**Core ADHD friction in this module**: Quality Management's ADHD problem is consequence invisibility — a `Quality Inspection` that fails, or a `Non-Conformance` report that is raised, creates no ambient urgency signal anywhere in the system. The user who raised the NCR has no ambient reminder to follow up; the manager who needs to close it has no visibility unless they actively run the Quality module reports. The module is also low-frequency for most users, making initiation cost disproportionately high.

#### Quality Inspection "Pass/Fail at a Glance" on Source Document
**Problem**: A `Quality Inspection` is linked to its source document (`Purchase Receipt`, `Delivery Note`, `Stock Entry`, `Job Card`) via the `reference_type` and `reference_name` fields. But the source document form shows no indication of whether the associated Quality Inspection passed or failed — the user must open the QI record separately.
**Feature**: When ADHD mode is active on a `Purchase Receipt`, `Delivery Note`, `Stock Entry`, or `Job Card` form, check for linked `Quality Inspection` records via `frappe.call('frappe.client.get_list', {doctype: 'Quality Inspection', filters: {reference_type: frm.doctype, reference_name: frm.doc.name}})`. If any exist, inject a compact "QI Status" badge next to the form title: green "QI Passed" / red "QI Failed" / amber "QI Pending." Clicking the badge opens the QI document. If no QI exists but the item has `inspection_required_before_delivery = 1` (on the `Item` doctype), show an amber "QI Required — [Create Inspection]" prompt. Eliminates the context switch to the QI module to check status.
**Complexity**: S
**Cognitive mechanism addressed**: working memory, attention switching

#### Non-Conformance Escalation Timer
**Problem**: `Non-Conformance` (NCR) records have no mandatory resolution date in the default ERPNext Quality module setup. Once raised, an NCR can sit open indefinitely. For ADHD users — both the person responsible for resolution and the person who raised it — there is no ambient signal that the NCR is aging.
**Feature**: Extend the Phase 3.1 heat-map infrastructure to the `Non-Conformance` list view, using `modified` (last activity date) as the staleness signal: amber border if unresolved and `modified` > 7 days ago; red border if > 14 days. If the NCR has a `due_date` field (custom or standard depending on ERPNext version), prefer that. On the `Non-Conformance` form, inject a "Days open: X" counter below the form title, updating in real-time via a 60-second interval. For NCRs older than 14 days, the counter turns red. Implemented in a new `quality_management/doctype/non_conformance/adhd_non_conformance.js`.
**Complexity**: S
**Cognitive mechanism addressed**: time blindness

#### Quality Goal Progress Ambient Tracker
**Problem**: `Quality Goal` records define targets (e.g., "reduce defect rate to <2% by Q4"). Progress against these goals must be manually reviewed by opening each goal. There is no ambient indication of which goals are on track, at risk, or missed.
**Feature**: Low priority for an initial ADHD build — `Quality Goal` is a strategic planning document, not an operational one. ADHD friction in ERPNext is predominantly operational (what do I do right now, did I miss a deadline). Quality Goal progress review is inherently periodic and deliberate; a "due-date heat map" approach does not map cleanly to a metric-vs-target tracking use case. **Recommendation**: defer to a later iteration; prioritize the QI pass/fail badge and NCR aging timer, which address real-time operational friction.

---

### 7.12 Subcontracting

**Core ADHD friction in this module**: Subcontracting is a high-complexity low-frequency workflow: `Subcontracting Order` → `Stock Entry (Send to Subcontractor)` → `Subcontracting Receipt`. The ADHD problem is chain tracking — the user must manually verify that goods were sent, track what the subcontractor received, and then process the receipt when finished goods arrive back. Like `Asset Capitalization`, the workflow is rarely used enough to become automatic, so each use has maximum initiation cost.

#### Subcontracting Order Chain Status Panel
**Problem**: A `Subcontracting Order` can have goods partially sent, partially returned, and partially received back as finished goods — all tracked through separate `Stock Entry` and `Subcontracting Receipt` documents. The form header shows only a status badge and `per_received`. There is no compact "where are the goods right now?" summary.
**Feature**: When ADHD mode is active on a `Subcontracting Order` form, inject a compact "Material Flow" status panel (collapsible section) showing:
- "Sent to supplier: X of Y units" (from linked `Stock Entry` records with `purpose = 'Send to Subcontractor'` and `subcontracting_order = frm.doc.name`)
- "Received back: X of Y units" (from linked `Subcontracting Receipt`, `received_qty` sum)
- "Outstanding at supplier: X units" (computed)
- Links to create the next relevant document: "Send Materials" if nothing sent yet; "Create Subcontracting Receipt" if all materials sent.

Data fetched via two `frappe.call` requests on form load, rendered in a new `subcontracting/doctype/subcontracting_order/adhd_subcontracting_order.js`. This is the same pattern as the PO status panel (Phase 4.3) applied to subcontracting.
**Complexity**: M
**Cognitive mechanism addressed**: working memory

#### Subcontracting Receipt "Components vs Finished Goods" Reconciler
**Problem**: When a `Subcontracting Receipt` is created, the user must verify that the finished goods received correspond to the components sent. The `items` child table shows finished goods; `supplied_items` shows components consumed. There is no visual link between the two, and an imbalance (more finished goods than components justify, or vice versa) is only caught at submit.
**Feature**: When ADHD mode is active on a `Subcontracting Receipt` form in Draft state, inject a compact reconciliation badge below the `items` and `supplied_items` child tables showing: "Finished goods: X units | Components consumed: Y units | Expected yield: Z% | [OK / Warning]." Expected yield is configurable per item via a custom field `expected_yield_pct` on the `Item` master (a small schema addition), defaulting to 100% if absent. If actual yield deviates from expected by more than 10%, the badge turns amber. If deviation is more than 25%, it turns red with: "Yield looks low — verify with supplier before submitting." Prevents a post-submit discovery that something was wrong. Implemented in `subcontracting/doctype/subcontracting_receipt/adhd_subcontracting_receipt.js`.
**Complexity**: M
**Cognitive mechanism addressed**: working memory, RSD

#### Subcontracting "Send Materials" Reminder
**Problem**: After submitting a `Subcontracting Order`, the user must remember to create the `Stock Entry` to send raw materials to the supplier. This is a manual next step with no prompt. For ADHD users, the gap between submitting the order and sending the materials is where work disappears.
**Feature**: When ADHD mode is active on a submitted `Subcontracting Order` where `per_sent_qty` (the existing field tracking material transfer progress) is 0, inject a post-submit banner: "Materials haven't been sent yet. [Create Stock Entry to send materials to supplier]" with a direct button that creates a `Stock Entry` with `purpose = 'Send to Subcontractor'` and pre-fills the `subcontracting_order` and `items` child table from the SCO. This is the chain-navigator pattern (Phase 2.1) applied to subcontracting, which is not covered by the standard Document Chain Navigator because it involves a `Stock Entry` with a non-standard purpose, not a direct Make menu item.
**Complexity**: S
**Cognitive mechanism addressed**: initiation, working memory
