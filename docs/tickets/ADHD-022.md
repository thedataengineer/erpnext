# ADHD-022: Customer "Essentials Only" Tab

## Current implementation record

- **Status:** Implemented (2026-09-21). See `docs/adhd_mode_features.md` for where it lives and how it differs from this ticket.
- **Implementation:** No matching implementation or bundle registration exists on `iteration_3`.
- **Verification:** No implementation test exists; original acceptance criteria remain pending.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Injects a persistent "Essentials" summary section onto the Customer form when ADHD mode is active, surfacing the four fields that answer "can I take this order?" — credit limit, payment terms, primary contact email, and outstanding amount — without scrolling or opening child tables.

## Background / Context
The ERPNext Customer form is dense: it contains dozens of fields across multiple tabs (Details, Contacts, Addresses, Credit Limits, Portal, etc.). When an ADHD user is mid-conversation with a customer and needs a quick viability check — "is their credit okay, who do I email, how much do they owe?" — they must context-switch across three or four tabs. This working-memory overhead causes either hesitation before taking an order or mistakes from skipping the checks entirely. Surfacing the four decision-critical fields in one always-visible block eliminates every tab switch.

## Cognitive Mechanism
Working memory | attention switching | initiation

## Prerequisites
- ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` must be readable on the client.

## Scope
**Create:**
- `erpnext/selling/doctype/customer/adhd_customer.js`

## What Needs to Be Done

1. **Register the form hook.** In `adhd_customer.js`, register for both `refresh` and `after_load` so the section renders on first open and after saves:
   ```js
   frappe.ui.form.on("Customer", {
     after_load(frm) {
       if (!frappe.boot.adhd_mode) return;
       renderCustomerEssentials(frm);
     },
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       renderCustomerEssentials(frm);
     },
   });
   ```

2. **Fetch all required values in a single `frappe.call`.** Use `frappe.client.get_value` to retrieve scalar fields in one round trip:
   ```js
   async function renderCustomerEssentials(frm) {
     // Remove existing panel to prevent duplication
     $(frm.wrapper).find(".adhd-customer-essentials").remove();

     if (!frm.doc.name || frm.doc.__islocal) return;

     const customerData = await frappe.call({
       method: "frappe.client.get_value",
       args: {
         doctype: "Customer",
         filters: { name: frm.doc.name },
         fieldname: ["credit_limit", "payment_terms", "outstanding_amount"],
       },
     });

     // Fetch primary contact email from the Contacts child table (first row)
     const contactData = await frappe.call({
       method: "frappe.client.get_list",
       args: {
         doctype: "Contact",
         filters: [["Dynamic Link", "link_doctype", "=", "Customer"],
                   ["Dynamic Link", "link_name",    "=", frm.doc.name]],
         fields: ["email_id", "first_name", "last_name"],
         limit: 1,
         order_by: "creation asc",
       },
     });

     const vals = customerData.message || {};
     const contact = (contactData.message || [])[0] || {};

     injectEssentialsPanel(frm, vals, contact);
   }
   ```

3. **Implement `injectEssentialsPanel(frm, vals, contact)`.** Build the HTML string and inject it above the first form section:
   ```js
   function injectEssentialsPanel(frm, vals, contact) {
     const creditLimit    = vals.credit_limit
       ? format_currency(vals.credit_limit, frm.doc.default_currency)
       : "—";
     const outstanding    = vals.outstanding_amount != null
       ? format_currency(vals.outstanding_amount, frm.doc.default_currency)
       : "—";
     const paymentTerms   = vals.payment_terms || "—";
     const contactName    = contact.first_name
       ? `${contact.first_name} ${contact.last_name || ""}`.trim()
       : "—";
     const contactEmail   = contact.email_id || "—";

     // Credit utilisation status colour
     let creditStatusClass = "adhd-credit-ok";
     if (vals.credit_limit > 0 && vals.outstanding_amount >= vals.credit_limit) {
       creditStatusClass = "adhd-credit-over";
     } else if (vals.credit_limit > 0 && vals.outstanding_amount >= vals.credit_limit * 0.8) {
       creditStatusClass = "adhd-credit-warn";
     }

     const html = `
       <div class="adhd-customer-essentials">
         <span class="adhd-essentials-label">Essentials</span>
         <div class="adhd-essentials-grid">
           <div class="adhd-essentials-item">
             <span class="adhd-essentials-key">Credit Limit</span>
             <span class="adhd-essentials-value">${creditLimit}</span>
           </div>
           <div class="adhd-essentials-item">
             <span class="adhd-essentials-key">Outstanding</span>
             <span class="adhd-essentials-value ${creditStatusClass}">${outstanding}</span>
           </div>
           <div class="adhd-essentials-item">
             <span class="adhd-essentials-key">Payment Terms</span>
             <span class="adhd-essentials-value">${paymentTerms}</span>
           </div>
           <div class="adhd-essentials-item">
             <span class="adhd-essentials-key">Primary Contact</span>
             <span class="adhd-essentials-value">
               ${contactName}
               ${contactEmail !== "—" ? `<a href="mailto:${contactEmail}">${contactEmail}</a>` : "—"}
             </span>
           </div>
         </div>
       </div>`;

     // Prepend above the first form layout section
     $(frm.wrapper).find(".page-body .form-layout").prepend(html);
   }
   ```

4. **Add CSS to `adhd_mode.scss`:**
   - `.adhd-customer-essentials` — `display: flex; flex-direction: column; gap: 0.4rem; padding: 10px 16px; background: var(--subtle-fg); border-bottom: 2px solid var(--border-color); margin-bottom: 8px;`
   - `.adhd-essentials-label` — `font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);`
   - `.adhd-essentials-grid` — `display: flex; gap: 2rem; flex-wrap: wrap;`
   - `.adhd-essentials-key` — `font-size: 0.75rem; color: var(--text-muted); display: block;`
   - `.adhd-essentials-value` — `font-size: 0.95rem; font-weight: 600;`
   - `.adhd-credit-warn` — `color: var(--yellow-500);`
   - `.adhd-credit-over` — `color: var(--red-500);`

5. **Guard new Customer records.** The `frm.doc.__islocal` check in step 2 prevents fetch attempts on unsaved records where `frm.doc.name` is a temporary UUID.

6. **Include the file in `hooks.py`** under `app_include_js`, gated the same way as all other ADHD form scripts.

## How to Test

1. Open ERPNext desk with ADHD mode enabled.
2. Navigate to **Selling → Customers**. Open any existing Customer record.
3. Confirm a horizontal "Essentials" strip appears at the very top of the form body (above the first tab/section), showing four labelled values: Credit Limit, Outstanding, Payment Terms, Primary Contact.
4. If the customer has no payment terms set, confirm the Payment Terms field shows "—" rather than blank or an error.
5. If the customer has no linked Contact, confirm Primary Contact shows "—" rather than throwing a JS error.
6. Set the customer's `credit_limit` to 10,000 and `outstanding_amount` to 8,500 (≥80%). Save. Reopen. Confirm the Outstanding value is amber.
7. Set `outstanding_amount` to 10,000 (≥ limit). Reopen. Confirm the Outstanding value is red.
8. Confirm the email address in the Primary Contact row is a clickable `mailto:` link.
9. Click **New Customer** (unsaved). Confirm the Essentials panel does not appear (no fetch on new records).
10. Disable ADHD mode. Reopen an existing Customer. Confirm the Essentials panel is absent.
11. Open the Customer, trigger a save. Reopen. Confirm only one Essentials panel appears (no duplication).

## Acceptance Criteria
- [ ] Essentials panel appears at the top of the Customer form body when ADHD mode is active and the record is saved.
- [ ] Panel displays Credit Limit, Outstanding Amount, Payment Terms, and primary Contact email in a single horizontal strip.
- [ ] Outstanding Amount is coloured amber when ≥80% of credit limit and red when ≥100%.
- [ ] Primary contact email is rendered as a `mailto:` link when present.
- [ ] Missing values (no payment terms, no contact) display "—" without errors.
- [ ] Panel does not render on new (unsaved) Customer records.
- [ ] Panel does not duplicate after multiple saves/refreshes.
- [ ] Panel is absent when ADHD mode is disabled.
- [ ] No JavaScript console errors on the Customer form in any of the above states.

## Dependencies
- **Blocked by:** ADHD mode toggle (shipped)
- **Blocks:** None

## Complexity
S — Single form script, two async `frappe.call` fetches, pure HTML injection. No server endpoint, no doctype changes.

## Phase
Phase 7 — Module-by-Module Expansion

---

## LLM Implementation Guide

### Codebase Context

```
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- Client scripts: frappe.ui.form.on("DocType", { hook(frm) {} })
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Async API: frappe.call({ method, args, callback }) or await frappe.call(...)
- Child tables: frappe.model.add_child(frm.doc, childDoctype, fieldname)
- DOM sync: frm.refresh_field(fieldname)
- Persistence: localStorage.setItem/getItem/removeItem
- Include files: hooks.py under app_include_js or doctype_js
- CSS: erpnext/public/scss/adhd_mode.scss with CSS custom properties
- Python API: @frappe.whitelist(), called via dotted module path
- List queries: frappe.db.get_list / frappe.client.get_list return arrays of dicts
- Dialogs: new frappe.ui.Dialog({ title, fields, primary_action })
- Currency format: frappe.format(value, { fieldtype: "Currency" })

