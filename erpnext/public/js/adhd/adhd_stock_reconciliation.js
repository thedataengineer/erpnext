// Stock Reconciliation variance warnings for ADHD mode.

frappe.provide("erpnext.adhd");

(() => {
	function calculateVariance(enteredValue, currentValue) {
		const entered = Number.parseFloat(enteredValue);
		const current = Number.parseFloat(currentValue);
		if (!Number.isFinite(entered) || !Number.isFinite(current)) return null;
		const difference = entered - current;
		const absolute = Math.abs(difference);
		const percent = current !== 0 ? (absolute / Math.abs(current)) * 100 : entered !== 0 ? 100 : 0;
		return {
			difference,
			absolute,
			percent,
			isHigh: percent > 10 || absolute > 50,
		};
	}

	function getGridRow(frm, rowName) {
		const gridRow = frm.fields_dict.items?.grid?.grid_rows_by_docname?.[rowName];
		if (gridRow?.$row?.length) return gridRow.$row;
		return $(frm.fields_dict.items?.grid?.wrapper)
			.find("[data-name]")
			.filter((_, element) => element.dataset.name === rowName)
			.first();
	}

	function clearVariance(frm) {
		const $wrapper = frm.layout?.$wrapper;
		$wrapper?.find("#adhd-variance-banner").remove();
		$wrapper?.find(".adhd-variance-row").removeClass("adhd-variance-row");
		$wrapper?.find(".adhd-variance-cell").remove();
	}

	function updateVarianceCell($gridRow, variance) {
		$gridRow.find(".adhd-variance-cell").remove();
		if (!variance.isHigh) return;
		const sign = variance.difference >= 0 ? "+" : "−";
		const colorClass = variance.difference >= 0 ? "text-success" : "text-danger";
		const $dataRow = $gridRow.find(".data-row").first().addBack(".data-row").first();
		$($dataRow.length ? $dataRow : $gridRow).append(`
			<div class="col grid-static-col adhd-variance-cell ${colorClass}">
				${__("Variance: {0}{1}", [sign, Math.abs(variance.difference).toFixed(2)])}
			</div>
		`);
	}

	function renderVarianceSummaryBanner(frm, flaggedCount) {
		const $existing = frm.layout.$wrapper.find("#adhd-variance-banner");
		if (!flaggedCount) {
			$existing.remove();
			return;
		}
		if ($existing.length) {
			$existing.find(".adhd-variance-count").text(flaggedCount);
			return;
		}
		const $banner = $(`
			<div id="adhd-variance-banner" class="alert alert-warning adhd-variance-banner" role="alert">
				<span>⚠</span>
				<span><strong><span class="adhd-variance-count">${flaggedCount}</span> ${__(
					"row(s)",
				)}</strong> ${__("have a variance above 10% or 50 units. Review before submitting.")}</span>
			</div>
		`);
		$(frm.fields_dict.items.wrapper).before($banner);
	}

	function applyVarianceHighlights(frm) {
		clearVariance(frm);
		if (!frappe.boot?.adhd_mode || frm.doc.docstatus !== 0) return;
		let flaggedCount = 0;
		(frm.doc.items || []).forEach((row) => {
			if (row.qty === null || row.qty === undefined || row.qty === "") return;
			if (row.current_qty === null || row.current_qty === undefined || row.current_qty === "") return;
			const variance = calculateVariance(row.qty, row.current_qty);
			if (!variance) return;
			const $gridRow = getGridRow(frm, row.name);
			if (!$gridRow.length) return;
			$gridRow.toggleClass("adhd-variance-row", variance.isHigh);
			updateVarianceCell($gridRow, variance);
			if (variance.isHigh) flaggedCount += 1;
		});
		renderVarianceSummaryBanner(frm, flaggedCount);
	}

	function scheduleVarianceCheck(frm) {
		clearTimeout(frm._adhdVarianceTimer);
		frm._adhdVarianceTimer = setTimeout(() => applyVarianceHighlights(frm), 400);
	}

	function refresh(frm) {
		if (frappe.boot?.adhd_mode && frm.doc.docstatus === 0) scheduleVarianceCheck(frm);
		else clearVariance(frm);
	}

	if (!$("#adhd-stock-recon-styles").length) {
		$("<style>", {
			id: "adhd-stock-recon-styles",
			text: `.adhd-variance-row .data-row{background-color:rgba(255,220,0,.18)!important}
				.adhd-variance-cell{font-size:.78rem;font-weight:600;padding:4px 8px;white-space:nowrap;min-width:130px}
				.adhd-variance-banner{margin:8px 0;display:flex;align-items:center;gap:8px;border-left:4px solid var(--yellow-500)}`,
		}).appendTo("head");
	}

	frappe.ui.form.on("Stock Reconciliation", {
		refresh,
		after_save: refresh,
		after_submit: clearVariance,
	});
	frappe.ui.form.on("Stock Reconciliation Item", {
		qty: scheduleVarianceCheck,
		current_qty: scheduleVarianceCheck,
		item_code: scheduleVarianceCheck,
		warehouse: scheduleVarianceCheck,
		items_remove: scheduleVarianceCheck,
	});

	erpnext.adhd.calculateStockVariance = calculateVariance;
})();
