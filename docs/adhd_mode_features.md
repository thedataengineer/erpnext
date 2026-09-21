# ADHD Mode Feature Catalog

This catalog reflects `main` as of 2026-09-21, after a review of every ticket against the code and the Frappe source. A status of **Implemented** means code exists and is loaded or callable. It does not mean browser or site acceptance has passed.

Status meanings:

- **Implemented:** Code exists, is loaded, and was checked against the Frappe/ERPNext source it depends on (field names, events, APIs). Test coverage varies by ticket; behaviour in a logged-in browser remains unverified unless stated.
- **Partial:** A useful subset exists, but repository schema or DocType structure prevents the ticket's full flow.
- **Blocked:** The required application structure or dependency is absent.
- **Planned:** The ticket exists, but no matching implementation is present.

## Runtime architecture

Client modules live under `erpnext/public/js/adhd/` and are imported in dependency order by `erpnext/public/js/erpnext.bundle.js`. `erpnext/hooks.py` includes that bundle; it does not register one `doctype_js` entry per ADHD feature.

Server-backed features call whitelisted RPC modules:

- Accounts: `erpnext/accounts/services/adhd_payment_digest.py`, `adhd_month_end.py`, and `adhd_period_close_check.py`
- Manufacturing: `erpnext/manufacturing/services/adhd_bom_ancestry.py`
- Stock: `erpnext/stock/adhd.py` and `erpnext/stock/adhd_quality.py`
- Telemetry: `erpnext/adhd_usage_log/doctype/adhd_usage_log/adhd_usage_log.py`

## ADHD-001 through ADHD-020

- **ADHD-001, Implemented:** Workflow document chain navigator, `adhd_chain_navigator.js`.
- **ADHD-002, Implemented:** Smart Inbox, `adhd_smart_inbox.js` and `erpnext/setup/page/adhd_inbox/`. It opens at `/desk/adhd-inbox`; the ADHD Home workspace (`erpnext/setup/workspace/adhd_home/`) links to it and to the Task Board. The workspace is named so it does not share a slug with the page, which Frappe would resolve to the workspace first.
- **ADHD-003, Implemented:** Mandatory-field guided save, `adhd_form_wizard.js`.
- **ADHD-004, Implemented:** Assistant recipes for Task, Expense Claim, Material Request, and Timesheet, `erpnext/assistant/recipes.py`.
- **ADHD-005, Implemented:** Keyboard shortcut reference, `adhd_help.js`.
- **ADHD-006, Implemented:** Due-date list heat map, `adhd_list_view.js`. It read `frappe.views.list_view` as if it were the list on screen (it is a map keyed by route), so it never attached; it now uses `cur_list`. Not yet seen in a browser.
- **ADHD-007, Implemented:** Pomodoro time-log prompt, `adhd_time_log.js`.
- **ADHD-008, Implemented:** Contextual deadline banners, `adhd_deadline_banner.js`.
- **ADHD-009, Implemented:** Hyperfocus time-box prompts, `form_focus.js` and `adhd_timebox_timer.js`.
- **ADHD-010, Implemented:** Focus Panel payment digest, `adhd_payment_digest.js` and its whitelisted service.
- **ADHD-011, Implemented:** Journal Entry balance meter, `adhd_accounts.js`. It called `frm.set_indicator`, which does not exist on a Form, and threw on every balanced entry; it now uses the page indicator and sums company-currency debit/credit.
- **ADHD-012, Implemented:** Month-end close checklist, `adhd_month_end.js` and its whitelisted service.
- **ADHD-013, Implemented:** Purchase Order lifecycle panel, `adhd_buying.js`. The step follows `status_updater.py` (a fully billed order that has not been received is still "To Receive").
- **ADHD-014, Blocked:** Employee onboarding wizard depends on HRMS doctypes and workspace files absent from this repository.
- **ADHD-015, Implemented:** Eight-DocType, 80-entry field-help catalog, `adhd_field_help.js`.
- **ADHD-016, Implemented:** Per-feature settings, `adhd_settings.js`.
- **ADHD-017, Implemented:** Opt-in friction telemetry and usage report.
- **ADHD-018, Implemented:** Personalized Smart Inbox ordering.
- **ADHD-019, Implemented:** Completion feedback with reduced-motion handling. Task completion and document submit (`on_submit`); a submit made through a workflow action fires no `on_submit`, so no feedback shows there.
- **ADHD-020, Implemented:** Developer-only browser test harness, `adhd_test_utils.js`.

## ADHD-021 through ADHD-030

These tickets remain **Planned**. No matching implementation or bundle registration exists on `iteration_3`:

- ADHD-021 Quotation expiry warning
- ADHD-022 Customer essentials view
- ADHD-023 Sales Order interruption restore (an earlier 60-second server auto-save in `form_focus.js` was removed: it saved half-edited forms and is not what the ticket specifies, which is a local snapshot)
- ADHD-024 Installation Note checklist
- ADHD-025 RFQ comparison card
- ADHD-026 Supplier scorecard nudge
- ADHD-027 Purchase Receipt expected-versus-received view
- ADHD-028 Purchase Invoice three-way match indicator
- ADHD-029 Sales Order delivery summary
- ADHD-030 Opportunity staleness indicator

## ADHD-031 through ADHD-040

