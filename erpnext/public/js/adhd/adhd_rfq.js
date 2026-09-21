// Request for Quotation "Compare Responses" for ADHD mode (ADHD-025).
// Every Supplier Quotation for the RFQ in one table, item by item, so nothing has to be held in mind while the
// quotations are opened one after another.

frappe.provide("erpnext.adhd");

(() => {
	const RFQ_DOCTYPE = "Request for Quotation";
	const COMPARE_METHOD = "erpnext.buying.services.adhd_rfq_compare.get_rfq_supplier_comparison";
	const COMPARISON_REPORT = "Supplier Quotation Comparison";
	// prices are ranked on the server's six-decimal company-currency rate; differences below that are ties
	const RATE_DECIMALS = 6;

	const adhdOn = () => Boolean(frappe.boot?.adhd_mode);
	const esc = (value) => frappe.utils.escape_html(String(value ?? ""));
	const comparable = (value) => Number(flt(value).toFixed(RATE_DECIMALS));

	// For each RFQ item, the quotations whose company-currency price per stock unit is the lowest.
	// Every quotation tied for the lowest wins. Nothing is marked when fewer than two quotations priced the
	// item, or when they all priced it the same: there is nothing to point out then. An unpriced row (0) and a
	// missing row never win.
	function lowestRateByItem(data) {
		const winners = {};
		(data.items || []).forEach((item) => {
			const priced = (data.quotations || [])
				.filter((quotation) => flt(quotation.rates?.[item.name]?.unit_base_rate) > 0)
				.map((quotation) => ({
					name: quotation.name,
					rate: comparable(quotation.rates[item.name].unit_base_rate),
				}));
			if (priced.length < 2) return;
			const lowest = Math.min(...priced.map((entry) => entry.rate));
			if (lowest === Math.max(...priced.map((entry) => entry.rate))) return;
			winners[item.name] = new Set(
				priced.filter((entry) => entry.rate === lowest).map((entry) => entry.name)
			);
		});
		return winners;
	}

	// Totals are only comparable between quotations that priced every RFQ item: a quotation that left items
	// out is cheap because of what it leaves out.
	function lowestTotal(data) {
		const itemCount = (data.items || []).length;
		const complete = (data.quotations || []).filter(
			(quotation) => itemCount && quotation.quoted === itemCount && flt(quotation.base_grand_total) > 0
		);
		if (complete.length < 2) return new Set();
		const totals = complete.map((quotation) => comparable(quotation.base_grand_total));
		const lowest = Math.min(...totals);
		if (lowest === Math.max(...totals)) return new Set();
		return new Set(
			complete
				.filter((quotation) => comparable(quotation.base_grand_total) === lowest)
				.map((quotation) => quotation.name)
		);
	}

	const star = () =>
		`<span class="adhd-rfq-star" role="img" aria-label="${esc(__("Lowest price"))}" title="${esc(
			__("Lowest price")
		)}">★</span> `;

	function itemCell(item) {
		const name =
			item.item_name && item.item_name !== item.item_code
				? `<div class="adhd-rfq-item-name text-muted">${esc(item.item_name)}</div>`
				: "";
		return `<th scope="row" class="adhd-rfq-item">
			<div>${esc(item.item_code)}</div>${name}
			<div class="adhd-rfq-uom">${esc(__("Qty"))} ${esc(format_number(flt(item.qty)))} ${esc(item.uom)}</div>
		</th>`;
	}

	function rateCell(data, quotation, item, winners) {
		const rate = quotation.rates?.[item.name];
		if (!rate) return `<td class="adhd-rfq-missing text-muted">—</td>`;
		const best = Boolean(winners[item.name]?.has(quotation.name));
		const foreign = quotation.currency && quotation.currency !== data.company_currency;
		const converted = foreign
			? `<div class="adhd-rfq-base text-muted">${esc(
					format_currency(rate.base_rate, data.company_currency)
			  )}</div>`
			: "";
		const uom = rate.uom ? ` <span class="adhd-rfq-uom">/ ${esc(rate.uom)}</span>` : "";
		return `<td class="${best ? "adhd-rfq-best" : ""}">${best ? star() : ""}${esc(
			format_currency(rate.rate, quotation.currency)
		)}${uom}${converted}</td>`;
	}

	function totalCell(data, quotation, lowest) {
		const best = lowest.has(quotation.name);
		const foreign = quotation.currency && quotation.currency !== data.company_currency;
		const converted = foreign
			? `<div class="adhd-rfq-base text-muted">${esc(
					format_currency(quotation.base_grand_total, data.company_currency)
			  )}</div>`
			: "";
		return `<td class="${best ? "adhd-rfq-best" : ""}">${best ? star() : ""}${esc(
			format_currency(quotation.grand_total, quotation.currency)
		)}${converted}</td>`;
	}

	function validTillCell(quotation) {
		const date = quotation.valid_till ? esc(frappe.datetime.str_to_user(quotation.valid_till)) : "—";
		const expired = quotation.expired
			? ` <span class="adhd-rfq-expired">${esc(__("Expired"))}</span>`
			: "";
		return `<td>${date}${expired}</td>`;
	}

	function headerCell(quotation) {
		return `<th scope="col" class="adhd-rfq-col">
			<div class="adhd-rfq-supplier">${esc(quotation.supplier_name || quotation.supplier)}</div>
			<div class="adhd-rfq-quote-id text-muted">${esc(quotation.name)}</div>
			<div class="adhd-rfq-status">${esc(__(quotation.status || ""))}</div>
		</th>`;
	}

	function notesHtml(data) {
		const notes = [
			__(
				"Rates are shown in each quotation's own currency. The lowest price is chosen after converting to {0}, per stock unit.",
				[esc(data.company_currency)]
			),
		];
		if (data.truncated?.quotations) {
			notes.push(
				__("Only the {0} most recent quotations are shown. The full report has the rest.", [
					(data.quotations || []).length,
				])
			);
		}
		if (data.truncated?.items) {
			notes.push(__("This Request for Quotation has more items than are shown here."));
		}
		const awaiting = (data.awaiting_suppliers || []).map((row) => esc(row.supplier_name || row.supplier));
		if (awaiting.length) notes.push(__("Still waiting for: {0}", [awaiting.join(", ")]));
		return notes.map((note) => `<p class="adhd-rfq-note">${note}</p>`).join("");
	}

	// The whole modal body. Everything that comes from data goes through esc().
	function buildComparisonHtml(data) {
		const items = data.items || [];
		const quotations = data.quotations || [];
		const winners = lowestRateByItem(data);
		const lowest = lowestTotal(data);
		const cells = (build) => quotations.map(build).join("");

		const itemRows = items
			.map(
				(item) =>
					`<tr>${itemCell(item)}${cells((quotation) =>
						rateCell(data, quotation, item, winners)
					)}</tr>`
			)
			.join("");
		const summaryRows = [
			[__("Total"), cells((quotation) => totalCell(data, quotation, lowest))],
			[__("Items quoted"), cells((quotation) => `<td>${esc(quotation.quoted)} / ${items.length}</td>`)],
			[__("Valid till"), cells(validTillCell)],
			[
				__("Payment terms (supplier default)"),
				cells((quotation) => `<td>${esc(quotation.payment_terms || "—")}</td>`),
			],
			[
				"",
				cells(
					(quotation) => `<td><button type="button" class="btn btn-xs btn-primary adhd-rfq-select"
						data-quotation="${esc(quotation.name)}"
						title="${esc(__("Open this Supplier Quotation"))}">${esc(__("Select"))} →</button></td>`
				),
			],
		]
			.map(
				([label, row]) => `<tr class="adhd-rfq-summary"><th scope="row">${esc(label)}</th>${row}</tr>`
			)
			.join("");

		return `<div class="adhd-rfq-compare">
			${notesHtml(data)}
			<div class="adhd-rfq-scroll">
				<table class="adhd-rfq-table table table-bordered">
					<thead><tr><th scope="col">${esc(__("Item"))}</th>${cells(headerCell)}</tr></thead>
					<tbody>${itemRows}${summaryRows}</tbody>
				</table>
			</div>
		</div>`;
	}

	function showEmpty(frm, data) {
		const awaiting = (data.awaiting_suppliers || []).map((row) => esc(row.supplier_name || row.supplier));
		const waiting = awaiting.length
			? `<p>${__("Still waiting for: {0}", [awaiting.join(", ")])}</p>`
			: "";
		frappe.msgprint({
			title: __("Compare Responses"),
			indicator: "blue",
			message: `<p>${__("No Supplier Quotations have been made for {0} yet.", [
				esc(frm.doc.name),
			])}</p>${waiting}`,
		});
	}

	function showComparison(frm, data) {
		// a second dialog on top of the first would leave two tables that disagree with each other
		frm._adhdRfqDialog?.hide?.();
		const dialog = new frappe.ui.Dialog({
			title: __("Supplier responses — {0}", [esc(frm.doc.name)]),
			size: "extra-large",
			fields: [{ fieldtype: "HTML", fieldname: "comparison" }],
			secondary_action_label: __("Open comparison report"),
			secondary_action: () => {
				dialog.hide();
				frappe.set_route("query-report", COMPARISON_REPORT, data.report_filters || {});
			},
		});
		dialog.fields_dict.comparison.$wrapper.html(buildComparisonHtml(data));
		// "Select" is the standard flow: open the quotation and let its own Create menu make the Purchase Order
		dialog.$wrapper.on("click", ".adhd-rfq-select", (event) => {
			const quotation = event.currentTarget.dataset.quotation;
			dialog.hide();
			frappe.set_route("Form", "Supplier Quotation", quotation);
		});
		frm._adhdRfqDialog = dialog;
		dialog.show();
	}

	async function openComparison(frm) {
		if (!adhdOn() || frm._adhdRfqLoading) return;
		// a double click must not load and open the comparison twice
		frm._adhdRfqLoading = true;
		let data;
		try {
			const response = await frappe.call({
				method: COMPARE_METHOD,
				args: { rfq_name: frm.doc.name },
				freeze: true,
				freeze_message: __("Loading supplier responses…"),
			});
			data = response?.message;
		} catch {
			// a failed load already showed Frappe's own error dialog
			return;
		} finally {
			frm._adhdRfqLoading = false;
		}
		// ADHD mode may have been switched off while the request was out
		if (!adhdOn() || !data) return;
		if (!(data.quotations || []).length) return showEmpty(frm, data);
		showComparison(frm, data);
	}

	// Frappe rebuilds the form's buttons on every refresh, so this adds the button when it should be there.
	// It also runs when the mode is switched on or off with the form open, so it removes it as well.
	function syncCompareButton(frm) {
		if (frm.doctype !== RFQ_DOCTYPE || !frm.doc) return;
		const label = __("Compare Responses");
		const group = __("ADHD");
		const wanted = adhdOn() && cint(frm.doc.docstatus) === 1;
		const present = Boolean(frm.custom_buttons?.[label]);
		if (wanted && !present) {
			frm.add_custom_button(label, () => openComparison(frm), group);
		} else if (!wanted && present) {
			frm.remove_custom_button(label, group);
			frm._adhdRfqDialog?.hide?.();
		}
	}

	frappe.ui.form.on(RFQ_DOCTYPE, { refresh: syncCompareButton });
	erpnext.adhd.onStateChange?.(() => {
		const frm = window.cur_frm;
		if (frm?.doctype === RFQ_DOCTYPE && frm.doc) syncCompareButton(frm);
	});

	erpnext.adhd.lowestRateByItem = lowestRateByItem;
	erpnext.adhd.lowestTotal = lowestTotal;
	erpnext.adhd.buildRfqComparisonHtml = buildComparisonHtml;
	erpnext.adhd.openRfqComparison = openComparison;
	erpnext.adhd.syncRfqCompareButton = syncCompareButton;
})();
