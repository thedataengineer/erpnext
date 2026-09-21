# ADHD-025: RFQ Multi-Supplier Comparison Card

## Current implementation record

- **Status:** Implemented (2026-09-21). See `docs/adhd_mode_features.md` for where it lives and how it differs from this ticket.
- **Implementation:** No matching implementation or bundle registration exists on `iteration_3`.
- **Verification:** No implementation test exists; original acceptance criteria remain pending.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Adds a "Compare Responses" button to submitted Request for Quotation forms in ADHD mode that opens a side-by-side modal showing all linked Supplier Quotations with rate, validity, and payment terms — and a direct "Select" button per row that navigates to that quotation and pre-focuses the Create PO action.

## Background / Context
After sending a Request for Quotation to multiple suppliers, ERPNext requires the user to open each Supplier Quotation individually, manually note rates, switch back, open the next one, and mentally compare. For ADHD users this multi-step navigation is a context-switching trap: by the third Supplier Quotation, the first one's rate has left working memory. A single modal card that puts all responses side by side removes the need to hold any information in memory and makes the decision visually immediate.

## Cognitive Mechanism
Working memory | attention switching | initiation

## Prerequisites
- ADHD mode toggle (`public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` readable on the client.

## Scope
**Create:**
- `erpnext/buying/services/adhd_rfq_compare.py` — server-side endpoint returning Supplier Quotation comparison data.
- `erpnext/buying/doctype/request_for_quotation/adhd_rfq.js` — client-side form script injecting the button and modal.

## What Needs to Be Done

1. **Create the server endpoint `adhd_rfq_compare.py`.**
   ```python
   import frappe

   @frappe.whitelist()
   def get_rfq_supplier_comparison(rfq_name: str) -> list[dict]:
       """
       Returns a list of Supplier Quotation summaries linked to the given RFQ.
       Each dict contains: name, supplier, valid_till, payment_terms,
       first_item_rate, first_item_uom, status.
       """
       if not rfq_name:
           frappe.throw("rfq_name is required")

       # Validate the caller has read access to the RFQ
       frappe.has_permission("Request for Quotation", doc=rfq_name, throw=True)

       supplier_quotations = frappe.get_all(
           "Supplier Quotation",
           filters={"request_for_quotation": rfq_name, "docstatus": ["!=", 2]},
           fields=["name", "supplier", "valid_till", "payment_terms", "status", "grand_total"],
       )

       result = []
       for sq in supplier_quotations:
           # Fetch first item row for the rate preview
           items = frappe.get_all(
               "Supplier Quotation Item",
               filters={"parent": sq["name"]},
               fields=["item_code", "item_name", "qty", "rate", "uom"],
               limit=1,
               order_by="idx asc",
           )
           first_item = items[0] if items else {}
           result.append({
               "name":            sq["name"],
               "supplier":        sq["supplier"],
               "valid_till":      str(sq["valid_till"]) if sq["valid_till"] else "",
               "payment_terms":   sq["payment_terms"] or "—",
               "status":          sq["status"],
               "grand_total":     sq["grand_total"],
               "first_item_code": first_item.get("item_code", ""),
               "first_item_rate": first_item.get("rate", 0),
               "first_item_uom":  first_item.get("uom", ""),
           })

       # Sort by first_item_rate ascending (cheapest first)
       result.sort(key=lambda x: x["first_item_rate"])
       return result
   ```
   Place `adhd_rfq_compare.py` inside `erpnext/buying/services/` (create the `services/` directory and an `__init__.py` if they don't exist). Add `frappe.whitelist()` — no custom role required beyond standard `Supplier Quotation` read permission.

2. **Create `adhd_rfq.js` and register the button.**
   ```js
   frappe.ui.form.on("Request for Quotation", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       // Only show on submitted RFQs (docstatus === 1)
       if (frm.doc.docstatus !== 1) return;

       // Prevent duplicate buttons
       if (frm.custom_buttons && frm.custom_buttons["Compare Responses"]) return;

       frm.add_custom_button("Compare Responses", () => {
         openComparisonModal(frm);
       }, /* group */ "ADHD");
     },
   });
   ```

3. **Implement `openComparisonModal(frm)`.** Fetches data then renders a Frappe dialog:
   ```js
   async function openComparisonModal(frm) {
     frappe.show_progress("Loading supplier responses…", 0, 100);

     let data;
     try {
       const result = await frappe.call({
         method: "erpnext.buying.services.adhd_rfq_compare.get_rfq_supplier_comparison",
         args: { rfq_name: frm.docname },
       });
       data = result.message || [];
     } catch (err) {
       frappe.hide_progress();
       frappe.throw("Could not load supplier quotations: " + err);
       return;
     }

     frappe.hide_progress();

     if (!data.length) {
       frappe.msgprint("No Supplier Quotations found for this RFQ.");
       return;
     }

     renderComparisonDialog(frm, data);
   }
   ```

4. **Implement `renderComparisonDialog(frm, rows)`.** Builds the table HTML and mounts it in a `frappe.ui.Dialog`:
   ```js
   function renderComparisonDialog(frm, rows) {
     const currency = frappe.boot.sysdefaults.currency || "";

     const tableRows = rows.map((r, idx) => `
       <tr class="${idx === 0 ? "adhd-rfq-best-row" : ""}">
         <td>${idx === 0 ? "⭐ " : ""}${frappe.utils.escape_html(r.supplier)}</td>
         <td>${frappe.format(r.first_item_rate, { fieldtype: "Currency" })} ${currency}
             <span class="adhd-rfq-uom">${frappe.utils.escape_html(r.first_item_uom)}</span></td>
         <td>${r.valid_till || "—"}</td>
         <td>${frappe.utils.escape_html(r.payment_terms)}</td>
         <td>
           <button class="btn btn-xs btn-primary adhd-rfq-select-btn"
                   data-sq-name="${frappe.utils.escape_html(r.name)}">
             Select →
           </button>
         </td>
       </tr>
     `).join("");

     const html = `
       <div class="adhd-rfq-compare-wrapper">
         <p class="adhd-rfq-sorted-note">Sorted by unit rate (lowest first). ⭐ = best price.</p>
         <table class="adhd-rfq-table table table-bordered table-condensed">
           <thead>
             <tr>
               <th>Supplier</th>
               <th>Rate (1st Item)</th>
               <th>Valid Till</th>
               <th>Payment Terms</th>
               <th></th>
             </tr>
           </thead>
           <tbody>${tableRows}</tbody>
         </table>
       </div>
     `;

     const dialog = new frappe.ui.Dialog({
       title: `Supplier Responses — ${frm.docname}`,
       fields: [{ fieldtype: "HTML", fieldname: "rfq_comparison_html" }],
       size: "large",
     });

     dialog.fields_dict.rfq_comparison_html.$wrapper.html(html);

     // Wire "Select" buttons
     dialog.$wrapper.find(".adhd-rfq-select-btn").on("click", function () {
       const sqName = $(this).data("sq-name");
       dialog.hide();
       frappe.set_route("Form", "Supplier Quotation", sqName);
       // After navigation, highlight the Make PO button (deferred to next frame)
       frappe.after_ajax(() => {
         const makePoBtn = $("button:contains('Purchase Order')");
         if (makePoBtn.length) makePoBtn.addClass("adhd-highlight-action").focus();
       });
     });

     dialog.show();
   }
   ```

5. **CSS in `adhd_mode.scss`:**
   - `.adhd-rfq-table` — `width: 100%; font-size: 0.85rem;`
   - `.adhd-rfq-best-row` — `background: var(--green-50);`
   - `.adhd-rfq-uom` — `color: var(--text-muted); font-size: 0.75rem;`
   - `.adhd-rfq-sorted-note` — `font-size: 0.75rem; color: var(--text-muted); margin-bottom: 8px;`
   - `.adhd-highlight-action` — `animation: adhd-pulse 1.5s ease-in-out 2; outline: 2px solid var(--primary);`

6. **Register `adhd_rfq_compare.py` in `hooks.py`** under `override_whitelisted_methods` or confirm `frappe.whitelist()` is sufficient for the method to be callable (it is, via `frappe.call` with the dotted module path).

7. **Include `adhd_rfq.js` in `hooks.py`** under `app_include_js`.

## How to Test

1. Enable ADHD mode. Navigate to **Buying → Request for Quotation**. Open or create an RFQ with at least two suppliers. Submit the RFQ.
2. For each supplier, create a Supplier Quotation from the RFQ (Suppliers tab → Create Supplier Quotation or via the Make button) and submit it with different rates.
3. Return to the submitted RFQ. Confirm a "Compare Responses" button appears inside an "ADHD" button group.
4. Click "Compare Responses". Confirm a large modal appears with a table listing all Supplier Quotations.
5. Confirm the table columns are: Supplier, Rate (1st Item), Valid Till, Payment Terms, and a Select button column.
6. Confirm rows are sorted lowest rate first, and the top row has a ⭐ prefix.
7. Click "Select →" on any row. Confirm the modal closes and the browser navigates to that Supplier Quotation form.
8. Confirm the "Make → Purchase Order" button on the Supplier Quotation is visually highlighted (animated outline).
9. Return to the RFQ. Create a third Supplier Quotation but do not submit it (leave as Draft). Open Compare Responses again. Confirm the draft quotation still appears in the modal (docstatus ≠ 2 filter includes drafts).
10. Open an RFQ with no linked Supplier Quotations. Click Compare Responses. Confirm a "No Supplier Quotations found" message appears rather than an empty table.
11. Disable ADHD mode. Reopen the submitted RFQ. Confirm no "Compare Responses" button is present.
12. Confirm no console errors at any step.

## Acceptance Criteria
- [ ] "Compare Responses" button appears on submitted RFQ forms in ADHD mode; absent on draft/cancelled RFQs.
- [ ] Modal table displays all linked Supplier Quotations (excluding cancelled) with Supplier, Rate, Valid Till, Payment Terms columns.
- [ ] Rows are sorted by first-item rate ascending; lowest-rate row is marked ⭐ and highlighted green.
- [ ] "Select →" navigates to the chosen Supplier Quotation and highlights the Create PO button.
- [ ] Empty state (no Supplier Quotations) shows an informative message rather than a broken table.
- [ ] Button and modal are absent when ADHD mode is disabled.
- [ ] Server endpoint respects Supplier Quotation read permissions.
- [ ] No JavaScript console errors in any of the above states.

## Dependencies
- **Blocked by:** ADHD mode toggle (shipped)
- **Blocks:** None

## Complexity
M — Requires a new Python whitelist endpoint, a client-side dialog with dynamic HTML, and a cross-form navigation sequence. No DocType schema changes.

## Phase
Phase 7 — Module-by-Module Expansion
