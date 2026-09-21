// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
// ADHD-029: what has been delivered on a submitted Sales Order and what is still to go, per line, under the items
// grid, with a "Create Delivery Note" shortcut while something is left to ship.
//
// The numbers are already on the form: every Sales Order Item carries qty and delivered_qty (updated when a
// Delivery Note is submitted), so there is no server call. Which lines can be delivered at all follows
// erpnext/selling/doctype/sales_order/mapper.py (make_delivery_note) and the standard Create > Delivery Note button
// in sales_order.js, so the panel never offers a delivery the standard flow would not.

frappe.provide("erpnext.adhd");

(() => {
	const PANEL_CLASS = "adhd-delivery-status";
	const MAPPER = "erpnext.selling.doctype.sales_order.mapper.make_delivery_note";
	// the row states in which the panel says "delivered" (nothing more to ship for that line)
	const FINISHED = ["done", "over"];

	// Read at run time, never once at load: the mode can be switched on and off while a form is open.
	function isActive() {
		return Boolean(frappe.boot && frappe.boot.adhd_mode);
	}

	function esc(value) {
		return frappe.utils.escape_html(value == null ? "" : value);
	}

	// 10.3 - 10.1 is 0.20000000000000107 in floating point
	function round(value) {
		return Math.round(value * 1e6) / 1e6;
	}

	// Whole quantities without decimals (like the Float formatter), others with the system's precision.
	function formatQty(value) {
		return format_number(value, null, Number.isInteger(value) ? 0 : undefined);
	}

	// One line of the order. Quantities are compared by size, as the mapper does, so a return-style negative line
	// is measured the same way. `state` is one of:
	//   closed      the row was closed: no delivery is expected
	//   not_needed  the row (or the whole order) is marked to skip delivery, e.g. a service item
	//   supplier    drop-ship: the supplier ships it, so it is never delivered from here
	//   to_confirm  quantity 0 on an order with unit-price items: the quantity is settled at delivery
	//   no_qty      quantity 0 on any other order: nothing to deliver
	//   pending     something is left to deliver
	//   over        delivered more than ordered (over-delivery allowance): remaining is 0, over_by is the excess
	//   done        delivered in full
	// Rows that are pending, or to_confirm with nothing delivered yet, are the ones a Delivery Note is made for.
	function getDeliveryRow(row, order) {
		const ordered = round(Math.abs(flt(row.qty)));
		const delivered = round(Math.abs(flt(row.delivered_qty)));
		const result = {
			item_code: row.item_code,
			item_name: row.item_name,
			ordered,
			delivered,
			remaining: 0,
			over_by: 0,
			deliverable: false,
		};

		if (cint(row.closed)) return { ...result, state: "closed" };
		if (cint(row.skip_delivery) || cint(order.skip_delivery_note))
			return { ...result, state: "not_needed" };
		if (cint(row.delivered_by_supplier)) {
			return { ...result, state: "supplier", remaining: Math.max(round(ordered - delivered), 0) };
		}
		if (!ordered) {
			return cint(order.has_unit_price_items)
				? { ...result, state: "to_confirm", deliverable: delivered === 0 }
				: { ...result, state: "no_qty" };
		}

		const remaining = round(ordered - delivered);
		if (remaining > 0) return { ...result, state: "pending", remaining, deliverable: true };
		if (remaining < 0) return { ...result, state: "over", over_by: -remaining };
		return { ...result, state: "done" };
	}

	function getDeliveryRows(doc) {
		return (doc.items || []).map((row) => getDeliveryRow(row, doc));
	}

	// The same conditions as the standard Create > Delivery Note button (sales_order.js): a submitted order that is
	// not On Hold or Closed, still short of 100% delivered, whose type is a sale (Maintenance orders get Maintenance
	// Visit instead), and delivery is not switched off for it. Plus the user must be allowed to create one, and there
	// must be a line to make it for.
	function canCreateDeliveryNote(doc, rows) {
		if (!doc || doc.docstatus !== 1) return false;
		if (["On Hold", "Closed"].includes(doc.status)) return false;
		if (cint(doc.skip_delivery_note) || doc.order_type === "Maintenance") return false;
		if (flt(doc.per_delivered) >= 100) return false;
		if (!frappe.model.can_create("Delivery Note")) return false;
		return rows.some((row) => row.deliverable);
	}

	function remainingCell(row) {
		switch (row.state) {
			case "pending":
				return { css: "adhd-delivery-remaining-qty", html: esc(formatQty(row.remaining)) };
			case "done":
				return { css: "", html: "✓" };
			case "over":
				return { css: "", html: `✓ ${esc(__("{0} over", [formatQty(row.over_by)]))}` };
			case "closed":
				return { css: "", html: esc(__("Closed")) };
			case "not_needed":
				return { css: "", html: esc(__("No delivery needed")) };
			case "supplier":
				return {
					css: "",
					html: esc(
						row.remaining > 0
							? __("{0} from supplier", [formatQty(row.remaining)])
							: __("Delivered by supplier")
					),
				};
			case "to_confirm":
				return { css: "", html: esc(__("Quantity to confirm")) };
			default:
				return { css: "", html: "—" };
		}
	}

	function buildTableRow(row) {
		const cell = remainingCell(row);
		const finished = row.state !== "pending" && row.state !== "to_confirm";
		return `<tr class="${finished ? "adhd-delivery-done" : "adhd-delivery-pending"}">
			<td>${esc(row.item_code)}</td>
			<td>${esc(row.item_name || "")}</td>
			<td class="text-right">${row.state === "to_confirm" ? "—" : esc(formatQty(row.ordered))}</td>
			<td class="text-right">${esc(formatQty(row.delivered))}</td>
			<td class="text-right ${cell.css}">${cell.html}</td>
		</tr>`;
	}

	// The whole panel as HTML. `showButton` decides whether the "Create Delivery Note" button is drawn.
	function buildDeliveryHtml(rows, showButton) {
		const allDone = rows.length > 0 && rows.every((row) => FINISHED.includes(row.state));
		const toDeliver = rows.filter((row) => row.deliverable).length;
		const summary = allDone
			? ""
			: `<span class="adhd-delivery-count">${esc(
					toDeliver ? __("{0} of {1} lines still to deliver", [toDeliver, rows.length]) : ""
			  )}</span>`;
		const button = showButton
			? `<button type="button" class="btn btn-sm btn-primary adhd-create-dn-btn">${esc(
					__("Create Delivery Note")
			  )}</button>`
			: "";
		const body = allDone
			? `<p class="adhd-delivery-all-done">✅ ${esc(__("All items fully delivered."))}</p>`
			: `<table class="adhd-delivery-table table table-condensed">
				<thead>
					<tr>
						<th scope="col">${esc(__("Item Code"))}</th>
						<th scope="col">${esc(__("Item Name"))}</th>
						<th scope="col" class="text-right">${esc(__("Ordered"))}</th>
						<th scope="col" class="text-right">${esc(__("Delivered"))}</th>
						<th scope="col" class="text-right">${esc(__("Remaining"))}</th>
					</tr>
				</thead>
				<tbody>${rows.map(buildTableRow).join("")}</tbody>
			</table>`;

		return `<div class="${PANEL_CLASS}">
			<div class="adhd-delivery-header">
				<span class="adhd-delivery-title">${esc(__("Delivery Status"))}</span>
				${summary}
				${button}
			</div>
			${body}
		</div>`;
	}

	// Same as the standard Create > Delivery Note button, which is a method of the form's controller (it asks which
	// delivery dates when the order has several, then runs the standard mapper for reserved stock). Should that
	// method ever be missing, the mapper is called directly with the same arguments.
	function createDeliveryNote(frm) {
		const controller = frm.cscript;
		if (controller && typeof controller.make_delivery_note_based_on_delivery_date === "function") {
			return controller.make_delivery_note_based_on_delivery_date(true);
		}
		return frappe.model.open_mapped_doc({
			method: MAPPER,
			frm,
			args: { delivery_dates: [], for_reserved_stock: true },
			freeze: true,
			freeze_message: __("Creating Delivery Note ..."),
		});
	}

	function removeDeliveryStatus(frm) {
		if (frm && frm.$wrapper) frm.$wrapper.find(`.${PANEL_CLASS}`).remove();
	}

	function renderDeliveryStatus(frm) {
		if (!frm || !frm.doc) return;
		// whatever was drawn for an earlier state of the order goes first, so a refresh never stacks a second panel
		removeDeliveryStatus(frm);
		if (!isActive() || frm.doc.docstatus !== 1) return;

		const rows = getDeliveryRows(frm.doc);
		if (!rows.length) return;
		const $panel = $(buildDeliveryHtml(rows, canCreateDeliveryNote(frm.doc, rows)));
		$panel.find(".adhd-create-dn-btn").on("click", () => createDeliveryNote(frm));

		// below the items grid
		const grid = frm.fields_dict && frm.fields_dict.items && frm.fields_dict.items.grid;
		if (grid && grid.wrapper) {
			$(grid.wrapper).after($panel);
		} else if (frm.layout && frm.layout.wrapper) {
			frm.layout.wrapper.append($panel);
		}
	}

	frappe.ui.form.on("Sales Order", {
		// runs on the first open, after a save or submit, and on reload, which is when delivered_qty can have changed
		refresh(frm) {
			renderDeliveryStatus(frm);
		},
	});

	// Switching the mode on or off with a Sales Order open takes effect at once, without a reload.
	// (onStateChange calls back immediately with the current state, when no form is open yet.)
	if (erpnext.adhd.onStateChange) {
		erpnext.adhd.onStateChange(() => {
			const frm = window.cur_frm;
			if (frm && frm.doctype === "Sales Order") renderDeliveryStatus(frm);
		});
	}

	erpnext.adhd.SALES_ORDER_DELIVERY_MAPPER = MAPPER;
	erpnext.adhd.getDeliveryRow = getDeliveryRow;
	erpnext.adhd.getDeliveryRows = getDeliveryRows;
	erpnext.adhd.canCreateDeliveryNote = canCreateDeliveryNote;
	erpnext.adhd.buildDeliveryHtml = buildDeliveryHtml;
	erpnext.adhd.renderDeliveryStatus = renderDeliveryStatus;
	erpnext.adhd.removeDeliveryStatus = removeDeliveryStatus;
})();
