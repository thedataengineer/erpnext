// ADHD-028: Purchase Invoice three-way match badge.
//
// ERPNext refuses an over-billed invoice when it is saved or submitted, after all the typing is done. In ADHD
// mode a colour-coded badge next to Grand Total shows, while the invoice is still a draft, how what it bills
// compares with what its Purchase Orders and Purchase Receipts still had open. It never blocks anything.
//
// The invoice is linked to its Purchase Order and Receipt on the item rows (po_detail / pr_detail), not on the
// header, and it can span several of each, so the server compares every referenced row in the invoice's own
// currency and returns one status per referenced document. The rules it applies are the ones ERPNext applies
// itself (see erpnext/accounts/services/adhd_three_way_match.py), so green never means "submit will throw" and
// red never means "the system accepts it".

frappe.provide("erpnext.adhd");

(() => {
	// The mode can be switched on or off after this file loads, so every handler checks it when it runs.
	const adhdOn = () => Boolean(frappe.boot && frappe.boot.adhd_mode);
	const esc = (value) => frappe.utils.escape_html(String(value ?? ""));

	const METHOD = "erpnext.accounts.services.adhd_three_way_match.get_three_way_match";
	const DEBOUNCE_MS = 500;
	// the server refuses to check more rows than this
	const MAX_ROWS = 300;

	// Item-row events that can change what is compared: the amounts a row bills and the references it holds.
	// `amount` is worked out by ERPNext from qty and rate after these fire, which is why the check is debounced.
	const ITEM_EVENTS = [
		"item_code",
		"qty",
		"rate",
		"price_list_rate",
		"discount_percentage",
		"discount_amount",
		"uom",
		"conversion_factor",
		"amount",
		"purchase_order",
		"po_detail",
		"purchase_receipt",
		"pr_detail",
		// Grid.js triggers "<table>_remove" on the child doctype, after the row is gone
		"items_remove",
	];

	// forms that hold a pending check or a badge, so switching the mode off can clean every one of them
	const tracked = new Set();

	const isDraft = (frm) => cint(frm?.doc?.docstatus) === 0;

	// ---- inputs ---------------------------------------------------------------------------------------------

	// Only the rows that point at a Purchase Order or Receipt row are compared. Returns null when there is
	// nothing to compare, which is also the case for a return (debit note): ERPNext skips these checks for it.
	function collectMatchInputs(frm) {
		const doc = frm.doc || {};
		if (cint(doc.is_return)) return null;
		const rows = (doc.items || [])
			.filter((row) => row.po_detail || row.pr_detail)
			.map((row) => ({
				idx: cint(row.idx),
				item_code: row.item_code || "",
				purchase_order: row.purchase_order || "",
				po_detail: row.po_detail || "",
				purchase_receipt: row.purchase_receipt || "",
				pr_detail: row.pr_detail || "",
				rate: flt(row.rate),
				amount: flt(row.amount),
			}));
		if (!rows.length || rows.length > MAX_ROWS) return null;
		return {
			items: rows,
			currency: doc.currency || "",
			is_internal_supplier: cint(doc.is_internal_supplier),
		};
	}

	// What a check depends on. The server is only asked again when this changes, so events that touch nothing
	// relevant (a totals recalculation, a refresh, a tax edit) cost nothing.
	const inputSignature = (inputs) => JSON.stringify(inputs);

	// ---- view -----------------------------------------------------------------------------------------------

	// What a problem reads as. `short` is the badge's own words, `long` the line under it.
	const REASONS = {
		over_billed: {
			short: (money) => __("Over by {0}", [money]),
			long: (money) => __("Over-billed by {0}; submit will be refused", [money]),
		},
		over_allowed: {
			short: (money) => __("Over by {0}", [money]),
			long: (money) => __("Over by {0}, but your role or the settings allow it", [money]),
		},
		within_allowance: {
			short: (money) => __("Over by {0}", [money]),
			long: (money) => __("Over by {0}, within the over-billing allowance", [money]),
		},
		rate: {
			short: () => __("Rate differs"),
			long: () => __("Rate differs from the reference; submit will be refused"),
		},
		rate_warned: {
			short: () => __("Rate differs"),
			long: () => __("Rate differs from the reference (a warning only)"),
		},
		currency: {
			short: () => __("Currency differs"),
			long: () => __("Currency differs from this invoice's; submit will be refused"),
		},
		not_submitted: {
			short: () => __("Not submitted"),
			long: () => __("Not submitted; submit will be refused"),
		},
		status: {
			short: () => __("Closed or on hold"),
			long: () => __("Closed or on hold; submit will be refused"),
		},
		closed_row: {
			short: () => __("Row closed"),
			long: () => __("The row is closed; submit will be refused"),
		},
	};

	// the problems the server counts as ones that make ERPNext refuse the invoice
	const BLOCKING = new Set(["over_billed", "rate", "currency", "not_submitted", "status", "closed_row"]);

	const STATES = {
		match: { css: "green", icon: "✓", label: () => __("Matched") },
		within_tolerance: { css: "orange", icon: "⚠", label: () => __("Within tolerance") },
		over: { css: "red", icon: "✗", label: () => __("Mismatch") },
	};

	// Turns the server's answer into the words and colour of the badge. Plain data, so it can be tested.
	function describeMatch(result, fallbackCurrency) {
		const state = STATES[result?.status];
		if (!state || !result.references?.length) return null;
		const currency = result.currency || fallbackCurrency;
		// a problem about a whole document (currency, closed) has no amount to show
		const money = (value) =>
			value === undefined || value === null ? "" : format_currency(value, currency);

		const references = result.references.map((reference) => {
			const sentences = (reference.issues || [])
				.filter((issue) => REASONS[issue.reason])
				.map((issue) => {
					const text = REASONS[issue.reason].long(money(issue.amount));
					return issue.idx ? __("Row {0}: {1}", [issue.idx, text]) : text;
				});
			if (!sentences.length) {
				sentences.push(
					__("Bills {0} of the {1} still open", [
						money(reference.this_invoice),
						money(reference.open_amount),
					])
				);
				if (flt(reference.remaining_after) > 0) {
					sentences.push(__("{0} would still be left to bill", [money(reference.remaining_after)]));
				}
			}
			return { doctype: reference.doctype, name: reference.name, status: reference.status, sentences };
		});

		// what the badge itself says: the first problem, and for a red badge the first one that makes it red
		const totals = result.totals || {};
		let detail = "";
		const firstIssue = result.references
			.flatMap((reference) => reference.issues || [])
			.filter((issue) => REASONS[issue.reason])
			.find((issue) => result.status !== "over" || BLOCKING.has(issue.reason));
		if (result.status === "match") {
			if (flt(totals.remaining_after) > 0)
				detail = __("{0} still open", [money(totals.remaining_after)]);
		} else if (firstIssue) {
			detail = REASONS[firstIssue.reason].short(money(firstIssue.amount));
		}

		const notes = [];
		if (cint(result.unreadable_rows)) {
			notes.push(
				__("{0} row(s) point at documents you cannot read and were not checked.", [
					cint(result.unreadable_rows),
				])
			);
		}
		return {
			css: state.css,
			icon: state.icon,
			label: state.label(),
			detail,
			references,
			notes,
			currencyNote: currency ? __("Compared in {0}, the invoice's currency.", [currency]) : "",
		};
	}

	function buildMatchBadgeHtml(result, fallbackCurrency) {
		const view = describeMatch(result, fallbackCurrency);
		if (!view) return "";

		const headline = `${view.icon} ${view.label}${view.detail ? ` · ${view.detail}` : ""}`;
		const lines = view.references.map(
			(reference) => `${__(reference.doctype)} ${reference.name}: ${reference.sentences.join("; ")}`
		);
		const tooltip = [headline, ...lines, ...view.notes, view.currencyNote].filter(Boolean).join("\n");

		// under the badge, but only when there is something to act on; a match needs no explanation
		const list =
			result.status === "match" && !view.notes.length
				? ""
				: `<ul class="adhd-match-lines">${view.references
						.map(
							(reference) =>
								`<li>${esc(__(reference.doctype))} ${frappe.utils.get_form_link(
									reference.doctype,
									reference.name,
									true
								)}: ${esc(reference.sentences.join("; "))}</li>`
						)
						.concat(view.notes.map((note) => `<li>${esc(note)}</li>`))
						.join("")}</ul>`;

		return `<div class="adhd-match" role="status" aria-live="polite" aria-label="${esc(
			__("Three-way match status")
		)}">
			<span class="indicator-pill ${view.css} adhd-match-badge" title="${esc(tooltip)}">${esc(headline)}</span>
			${list}
		</div>`;
	}

	// ---- badge ----------------------------------------------------------------------------------------------

	const removeBadge = (frm) => $(frm.wrapper).find(".adhd-match").remove();

	function renderBadge(frm, result) {
		// Nothing above may leave two badges behind: this is also reached after an await, when a newer check
		// or a refresh can already have put one there.
		removeBadge(frm);
		if (!adhdOn() || !isDraft(frm) || !result) return;
		const html = buildMatchBadgeHtml(result, frm.doc.currency);
		const $target = $(frm.fields_dict?.grand_total?.wrapper);
		if (!html || !$target.length) return;
		$target.append(html);
	}

	// Stops everything this feature has going for a form: a pending check, an answer still on its way, the badge.
	function forget(frm) {
		frm._adhdMatchCheck?.cancel?.();
		frm._adhdMatchSeq = (frm._adhdMatchSeq || 0) + 1;
		frm._adhdMatchLast = null;
		removeBadge(frm);
		tracked.delete(frm);
	}

	// ---- checking -------------------------------------------------------------------------------------------

	async function checkMatch(frm) {
		if (!adhdOn() || !isDraft(frm)) return;
		const inputs = collectMatchInputs(frm);
		if (!inputs) {
			// nothing to compare (no reference any more, or a return): no badge and no request
			frm._adhdMatchLast = null;
			removeBadge(frm);
			return;
		}

		const signature = inputSignature(inputs);
		if (frm._adhdMatchLast?.signature === signature) {
			renderBadge(frm, frm._adhdMatchLast.result);
			return;
		}

		frm._adhdMatchSeq = (frm._adhdMatchSeq || 0) + 1;
		const seq = frm._adhdMatchSeq;
		let response;
		try {
			response = await frappe.call({
				method: METHOD,
				args: inputs,
				// silent: a user who may not read these documents must not get a dialog for a badge
				silent: true,
				no_spinner: true,
			});
		} catch {
			// no answer means no badge; the form works exactly as it does without the mode
			if (adhdOn() && seq === frm._adhdMatchSeq) removeBadge(frm);
			return;
		}

		// The form can have moved on while the request was out: the mode switched off, the invoice submitted,
		// a newer check started, or the rows edited again (the edit's own check is already on its way).
		if (seq !== frm._adhdMatchSeq || !adhdOn() || !isDraft(frm)) return;
		const now = collectMatchInputs(frm);
		if (!now || inputSignature(now) !== signature) return;

		frm._adhdMatchLast = { signature, result: response?.message || null };
		renderBadge(frm, frm._adhdMatchLast.result);
	}

	// A refresh may have rebuilt the form, so it shows the last answer again if the rows are unchanged,
	// and asks the server only when they are not.
	function showMatch(frm) {
		if (!adhdOn()) return;
		if (!isDraft(frm)) {
			forget(frm);
			return;
		}
		tracked.add(frm);
		const inputs = collectMatchInputs(frm);
		if (!inputs) {
			frm._adhdMatchLast = null;
			removeBadge(frm);
			return;
		}
		if (frm._adhdMatchLast?.signature === inputSignature(inputs)) {
			renderBadge(frm, frm._adhdMatchLast.result);
			return;
		}
		scheduleMatch(frm);
	}

	function scheduleMatch(frm) {
		if (!adhdOn() || frm?.doctype !== "Purchase Invoice" || !isDraft(frm)) return;
		tracked.add(frm);
		if (!frm._adhdMatchCheck) {
			frm._adhdMatchCheck = frappe.utils.debounce(() => checkMatch(frm), DEBOUNCE_MS);
		}
		frm._adhdMatchCheck();
	}

	const eventHandlers = Object.fromEntries(ITEM_EVENTS.map((name) => [name, scheduleMatch]));

	frappe.ui.form.on("Purchase Invoice", {
		refresh: showMatch,
		currency: scheduleMatch,
		is_return: scheduleMatch,
		is_internal_supplier: scheduleMatch,
		// the ticket's own trigger: the net total moves when rows are added, removed or repriced
		net_total: scheduleMatch,
	});
	frappe.ui.form.on("Purchase Invoice Item", eventHandlers);

	// Switching the mode off clears every form's badge and pending check at once; switching it on shows the
	// badge on the invoice that is already open.
	erpnext.adhd.onStateChange?.((active) => {
		if (!active) {
			[...tracked].forEach(forget);
			return;
		}
		const frm = window.cur_frm;
		if (frm?.doctype === "Purchase Invoice") showMatch(frm);
	});

	erpnext.adhd.collectMatchInputs = collectMatchInputs;
	erpnext.adhd.describeMatch = describeMatch;
	erpnext.adhd.buildMatchBadgeHtml = buildMatchBadgeHtml;
})();
