# ADHD-030: Opportunity Staleness Indicator

## Current implementation record

- **Status:** Implemented (2026-09-21). See `docs/adhd_mode_features.md` for where it lives and how it differs from this ticket.
- **Implementation:** No matching implementation or bundle registration exists on `iteration_3`.
- **Verification:** No implementation test exists; original acceptance criteria remain pending.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
Extends the Phase 3.1 heat-map infrastructure to the Opportunity list view using days-since-last-modification as the staleness signal, and injects a "stale" badge on the Opportunity form itself when the record has not been updated in more than 14 days.

## Background / Context
Sales opportunities silently age in ERPNext: a lead that went cold three weeks ago looks identical in the list view to one touched this morning. For ADHD users, "out of sight, out of mind" is not a figure of speech — it is the literal failure mode. A pipeline full of visually identical rows offers no urgency gradient, so old opportunities get perpetually deprioritised. The heat-map pattern from ADHD-006 provides the exact infrastructure needed to solve this: applying it to Opportunity's `modified` timestamp makes stale prospects visually unmissable without any new server logic.

## Cognitive Mechanism
Time blindness | attention switching | working memory

## Prerequisites
- ADHD-006 (heat-map list view infrastructure in `public/js/adhd/adhd_list_view.js`) must be shipped and `registerHeatmapDoctype()` must accept a `reversePolarity` option (most-recent = good; oldest = bad — opposite of deadline-style heat maps).

## Scope
**Create:**
- `erpnext/crm/doctype/opportunity/adhd_opportunity.js`

**Modify:**
- `erpnext/public/js/adhd/adhd_list_view.js` — register Opportunity with a staleness-mode heat-map call.

## What Needs to Be Done

1. **Extend `registerHeatmapDoctype` to support staleness mode.** In `adhd_list_view.js`, check whether the existing API supports a `mode` or `reversePolarity` option. If not, add it:
   ```js
   // Inside registerHeatmapDoctype, add a mode parameter:
   // mode: "deadline"  — red = closest to date (existing behaviour)
   // mode: "staleness" — red = furthest from date (new behaviour for Opportunity)
   function registerHeatmapDoctype(doctype, dateField, options = {}) {
     const mode = options.mode || "deadline";
     // ... existing logic, but for "staleness" mode:
     // Compute daysAgo = today - dateField value
     // red   if daysAgo > 14
     // amber if daysAgo > 7
     // no colour if daysAgo <= 7
   }
   ```
   Then register Opportunity:
   ```js
   registerHeatmapDoctype("Opportunity", "modified", { mode: "staleness" });
   ```

2. **Implement staleness colouring logic in list view.** In the `renderHeatmapCell` function (or equivalent), when `mode === "staleness"`:
   ```js
   function getStalenessClass(dateValue) {
     const daysAgo = frappe.datetime.get_day_diff(
       frappe.datetime.get_today(), dateValue
     );
     if (daysAgo > 14) return "adhd-heat--red";
     if (daysAgo > 7)  return "adhd-heat--amber";
     return "";
   }
   ```
   Apply this class to the list row. Tooltip text: `"No activity for ${daysAgo} day${daysAgo === 1 ? '' : 's'}."` (for red/amber) or `"Active"` (no colour).

3. **Create `adhd_opportunity.js` and register form event hooks:**
   ```js
   frappe.ui.form.on("Opportunity", {
     after_load(frm) {
       if (!frappe.boot.adhd_mode) return;
       renderStaleBadge(frm);
     },
     refresh(frm) {
       if (!frappe.boot.adhd_mode) return;
       renderStaleBadge(frm);
     },
   });
   ```

