# ADHD-034: Period Closing Readiness Dashboard

## Summary
A one-click "Close Readiness" section added to the Month-End Close Checklist that runs a server-side check and returns a plain-English summary of all blocking issues — giving ADHD users a single authoritative signal about whether it is safe to close the period.

## Background / Context
Determining whether a period is safe to close requires manually inspecting four separate doctypes (Journal Entry, Bank Transaction, Purchase Invoice, Sales Invoice) across filtered date ranges — a multi-tab, multi-step investigation that burns significant working memory and is highly prone to step omission. ADHD users either skip the check entirely (risking a dirty close) or over-check compulsively (losing time). The friction lives in the Accounts module's month-end workflow, specifically the gap between "I think I'm done" and "I'm certain it's safe to close."

## Cognitive Mechanism
Working memory | initiation | time blindness

## Prerequisites
- ADHD-012 (Month-End Close Checklist — both the `adhd_month_end.py` server module and the client-side checklist UI must exist; this ticket adds a new section to that existing structure).

## Scope
**Create:**
- `erpnext/accounts/services/adhd_period_close_check.py` — new server-side whitelisted API.

**Modify:**
- `erpnext/accounts/services/adhd_month_end.py` — add a "Close Readiness" section to the checklist rendered by ADHD-012.
- Client-side JS for the Month-End Checklist (wherever ADHD-012 defined its JS component) — add the readiness panel and real-time refresh logic.

## What Needs to Be Done

### Server Side — `adhd_period_close_check.py`

1. **Create the whitelisted API method:**
   ```python
   import frappe
   from frappe.utils import getdate

   @frappe.whitelist()
   def get_period_close_readiness(company: str, from_date: str, to_date: str) -> dict:
       """
       Returns a summary of blocking issues for period closing.
       All counts are scoped to the given company and date range.
       """
       issues = []

       # Check 1: Draft Journal Entries in the period
       draft_je = frappe.db.count("Journal Entry", {
           "company": company,
           "posting_date": ["between", [from_date, to_date]],
           "docstatus": 0,
       })
       if draft_je:
           issues.append({
               "type": "draft_journal_entries",
               "count": draft_je,
               "label": f"{draft_je} Draft Journal {'Entry' if draft_je == 1 else 'Entries'} in this period",
               "link": f"/app/journal-entry?company={company}&posting_date=between {from_date} {to_date}&docstatus=0",
               "severity": "error",
           })

       # Check 2: Unreconciled bank transactions in the period
       unreconciled = frappe.db.count("Bank Transaction", {
           "company": company,
           "date": ["between", [from_date, to_date]],
           "status": ["!=", "Reconciled"],
           "docstatus": 1,
       })
       if unreconciled:
           issues.append({
               "type": "unreconciled_bank_transactions",
               "count": unreconciled,
               "label": f"{unreconciled} Unreconciled Bank {'Transaction' if unreconciled == 1 else 'Transactions'}",
               "link": f"/app/bank-transaction?company={company}&date=between {from_date} {to_date}&status!=Reconciled",
               "severity": "warning",
           })

       # Check 3: Unsubmitted Purchase Invoices in the period
       unsubmitted_pi = frappe.db.count("Purchase Invoice", {
           "company": company,
           "posting_date": ["between", [from_date, to_date]],
           "docstatus": 0,
       })
       if unsubmitted_pi:
           issues.append({
               "type": "unsubmitted_purchase_invoices",
               "count": unsubmitted_pi,
               "label": f"{unsubmitted_pi} Draft Purchase {'Invoice' if unsubmitted_pi == 1 else 'Invoices'}",
               "link": f"/app/purchase-invoice?company={company}&posting_date=between {from_date} {to_date}&docstatus=0",
               "severity": "warning",
           })

       # Check 4: Unsubmitted Sales Invoices in the period
       unsubmitted_si = frappe.db.count("Sales Invoice", {
           "company": company,
           "posting_date": ["between", [from_date, to_date]],
           "docstatus": 0,
       })
       if unsubmitted_si:
           issues.append({
               "type": "unsubmitted_sales_invoices",
               "count": unsubmitted_si,
               "label": f"{unsubmitted_si} Draft Sales {'Invoice' if unsubmitted_si == 1 else 'Invoices'}",
               "link": f"/app/sales-invoice?company={company}&posting_date=between {from_date} {to_date}&docstatus=0",
               "severity": "warning",
           })

       total_issues = len(issues)
       return {
           "issues": issues,
           "total": total_issues,
           "ready": total_issues == 0,
           "summary": "Ready to close." if total_issues == 0
                       else f"{total_issues} {'issue' if total_issues == 1 else 'issues'} to resolve before closing.",
       }
   ```

