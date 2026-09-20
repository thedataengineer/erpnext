# ADHD-055: Depreciation Due Ambient Indicator

## Summary
Extend the ADHD-006 heat-map infrastructure to the Asset list view, coloring each row's border based on how soon depreciation is due, so overdue or imminent depreciation entries are impossible to miss.

## Background / Context
Posting depreciation on time is a periodic task with no natural trigger in the ERPNext UI — the user must remember to check `next_depreciation_date` on every asset, a classic time-blindness failure point. ADHD users either post depreciation in a burst when they remember (often late) or miss months entirely, causing incorrect book values. The Asset list gives no ambient signal about urgency; all rows look identical regardless of whether depreciation was due yesterday or three months from now.

## Cognitive Mechanism
Time blindness | Initiation | Working memory

## Prerequisites
- ADHD-006 (heat-map list-view infrastructure — must be in place to provide the row-coloring pattern, CSS classes, and list-page interval mechanism)
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Modify** `public/js/adhd/adhd_list_view.js` — add an Asset entry to the heat-map registry

## What Needs to Be Done

1. **Open `adhd_list_view.js`** and locate the heat-map registry (the object/array where existing doctypes like Sales Order are registered with their date fields and thresholds).

2. **Add an Asset entry** to the registry with the following configuration:
   ```js
   {
     doctype: 'Asset',
     dateField: 'next_depreciation_date',
     addFields: ['next_depreciation_date', 'finance_books'],  // ensure these are fetched
     thresholds: {
       red:   (doc) => doc.next_depreciation_date && new Date(doc.next_depreciation_date) < new Date(),
       amber: (doc) => doc.next_depreciation_date && daysBetween(new Date(), new Date(doc.next_depreciation_date)) <= 7,
       green: (doc) => doc.next_depreciation_date && daysBetween(new Date(), new Date(doc.next_depreciation_date)) <= 30,
     }
   }
   ```
   Where `daysBetween(a, b)` is a helper returning `Math.ceil((b - a) / 86400000)`.

3. **Threshold semantics** (evaluated in priority order — first match wins):
   - **Red**: `next_depreciation_date` is in the past (depreciation not yet posted).
   - **Amber**: `next_depreciation_date` is within the next 7 calendar days.
   - **Green**: `next_depreciation_date` is within the next 30 calendar days.
   - No border: `next_depreciation_date` is null/blank or more than 30 days away.

4. **Tooltip on hover**: attach a `title` attribute (or a `tippy`/Bootstrap tooltip if the project already uses one) to the row border element:
   - Text: `"Next depreciation: {frappe.datetime.str_to_user(doc.next_depreciation_date)}"`.
   - If the `finance_books` child table is available in the list data, append the monthly depreciation amount from the first finance book: `", ₹{finance_books[0].depreciation_amount}"`. Use the `finance_books` field only if it is returned by the list API call — do not make an extra API call per row.

5. **`add_fields` requirement**: the list endpoint must return `next_depreciation_date`. Confirm this by checking what `frappe.views.ListView` fetches for Asset. If it is not in the default columns, add it to `list_settings` or use the `add_fields` mechanism in the heat-map registry (which should push these fields into the list API request, following the ADHD-006 pattern).

6. **60-second re-evaluation interval**: the ADHD-006 infrastructure already sets a list-page interval. Confirm the Asset doctype is processed by that interval when the user is on the Asset list page. If the interval uses a doctype guard, add `'Asset'` to the allowed list.

7. **CSS classes**: reuse `.adhd-row-red`, `.adhd-row-amber`, `.adhd-row-green` already defined in ADHD-006. No new CSS needed.

8. **Null safety**: if `next_depreciation_date` is `null`, `undefined`, or empty string, skip coloring entirely — do not render any border. Assets not yet set up for depreciation should appear normal.

## How to Test

1. Enable ADHD mode. Navigate to **Assets → Asset List**.
2. Ensure at least three assets exist:
   - Asset A: `next_depreciation_date` = yesterday.
   - Asset B: `next_depreciation_date` = 5 days from today.
   - Asset C: `next_depreciation_date` = 20 days from today.
   - Asset D: `next_depreciation_date` = 60 days from today (or blank).
3. Confirm Asset A has a **red** left-border.
4. Confirm Asset B has an **amber** left-border.
5. Confirm Asset C has a **green** left-border.
6. Confirm Asset D has **no** colored border.
7. Hover over Asset A's row border. Confirm tooltip reads "Next depreciation: [date]".
8. Wait 60 seconds without refreshing. If Asset B's date was manipulated to be in the past, confirm it turns red without a page reload.
9. Disable ADHD mode. Reload the Asset list. Confirm no colored borders appear.
10. Navigate to a different doctype's list (e.g. Sales Order). Confirm Asset-specific logic does not bleed into other lists.

## Acceptance Criteria
- [ ] Asset list rows with `next_depreciation_date` in the past show a red left-border.
- [ ] Asset list rows with `next_depreciation_date` within 7 days show an amber left-border.
- [ ] Asset list rows with `next_depreciation_date` within 30 days show a green left-border.
- [ ] Asset list rows with null/blank `next_depreciation_date` or date > 30 days away show no border.
- [ ] Hovering a colored row shows a tooltip with the next depreciation date.
- [ ] Row colors update every 60 seconds without a page reload.
- [ ] No colored borders when ADHD mode is off.
- [ ] No JS errors or extra API calls per row.

## Dependencies
- Blocked by: ADHD-006 (heat-map infrastructure)
- Blocks: none

## Complexity
S — a single registry entry in the existing heat-map infrastructure; no new files, no server changes.

## Phase
Phase 7 — Module-by-Module Expansion