4. **Implement `renderStaleBadge(frm)`.** Computes days since last modification and conditionally renders a badge in the form header:
   ```js
   function renderStaleBadge(frm) {
     $(frm.wrapper).find(".adhd-stale-badge").remove();

     if (!frm.doc.modified) return;

     const daysAgo = frappe.datetime.get_day_diff(
       frappe.datetime.get_today(),
       frm.doc.modified.split(" ")[0] // strip time component
     );

     if (daysAgo <= 14) return; // Not stale — show nothing

     const badge = $(`
       <span class="adhd-stale-badge"
             title="No activity for ${daysAgo} days. Last modified: ${frm.doc.modified}">
         🕒 Stale — no activity for ${daysAgo} days
       </span>
     `);

     // Insert below the page title, above the first form section
     $(frm.wrapper).find(".page-head .page-title").after(badge);
   }
   ```

5. **Ensure the badge does not collide with other ADHD elements.** The stale badge is appended after `.page-title`; the deadline banner from ADHD-008 is appended to the form layout. Both are in different DOM zones. Add a code comment noting this.

6. **CSS in `adhd_mode.scss`:**
   - `.adhd-stale-badge` — `display: inline-block; padding: 3px 10px; margin: 4px 0 8px; background: var(--red-50); color: var(--red-700); border: 1px solid var(--red-300); border-radius: 12px; font-size: 0.78rem; font-weight: 600; cursor: default;`

7. **Include `adhd_opportunity.js` in `hooks.py`** under `app_include_js`.

## How to Test

### List View Tests

1. Enable ADHD mode. Navigate to **CRM → Opportunities** list view.
2. Open or create an Opportunity. Set its `modified` field to a date 16 days ago by editing it directly in the database (`bench execute "frappe.db.set_value('Opportunity', 'OPP-0001', 'modified', '2025-06-XX 00:00:00')"` adjusted to 16 days before today). Reload the list.
3. Confirm the row for that Opportunity is coloured red.
4. Hover over the red row. Confirm the tooltip reads "No activity for 16 days."
5. Repeat with an Opportunity modified 10 days ago. Confirm amber colouring and tooltip "No activity for 10 days."
6. Confirm an Opportunity modified 3 days ago has no special colouring and no tooltip.

### Form View Tests

7. Open the Opportunity modified 16 days ago. Confirm a red badge appears below the page title reading "🕒 Stale — no activity for 16 days". Hover over it to confirm the tooltip shows the exact `modified` timestamp.
8. Open the Opportunity modified 10 days ago. Confirm no stale badge appears (threshold is 14 days, not 7).
9. Update (save) the stale Opportunity — which refreshes `modified` to today. Reload. Confirm the stale badge disappears from the form. Reload the list. Confirm the row is no longer red.
10. Disable ADHD mode. Reload the list. Confirm no heat-map colours appear on any row. Open the 16-day-stale Opportunity. Confirm no stale badge appears.
11. Confirm no duplicate badges appear after multiple form refreshes.
12. Confirm no JavaScript console errors at any step.

## Acceptance Criteria
- [ ] Opportunity list rows are coloured red when `modified` is > 14 days ago and amber when > 7 days ago, in ADHD mode.
- [ ] Hovering over a coloured row shows a tooltip stating "No activity for X days."
- [ ] Rows modified within 7 days have no special colouring.
- [ ] A "🕒 Stale — no activity for X days" badge appears on the Opportunity form when `modified` is > 14 days ago and ADHD mode is active.
- [ ] Badge includes a tooltip with the exact last-modified timestamp.
- [ ] Saving the Opportunity removes the stale badge on the subsequent refresh.
- [ ] No stale badge appears for records modified 14 days or fewer ago.
- [ ] All heat-map and badge behaviour is absent when ADHD mode is disabled.
- [ ] No duplicate badges appear after multiple form refreshes.
- [ ] No JavaScript console errors on the Opportunity list or form.

## Dependencies
- **Blocked by:** ADHD-006 (heat-map infra, `registerHeatmapDoctype` must support staleness mode)
- **Blocks:** None

## Complexity
S — Extends existing heat-map infra with a one-call registration and one new mode flag; form script is a single badge render. No server endpoint, no DocType changes.

## Phase
Phase 7 — Module-by-Module Expansion
