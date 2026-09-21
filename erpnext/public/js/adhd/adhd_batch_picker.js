// FEFO batch picker for batch fields in editable child tables.

frappe.provide("erpnext.adhd");

(() => {
	const prototype = frappe.ui.form.ControlLink?.prototype;
	if (!prototype || prototype._adhdBatchPickerWrapped) return;
	const originalOpenAdvancedSearch = prototype.open_advanced_search;

	function renderBatchPicker(control, batches, itemCode, warehouse) {
		const dialog = new frappe.ui.Dialog({
			title: __("Select Batch — {0}", [itemCode]),
			size: "large",
		});
		dialog.show();
		const $body = $(dialog.$wrapper.find(".modal-body"));
		if (!batches.length) {
			$body.html(`<p class="text-muted">${__("No batches found for this item.")}</p>`);
			return;
		}

		const today = frappe.datetime.get_today();
		const expiringDate = frappe.datetime.add_days(today, 30);
		const rows = batches
			.map((batch) => {
				const expired = Boolean(batch.expiry_date && batch.expiry_date < today);
				const expiring = Boolean(
					!expired && batch.expiry_date && batch.expiry_date <= expiringDate,
				);
				const batchName = frappe.utils.escape_html(batch.name);
				const expiryText = batch.expiry_date
					? `${frappe.utils.escape_html(batch.expiry_date)}${
							expired ? ` ${__("⚠ Expired")}` : expiring ? ` ${__("⏳ Expiring soon")}` : ""
						}`
					: __("No expiry");
				return `<tr class="${expired ? "adhd-batch-expired" : expiring ? "adhd-batch-expiring" : ""}">
					<td><strong>${batchName}</strong></td>
					<td>${frappe.utils.escape_html(batch.manufacturing_date || "—")}</td>
					<td class="${expired ? "text-danger" : expiring ? "text-warning" : ""}">${expiryText}</td>
					<td class="text-right"><strong>${format_number(batch.available_qty || 0)}</strong></td>
					<td><button type="button" class="btn btn-xs btn-primary adhd-batch-select-btn"
						data-batch="${batchName}">${__("Select")}</button></td>
				</tr>`;
			})
			.join("");
		$body.html(`
			<table class="table table-condensed adhd-batch-table">
				<thead><tr><th>${__("Batch ID")}</th><th>${__("Mfg. Date")}</th>
					<th>${__("Expiry Date")}</th><th class="text-right">${__("Available Qty")}</th><th></th></tr></thead>
				<tbody>${rows}</tbody>
			</table>
			<p class="text-muted adhd-batch-context">${__("Sorted by expiry date (FEFO).")} ${
				warehouse ? __("Warehouse: {0}", [frappe.utils.escape_html(warehouse)]) : ""
			}</p>
		`);
		$body.on("click", ".adhd-batch-select-btn", (event) => {
			control.set_value(event.currentTarget.dataset.batch);
			dialog.hide();
		});
	}

	async function openAdhdBatchPicker(control, row, originalArgs = []) {
		const itemCode = row.item_code;
		const warehouse = row.s_warehouse || row.warehouse || row.t_warehouse || "";
		if (!itemCode) return originalOpenAdvancedSearch.apply(control, originalArgs);
		frappe.show_progress(__("Loading batches…"), 50, 100, __("Please wait"));
		try {
			const response = await frappe.call({
				method: "erpnext.stock.adhd.get_available_batches",
				args: { item_code: itemCode, warehouse, limit: 50 },
			});
			renderBatchPicker(control, response.message || [], itemCode, warehouse);
		} catch {
			return originalOpenAdvancedSearch.apply(control, originalArgs);
		} finally {
			frappe.hide_progress();
		}
	}

	prototype.open_advanced_search = function (...args) {
		if (
			!frappe.boot?.adhd_mode ||
			this.df?.fieldname !== "batch_no" ||
			!this.grid_row?.doc
		) {
			return originalOpenAdvancedSearch.apply(this, args);
		}
		return openAdhdBatchPicker(this, this.grid_row.doc, args);
	};
	prototype._adhdBatchPickerWrapped = true;

	if (!$("#adhd-batch-picker-styles").length) {
		$("<style>", {
			id: "adhd-batch-picker-styles",
			text: `.adhd-batch-expired{opacity:.5;text-decoration:line-through}
				.adhd-batch-expiring{background:rgba(var(--yellow-rgb),.1)}
				.adhd-batch-table{font-size:.82rem}.adhd-batch-context{font-size:.75rem;margin-top:4px}`,
		}).appendTo("head");
	}

	erpnext.adhd.openBatchPicker = openAdhdBatchPicker;
})();
