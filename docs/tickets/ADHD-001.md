# ADHD-001: Workflow Wizard — Document Chain Navigator

## Summary
A persistent progress bar rendered on key transactional documents (Sales Order, Purchase Invoice, etc.) that shows every step in the document chain, marks completed steps, highlights the current one, and offers a pre-filled "Create Next Step" button — eliminating the cognitive load of remembering what comes next.

## Background / Context
ERPNext's document lifecycle (Quotation → Sales Order → Delivery Note → Sales Invoice → Payment Entry) requires the user to mentally track where they are in the chain, navigate away to create the next document, and manually re-enter fields that could be copied forward. For ADHD users, each navigation hop is a context-switch that burns working memory and risks losing the thread entirely. The friction is highest immediately after saving a document, when the next action is unclear and the temptation to "just check one more thing" is strong.

## Cognitive Mechanism
Working memory | attention switching | initiation

## Prerequisites
- Phase 1 ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and setting `adhd_mode` must be readable via `frappe.boot.adhd_mode` or equivalent.
- No other ticket prerequisites — this is the first Phase 2 deliverable.

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_chain_navigator.js`

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-chain-nav` styles
- `erpnext/hooks.py` — include `adhd_chain_navigator.js` in `app_include_js` (behind ADHD mode guard if bundled conditionally)

## What Needs to Be Done

1. **Define the chain map.** At the top of `adhd_chain_navigator.js`, export a `CHAIN_MAP` constant — a plain object keyed by doctype:
   ```js
   const CHAIN_MAP = {
     "Sales Order": [
       { label: "Quotation",       doctype: "Quotation",       link_field: "prevdoc_docname" },
       { label: "Sales Order",     doctype: "Sales Order",     link_field: null },          // current anchor
       { label: "Delivery Note",   doctype: "Delivery Note",   link_field: "against_sales_order" },
       { label: "Sales Invoice",   doctype: "Sales Invoice",   link_field: "sales_order" },
       { label: "Payment Entry",   doctype: "Payment Entry",   link_field: "reference_name" },
     ],
     "Purchase Order": [ /* analogous chain */ ],
     "Sales Invoice":  [ /* start from Sales Order */ ],
     "Purchase Invoice": [ /* start from Purchase Order */ ],
     "Purchase Receipt": [ /* start from Purchase Order */ ],
     "Delivery Note":  [ /* start from Sales Order */ ],
     "Payment Entry":  [ /* subset */ ],
   };
   ```

2. **Detect completion state per step.** Write `getStepStatus(doc, step)` which returns `"done" | "current" | "pending"`:
   - `"done"` — the linked document name field on the current doc is non-empty **and** the linked doc has `docstatus === 1`, verified via a lightweight `frappe.db.get_value` call (cached per page load).
   - `"current"` — the step's doctype matches `frm.doctype`.
   - `"pending"` — all other cases.

3. **Render the navigator bar.** Write `renderChainNav(frm)`:
   - Build a `<div class="adhd-chain-nav">` containing one `<span class="adhd-chain-step">` per step.
   - Each step span gets a class: `adhd-step--done`, `adhd-step--current`, or `adhd-step--pending`.
   - Done steps show a ✓ checkmark prefix. Current step is bold. Pending steps are muted.
   - Insert the bar using `frm.layout.add_view()` or, if unavailable, prepend to `$(frm.wrapper).find('.page-head')`.

4. **Add the "Create Next Step" button.** After determining the current step index, find the first `"pending"` step. Add a primary button `"Create Next Step → [Label]"` via `frm.add_custom_button`. On click:
   - Call `frappe.model.open_mapped_doc` with the appropriate mapping name (e.g., `"Sales Order-Delivery Note"`) **or** fall back to `frappe.new_doc(nextDoctype, prefillValues)` where `prefillValues` copies `customer`/`supplier`, `company`, `currency`, `items` array, and any other transferable scalar fields defined per chain step in `CHAIN_MAP`.
   - Pass a `freeze: true` argument to prevent double-clicks.

