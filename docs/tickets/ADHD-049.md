# ADHD-049: Pipeline Stage Progress Bar on Opportunity

## Current implementation record

- **Status:** Implemented.
- **Implementation:** Opportunity pipeline rendering in `erpnext/public/js/adhd/adhd_tickets_041_061.js`.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` provides structural and helper coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When ADHD mode is active on an Opportunity form, replace the status dropdown's abstract labels with a horizontal visual stage progress bar (Prospect → Qualified → Proposal → Negotiation → Closed Won/Lost) so users see exactly where this deal stands and can advance it with a single click.

## Background / Context
ERPNext's Opportunity `status` field is a plain dropdown — there is no indication of how many stages there are, which stages have been passed, or what the next stage is. ADHD users working multiple deals simultaneously must mentally reconstruct pipeline position for each Opportunity every time they open the form. The dropdown also places all stages — including terminal states like "Closed Lost" — as peer options, which obscures the directional nature of a sales pipeline. A visual progress track converts a state machine into a spatial map, dramatically reducing the cognitive load of pipeline management.

## Cognitive Mechanism
Working memory | attention switching | time blindness

## Prerequisites
- ADHD mode toggle (`frappe.boot.adhd_mode`) must be shipped and functional.
- ADHD-030 (`adhd_opportunity.js`) — check for filename conflict. If `adhd_opportunity.js` already exists from ADHD-030, add the pipeline bar code to that same file rather than creating a new one.
- The Opportunity doctype must have a `status` field with options including (at minimum): "Open", "Quotation", "Converted" and/or custom stage options. Check your ERPNext instance's Opportunity `status` options — the stage map in this ticket may need to match your configured values.

## Scope
**Create (or modify if ADHD-030 exists):**
- `erpnext/crm/doctype/opportunity/adhd_opportunity_pipeline.js` — new file if `adhd_opportunity.js` from ADHD-030 does not exist; otherwise add to existing `adhd_opportunity.js`

**Modify:**
- `erpnext/hooks.py` — add or update `doctype_js` entry for `"Opportunity"`
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-pipeline` styles

## What Needs to Be Done

1. **Define the pipeline stage map** at the top of the file:
   ```js
   // Ordered stages — must match the actual Opportunity status field options in your instance.
   // Terminal states (Won/Lost) are rendered separately at the end.
   const PIPELINE_STAGES = [
     { label: "Prospect",     status: "Open" },
     { label: "Qualified",    status: "Quotation" },
     { label: "Proposal",     status: "Replied" },
     { label: "Negotiation",  status: "To Follow Up" },
   ];

   const TERMINAL_WON  = { label: "Closed Won",  status: "Converted" };
   const TERMINAL_LOST = { label: "Closed Lost", status: "Lost" };
   ```
   **Important:** these `status` values are ERPNext defaults. Verify them against your actual Opportunity status field options via `frappe.meta.get_docfield("Opportunity", "status").options` in the browser console before shipping. Adjust `PIPELINE_STAGES` to match.

2. **Hook into form events**:
   ```js
   frappe.ui.form.on("Opportunity", {
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       render_pipeline_bar(frm);
     },
     status(frm) {
       // Re-render when status changes via the field itself
       if (!frappe.boot.adhd_mode) return;
       render_pipeline_bar(frm);
     },
   });
   ```

3. **Implement `render_pipeline_bar(frm)`**:
   ```js
   function render_pipeline_bar(frm) {
     $(frm.wrapper).find(".adhd-pipeline").remove();

     const current_status = frm.doc.status;
     const is_won  = current_status === TERMINAL_WON.status;
     const is_lost = current_status === TERMINAL_LOST.status;

     // Find current stage index (-1 if terminal)
     const current_idx = PIPELINE_STAGES.findIndex((s) => s.status === current_status);

     // Build stage elements
     const stage_elements = PIPELINE_STAGES.map((stage, idx) => {
       const is_done    = !is_won && !is_lost && idx < current_idx;
       const is_current = !is_won && !is_lost && idx === current_idx;
       const is_pending = !is_done && !is_current;

       const cls = is_done
         ? "adhd-pipeline-stage adhd-pipeline-stage--done"
         : is_current
         ? "adhd-pipeline-stage adhd-pipeline-stage--current"
         : "adhd-pipeline-stage adhd-pipeline-stage--pending";

       const icon = is_done ? "✓" : is_current ? "●" : "○";

       return `
         <button class="${cls}" data-status="${stage.status}" title="Set to ${stage.label}">
           <span class="adhd-pipeline-stage__icon">${icon}</span>
           <span class="adhd-pipeline-stage__label">${stage.label}</span>
         </button>
       `;
     });

     // Add terminal states
     const won_cls  = is_won  ? "adhd-pipeline-stage adhd-pipeline-stage--won"  : "adhd-pipeline-stage adhd-pipeline-stage--terminal";
     const lost_cls = is_lost ? "adhd-pipeline-stage adhd-pipeline-stage--lost" : "adhd-pipeline-stage adhd-pipeline-stage--terminal";

     stage_elements.push(`
       <button class="${won_cls}" data-status="${TERMINAL_WON.status}" title="Mark as Closed Won">
         <span class="adhd-pipeline-stage__icon">${is_won ? "🏆" : "○"}</span>
         <span class="adhd-pipeline-stage__label">${TERMINAL_WON.label}</span>
       </button>
     `);
     stage_elements.push(`
       <button class="${lost_cls}" data-status="${TERMINAL_LOST.status}" title="Mark as Closed Lost">
         <span class="adhd-pipeline-stage__icon">${is_lost ? "✗" : "○"}</span>
         <span class="adhd-pipeline-stage__label">${TERMINAL_LOST.label}</span>
       </button>
     `);

     const $bar = $(`
       <div class="adhd-pipeline">
         <div class="adhd-pipeline__track">
           ${stage_elements.join('<span class="adhd-pipeline__arrow">›</span>')}
         </div>
       </div>
     `);

     // Click handlers: each stage button updates the status field with confirmation
     $bar.find("[data-status]").on("click", function () {
       const new_status = $(this).data("status");
       if (new_status === current_status) return; // No-op if already current

       const stage_label = $(this).find(".adhd-pipeline-stage__label").text();
       frappe.confirm(
         `Move this Opportunity to "<strong>${stage_label}</strong>"?`,
         () => {
           frappe.model.set_value(frm.doctype, frm.doc.name, "status", new_status);
           frm.save().then(() => {
             frappe.show_alert({ message: `Status updated to ${stage_label}.`, indicator: "green" });
           });
         }
       );
     });

     // Inject above the first form section
     $(frm.wrapper).find(".form-layout").prepend($bar);
   }
   ```

