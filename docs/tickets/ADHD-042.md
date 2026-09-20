# ADHD-042: Work Order "What to Do Next" Status Prompt

## Summary
When ADHD mode is active on a Work Order form, inject a one-line contextual "Next action" prompt below the document title that tells the user exactly what to do based on the Work Order's current state — eliminating the need to decode ERPNext's status fields to figure out the next step.

## Background / Context
A Work Order passes through Draft → Submitted → In Process → Completed, but ERPNext's status badge gives no instruction — it describes state, not action. ADHD users stall at transition points: "It says 'In Process' but I don't know if I need to do anything." Checking produced quantity, counting open Job Cards, and mapping that to the next required action requires holding several data points in working memory simultaneously. The friction is highest mid-production when the user returns to a Work Order after an interruption and must rebuild context from scratch.

## Cognitive Mechanism
Working memory | initiation | attention switching

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- The Work Order doctype must have `status`, `produced_qty`, and `qty` fields (standard ERPNext fields).
- The Job Card doctype must exist with a `work_order` link field and a `status` field (standard).

## Scope
**Create:**
- `erpnext/manufacturing/doctype/work_order/adhd_work_order.js`

**Modify:**
- `erpnext/hooks.py` — add `adhd_work_order.js` to the `doctype_js` map under `"Work Order"`
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-next-action` styles

## What Needs to Be Done

1. **Hook into form events** in `adhd_work_order.js`:
   ```js
   frappe.ui.form.on("Work Order", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       render_next_action_prompt(frm);
     },
     after_save(frm) {
       if (!frappe.boot.adhd_mode) return;
       render_next_action_prompt(frm);
     },
   });
   ```

2. **Implement `render_next_action_prompt(frm)`**:
   - Remove any existing `.adhd-next-action` element first to avoid duplicates.
   - Branch on `frm.doc.status`:
     - `"Draft"` → message: `"Submit this Work Order to start production."`, no extra button needed beyond the standard Submit button.
     - `"Submitted"` and `frm.doc.produced_qty === 0` → message: `"Create Job Cards to begin operations."`, show a "Create Job Cards" button that calls `frappe.call('erpnext.manufacturing.doctype.work_order.work_order.create_job_cards', { work_order: frm.doc.name, auto_create: 1 })` then reloads the form.
     - `"In Process"` → call `get_open_job_card_count(frm)` (see step 3) asynchronously, then render the appropriate message.
     - `"Completed"` → message: `"Work Order complete. Create a Stock Entry to transfer finished goods."`, show a "Create Stock Entry" button that opens `frappe.new_doc('Stock Entry', { work_order: frm.doc.name, purpose: 'Manufacture' })`.
     - Any other status (e.g., `"Stopped"`) → render no prompt (silently return).

3. **Implement `get_open_job_card_count(frm, callback)`** — uses `frappe.call`:
   ```js
   function get_open_job_card_count(frm, callback) {
     frappe.call({
       method: "frappe.client.get_count",
       args: {
         doctype: "Job Card",
         filters: {
           work_order: frm.doc.name,
           status: ["in", ["Open", "Work In Progress"]],
         },
       },
       callback(r) {
         const open_count = r.message || 0;
         frappe.call({
           method: "frappe.client.get_count",
           args: {
             doctype: "Job Card",
             filters: { work_order: frm.doc.name },
           },
           callback(r2) {
             const total_count = r2.message || 0;
             callback(open_count, total_count);
           },
         });
       },
     });
   }
   ```
   In the callback:
   - If `open_count > 0` → message: `"${open_count} of ${total_count} Job Cards still open — complete operations to finish production."`, with a "View Job Cards" button that opens `frappe.set_route('List', 'Job Card', { work_order: frm.doc.name })`.
   - If `open_count === 0 && total_count > 0` → message: `"All operations complete — click Finish to close this Work Order."`, with a "Finish Work Order" button that sets `frm.doc.status = 'Completed'` and calls `frm.save()`.

4. **Implement `show_next_action(frm, message, button_label, button_action)`**:
   ```js
   function show_next_action(frm, message, button_label, button_action) {
     $(frm.wrapper).find(".adhd-next-action").remove();

     const $btn = button_label
       ? `<button class="btn btn-xs btn-primary adhd-next-action__btn">${button_label}</button>`
       : "";

     const $prompt = $(`
       <div class="adhd-next-action">
         <span class="adhd-next-action__icon">▶</span>
         <span class="adhd-next-action__message">${message}</span>
         ${$btn}
       </div>
     `);

     if (button_label && button_action) {
       $prompt.find(".adhd-next-action__btn").on("click", button_action);
     }

     // Insert immediately after the page title bar
     $(frm.wrapper).find(".page-head").after($prompt);
   }
   ```

5. **Add CSS** to `adhd_mode.scss`:
   ```scss
   .adhd-next-action {
     display: flex;
     align-items: center;
     gap: 10px;
     padding: 8px 16px;
     background: var(--yellow-100, #fefce8);
     border-left: 4px solid var(--yellow-500, #eab308);
     font-size: 0.88rem;
     font-weight: 500;
     margin-bottom: 8px;

     &__icon { font-size: 1rem; }
     &__message { flex: 1; }
     &__btn { white-space: nowrap; }
   }
   ```

6. **Register in `hooks.py`** under `doctype_js`:
   ```python
   "Work Order": "manufacturing/doctype/work_order/adhd_work_order.js",
   ```

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Create a new Work Order (do not submit). Confirm the prompt reads: "Submit this Work Order to start production."
3. Submit the Work Order (produced_qty = 0). Confirm the prompt reads: "Create Job Cards to begin operations." and a "Create Job Cards" button is visible.
4. Click "Create Job Cards". Confirm Job Cards are created and the form reloads with an updated prompt showing "X of Y Job Cards still open — complete operations to finish production."
5. Click "View Job Cards". Confirm the Job Card list opens filtered to this Work Order.
6. Open one of the Job Cards and set its status to Submitted/Complete. Return to the Work Order. Confirm the open count in the prompt decreases correctly.
7. Complete all Job Cards. Reload the Work Order. Confirm the prompt reads: "All operations complete — click Finish to close this Work Order." and the "Finish Work Order" button appears.
8. Click "Finish Work Order". Confirm the Work Order transitions to Completed.
9. Confirm the Completed prompt reads: "Work Order complete. Create a Stock Entry to transfer finished goods." and the "Create Stock Entry" button opens a new Stock Entry pre-filled with `purpose = Manufacture`.
10. **Disable ADHD mode**. Reload the Work Order. Confirm the prompt bar is completely absent.
11. Confirm no JavaScript console errors on any step.

## Acceptance Criteria
- [ ] Prompt appears below the page title on Work Order form when ADHD mode is active.
- [ ] Draft state shows the correct submit instruction.
- [ ] Submitted + produced_qty=0 state shows "Create Job Cards" prompt with a functional button.
- [ ] In Process state shows correct open/total Job Card count, updating after a page refresh.
- [ ] All Job Cards complete state shows the Finish Work Order prompt with a functional button.
- [ ] Completed state shows the Stock Entry creation prompt with a functional button.
- [ ] Prompt is absent when ADHD mode is disabled.
- [ ] No duplicate prompt bars appear after multiple saves.
- [ ] No JavaScript errors on the Work Order form.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped)
- **Blocks:** None

## Complexity
S — Pure client-side JS; two lightweight `frappe.call` count queries; no new Python files or schema changes required.

## Phase
Phase 7 — Module-by-Module Expansion