- **ADHD-031, Implemented:** Bank reconciliation local progress, `adhd_bank_recon.js`.
- **ADHD-032, Implemented:** Payment Entry invoice shortlist, `adhd_payment_entry.js`.
- **ADHD-033, Implemented:** Last-used cost center and dimensions, `adhd_accounts.js`.
- **ADHD-034, Implemented:** Period-close readiness, `adhd_period_close_check.py` and `adhd_month_end.js`.
- **ADHD-035, Implemented:** Stock Entry impact preview, `adhd_stock_entry.js` and `erpnext/stock/adhd.py`.
- **ADHD-036, Implemented:** Item reorder-level list indicator, `adhd_list_view.js` and `erpnext/stock/adhd.py`. Same list-view fix as ADHD-006.
- **ADHD-037, Implemented:** FEFO batch picker with standard-search fallback, `adhd_batch_picker.js`.
- **ADHD-038, Partial:** Putaway explanation UI exists in `adhd_stock_entry.js`. `putaway_rule` does exist on `Stock Entry Detail` and `Purchase Receipt Item`; what is missing is a strategy or item-group on `Putaway Rule`, so the explanation can only say whether the rule is item-specific or generic.
- **ADHD-039, Implemented:** Stock Reconciliation variance warning, `adhd_stock_reconciliation.js`.
- **ADHD-040, Implemented:** Delivery Trip route summary, `adhd_delivery_trip.js`.

## ADHD-041 through ADHD-061

Most client behavior is consolidated in `erpnext/public/js/adhd/adhd_tickets_041_061.js`.

- **ADHD-041, Implemented:** BOM ancestry breadcrumb with whitelisted, permission-checked RPC.
- **ADHD-042, Implemented:** Work Order next-action prompt.
- **ADHD-043, Implemented:** Production Plan demand summary.
- **ADHD-044, Implemented:** Job Card start/stop time logger. Shown on saved (draft) cards that are not completed, which is where time is logged; times are written in the system time zone.
- **ADHD-045, Blocked:** The ticket assumes Plant Floor card hooks that the current ERPNext structure does not expose. A Shop Floor compatibility patch exists, but user-visible Plant Floor acceptance cannot be claimed.
- **ADHD-046, Implemented:** Project health snapshot.
- **ADHD-047, Implemented:** Timesheet activity and Task prefill.
- **ADHD-048, Partial:** Commitment extraction is attached to the CRM Notes dialog. CRM Note is a child DocType in this branch, so the implementation creates a parent-linked ToDo rather than a standalone CRM Note flow.
- **ADHD-049, Implemented:** Opportunity pipeline progress bar. Proposal runs ERPNext's `create_quotation` and Closed Lost opens the standard lost-reason dialog; the other stages are display-only.
- **ADHD-050, Implemented:** Task dependency blocker warning.
- **ADHD-051, Implemented:** Issue SLA form countdown and list urgency. Server times are read in the system time zone; the list urgency depends on the list-view fix under ADHD-006.
- **ADHD-052, Implemented:** Warranty coverage banner.
- **ADHD-053, Not needed:** The earlier implementation targeted `.reply-area` / `.communication-box` elements that do not exist, so it never saved anything. Frappe's own reply composer already keeps a draft per document, so the code was removed.
- **ADHD-054, Implemented:** Fixed-asset creation prompt from Purchase Invoice.
- **ADHD-055, Implemented:** Asset depreciation urgency in list view. Depends on the list-view fix under ADHD-006.
- **ADHD-056, Implemented:** Asset Capitalization guided steps.
- **ADHD-057 through ADHD-059, Blocked:** Payroll checklist, leave balance, and Expense Claim receipt checks require HRMS, which is absent. No application code was added.
- **ADHD-060, Implemented:** Batched Quality Inspection status on source documents.
- **ADHD-061, Implemented:** Subcontracting Order material-flow status and standard mapping actions.

There is no `docs/tickets/ADHD-062.md`. ADHD-061 is the highest existing ticket.

## Known limitations

- **Not seen in a browser.** Nothing here has been exercised in a logged-in Desk. Payment Entry timing (waiting for ERPNext's own party handler), the payment-digest hand-off, and the list-view heat map need that check first.
- **Payment Entry** does not recalculate `paid_amount` after applying a shortlisted invoice.
- **Chain navigator** on a Quotation cannot see existing Delivery Notes or Sales Invoices (Frappe's `linked_with` does not return them from a Quotation), so those steps may offer a duplicate.
- **ADHD Home** is a public workspace, so it appears in the sidebar for every user whether or not they use ADHD mode.
- **Command bar and chat** (`erpnext/assistant/`) are deliberately available to every user, not only in ADHD mode: Cmd/Ctrl+K opens the bar, Alt+J the chat.

## Reproducible checks

Run repository-level Node checks from the repository root:

```bash
node --test erpnext/tests/*.test.js
```

These read the client source and run its pure helpers in a `vm` sandbox. The `adhd_fixes_*.test.js` files each fail against the code as it was before the review fixes.

Run assistant tests only from a working bench with a configured test site:

```bash
bench --site <test-site> run-tests --module erpnext.tests.test_hooks
bench --site <test-site> run-tests --module erpnext.tests.test_adhd_server
bench --site <test-site> run-tests --module erpnext.assistant.test_assistant
bench --site <test-site> run-tests --module erpnext.assistant.test_crm
bench --site <test-site> run-tests --module erpnext.assistant.test_recipes_extended
```

`test_hooks` fails if `erpnext/hooks.py` loses its essential hooks; `test_adhd_server` runs each ADHD endpoint for real. They roll back and do not import `erpnext.tests.utils`, but use a disposable test site anyway.

Node tests do not prove Desk rendering, DocType permissions, mapped-document actions, or live RPC results. Those states remain **unverified at site level** until the browser matrix in `docs/adhd_testing.md` is executed.