Specifics for this ticket:
- Two async frappe.call calls: get_value for credit_limit/payment_terms/outstanding_amount on Customer;
  get_list on Contact via Dynamic Link filter {link_doctype: "Customer", link_name: frm.doc.name}
- Inject HTML panel using $(html).insertBefore(frm.layout.wrapper.find(".form-layout").first())
- Credit utilisation = outstanding_amount / credit_limit * 100
- Colour thresholds: >= 100% red, >= 80% amber, else green
```

---

### Claude Prompt

```text
You are implementing ADHD-022: Customer "Essentials Only" Tab for ERPNext's ADHD Mode.

Context:
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- Client scripts: frappe.ui.form.on("DocType", { hook(frm) {} })
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Async API: frappe.call({ method, args, callback }) or await frappe.call(...)
- List queries: frappe.client.get_list returns arrays of dicts
- CSS: erpnext/public/scss/adhd_mode.scss with CSS custom properties
- Currency format: frappe.format(value, { fieldtype: "Currency" })

Task:
Create selling/doctype/customer/adhd_customer.js that injects an "Essentials" panel on the Customer form.

Requirements:
1. Hook into frappe.ui.form.on("Customer", { refresh(frm) {} }) with ADHD mode guard.
2. Make two parallel async frappe.call requests:
   a. frappe.call with method "frappe.client.get_value", args: {doctype:"Customer", name:frm.doc.name,
      fieldname:["credit_limit","payment_terms","outstanding_amount"]}
   b. frappe.call with method "frappe.client.get_list", args: {doctype:"Contact",
      filters:[["Dynamic Link","link_doctype","=","Customer"],["Dynamic Link","link_name","=",frm.doc.name]],
      fields:["name","full_name","email_id","phone"]}
