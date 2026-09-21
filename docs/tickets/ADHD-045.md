# ADHD-045: Plant Floor "Blocked Work Order" Alert

## Current implementation record

- **Status:** Blocked.
- **Implementation:** `erpnext/public/js/adhd/adhd_tickets_041_061.js` contains a Shop Floor compatibility patch, but the ticket targets a Plant Floor card structure that the current implementation does not expose. Do not claim user-visible completion.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` covers overdue classification only; Plant Floor integration is blocked and unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When ADHD mode is active on the Plant Floor visual page, Work Order cards whose Job Cards are overdue by more than 2 hours are highlighted in red with a "Blocked" badge — surfacing production bottlenecks at a glance without requiring a separate report.

## Background / Context
The Plant Floor visual page renders Work Order cards as a kanban-style board, but all cards look identical regardless of health. An ADHD user scanning the board has no visual signal to indicate which Work Orders need immediate attention versus which are progressing normally. Running a report to find overdue Job Cards requires leaving the Plant Floor page, selecting filters, and mentally cross-referencing the results back to the board — three context switches for what should be a one-glance status check. The friction is highest during shift hand-offs when a user needs to rapidly assess the production floor state.

## Cognitive Mechanism
Attention switching | working memory

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- The Plant Floor visual page JS (`visual_plant_floor.js`) must already render Work Order cards (existing functionality).
- The `Job Card` doctype must have `work_order`, `status`, and `expected_time` or `planned_end_time` fields. Confirm field name against your ERPNext version; use `frappe.db.get_doc` in the console to verify.

## Scope
**Modify:**
- `erpnext/manufacturing/page/visual_plant_floor/visual_plant_floor.js` — add a post-render pass that marks overdue Work Order cards.

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-blocked-badge` styles.

## What Needs to Be Done

1. **Locate the render hook** inside `visual_plant_floor.js`. Look for the method that fires after Work Order cards are rendered to the DOM — typically a method called something like `render_work_orders`, `render_cards`, or a callback inside a `frappe.call` that fetches Work Orders. Identify the point where all card elements are in the DOM.

2. **Add a post-render call** at the end of that render method:
   ```js
   if (frappe.boot.adhd_mode) {
     adhd_mark_blocked_work_orders();
   }
   ```

3. **Implement `adhd_mark_blocked_work_orders()`**:
   ```js
   function adhd_mark_blocked_work_orders() {
     // Remove any existing blocked badges first
     $(".adhd-blocked-badge").remove();
     $(".adhd-work-order-card--blocked").removeClass("adhd-work-order-card--blocked");

     const now = new Date();
     const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

     // Collect all Work Order names currently rendered on the board
     const work_order_names = [];
     $("[data-work-order-name]").each(function () {
       work_order_names.push($(this).attr("data-work-order-name"));
     });

     if (!work_order_names.length) return;

     // Fetch open Job Cards for all rendered Work Orders in one call
     frappe.call({
       method: "frappe.client.get_list",
       args: {
         doctype: "Job Card",
         filters: [
           ["work_order", "in", work_order_names],
           ["status", "in", ["Open", "Work In Progress"]],
         ],
         fields: ["name", "work_order", "planned_end_time"],
         limit: 500,
       },
       callback(r) {
         if (!r.message) return;
         const overdue_work_orders = new Set();

         r.message.forEach((jc) => {
           if (!jc.planned_end_time) return;
           const end = new Date(jc.planned_end_time);
           if (now - end > TWO_HOURS_MS) {
             overdue_work_orders.add(jc.work_order);
           }
         });

         overdue_work_orders.forEach((wo_name) => {
           const $card = $(`[data-work-order-name="${wo_name}"]`);
           $card.addClass("adhd-work-order-card--blocked");
           $card.prepend(
             `<span class="adhd-blocked-badge">🚫 Blocked</span>`
           );
         });
       },
     });
   }
   ```
   - Uses a single `get_list` call to fetch all relevant open Job Cards across all rendered Work Orders, avoiding N+1 queries.
   - A Work Order is flagged if **any** of its open Job Cards has `planned_end_time` more than 2 hours in the past.

4. **Confirm the `data-work-order-name` attribute** exists on Work Order card elements. If the existing Plant Floor JS renders cards without this attribute, add it during card rendering:
   ```js
   // Inside the card rendering loop, when building the card element:
   $card.attr("data-work-order-name", work_order.name);
   ```
   This is the minimal change needed to the existing render logic.

5. **Add CSS** to `adhd_mode.scss`:
   ```scss
   .adhd-work-order-card--blocked {
     border: 2px solid var(--red-500, #ef4444) !important;
     background: var(--red-50, #fef2f2) !important;
     position: relative;
   }

   .adhd-blocked-badge {
     display: inline-block;
     background: var(--red-500, #ef4444);
     color: #fff;
     font-size: 0.7rem;
     font-weight: 700;
     padding: 2px 6px;
     border-radius: 3px;
     margin-bottom: 4px;
     letter-spacing: 0.02em;
   }
   ```

6. **No new Python file or schema change is needed.** The existing `Job Card` doctype already has `work_order` and status fields. Verify `planned_end_time` is the correct field name in your ERPNext version (it may be `expected_completion_date` in older versions — check and use whichever is correct).

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Navigate to **Plant Floor** (Manufacturing → Plant Floor).
3. Ensure at least one Work Order exists with status `"In Process"` and at least one open Job Card whose `planned_end_time` is more than 2 hours in the past. (Create test data: create a Job Card, set `planned_end_time` to 3 hours ago, leave status as Open.)
4. Load the Plant Floor page. Confirm the Work Order card for that Work Order has a red border, a red background tint, and a "🚫 Blocked" badge at the top of the card.
5. Confirm that Work Orders whose Job Cards are **not** overdue (or have no open Job Cards) show no badge and no red styling.
6. Confirm that Work Orders with open Job Cards overdue by **less than 2 hours** (e.g., 1.5 hours) show no badge.
7. Mark the overdue Job Card as Submitted/Completed. Reload the Plant Floor page. Confirm the blocked styling and badge are gone from that Work Order card.
8. **Disable ADHD mode**. Reload the Plant Floor. Confirm no cards show blocked styling regardless of Job Card state.
9. Open the browser console. Confirm no JavaScript errors.
10. Verify only one `frappe.call` fires for the blocked check (not one per Work Order card) — check the Network tab for a single `get_list` request.

## Acceptance Criteria
- [ ] Work Order cards with at least one open Job Card overdue by >2 hours show a red border, red background, and "🚫 Blocked" badge.
- [ ] Work Orders with no open Job Cards or with all Job Cards on time show no blocked styling.
- [ ] The 2-hour threshold is respected exactly (1h 59m = clean, 2h 1m = blocked).
- [ ] The blocked check uses a single batched `frappe.call` (not N+1 per card).
- [ ] Completing the overdue Job Card and reloading the page removes the blocked styling from that card.
- [ ] All styling is absent when ADHD mode is disabled.
- [ ] No JavaScript errors on the Plant Floor page.
- [ ] Existing Plant Floor functionality (drag-to-move, card clicks, etc.) is unaffected.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped)
- **Blocks:** None

## Complexity
S — Single JS modification to an existing page; one additional batched `frappe.call`; no new Python or schema changes. The only risk is locating the correct hook point in `visual_plant_floor.js`.

## Phase
Phase 7 — Module-by-Module Expansion
