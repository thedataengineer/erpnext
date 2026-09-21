// "What's still open?" panel on a submitted Purchase Receipt (ADHD-027): what was ordered, what this receipt
// brought in and what is still to come, so nobody has to open the Purchase Order to find out.
//
// The receipt has no purchase_order field of its own: every item row names its order (purchase_order) and the
// order row it fills (purchase_order_item). The numbers come from one server call that reads all the orders
// the receipt draws on together, and applies the permissions of whoever opened the receipt.

frappe.provide("erpnext.adhd");

(() => {
	const METHOD = "erpnext.buying.services.adhd_receipt_diff.get_receipt_diff";
	const PANEL = ".adhd-receipt-diff";

	function isActive() {
		return Boolean(frappe.boot?.adhd_mode);
	}

	// everything that came from data goes through here on its way into markup
	const esc = (value) => frappe.utils.escape_html(value);

	// quantities show only the decimals they have: "6", not "6.000"
	function formatQty(value) {
		const qty = flt(value, 3);
		const decimals = Number.isInteger(qty) ? 0 : (String(qty).split(".")[1] || "").length;
		return format_number(qty, null, decimals);
	}

	function orderLink(name) {
		const href = frappe.utils.get_form_link("Purchase Order", name);
		return `<a class="adhd-diff-po-link" href="${esc(
			href
		)}" target="_blank" rel="noopener noreferrer">${esc(name)} ↗</a>`;
	}

	function stillOpenCell(row) {
		if (row.state === "open") {
			const inStock =
				row.uom && row.stock_uom && row.uom !== row.stock_uom
					? ` <span class="adhd-diff-stock">${esc(
							__("= {0} {1}", [formatQty(row.pending_stock_qty), row.stock_uom])
					  )}</span>`
					: "";
			return `<td class="text-right adhd-diff-open-qty">${esc(formatQty(row.pending))}${inStock}</td>`;
		}
		if (row.state === "closed") {
			return `<td class="text-right adhd-diff-muted">${esc(__("Closed"))}</td>`;
		}
		if (row.state === "open_ended") {
			return `<td class="text-right adhd-diff-muted" title="${esc(
				__("This line has no fixed quantity")
			)}">—</td>`;
		}
		const over =
			flt(row.over_received) > 0
				? ` <span class="adhd-diff-over">${esc(
						__("{0} over", [formatQty(row.over_received)])
				  )}</span>`
				: "";
		return `<td class="text-right adhd-diff-done-qty">✓${over}</td>`;
	}

	function rowHtml(row) {
		const touched = flt(row.this_receipt) !== 0;
		const rejected =
			flt(row.this_receipt_rejected) > 0
				? ` <span class="adhd-diff-muted">${esc(
						__("({0} rejected)", [formatQty(row.this_receipt_rejected)])
				  )}</span>`
				: "";
		const returned =
			flt(row.returned) > 0
				? ` <span class="adhd-diff-muted">${esc(
						__("({0} returned)", [formatQty(row.returned)])
				  )}</span>`
				: "";
		return `<tr class="adhd-diff-${row.state === "open" ? "pending" : "complete"}">
			<td>${esc(row.item_code)}${
			row.item_name && row.item_name !== row.item_code
				? ` <span class="adhd-diff-muted">${esc(row.item_name)}</span>`
				: ""
		}</td>
			<td>${esc(row.uom || "")}</td>
			<td class="text-right">${esc(formatQty(row.ordered))}</td>
			<td class="text-right">${touched ? esc(formatQty(row.this_receipt)) : "—"}${rejected}</td>
			<td class="text-right">${esc(formatQty(row.received))}${returned}</td>
			${stillOpenCell(row)}
		</tr>`;
	}

	function tableHtml(rows) {
		return `<table class="adhd-diff-table table table-condensed">
			<thead><tr>
				<th>${esc(__("Item"))}</th>
				<th>${esc(__("UOM"))}</th>
				<th class="text-right">${esc(__("Ordered"))}</th>
				<th class="text-right">${esc(__("In this receipt"))}</th>
				<th class="text-right">${esc(__("Received so far"))}</th>
				<th class="text-right">${esc(__("Still open"))}</th>
			</tr></thead>
			<tbody>${rows.map(rowHtml).join("")}</tbody>
		</table>`;
	}

	function openLinesLabel(count) {
		return count === 1 ? __("1 line still open") : __("{0} lines still open", [count]);
	}

	function completeLinesLabel(count) {
		return count === 1 ? __("1 line complete") : __("{0} lines complete", [count]);
	}

	// Pure: the panel's markup for one response of get_receipt_diff, or "" when there is nothing to show.
	function buildReceiptDiffHtml(data) {
		const rows = data?.rows || [];
		if (!rows.length) return "";

		const orders = data.orders || [];
		// a line that still needs attention: something is pending, or there is no fixed quantity to judge by
		const needsAttention = (row) => row.state === "open" || row.state === "open_ended";
		const openCount = rows.filter((row) => row.state === "open").length;
		const allDone = !rows.some(needsAttention);

		const notes = [];
		if ((data.hidden_orders || []).length) {
			notes.push(
				__("You cannot see {0}, so its lines are not listed.", [data.hidden_orders.join(", ")])
			);
		}
		if (data.truncated) notes.push(__("This is only the first part of a long list."));

		const groups = orders
			.map((order) => {
				const own = rows.filter((row) => row.purchase_order === order.name);
				if (!own.length) return "";
				const status = order.status
					? ` <span class="adhd-diff-po-status">${esc(__(order.status))}</span>`
					: "";
				const head = `<div class="adhd-diff-order-head">${orderLink(order.name)}${status}</div>`;
				if (allDone) return `<div class="adhd-diff-order">${head}</div>`;

				const attention = own.filter(needsAttention);
				const rest = own.filter((row) => !needsAttention(row));
				const attentionHtml = attention.length
					? tableHtml(attention)
					: `<p class="adhd-diff-order-done">${esc(
							__("Nothing left to receive on this order.")
					  )}</p>`;
				const restHtml =
					attention.length && rest.length
						? `<details class="adhd-diff-rest"><summary>${esc(
								completeLinesLabel(rest.length)
						  )}</summary>${tableHtml(rest)}</details>`
						: "";
				return `<div class="adhd-diff-order">${head}${attentionHtml}${restHtml}</div>`;
			})
			.join("");

		return `<div class="adhd-receipt-diff" role="region" aria-label="${esc(__("What's still open?"))}">
			<div class="adhd-receipt-diff-header">
				<span class="adhd-diff-title">${esc(__("What's still open?"))}</span>
				${allDone ? "" : `<span class="adhd-diff-summary">${esc(openLinesLabel(openCount))}</span>`}
			</div>
			${allDone ? `<p class="adhd-diff-all-done">${esc(__("All items fully received."))}</p>` : ""}
			${notes.map((note) => `<p class="adhd-diff-note">${esc(note)}</p>`).join("")}
			${groups}
		</div>`;
	}

	function removePanel(frm) {
		frm.layout?.wrapper?.find(PANEL).remove();
	}

	// Only receipts made against an order have anything to compare, so a plain receipt asks the server nothing.
	function hasOrderRows(items) {
		return (items || []).some((row) => row.purchase_order);
	}

	async function renderReceiptDiff(frm) {
		// numbering every render, mode on or off, is what lets a switch-off cancel a reply still on its way
		const requestId = (frm._adhdReceiptRequest || 0) + 1;
		frm._adhdReceiptRequest = requestId;
		removePanel(frm);
		if (!isActive() || frm.doc?.doctype !== "Purchase Receipt" || frm.doc.docstatus !== 1) return;
		if (!hasOrderRows(frm.doc.items) || !frappe.model.can_read("Purchase Order")) return;

		const name = frm.doc.name;
		let data;
		try {
			// silent: a user who may open the receipt but not the orders must not get an error dialog
			const response = await frappe.call({
				method: METHOD,
				args: { receipt: name },
				silent: true,
				quiet: true,
			});
			data = response?.message;
		} catch {
			return;
		}

		// the form may have refreshed, moved to another document or lost the mode while the server worked
		if (requestId !== frm._adhdReceiptRequest || !isActive() || frm.doc?.name !== name) return;
		const html = buildReceiptDiffHtml(data);
		const $anchor = $(frm.fields_dict?.items?.wrapper);
		if (!html || !$anchor.length) return;
		// a refresh that overlapped this one may have added its panel already
		removePanel(frm);
		$anchor.after(html);
	}

	frappe.ui.form.on("Purchase Receipt", {
		refresh(frm) {
			// not returned: the form's own refresh must not wait for this network call
			renderReceiptDiff(frm).catch(() => null);
		},
	});

	// switched on or off while a receipt is open: show or remove the panel at once
	erpnext.adhd.onStateChange?.(() => {
		const frm = window.cur_frm;
		if (frm?.doctype === "Purchase Receipt" && frm.doc) renderReceiptDiff(frm).catch(() => null);
	});

	erpnext.adhd.buildReceiptDiffHtml = buildReceiptDiffHtml;
	erpnext.adhd.renderReceiptDiff = renderReceiptDiff;
})();