4. **Add CSS** to `adhd_mode.scss`:
   ```scss
   .adhd-pipeline {
     padding: 10px 16px 12px;
     background: var(--fg-color);
     border: 1px solid var(--border-color);
     border-radius: var(--border-radius);
     margin-bottom: 14px;

     &__track {
       display: flex;
       align-items: center;
       flex-wrap: wrap;
       gap: 4px;
     }

     &__arrow {
       color: var(--text-muted);
       font-size: 1rem;
       padding: 0 2px;
     }
   }

   .adhd-pipeline-stage {
     display: inline-flex;
     align-items: center;
     gap: 5px;
     padding: 5px 10px;
     border: 1px solid var(--border-color);
     border-radius: 20px;
     background: var(--control-bg);
     font-size: 0.78rem;
     cursor: pointer;
     transition: background 0.15s, border-color 0.15s;

     &:hover { background: var(--fg-hover-color); }

     &--done {
       background: var(--green-50, #f0fdf4);
       border-color: var(--green-400, #4ade80);
       color: var(--green-700, #15803d);
       font-weight: 500;
     }
     &--current {
       background: var(--primary-light, #ebf5fb);
       border-color: var(--primary);
       color: var(--primary);
       font-weight: 700;
     }
     &--pending {
       color: var(--text-muted);
     }
     &--won {
       background: var(--green-500, #22c55e);
       border-color: var(--green-600, #16a34a);
       color: #fff;
       font-weight: 700;
     }
     &--lost {
       background: var(--red-500, #ef4444);
       border-color: var(--red-600, #dc2626);
       color: #fff;
       font-weight: 700;
     }
     &--terminal {
       color: var(--text-muted);
       border-style: dashed;
     }
   }
   ```

5. **Register in `hooks.py`** — either create a new entry or update the existing one if ADHD-030 added `adhd_opportunity.js`:
   ```python
   # If no existing entry:
   "Opportunity": "crm/doctype/opportunity/adhd_opportunity_pipeline.js",

   # If ADHD-030 added adhd_opportunity.js, append this file there instead
   # and keep the hooks.py entry pointing to adhd_opportunity.js
   ```

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Open an **Opportunity** form with `status = "Open"`.
3. Confirm the pipeline progress bar appears above the form fields showing: Prospect (●) › Qualified › Proposal › Negotiation › Closed Won › Closed Lost.
4. Confirm "Prospect" stage is highlighted as current (primary colour, bold), and all subsequent stages are muted/pending.
5. Click the "Qualified" stage button. Confirm a confirmation dialog appears: "Move this Opportunity to Qualified?"
6. Confirm. Confirm the status field updates to the corresponding value, the form saves, and the progress bar re-renders with "Prospect" showing ✓ and "Qualified" as the current stage.
7. Click the "Closed Won" button. Confirm the confirmation dialog appears. Confirm. Confirm the bar shows the Won state with 🏆 styling.
8. Reload the page. Confirm the pipeline bar reflects the current status correctly on re-render.
9. Click a stage that is **already current**. Confirm nothing happens (no confirmation dialog).
10. Open the standard `status` **field dropdown** and change the status there directly. Confirm the pipeline bar re-renders to match (because the `status` field event fires `render_pipeline_bar`).
11. **Disable ADHD mode**. Reload the Opportunity. Confirm the pipeline bar is completely absent and the standard status field is the only UI.
12. Check browser console for JavaScript errors on all steps.

## Acceptance Criteria
- [ ] Pipeline progress bar renders on Opportunity form when ADHD mode is active.
- [ ] Completed stages (before current) show ✓ with green styling.
- [ ] Current stage is visually distinct with primary colour and bold text.
- [ ] Pending stages are muted/pending styled.
- [ ] Closed Won and Closed Lost are shown as terminal states with distinct styling.
- [ ] Clicking any stage button triggers a confirmation dialog before updating.
- [ ] Confirmed stage click updates `status` field and saves the form.
- [ ] Clicking the already-current stage is a no-op.
- [ ] Bar re-renders correctly when status is changed via the standard field dropdown.
- [ ] Bar is absent when ADHD mode is disabled.
- [ ] No conflict with existing `adhd_opportunity.js` from ADHD-030 (check for duplicate file/hook).
- [ ] No JavaScript errors.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped); ADHD-030 (check for filename conflict before creating new file)
- **Blocks:** None

## Complexity
S — Client-side JS only; DOM injection with click handlers; no new Python or schema changes. Main implementation risk is verifying the exact `status` option values in the target ERPNext instance.

## Phase
Phase 7 — Module-by-Module Expansion
