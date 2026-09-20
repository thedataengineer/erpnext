# ADHD-022: Customer "Essentials Only" Tab

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
