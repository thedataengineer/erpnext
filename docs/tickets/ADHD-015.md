# ADHD-015: Field Help Coverage — Systematic Expansion

## Current implementation record

- **Status:** Implemented.
- **Implementation:** `erpnext/public/js/adhd/adhd_field_help.js` supplies 80 entries across eight DocTypes; `form_focus.js` renders them.
- **Verification:** `node --test erpnext/tests/adhd_tickets_011_020.test.js` provides structural coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Expand contextual field help to cover the 10 most important fields in 8 key doctypes and extract all field help into a dedicated, reviewable file with a fallback mechanism for fields not yet covered.

## Background / Context
ADHD users benefit from plain-English field descriptions that appear on focus, reducing the need to remember what a field does or look it up in documentation. The existing `FIELD_HELP` dictionary in `form_focus.js` covers only a handful of fields, leaving most of the app without guidance. Users who encounter unfamiliar fields on Sales Invoices, Salary Slips, or Work Orders currently have no in-form help at all — a blank moment that triggers disengagement.

## Cognitive Mechanism
working memory | initiation

## Prerequisites
- ADHD-003 (Mandatory Field Wizard) — shares the `FIELD_HELP` data structure; ensure the format is compatible

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_field_help.js` — the canonical field help dictionary (80 entries)

**Modify:**
- `erpnext/public/js/adhd/form_focus.js` — import from `adhd_field_help.js` instead of inline dict; add fallback to `DocField.description`

## What Needs to Be Done

1. **Create `adhd_field_help.js` with the `FIELD_HELP` export**
   Structure:
   ```js
   export const FIELD_HELP = {
     'Sales Invoice': {
       customer:              'The person or company you are billing.',
       posting_date:          'The date this invoice is officially issued.',
       due_date:              'Last day to receive payment without penalty.',
       payment_terms_template:'Rules for when and how payment is split.',
       currency:              'Currency used for all amounts on this invoice.',
       selling_price_list:    'The price list that sets item rates automatically.',
       taxes_and_charges:     'Tax template applied to all line items.',
       grand_total:           'Total amount the customer owes including tax.',
       outstanding_amount:    'Amount still unpaid on this invoice.',
       cost_center:           'Department or project this revenue belongs to.',
     },
     'Purchase Order': {
       supplier:              'The vendor you are buying from.',
       transaction_date:      'Date you placed this order.',
       schedule_date:         'Expected delivery date from the supplier.',
       currency:              'Currency agreed with the supplier.',
       buying_price_list:     'Price list that sets item costs automatically.',
       taxes_and_charges:     'Tax template applied to all line items.',
       grand_total:           'Total amount you will pay including tax.',
       per_received:          'Percentage of ordered quantity already received.',
       per_billed:            'Percentage of received quantity already invoiced.',
       supplier_address:      'Supplier\'s address used on the purchase order.',
     },
     'Payment Entry': {
       payment_type:          'Receive (customer pays you), Pay (you pay someone), or Internal Transfer.',
       party_type:            'Whether you are paying a Customer, Supplier, or Employee.',
       party:                 'The specific customer, supplier, or employee.',
       paid_amount:           'How much money is being moved.',
       received_amount:       'Amount received after exchange rate conversion.',
       reference_date:        'Date of the bank transaction or cheque.',
       mode_of_payment:       'How money moves — bank transfer, cheque, cash, etc.',
       account_paid_from:     'Bank or cash account money leaves from.',
       account_paid_to:       'Bank or cash account money arrives in.',
       difference_amount:     'Rounding or exchange difference; should be zero normally.',
     },
     'Salary Slip': {
       employee:              'The person this payslip is for.',
       posting_date:          'Date the salary is officially processed.',
       start_date:            'First day of the pay period.',
       end_date:              'Last day of the pay period.',
       salary_structure:      'The pay template that defines earnings and deductions.',
       gross_pay:             'Total earnings before any deductions.',
       total_deduction:       'Total amount deducted (taxes, PF, etc.).',
       net_pay:               'Amount the employee actually receives.',
       payment_days:          'Working days the employee is being paid for.',
       leave_without_pay:     'Days absent without approved paid leave.',
     },
     'Work Order': {
       production_item:       'The finished product you are manufacturing.',
       qty:                   'How many units to produce.',
       planned_start_date:    'When production is scheduled to begin.',
       planned_end_date:      'When production should be finished.',
       bom_no:                'Bill of Materials that lists required raw materials.',
       wip_warehouse:         'Where raw materials are held during production.',
       fg_warehouse:          'Where finished goods go after production.',
       status:                'Current state — Draft, In Process, Completed, or Stopped.',
       produced_qty:          'How many units have been manufactured so far.',
       company:               'Legal entity responsible for this production order.',
     },
     'BOM': {
       item:                  'The finished product this Bill of Materials is for.',
       quantity:              'How many finished units one BOM batch produces.',
       is_active:             'Only active BOMs are used in production orders.',
       is_default:            'This BOM is selected automatically for the item.',
       raw_material_cost:     'Total cost of all ingredients to make one batch.',
       operating_cost:        'Labour and machine cost to make one batch.',
       total_cost:            'Raw material plus operating cost per batch.',
       currency:              'Currency used for all cost figures.',
       company:               'Plant or entity this BOM is valid for.',
       rm_cost_as_per:        'Basis for material cost — Valuation Rate or Price List.',
     },
     'Stock Entry': {
       stock_entry_type:      'Purpose — Material Issue, Receipt, Transfer, Manufacture, etc.',
       posting_date:          'Date this stock movement is recorded.',
       from_warehouse:        'Warehouse stock is moving out of (for transfers/issues).',
       to_warehouse:          'Warehouse stock is moving into (for receipts/transfers).',
       total_incoming_value:  'Total value of stock arriving in the destination warehouse.',
       total_outgoing_value:  'Total value of stock leaving the source warehouse.',
       value_difference:      'Difference in value; used for accounting entries.',
       purpose:               'Reason for movement — same as stock_entry_type.',
       company:               'Entity whose stock is being moved.',
       project:               'Project this stock movement is charged to, if any.',
     },
     'Journal Entry': {
       voucher_type:          'Category of entry — Bank Entry, Cash Entry, Accrual, etc.',
       posting_date:          'Date this entry appears in the general ledger.',
       company:               'Entity whose books are being updated.',
       total_debit:           'Sum of all debit amounts — must equal total credit.',
       total_credit:          'Sum of all credit amounts — must equal total debit.',
       cheque_no:             'Cheque or transaction reference number.',
       cheque_date:           'Date on the cheque or bank transaction.',
       remark:                'Internal note explaining why this entry was made.',
       multi_currency:        'Enable to record amounts in more than one currency.',
       bill_no:               'Vendor invoice number this entry relates to.',
     },
   };
   ```
   Each entry: plain English, ≤ 15 words, no accounting jargon without explanation.

2. **Update `form_focus.js` to import from `adhd_field_help.js`**
   - Replace the inline `FIELD_HELP` object with:
     ```js
     import { FIELD_HELP } from './adhd_field_help.js';
     ```
   - If the file uses `frappe.require` instead of ESM, concatenate `adhd_field_help.js` before `form_focus.js` in the asset bundle.

3. **Implement the DocField fallback**
   In the `showFieldHelp(frm, fieldname)` function within `form_focus.js`:
   - First check `FIELD_HELP[frm.doctype]?.[fieldname]`. If found, show it.
   - If not found, call:
     ```js
     frappe.call({
       method: 'frappe.client.get_value',
       args: {
         doctype: 'DocField',
         filters: { parent: frm.doctype, fieldname: fieldname },
         fieldname: 'description'
       },
       callback(r) {
         if (r.message?.description) showTooltip(r.message.description);
       }
     });
     ```
   - Cache the result in a session-level `Map<string, string>` keyed by `${doctype}.${fieldname}` to avoid repeated API calls.
   - If neither source has a description, show nothing (do not show an empty tooltip).

4. **Tooltip rendering**
   - Existing `showTooltip(text)` function should render below the field label using `frappe.ui.Field`'s `set_description` or a custom `<div class="adhd-field-help-tip">` appended to `.frappe-control`.
   - Remove the tooltip when the field loses focus (`blur` event).

5. **Translation readiness**
   - All 80 help strings must be wrapped in `__('...')` (Frappe's translation function) so they can be extracted by the translation pipeline.

## How to Test

1. Log in with ADHD mode **enabled**.
2. Open **Accounts → Sales Invoice → New**.
3. Click into the `customer` field. Confirm a tooltip appears: "The person or company you are billing."
4. Tab to `due_date`. Confirm tooltip "Last day to receive payment without penalty." appears.
5. Tab out of `due_date`. Confirm tooltip disappears.
6. Open a **Journal Entry** form. Click into `voucher_type`. Confirm the help text from the `Journal Entry` section of `FIELD_HELP` appears.
7. Click into a field that is **not** in `FIELD_HELP` but has a `DocField.description` set (add one manually via **Customize Form** if needed). Confirm the description from `DocField` is shown as a fallback.
8. Click into a field with neither `FIELD_HELP` entry nor `DocField.description`. Confirm no tooltip appears and no console errors are thrown.
9. Verify the `adhd_field_help.js` file contains exactly 80 entries (8 doctypes × 10 fields): `Object.values(FIELD_HELP).reduce((n, d) => n + Object.keys(d).length, 0) === 80` in the browser console.
10. Disable ADHD mode. Open a Sales Invoice. Confirm no tooltips appear on field focus.

## Acceptance Criteria
- [ ] `adhd_field_help.js` exports `FIELD_HELP` with entries for all 8 doctypes, 10 fields each (80 total).
- [ ] All 80 help strings are ≤ 15 words and wrapped in `__()`.
- [ ] `form_focus.js` imports help text from `adhd_field_help.js` instead of an inline object.
- [ ] Tooltip appears on field focus and disappears on blur for all 80 covered fields.
- [ ] DocField fallback fires for fields not in `FIELD_HELP` and shows description if available.
- [ ] Fallback results are cached per session; no duplicate API calls for the same field.
- [ ] Empty tooltip is never rendered (no help = no tooltip).
- [ ] No console errors across any of the 8 target doctypes.

## Dependencies
- Blocked by: ADHD-003 (Mandatory Field Wizard) — must use the same `FIELD_HELP` key format
- Blocks: ADHD-017 (Friction Logger) — logs tooltip hover duration; needs field names to be consistent
- Related: ADHD-020 (Test Harness) — should validate FIELD_HELP entry count

## Complexity
S — primarily content authoring and a small code refactor; the fallback API call is straightforward.

## Phase
Phase 4 — Workflow Clarity