3. Once both resolve, build an HTML panel with:
   - Credit limit, payment terms, outstanding amount (formatted as Currency)
   - Credit utilisation bar: outstanding/credit_limit*100, coloured green/<80%, amber/80-99%, red/>=100%
   - Primary contact name, email, phone
4. Inject the panel using insertBefore on ".form-layout" so it appears above the standard tabs.
5. Guard against re-injection if the panel already exists (#adhd-customer-essentials).

Think through: how to run two frappe.call requests in parallel and wait for both before rendering.
Produce the complete file with inline comments.
```

---

### GPT-4o Prompt

```text
## Task: ADHD-022 — Customer "Essentials Only" Tab

### Codebase Context
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- Client scripts: frappe.ui.form.on("DocType", { hook(frm) {} })
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Async API: await frappe.call({ method, args }) returns { message }
- List queries: frappe.client.get_list returns array of dicts
- Currency format: frappe.format(value, { fieldtype: "Currency" })
- CSS: erpnext/public/scss/adhd_mode.scss with CSS custom properties

### Requirements
- [ ] Create `selling/doctype/customer/adhd_customer.js`
- [ ] Hook: `frappe.ui.form.on("Customer", { refresh(frm) {} })`
- [ ] Guard: `if (!frappe.boot.adhd_mode) return;`
- [ ] Parallel async calls: get_value (credit_limit, payment_terms, outstanding_amount) + get_list (Contact via Dynamic Link)
- [ ] HTML panel injected above `.form-layout` using `insertBefore`
- [ ] Credit utilisation colour: >= 100% → red, >= 80% → amber, < 80% → green
- [ ] Panel ID `#adhd-customer-essentials` prevents duplicate injection
- [ ] Currency values formatted with `frappe.format`
- [ ] Handle case where credit_limit is 0 (avoid division by zero — show "No limit set")

### Output
Complete file contents for `adhd_customer.js` with inline comments.
```

---

### Gemini 1.5 Pro Prompt

```text
Implement ADHD-022: Customer "Essentials Only" Tab for ERPNext ADHD Mode. Follow these steps.

Codebase context:
Project: ERPNext on Frappe framework. JavaScript frontend, Python backend.
- Client scripts: frappe.ui.form.on("DocType", { hook(frm) {} })
- ADHD mode guard: if (!frappe.boot.adhd_mode) return;
- Async API: await frappe.call({ method, args }) returns { message }
- List queries: frappe.client.get_list returns array of dicts
- Currency format: frappe.format(value, { fieldtype: "Currency" })

Step 1 — Setup:
  Create selling/doctype/customer/adhd_customer.js.
  Register frappe.ui.form.on("Customer", { refresh(frm) {} }).
  Add ADHD mode guard as first statement. Add duplicate-panel guard checking for #adhd-customer-essentials.

Step 2 — Data fetch:
  Use Promise.all([frappe.call(...), frappe.call(...)]) to fetch in parallel:
  - get_value: doctype=Customer, name=frm.doc.name, fieldname=["credit_limit","payment_terms","outstanding_amount"]
  - get_list: doctype=Contact, filters on Dynamic Link for this customer, fields=["full_name","email_id","phone"]

Step 3 — Render panel:
  Build HTML string containing: credit limit, payment terms, outstanding amount (frappe.format as Currency).
  Compute utilisation = outstanding / credit_limit * 100. Assign class: red if >=100, amber if >=80, green otherwise.
  If credit_limit === 0, display "No limit set" instead of a percentage bar.
  Include primary contact (first result from get_list or "No contact found").

Step 4 — Inject:
  $('<div id="adhd-customer-essentials">'+html+'</div>').insertBefore(frm.layout.wrapper.find(".form-layout").first())

Step 5 — Verify:
  - Panel only injected once per form load.
  - No division by zero when credit_limit is 0.
  - Currency values use frappe.format, not raw numbers.

Output the complete file.
```

---

### Prompt Chain

This is an **S (small) ticket** — implement with a single prompt. Use any one of the three prompts above, then run the self-validation prompt below on the output.

---

### Self-Validation Prompt

```text
Review the following code for ADHD-022 (Customer "Essentials Only" Tab).

Check each item and respond PASS or FAIL + reason:

1. File is selling/doctype/customer/adhd_customer.js
2. frappe.ui.form.on("Customer", { refresh(frm) {} }) is registered
3. ADHD mode guard is the first statement in the handler
4. Two separate frappe.call requests are made (get_value for financials + get_list for Contact)
5. Both calls complete before the panel is rendered (Promise.all or sequential awaits)
6. Credit utilisation colour logic: >=100% red, >=80% amber, else green
7. Division-by-zero guard when credit_limit === 0
8. Panel has id="adhd-customer-essentials" and duplicate injection is prevented
9. Currency values use frappe.format(value, { fieldtype: "Currency" })

[Paste generated code here]
```