2. **Register in `erpnext/hooks.py`** under `doc_events` if needed, or simply rely on `@frappe.whitelist()` decorator — no hooks.py change required for a standalone API.

### Client Side — Month-End Checklist JS (ADHD-012 file)

3. **Add a "Close Readiness" section to the checklist UI.** In the existing checklist render function (from ADHD-012), append a new section after the existing checklist items:
   ```js
   function renderReadinessSection(container, company, fromDate, toDate) {
     const $section = $(`
       <div id="adhd-close-readiness" class="adhd-readiness-section">
         <div class="adhd-readiness-header">
           <h5>Close Readiness</h5>
           <button class="btn btn-sm btn-default adhd-check-readiness-btn">Check Now</button>
         </div>
         <div class="adhd-readiness-body">
           <span class="text-muted" style="font-size:0.85rem;">Click "Check Now" to scan for blocking issues.</span>
         </div>
       </div>
     `);
     container.append($section);

     $section.find(".adhd-check-readiness-btn").on("click", function () {
       runReadinessCheck(company, fromDate, toDate);
     });
   }
   ```

4. **`runReadinessCheck(company, fromDate, toDate)`.** Calls the server method and renders results:
   ```js
   function runReadinessCheck(company, fromDate, toDate) {
     const $body = $("#adhd-close-readiness .adhd-readiness-body");
     $body.html('<span class="text-muted">Checking…</span>');

     frappe.call({
       method: "erpnext.accounts.services.adhd_period_close_check.get_period_close_readiness",
       args: { company, from_date: fromDate, to_date: toDate },
       callback(r) {
         if (!r.message) return;
         const data = r.message;
         renderReadinessResults($body, data);
       },
     });
   }
   ```

5. **`renderReadinessResults($body, data)`.** Clears `$body` and renders:
   - A summary line: `"✅ Ready to close."` in green, or `"⚠ 3 issues to resolve before closing."` in red/amber.
   - For each issue, a row: `[icon] [label] — <a href="[link]">View ›</a>`.
   - Use `severity: "error"` for red items, `"warning"` for amber.
   - After each `<a>` link, add an inline `<button class="btn btn-xs btn-default adhd-recheck-btn" data-type="[type]">Recheck</button>`.

6. **"Recheck" per-issue button.** Clicking a Recheck button re-fires `runReadinessCheck` and updates only that issue's count in the results without re-rendering the whole section. Identify by `data-type` attribute and update the specific `<li>` element's count and label.

7. **Auto-recheck when user returns to the checklist tab.** Listen for `$(document).on("visibilitychange", ...)` — when `document.visibilityState === "visible"` and `#adhd-close-readiness` is in the DOM, silently re-run `runReadinessCheck` and update the summary line. This ensures the count is current after the user resolves an issue in another tab.

## How to Test

1. Open ERPNext with ADHD mode enabled. Navigate to the Month-End Close Checklist (ADHD-012 feature).
2. Ensure there is at least one Draft Journal Entry in the current month for the selected company.
3. In the "Close Readiness" section at the bottom of the checklist, click "Check Now."
4. Confirm a loading indicator appears, then results render with the Draft Journal Entry count and a "View ›" link.
5. Click the "View ›" link. Confirm it opens the Journal Entry list filtered to Draft entries in the correct date range.
6. Submit the Draft Journal Entry. Switch back to the checklist tab. Confirm the counts update automatically (via `visibilitychange`).
7. Resolve all four issue types (submit all drafts, reconcile all bank transactions). Click "Check Now" again. Confirm the section shows "✅ Ready to close."
8. Click "Recheck" next to a specific issue type. Confirm only that issue's count updates.
9. Disable ADHD mode. Confirm the readiness section does not appear on the checklist.

## Acceptance Criteria
- [ ] "Check Now" button fires the `get_period_close_readiness` API and renders results within the checklist UI.
- [ ] All four checks (Draft JE, Unreconciled Bank Transactions, Draft Purchase Invoices, Draft Sales Invoices) return correct counts scoped to the selected company and date range.
- [ ] Each issue includes a "View ›" link that opens the correct pre-filtered ERPNext list.
- [ ] When all checks pass, the summary shows "Ready to close." in green.
- [ ] Auto-recheck fires when the user returns to the checklist browser tab.
- [ ] Per-issue "Recheck" button updates only the relevant issue's count.
- [ ] No issues appear when the period is clean and ready to close.
- [ ] Readiness section is absent when ADHD mode is disabled.
- [ ] No Python exceptions or JavaScript console errors during normal operation.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD-012 (Month-End Close Checklist must be fully implemented before this section can be added to it).

## Complexity
M — Requires a new Python API with four DB count queries, client-side result rendering in an existing UI component, and a visibility-change auto-refresh mechanism; no schema changes.

## Phase
Phase 7 — Module-by-Module Expansion