5. **Hook into `Form.after_save` and `Form.refresh`.** Register via:
   ```js
   frappe.ui.form.on("Sales Order", {
     after_save(frm) { renderChainNav(frm); },
     refresh(frm)    { renderChainNav(frm); },
   });
   ```
   Repeat for each doctype in `CHAIN_MAP`. Use a shared helper so the registration loop is a single `Object.keys(CHAIN_MAP).forEach(...)`.

6. **Guard behind ADHD mode.** At the top of every public function, check:
   ```js
   if (!frappe.boot.adhd_mode) return;
   ```

7. **CSS in `adhd_mode.scss`:**
   - `.adhd-chain-nav` — `display: flex; gap: 0.5rem; align-items: center; padding: 6px 12px; background: var(--fg-color); border-bottom: 1px solid var(--border-color); font-size: 0.8rem;`
   - `.adhd-step--done` — `color: var(--green-500); font-weight: 500;`
   - `.adhd-step--current` — `font-weight: 700; text-decoration: underline;`
   - `.adhd-step--pending` — `color: var(--text-muted);`
   - Arrow separator `›` between steps via CSS `::after` pseudo-element.

8. **Avoid duplicate renders.** Before inserting, check for an existing `.adhd-chain-nav` on the form wrapper and remove it first.

## How to Test

1. Open a fresh ERPNext desk. Confirm ADHD mode is enabled (User Settings → ADHD Mode → On).
2. Navigate to **Sales Order** list. Open any submitted Sales Order that has a linked Delivery Note.
3. Verify a horizontal step bar appears below the page header: `Quotation › [Sales Order] › Delivery Note › Sales Invoice › Payment Entry`.
4. Confirm the "Sales Order" step is bold and underlined; "Delivery Note" shows a ✓; "Sales Invoice" and "Payment Entry" are muted grey.
5. Click "Create Next Step → Sales Invoice". Confirm the new Sales Invoice form opens with `customer`, `company`, `currency`, and `items` pre-filled from the source Sales Order.
6. Save and submit the Sales Invoice. Return to the original Sales Order. Refresh. Confirm "Sales Invoice" now shows ✓.
7. Disable ADHD mode. Reload the same Sales Order. Confirm the navigator bar is absent.
8. Open a **Purchase Order** form. Confirm a separate correct chain renders (Purchase Order → Purchase Receipt → Purchase Invoice → Payment Entry).
9. Open a **Payment Entry** linked to a Sales Invoice. Confirm the bar renders with all prior steps marked ✓ and no "Create Next Step" button (no pending steps remain).

## Acceptance Criteria
- [ ] Chain navigator bar appears on all seven doctypes listed in `CHAIN_MAP` when ADHD mode is active.
- [ ] Completed steps (docstatus = 1 and link field populated) display a ✓ and the `adhd-step--done` style.
- [ ] Current document step is visually distinct (bold + underline) with `adhd-step--current`.
- [ ] Pending steps are rendered in muted colour with `adhd-step--pending`.
- [ ] "Create Next Step" button appears when at least one pending step exists; it is absent when all steps are complete.
- [ ] Clicking "Create Next Step" opens the correct next doctype with all transferable fields pre-filled (customer/supplier, company, currency, items).
- [ ] Navigator bar is absent on all doctypes when ADHD mode is disabled.
- [ ] No duplicate bars appear after multiple saves on the same form.
- [ ] No JavaScript console errors on any of the seven target doctypes.

## Dependencies
- **Blocks:** ADHD-023 (Sales Order Interruption Restore), ADHD-031 (Bank Recon Progress Saver)
- **Blocked by:** None (Phase 1 ADHD mode toggle already shipped)

## Complexity
M — Multiple doctypes, async link-status checks, and field-mapping logic per chain step; no new server endpoints required.

## Phase
Phase 2 — Core Workflow Clarity
