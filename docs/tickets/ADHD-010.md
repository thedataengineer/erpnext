# ADHD-010: Payment Schedule Digest in Focus Panel

## Current implementation record

- **Status:** Implemented.
- **Implementation:** `erpnext/public/js/adhd/adhd_payment_digest.js` calls whitelisted `erpnext/accounts/services/adhd_payment_digest.py`.
- **Verification:** No ticket-specific automated test; site and browser behavior remain unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Adds a collapsible "Payment Summary" section to the ADHD Focus Panel showing total outstanding receivables, payments due this week grouped by customer, and overdue payments grouped by customer — each line with a one-click "Create Payment Entry" shortcut — so the user can manage cash flow without leaving the Focus Panel or navigating to the Accounts module.

## Background / Context
For small business ERPNext users with ADHD, accounts receivable is the area most likely to be neglected — not because it is unimportant, but because it requires navigating to a separate module, running a report, and then executing one or more actions. Each hop is a context switch that the ADHD brain interprets as "too much work right now". Missing payment follow-up directly harms cash flow. Surfacing the most critical receivable information inside the Focus Panel — which the user already has open for task management — reduces the activation energy to near zero.

## Cognitive Mechanism
Working memory | initiation | time blindness

## Prerequisites
- Focus Panel (`public/js/adhd/focus_panel.js`, shipped) must support adding collapsible sections to its DOM.
- ADHD mode toggle (`adhd_mode.js`, Phase 1) must be active.

## Scope
**Modify:**
- `erpnext/public/js/adhd/focus_panel.js` — add `_loadPaymentDigest()` and `_renderPaymentDigest(data)` methods; call `_loadPaymentDigest()` on panel open and on a 10-minute refresh interval

**Create:**
- `erpnext/accounts/services/adhd_payment_digest.py` — whitelisted Python endpoint returning structured payment summary data

## What Needs to Be Done

### Python: `erpnext/accounts/services/adhd_payment_digest.py`

1. **Create the module file.** Ensure it is importable — add an `__init__.py` to `erpnext/accounts/services/` if the directory is new.

2. **Write `get_payment_digest(company=None)`.** Decorated with `@frappe.whitelist()`. Logic:
   ```python
   import frappe
   from frappe.utils import today, add_days, flt

   @frappe.whitelist()
   def get_payment_digest(company=None):
       if not company:
           company = frappe.defaults.get_user_default("Company")
       
       filters = {"company": company, "docstatus": 1, "outstanding_amount": (">", 0)}
       
       invoices = frappe.get_all(
           "Sales Invoice",
           filters=filters,
           fields=["name", "customer", "outstanding_amount", "due_date", "currency"],
       )
       
       today_date  = today()
       week_end    = add_days(today_date, 7)
       
       total_outstanding = sum(flt(inv["outstanding_amount"]) for inv in invoices)
       
       overdue       = [inv for inv in invoices if inv["due_date"] < today_date]
       due_this_week = [inv for inv in invoices if today_date <= inv["due_date"] <= week_end]
       
       def group_by_customer(inv_list):
           grouped = {}
           for inv in inv_list:
               cust = inv["customer"]
               if cust not in grouped:
                   grouped[cust] = {"customer": cust, "total": 0.0, "invoices": []}
               grouped[cust]["total"] = flt(grouped[cust]["total"]) + flt(inv["outstanding_amount"])
               grouped[cust]["invoices"].append(inv["name"])
           return sorted(grouped.values(), key=lambda x: x["total"], reverse=True)
       
       return {
           "total_outstanding": total_outstanding,
           "currency": frappe.get_cached_value("Company", company, "default_currency"),
           "overdue":        group_by_customer(overdue),
           "due_this_week":  group_by_customer(due_this_week),
       }
   ```

3. **Add the module to `erpnext/hooks.py`.** No explicit hook is needed — the endpoint is reachable via `frappe.call` because `@frappe.whitelist()` registers it automatically. Verify it is reachable by path `erpnext.accounts.services.adhd_payment_digest.get_payment_digest`.

### JavaScript: `focus_panel.js` additions

4. **Add `_loadPaymentDigest()`.** Called on panel open and every 10 minutes:
   ```js
   _loadPaymentDigest() {
     if (!frappe.boot.adhd_mode) return;
     frappe.call({
       method: "erpnext.accounts.services.adhd_payment_digest.get_payment_digest",
       args: { company: frappe.defaults.get_default("Company") },
       callback: (r) => {
         if (r.message) this._renderPaymentDigest(r.message);
       },
     });
   }
   ```
   Schedule auto-refresh: in the panel constructor (or `open()` method), after calling `_loadPaymentDigest()`, store `this._paymentDigestInterval = setInterval(() => this._loadPaymentDigest(), 10 * 60 * 1000)`. Clear it in the panel's `close()` or `destroy()` method.

