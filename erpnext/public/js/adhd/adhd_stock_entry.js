// Stock impact preview and putaway explanations for ADHD mode.

frappe.provide("erpnext.adhd");

(() => {
	function isActive() {
		return Boolean(frappe.boot?.adhd_mode);
	}

	function itemQuantity(row) {
		return Number(row.transfer_qty ?? row.qty) || 0;
	}

	function getItemWarehousePairs(frm) {
		const pairs = new Map();
		(frm.doc.items || []).forEach((row) => {
			if (!row.item_code) return;
			[row.s_warehouse, row.t_warehouse].filter(Boolean).forEach((warehouse) => {
				const key = `${row.item_code}::${warehouse}`;
				pairs.set(key, { item_code: row.item_code, warehouse });
			});
		});
		return [...pairs.values()];
	}

	// Rows are applied in order, so a later row for the same item and warehouse starts from the
	// quantity the earlier rows leave behind, not from the stock the warehouse holds today.
	function buildPreviewRows(items, binMap) {
		const rows = [];
		const running = new Map();
		(items || []).forEach((item) => {
			if (!item.item_code) return;
			const quantity = itemQuantity(item);
			for (const [warehouse, direction] of [
				[item.s_warehouse, -1],
				[item.t_warehouse, 1],
			]) {
				if (!warehouse) continue;
				const key = `${item.item_code}::${warehouse}`;
				const currentQty = running.has(key) ? running.get(key) : Number(binMap[key]) || 0;
				const change = direction * quantity;
				running.set(key, currentQty + change);
				rows.push({
					item_code: item.item_code,
					warehouse,
					current_qty: currentQty,
					change,
					after: currentQty + change,
				});
			}
		});
		return rows;
	}

	// The server rejects a request with more than 400 item and warehouse pairs.
	const MAX_PAIRS_PER_REQUEST = 400;

	function chunkPairs(pairs, size = MAX_PAIRS_PER_REQUEST) {
		const chunks = [];
		for (let start = 0; start < pairs.length; start += size) {
			chunks.push(pairs.slice(start, start + size));
		}
		return chunks;
	}

	async function fetchBinQuantities(pairs) {
		if (!pairs.length) return {};
		const responses = await Promise.all(
			chunkPairs(pairs).map((chunk) =>
				frappe.call({
					method: "erpnext.stock.adhd.get_bin_quantities",
					args: { pairs: chunk },
				})
			)
		);
		return responses.reduce((map, response) => {
			(response.message || []).forEach((row) => {
				map[`${row.item_code}::${row.warehouse}`] = row.actual_qty || 0;
			});
			return map;
		}, {});
	}

	function previewTable(rows) {
		const warningCount = rows.filter((row) => row.after < 0).length;
		const warning = warningCount
			? `<div class="alert alert-danger adhd-stockout-warning">${__(
					"⚠ Warning: {0} warehouse row(s) would go below zero after this entry.",
					[warningCount]
			  )}</div>`
			: "";
		const body = rows
			.map((row) => {
				const changeClass = row.change >= 0 ? "adhd-change-positive" : "adhd-change-negative";
				const change = `${row.change >= 0 ? "+" : "−"}${Math.abs(row.change)}`;
				return `<tr class="${row.after < 0 ? "adhd-row-stockout" : ""}">
					<td>${frappe.utils.escape_html(row.item_code)}</td>
					<td>${frappe.utils.escape_html(row.warehouse)}</td>
					<td class="text-right">${format_number(row.current_qty)}</td>
					<td class="text-right ${changeClass}">${change}</td>
					<td class="text-right">${format_number(row.after)}</td>
				</tr>`;
			})
			.join("");
		return `${warning}<table class="table table-condensed adhd-preview-table">
			<thead><tr><th>${__("Item")}</th><th>${__("Warehouse")}</th>
				<th class="text-right">${__("Current Qty")}</th><th class="text-right">${__("Change")}</th>
				<th class="text-right">${__("After Submit")}</th></tr></thead>
			<tbody>${body}</tbody></table>`;
	}

	async function renderPreview(frm) {
		frm.layout.$wrapper.find("#adhd-stock-preview").remove();
		if (!isActive() || frm.doc.docstatus !== 0) return;
		const pairs = getItemWarehousePairs(frm);
		if (!pairs.length) return;
		const requestId = (frm._adhdStockPreviewRequest || 0) + 1;
		frm._adhdStockPreviewRequest = requestId;
		const binMap = await fetchBinQuantities(pairs);
		if (requestId !== frm._adhdStockPreviewRequest || !isActive() || frm.doc.docstatus !== 0) return;
		const rows = buildPreviewRows(frm.doc.items, binMap);
		if (!rows.length || !frm.fields_dict.items?.wrapper) return;
		const $section = $(`
			<div id="adhd-stock-preview" class="adhd-stock-preview">
				<details open><summary class="adhd-preview-title">${__("📦 Stock Impact Preview")}</summary>
					${previewTable(rows)}
				</details>
			</div>
		`);
		$(frm.fields_dict.items.wrapper).after($section);
	}

	function schedulePreviewRefresh(frm) {
		clearTimeout(frm._adhdStockPreviewTimer);
		frm._adhdStockPreviewTimer = setTimeout(() => renderPreview(frm).catch(() => null), 600);
	}

	function findGridRow(frm, rowName) {
		const gridRow = frm.fields_dict.items?.grid?.grid_rows_by_docname?.[rowName];
		if (gridRow?.$row?.length) return gridRow.$row;
		return $(frm.fields_dict.items?.grid?.wrapper)
			.find("[data-name]")
			.filter((_, element) => element.dataset.name === rowName)
			.first();
	}

	function buildPutawayExplanation(rule) {
		if (rule.item_code) {
			const capacity = rule.capacity
				? __(" Its configured capacity is {0} {1}.", [rule.capacity, rule.uom || ""])
				: "";
			return __(
				"This item-specific rule selected the warehouse using priority {0} and available capacity.{1}",
				[rule.priority || 1, capacity]
			);
		}
		return __("The configured putaway rule selected this warehouse using its priority and capacity.");
	}

	async function openPutawayExplanation(row) {
		const response = await frappe.db.get_value("Putaway Rule", row.putaway_rule, [
			"name",
			"warehouse",
			"item_code",
			"capacity",
			"stock_capacity",
			"priority",
			"uom",
			"disable",
			"company",
		]);
		const rule = response?.message || {};
		const dialog = new frappe.ui.Dialog({
			title: __("Why was this warehouse assigned?"),
			size: "small",
		});
		$(dialog.$wrapper.find(".modal-body")).html(`
			<div class="adhd-putaway-explanation">
				<p>${__("Putaway rule <strong>{0}</strong> assigned <strong>{1}</strong> as the target warehouse.", [
					frappe.utils.escape_html(row.putaway_rule),
					frappe.utils.escape_html(row.t_warehouse || rule.warehouse || ""),
				])}</p>
				<p>${buildPutawayExplanation(rule)}</p>
				<p><a href="/app/putaway-rule/${encodeURIComponent(
					row.putaway_rule
				)}" target="_blank" rel="noopener noreferrer">${__("View Putaway Rule ›")}</a></p>
			</div>
		`);
		dialog.show();
	}

	function decorateSingleRow(frm, row) {
		const $gridRow = findGridRow(frm, row.name);
		const $cell = $gridRow.find('[data-fieldname="t_warehouse"]').first();
		if (!$cell.length || $cell.find(".adhd-putaway-why").length) return;
		const $icon = $(
			`<button type="button" class="btn btn-link btn-xs adhd-putaway-why"
				title="${__("Why was this warehouse assigned?")}" aria-label="${__("Explain putaway warehouse")}">ⓘ</button>`
		);
		$icon.on("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openPutawayExplanation(row);
		});
		$cell.append($icon);
	}

	function decoratePutawayRows(frm) {
		frm.layout.$wrapper.find(".adhd-putaway-why").remove();
		if (!isActive()) return;
		(frm.doc.items || []).filter((row) => row.putaway_rule).forEach((row) => decorateSingleRow(frm, row));
		const $grid = $(frm.fields_dict.items?.grid?.wrapper);
		$grid.off("change.adhdPutaway").on(
			"change.adhdPutaway",
			frappe.utils.debounce(() => decoratePutawayRows(frm), 300)
		);
	}

	function refreshFeatures(frm) {
		if (!isActive() || frm.doc.docstatus !== 0) {
			frm.layout.$wrapper.find("#adhd-stock-preview,.adhd-putaway-why").remove();
			return;
		}
		schedulePreviewRefresh(frm);
		setTimeout(() => decoratePutawayRows(frm), 0);
	}

	function childChanged(frm) {
		if (!isActive()) return;
		schedulePreviewRefresh(frm);
		setTimeout(() => decoratePutawayRows(frm), 0);
	}

	if (!$("#adhd-stock-entry-styles").length) {
		$("<style>", {
			id: "adhd-stock-entry-styles",
			text: `.adhd-stock-preview{margin:8px 0;border:1px solid var(--border-color);border-radius:4px}
				.adhd-preview-title{cursor:pointer;font-weight:600;padding:8px 12px;list-style:none}
				.adhd-preview-table{font-size:.8rem;margin:0}.adhd-change-positive{color:var(--green-500);font-weight:600}
				.adhd-change-negative{color:var(--red-500);font-weight:600}.adhd-row-stockout{background:color-mix(in srgb,var(--red-500) 10%,transparent)}
				.adhd-putaway-why{margin-left:4px}.adhd-putaway-explanation p{margin-bottom:8px;font-size:.9rem;line-height:1.5}`,
		}).appendTo("head");
	}

	frappe.ui.form.on("Stock Entry", {
		refresh: refreshFeatures,
		after_save: refreshFeatures,
		after_submit: refreshFeatures,
	});
	frappe.ui.form.on("Stock Entry Detail", {
		item_code: childChanged,
		qty: childChanged,
		transfer_qty: childChanged,
		s_warehouse: childChanged,
		t_warehouse: childChanged,
		putaway_rule: childChanged,
		items_remove: childChanged,
	});

	erpnext.adhd.getItemWarehousePairs = getItemWarehousePairs;
	erpnext.adhd.buildStockPreviewRows = buildPreviewRows;
	erpnext.adhd.chunkStockPairs = chunkPairs;
	erpnext.adhd.fetchBinQuantities = fetchBinQuantities;
	erpnext.adhd.buildPutawayExplanation = buildPutawayExplanation;
})();
