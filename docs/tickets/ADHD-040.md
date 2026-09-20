# ADHD-040: Delivery Trip "Stop Sequence" At-a-Glance

## Summary
When ADHD mode is active on a Delivery Trip form, inject a compact route summary above the Delivery Stops child table and add numbered sequence badges to each stop row — giving the driver or dispatcher an instant overview of the full route without scrolling through every row.

## Background / Context
A Delivery Trip form can contain 10–20 stops, each with an address, linked Delivery Note, and status field, all crammed into a child table that requires horizontal scrolling. For ADHD users, comprehending a multi-stop route means counting rows manually, clicking into individual stops to check the address, and mentally summing up the package count — a high working-memory task that is frequently abandoned partway through. The route summary and sequence badges externalise this mental work directly onto the form.

## Cognitive Mechanism
Working memory | attention switching | initiation

## Prerequisites
- ADHD mode toggle (Phase 1, `public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` must be readable.

## Scope
**Create:**
- `erpnext/stock/doctype/delivery_trip/adhd_delivery_trip.js`

**Modify:**
- `erpnext/hooks.py` — add `"Delivery Trip": "stock/doctype/delivery_trip/adhd_delivery_trip.js"` to `doctype_js`.

## What Needs to Be Done

1. **Register form hooks.**
   ```js
   frappe.ui.form.on("Delivery Trip", {
     refresh(frm)    { if (frappe.boot.adhd_mode) scheduleRouteSummary(frm); },
     after_save(frm) { if (frappe.boot.adhd_mode) scheduleRouteSummary(frm); },
   });

   // Re-render when stops change
   frappe.ui.form.on("Delivery Stop", {
     delivery_notes_add(frm)    { if (frappe.boot.adhd_mode) scheduleRouteSummary(frm); },
     delivery_notes_remove(frm) { if (frappe.boot.adhd_mode) scheduleRouteSummary(frm); },
     address(frm)               { if (frappe.boot.adhd_mode) scheduleRouteSummary(frm); },
   });
   ```
   Note: the Delivery Stop child table fieldname is `delivery_stops` on the Delivery Trip doctype; verify against the actual field definition and adjust `frappe.ui.form.on("Delivery Stop", ...)` fieldname events accordingly.

2. **Debounce.** 500 ms to avoid re-rendering during rapid child table edits:
   ```js
   let _routeTimer = null;
   function scheduleRouteSummary(frm) {
     clearTimeout(_routeTimer);
     _routeTimer = setTimeout(() => renderRouteSummary(frm), 500);
   }
   ```

3. **Compute summary stats.** `computeRouteSummary(frm)`:
   ```js
   async function computeRouteSummary(frm) {
     const stops = frm.doc.delivery_stops || [];
     const totalStops = stops.length;
     if (!totalStops) return null;

     // Collect all unique Delivery Note names linked across all stops
     const dnNames = [];
     stops.forEach(stop => {
       // Each stop has a `delivery_note` field linking to a Delivery Note
       if (stop.delivery_note) dnNames.push(stop.delivery_note);
     });

     // Fetch total item count across all linked Delivery Notes
     let totalPackages = 0;
     if (dnNames.length) {
       const dnItems = await frappe.db.get_list("Delivery Note Item", {
         filters: [["parent", "in", dnNames]],
         fields: ["qty"],
         limit: dnNames.length * 50,  // reasonable upper bound
       });
       totalPackages = dnItems.reduce((sum, i) => sum + (parseFloat(i.qty) || 0), 0);
     }

     // First stop address
     const firstStop = stops[0];
     const firstAddress = firstStop?.customer_address || firstStop?.address || "—";

     // Estimated total distance (frm.doc.total_distance if available, else "—")
     const totalDistance = frm.doc.total_distance
       ? `${frm.doc.total_distance} ${frm.doc.uom || "km"}`
       : "—";

     return { totalStops, totalPackages, firstAddress, totalDistance };
   }
   ```

4. **`renderRouteSummary(frm)`.** Builds and injects the summary card:
   ```js
   async function renderRouteSummary(frm) {
     $("#adhd-route-summary").remove();

     const stats = await computeRouteSummary(frm);
     if (!stats) return;

     const $summary = $(`
       <div id="adhd-route-summary" class="adhd-route-summary">
         <div class="adhd-route-stat">
           <span class="adhd-stat-label">Stops</span>
           <span class="adhd-stat-value">${stats.totalStops}</span>
         </div>
         <div class="adhd-route-stat">
           <span class="adhd-stat-label">Distance</span>
           <span class="adhd-stat-value">${frappe.utils.escape_html(stats.totalDistance)}</span>
         </div>
         <div class="adhd-route-stat">
           <span class="adhd-stat-label">Packages</span>
           <span class="adhd-stat-value">${stats.totalPackages.toFixed(0)}</span>
         </div>
         <div class="adhd-route-stat adhd-route-first-stop">
           <span class="adhd-stat-label">First Stop</span>
           <span class="adhd-stat-value adhd-first-address">
             ${frappe.utils.escape_html(stats.firstAddress)}
           </span>
         </div>
       </div>
     `);

     // Insert above the delivery_stops child table
     $(frm.fields_dict.delivery_stops.wrapper).before($summary);

     // Apply sequence badges after summary renders
     applySequenceBadges(frm);
   }
   ```

5. **`applySequenceBadges(frm)`.** Adds a numbered badge to the leftmost cell of each Delivery Stop grid row:
   ```js
   function applySequenceBadges(frm) {
     const $grid = $(frm.fields_dict.delivery_stops.grid.wrapper);
     // Remove existing badges first
     $grid.find(".adhd-stop-badge").remove();

     $grid.find("tbody tr.grid-row").each(function (index) {
       const $firstCell = $(this).find("td:first-child");
       if (!$firstCell.length) return;
       $firstCell.prepend(
         `<span class="adhd-stop-badge">${index + 1}</span>`
       );
     });
   }
   ```

6. **Re-apply badges after grid renders.** The grid re-renders on row add/remove/reorder. Use a `MutationObserver` on the grid's `tbody`:
   ```js
   function watchGridForBadgeUpdates(frm) {
     const target = frm.fields_dict.delivery_stops?.grid?.wrapper?.querySelector("tbody");
     if (!target || frm._adhdRouteObserver) return;

     frm._adhdRouteObserver = new MutationObserver(() => {
       clearTimeout(frm._adhdBadgeTimer);
       frm._adhdBadgeTimer = setTimeout(() => applySequenceBadges(frm), 200);
     });
     frm._adhdRouteObserver.observe(target, { childList: true });
   }
   ```
   Call `watchGridForBadgeUpdates(frm)` at the end of `renderRouteSummary`.

7. **CSS** (inline `<style>` or `adhd_mode.scss`):
   ```css
   .adhd-route-summary {
     display: flex;
     flex-wrap: wrap;
     gap: 12px;
     padding: 10px 16px;
     margin-bottom: 12px;
     background: var(--subtle-fg);
     border: 1px solid var(--border-color);
     border-radius: 6px;
     font-size: 0.85rem;
   }
   .adhd-route-stat {
     display: flex;
     flex-direction: column;
     align-items: center;
     min-width: 80px;
   }
   .adhd-stat-label {
     font-size: 0.7rem;
     text-transform: uppercase;
     color: var(--text-muted);
     letter-spacing: 0.04em;
   }
   .adhd-stat-value {
     font-size: 1.2rem;
     font-weight: 700;
     color: var(--text-color);
   }
   .adhd-first-address {
     font-size: 0.85rem !important;
     font-weight: 500 !important;
     max-width: 220px;
     overflow: hidden;
     text-overflow: ellipsis;
     white-space: nowrap;
   }
   .adhd-stop-badge {
     display: inline-flex;
     align-items: center;
     justify-content: center;
     width: 22px;
     height: 22px;
     border-radius: 50%;
     background: var(--primary);
     color: #fff;
     font-size: 0.72rem;
     font-weight: 700;
     margin-right: 6px;
     flex-shrink: 0;
   }
   ```

## How to Test

1. Open ERPNext with ADHD mode enabled.
2. Navigate to **Stock → Delivery Trip → New**. Fill in `driver`, `vehicle`, and `company`.
3. Add 3 Delivery Stops, each linking a different Delivery Note with at least 2 items each.
4. Confirm a compact route summary card appears **above** the Delivery Stops child table showing:
   - **Stops:** 3
   - **Distance:** value from `total_distance` field or "—" if not set
   - **Packages:** total item qty across all linked Delivery Notes
   - **First Stop:** address of the first stop row
5. Confirm each row in the Delivery Stops child table has a circular numbered badge (①, ②, ③) in its leftmost column.
6. Add a 4th stop. Confirm the Stops count in the summary increments to 4 and a "4" badge appears on the new row.
7. Remove the 2nd stop. Confirm the remaining rows re-number (1, 2, 3) and the Stops count decrements.
8. If `total_distance` is filled on the form header, confirm the Distance stat displays it correctly.
9. Disable ADHD mode. Open a Delivery Trip with stops. Confirm no summary card and no sequence badges appear.

## Acceptance Criteria
- [ ] Route summary card appears above the Delivery Stops child table when ADHD mode is active.
- [ ] Summary correctly shows total stop count, estimated distance (or "—"), total package quantity, and first stop address.
- [ ] Each Delivery Stop row has a circular numbered badge starting at 1.
- [ ] Badge numbers update correctly after rows are added, removed, or reordered.
- [ ] Summary stats update within 500 ms of any change to the stops child table.
- [ ] Total packages is computed from the actual Delivery Note item quantities, not the stop count.
- [ ] Summary card and badges are absent when ADHD mode is disabled.
- [ ] No JavaScript console errors on the Delivery Trip form.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD mode toggle (Phase 1, already shipped).

## Complexity
S — One async `db.get_list` call for DN items, a flex-card summary render, numbered badge injection via MutationObserver; self-contained in a new file with no changes to existing Python or JS.

## Phase
Phase 7 — Module-by-Module Expansion
