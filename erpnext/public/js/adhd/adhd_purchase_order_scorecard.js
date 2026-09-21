// "Before you order" supplier scorecard nudge on a new Purchase Order for ADHD mode (ADHD-026).
// When a supplier is picked and its scorecard score is low, one line under the Supplier field says so. It never
// blocks anything: ERPNext's own warn/prevent rules for a Purchase Order still run when the order is saved.

frappe.provide("erpnext.adhd");

(() => {
	const PURCHASE_ORDER = "Purchase Order";
	const SCORECARD = "Supplier Scorecard";
	const BANNER_CLASS = "adhd-scorecard-nudge";
	// A score below this shows the nudge; a score equal to it does not. 50 is where ERPNext's default standings
	// move from "Poor" to "Average" (get_default_scorecard_standing in supplier_scorecard.py).
	const SCORECARD_NUDGE_THRESHOLD = 50;

	const adhdOn = () => Boolean(frappe.boot?.adhd_mode);
	const esc = (value) => frappe.utils.escape_html(String(value ?? ""));

	// Supplier Scorecard.supplier_score is a Data field holding "72.5", or nothing before the first score
	function parseScore(value) {
		if (value === null || value === undefined || String(value).trim() === "") return null;
		const score = Number.parseFloat(value);
		return Number.isFinite(score) ? score : null;
	}

	const shouldNudge = (score) => score !== null && score < SCORECARD_NUDGE_THRESHOLD;

	function removeBanner(frm) {
		// Form.$wrapper wraps the whole form (Layout has no $wrapper, only a jQuery `wrapper`)
		frm.$wrapper.find(`.${BANNER_CLASS}`).remove();
	}

	function paintBanner(frm, card) {
		// removed again right before the insert: this can run after an await, and after a refresh drew one
		removeBanner(frm);
		if (!adhdOn() || !card) return;
		const score = parseScore(card.supplier_score);
		if (!shouldNudge(score)) return;
		const $field = frm.fields_dict?.supplier?.$wrapper;
		if (!$field?.length) return;

		const shown = Number(score.toFixed(1));
		const standing = card.status ? ` (${esc(card.status)})` : "";
		const link = frappe.utils.get_form_link(SCORECARD, frm.doc.supplier);
		$field.after(`
			<div class="${BANNER_CLASS}" role="status">
				<span class="adhd-scorecard-icon" aria-hidden="true">⚠</span>
				<span class="adhd-scorecard-text">${__(
					"{0} has a supplier score of {1}/100{2}. Worth a look before you order.",
					[`<strong>${esc(frm.doc.supplier)}</strong>`, `<strong>${esc(shown)}</strong>`, standing]
				)}</span>
				<a class="adhd-scorecard-link" href="${esc(link)}" target="_blank" rel="noopener">${esc(
			__("View scorecard")
		)} ↗</a>
			</div>`);
	}

	// One read of the scorecard, which is named after its supplier. It needs read permission on Supplier
	// Scorecard (System Manager only unless a role was added), so a user without it is not asked at all
	// rather than being shown a "Not permitted" dialog for a hint. A missing scorecard, or any failure, is
	// simply "no nudge".
	async function readScorecard(supplier) {
		if (!frappe.model.can_read(SCORECARD)) return null;
		try {
			const response = await frappe.call({
				method: "frappe.client.get_value",
				type: "GET",
				args: { doctype: SCORECARD, filters: { supplier }, fieldname: ["supplier_score", "status"] },
				silent: true,
			});
			return response?.message || null;
		} catch {
			return null;
		}
	}

	// A form is reused for every new Purchase Order, so what was asked is remembered per document and supplier.
	const requestKey = (frm) => `${frm.docname}::${frm.doc.supplier}`;

	function forget(frm) {
		frm._adhdScorecard = null;
		removeBanner(frm);
	}

	async function syncNudge(frm) {
		if (frm.doctype !== PURCHASE_ORDER || !frm.doc) return;
		if (!adhdOn() || !frm.doc.supplier || !frm.is_new()) {
			// with the mode off nothing was ever added, so there is nothing to touch
			if (frm._adhdScorecard) forget(frm);
			return;
		}

		const key = requestKey(frm);
		if (frm._adhdScorecard?.key === key) {
			// refresh fires all the time: redraw from what is already known, never ask again
			if (frm._adhdScorecard.settled) paintBanner(frm, frm._adhdScorecard.card);
			return;
		}
		removeBanner(frm);
		const entry = { key, settled: false, card: null };
		frm._adhdScorecard = entry;

		const card = await readScorecard(frm.doc.supplier);
		// the supplier was changed or cleared, the order saved, or the mode switched off, while waiting
		if (frm._adhdScorecard !== entry || !adhdOn()) return;
		entry.settled = true;
		entry.card = card;
		paintBanner(frm, card);
	}

	frappe.ui.form.on(PURCHASE_ORDER, { supplier: syncNudge, refresh: syncNudge });
	erpnext.adhd.onStateChange?.(() => {
		const frm = window.cur_frm;
		if (frm?.doctype === PURCHASE_ORDER && frm.doc) syncNudge(frm);
	});

	erpnext.adhd.SCORECARD_NUDGE_THRESHOLD = SCORECARD_NUDGE_THRESHOLD;
	erpnext.adhd.shouldNudgeForScore = shouldNudge;
	erpnext.adhd.parseSupplierScore = parseScore;
	erpnext.adhd.syncScorecardNudge = syncNudge;
})();
