# ADHD Mode Feature Catalog

This catalog reflects `main` as of 2026-09-21, after a review of every ticket against the code and the Frappe source. A status of **Implemented** means code exists and is loaded or callable. It does not mean browser or site acceptance has passed.

Status meanings:

- **Implemented:** Code exists, is loaded, and was checked against the Frappe/ERPNext source it depends on (field names, events, APIs). Test coverage varies by ticket; behaviour in a logged-in browser remains unverified unless stated.
- **Partial:** A useful subset exists, but repository schema or DocType structure prevents the ticket's full flow.
- **Blocked:** The required application structure or dependency is absent.
- **Planned:** The ticket exists, but no matching implementation is present.

## Naming

People see "Focus" everywhere: Focus Mode, Focus Settings, Focus Inbox, Focus Home, Focus Panel, the `/desk/focus-inbox` and `/desk/focus-task-board` pages (the old `adhd-inbox` and `adhd-task-board` addresses still redirect), and the Focus Usage Log DocType, module and Focus Usage Summary report. "ADHD" is kept only as an internal name that no page shows: ticket numbers (ADHD-0NN), file names under `public/js/adhd/`, the `erpnext.adhd` JavaScript namespace, `frappe.boot.adhd_mode`, CSS classes, and the `adhd_telemetry_enabled` and `adhd_confirmed_installed` Custom Field names (renaming a field moves data, and nobody reads the field name).

Sites created before the rename are moved by the patch `erpnext.patches.v17_0.rename_adhd_to_focus`, which runs before the model sync: the DocType and its table are renamed (rows kept), the usage-log module is replaced, and the old report and pages are removed.

## Runtime architecture

Client modules live under `erpnext/public/js/adhd/` and are imported in dependency order by `erpnext/public/js/erpnext.bundle.js`. `erpnext/hooks.py` includes that bundle; it does not register one `doctype_js` entry per ADHD feature.

Server-backed features call whitelisted RPC modules:

- Accounts: `erpnext/accounts/services/adhd_payment_digest.py`, `adhd_month_end.py`, `adhd_period_close_check.py`, and `adhd_three_way_match.py`
- Selling: `erpnext/selling/services/adhd_customer_essentials.py`
- Buying: `erpnext/buying/services/adhd_rfq_compare.py` and `adhd_receipt_diff.py`
- Manufacturing: `erpnext/manufacturing/services/adhd_bom_ancestry.py`
- Stock: `erpnext/stock/adhd.py` and `erpnext/stock/adhd_quality.py`
- Telemetry: `erpnext/focus_usage_log/doctype/focus_usage_log/focus_usage_log.py`

## ADHD-001 through ADHD-020

- **ADHD-001, Implemented:** Workflow document chain navigator, `adhd_chain_navigator.js`.
- **ADHD-002, Implemented:** Smart Inbox, `adhd_smart_inbox.js` and `erpnext/setup/page/focus_inbox/`. It opens at `/desk/focus-inbox`; the Focus Home workspace (`erpnext/setup/workspace/focus_home/`) links to it and to the Task Board. The workspace is named so it does not share a slug with the page, which Frappe would resolve to the workspace first.
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
- **ADHD-016, Implemented:** Per-feature settings, `adhd_settings.js`. Eleven switches, each read by its feature and applied without a reload; the settings are stored per browser, not per user. Defaults follow the ticket: everything on except Auto Time-Log Prompt and Daily Payment Digest, so those two sections stay hidden until switched on.
- **ADHD-017, Implemented:** Opt-in friction telemetry and usage report.
- **ADHD-018, Implemented:** Personalized Smart Inbox ordering.
- **ADHD-019, Implemented:** Completion feedback with reduced-motion handling. Task completion and document submit (`on_submit`); a submit made through a workflow action fires no `on_submit`, so no feedback shows there.
- **ADHD-020, Implemented:** Developer-only browser test harness, `adhd_test_utils.js`.

## ADHD-021 through ADHD-030

Built 2026-09-21 on `main`, each against the Frappe/ERPNext source it depends on. Every one is display or navigation only: none blocks a save or submit. None has been seen in a logged-in browser.