5. **Add `_renderPaymentDigest(data)`.** Find or create the digest section inside the Focus Panel DOM:
   ```js
   _renderPaymentDigest(data) {
     let $section = this.$body.find(".adhd-payment-section");
     if (!$section.length) {
       $section = $(`
         <div class="adhd-payment-section">
           <div class="adhd-payment-header">
             <span class="adhd-payment-title">💰 Payment Summary</span>
             <button class="adhd-payment-toggle" aria-label="Toggle">▾</button>
           </div>
           <div class="adhd-payment-body"></div>
         </div>
       `);
       $section.find(".adhd-payment-toggle").on("click", () => {
         $section.find(".adhd-payment-body").slideToggle(150);
         $section.find(".adhd-payment-toggle").text(
           $section.find(".adhd-payment-body").is(":visible") ? "▾" : "▸"
         );
       });
       this.$body.append($section);
     }
     const fmt = (amt) => format_currency(amt, data.currency);
     const makeRows = (items, label) => {
       if (!items || !items.length) return `<p class="adhd-payment-empty">No ${label} invoices</p>`;
       return items.map(item => `
         <div class="adhd-payment-row">
           <span class="adhd-payment-customer">${item.customer}</span>
           <span class="adhd-payment-amount">${fmt(item.total)}</span>
           <button class="btn btn-xs btn-primary adhd-payment-create"
             data-customer="${item.customer}"
             data-invoices="${item.invoices.join(",")}">
             Create Payment Entry
           </button>
         </div>
       `).join("");
     };
     $section.find(".adhd-payment-body").html(`
       <div class="adhd-payment-total">Total Outstanding: <strong>${fmt(data.total_outstanding)}</strong></div>
       <h5 class="adhd-payment-subhead">Overdue</h5>
       ${makeRows(data.overdue, "overdue")}
       <h5 class="adhd-payment-subhead">Due This Week</h5>
       ${makeRows(data.due_this_week, "due-this-week")}
     `);
     // Bind "Create Payment Entry" buttons
     $section.find(".adhd-payment-create").on("click", function () {
       const customer  = $(this).data("customer");
       const invoices  = $(this).data("invoices").split(",").filter(Boolean);
       frappe.new_doc("Payment Entry", {
         payment_type:    "Receive",
         party_type:      "Customer",
         party:           customer,
         references:      invoices.map(inv => ({ reference_doctype: "Sales Invoice", reference_name: inv })),
       });
     });
   }
   ```

6. **CSS additions in `adhd_mode.scss`:**
   ```scss
   .adhd-payment-section {
     border-top: 1px solid var(--border-color);
     padding-top: 10px;
     margin-top: 10px;
   }
   .adhd-payment-header {
     display: flex; justify-content: space-between; align-items: center;
     cursor: pointer; user-select: none;
   }
   .adhd-payment-title  { font-weight: 600; font-size: 0.85rem; }
   .adhd-payment-toggle { background: none; border: none; cursor: pointer; color: var(--text-muted); }
   .adhd-payment-total  { font-size: 0.82rem; margin: 6px 0; }
   .adhd-payment-subhead { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin: 8px 0 4px; }
   .adhd-payment-row {
     display: flex; align-items: center; gap: 6px;
     font-size: 0.82rem; padding: 3px 0;
   }
   .adhd-payment-customer { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
   .adhd-payment-amount   { font-weight: 600; flex-shrink: 0; }
   .adhd-payment-empty    { font-size: 0.8rem; color: var(--text-muted); }
   ```

## How to Test

1. Enable ADHD mode. Create two or three submitted Sales Invoices with `outstanding_amount > 0`: one with `due_date = yesterday` (overdue), two with `due_date = 3 days from now` (due this week), from different customers.
2. Open the Focus Panel. Confirm a "💰 Payment Summary" section appears at the bottom.
3. Confirm "Total Outstanding" shows the correct summed amount across all open invoices.
4. Confirm the overdue customer appears under "Overdue" with the correct amount.
5. Confirm the due-this-week customers appear under "Due This Week" with correct amounts.
6. Confirm each customer row has a "Create Payment Entry" button.
7. Click "Create Payment Entry" for one customer. Confirm a new Payment Entry form opens, pre-filled with `payment_type = Receive`, `party_type = Customer`, `party = [customer name]`.
8. Click the ▾ toggle on the Payment Summary section. Confirm the body collapses. Click again to confirm it re-expands.
9. Fully pay one of the overdue invoices (create and submit a Payment Entry for it). Wait for the 10-minute refresh or click a manual refresh if available. Confirm the paid invoice/customer no longer appears under "Overdue".
10. Disable ADHD mode. Close and reopen the Focus Panel. Confirm the Payment Summary section does not appear.
11. Open the browser console during panel load. Confirm no errors and confirm a single `frappe.call` to `get_payment_digest` is made.

## Acceptance Criteria
- [ ] "Payment Summary" collapsible section appears inside the Focus Panel when ADHD mode is active.
- [ ] Total Outstanding shows the correct sum of all open Sales Invoice outstanding amounts for the default company.
- [ ] "Overdue" sub-section lists customers with overdue invoices, grouped, with summed amounts.
- [ ] "Due This Week" sub-section lists customers with invoices due within 7 days, grouped, with summed amounts.
- [ ] Each customer row has a "Create Payment Entry" button that opens a pre-filled Payment Entry form.
- [ ] Pre-filled Payment Entry has `payment_type = Receive`, `party_type = Customer`, and the correct party name.
- [ ] The section collapses and expands correctly via the toggle button.
- [ ] Data refreshes every 10 minutes automatically.
- [ ] Fully paid invoices disappear from the digest after the next refresh.
- [ ] Payment Summary section is absent when ADHD mode is disabled.
- [ ] No console errors on load or refresh.

## Dependencies
- **Blocked by:** Focus Panel (shipped); ADHD mode toggle (Phase 1, shipped)
- **Blocks:** None directly; provides the payment digest endpoint that could be reused by ADHD-002 (Smart Inbox) future iterations

## Complexity
M — Requires a new Python endpoint with grouping logic, Focus Panel DOM extension, async data binding, and collapsible section UI; no novel risk but several moving parts across two files.

## Phase
Phase 3 — Ambient Awareness