- **ADHD-021, Implemented:** Quotation expiry banner, `adhd_quotation.js`, and expiry colouring in the Quotation list, `adhd_list_view.js` (`valid_till`; amber in the last 7 days, red on the last day and after). A quotation is still valid on its `valid_till` date, so that day is "Expires today", not "Expired".
- **ADHD-022, Implemented:** Customer "Essentials" strip, `adhd_customer.js` and `erpnext/selling/services/adhd_customer_essentials.py`: credit limit, outstanding amount, payment terms and primary contact email. Neither the limit (a per-company child table) nor the outstanding amount (computed from the ledger) is a Customer column, so both come from the functions ERPNext's own credit-limit check uses, for one company in that company's currency. With several companies and no default the figures are withheld rather than guessed.
- **ADHD-023, Implemented:** Sales Order / Quotation interruption restore, `adhd_draft_recovery.js`. A snapshot of the unsaved form is kept in `localStorage` every 30 seconds, per user (a week's expiry, at most 20 snapshots, none over 150k characters) and the next open asks "Resume it?". It never saves or calls the server. `create_new.js` marks every new document unsaved, so a new form is only snapshotted once a party or item exists. Quotation has no `customer` field (its party is `quotation_to` and `party_name`), so its field list differs from Sales Order's. The offer is triggered from the Smart Inbox's form hook and from the module's own `refresh` handler.
- **ADHD-024, Implemented:** Installation Note checklist, `adhd_installation_note.js`. The column is a real Custom Field, `Installation Note Item-adhd_confirmed_installed` (Check, hidden by default), shipped in `erpnext/fixtures/custom_field.json`; the mode reveals it in the items grid and shows "3 of 5 confirmed". It needs `bench migrate` on an existing site. Frappe's Grid cannot add a column at run time (`add_custom_column` exists only on Query Report), which is why it is a field and not a client-only column. A user with custom grid columns may need "Add / Remove Columns" to see it.
- **ADHD-025, Implemented:** RFQ "Compare Responses" dialog, `adhd_rfq.js` and `erpnext/buying/services/adhd_rfq_compare.py`. A Supplier Quotation does not name its RFQ on the header; the link is on its item rows, so quotations are found through those. Rates are ranked per stock UOM in company currency, and totals only between quotations that priced every item. Supplier Quotation has no payment terms, so the supplier's default is shown. "Select" opens the quotation and creates nothing.
- **ADHD-026, Implemented:** Supplier scorecard nudge on a new Purchase Order, `adhd_purchase_order_scorecard.js` (threshold `SCORECARD_NUDGE_THRESHOLD`, 50). Supplier Scorecard is readable by System Manager only, so other roles see no nudge and no error.
- **ADHD-027, Implemented:** Purchase Receipt open-quantity view, `adhd_purchase_receipt.js` and `erpnext/buying/services/adhd_receipt_diff.py`. The receipt has no `purchase_order` header field, so orders come from the item rows. Pending is `qty - received_qty`, which is already net of returns.
- **ADHD-028, Implemented:** Purchase Invoice three-way match badge, `adhd_purchase_invoice_match.js` and `erpnext/accounts/services/adhd_three_way_match.py`. The invoice links to its Purchase Order and Receipt on the item rows (`po_detail`, `pr_detail`), not the header, so each referenced row is compared in the invoice's own currency. The ticket's fixed 5% tolerance is not used: the badge mirrors ERPNext's own rules (the Purchase Order overflow check on submit, the Purchase Receipt billing validation, the same-rate setting, the item's or Accounts Settings' over-billing allowance), so green never means "submit will throw". Draft invoices only, advisory, and no badge on returns.
- **ADHD-029, Implemented:** Sales Order delivery summary, `adhd_sales_order.js`: delivered and remaining quantity per line and a "Create Delivery Note" shortcut. It needs no server call, since each item row carries `delivered_qty`.
- **ADHD-030, Implemented:** Opportunity staleness, `adhd_opportunity.js` and `adhd_list_view.js`: a "stale" badge and list colouring once an opportunity has not been saved for two weeks (amber from one week). It counts from `modified`, so a note, call or email added to it does not reset the count.

Form modules must use `frm.layout.wrapper` (jQuery) or `frm.$wrapper`. `frm.layout.$wrapper` does not exist; ten earlier modules used it and were fixed.

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
- **Focus Home** is a public workspace, so it appears in the sidebar for every user whether or not they use Focus Mode.
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