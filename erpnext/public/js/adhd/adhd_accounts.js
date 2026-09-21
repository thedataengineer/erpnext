// Journal Entry balance feedback for ADHD mode.

frappe.provide("erpnext.adhd");

function isBalanceMeterEnabled() {
	const modeActive = erpnext.adhd?.isActive?.() || window.ADHDMode?.isActive?.();
	const settingActive = !window.ADHDSettings || window.ADHDSettings.get("balance_meter");
	return modeActive && settingActive;
}

function removeJournalEntryBalanceMeter(frm) {
	const field = frm?.get_field?.("accounts");
	field?.grid?.wrapper?.off(".adhdBalanceMeter");
	frm?.layout?.$wrapper?.find("#adhd-balance-meter").remove();
}

// The server balances a Journal Entry on the company-currency amounts (debit/credit), not on the
// *_in_account_currency ones, so a multi-currency entry must be summed the same way.
function getJournalEntryTotals(rows) {
	return (rows || []).reduce(
		(result, row) => {
			result.debit += flt(row.debit);
			result.credit += flt(row.credit);
			return result;
		},
		{ debit: 0, credit: 0 }
	);
}

// set_indicator belongs to the page (frm.page), not the form, and the verdict only means
// something while the entry can still be edited.
function setBalanceIndicator(frm, label, color) {
	if (frm.doc.docstatus !== 0) return;
	frm.page?.set_indicator?.(label, color);
}

function updateJournalEntryBalanceMeter(frm) {
	const $meter = frm?.layout?.$wrapper?.find("#adhd-balance-meter");
	if (!$meter?.length) return;

	const totals = getJournalEntryTotals(frm.doc.accounts);
	const difference = Math.abs(totals.debit - totals.credit);
	const currency = frm.doc.company_currency || erpnext.get_currency?.(frm.doc.company);
	const format = (value) => format_currency(value, currency);

	$meter.find("#adhd-debit-total").text(__("Debit: {0}", [format(totals.debit)]));
	$meter.find("#adhd-credit-total").text(__("Credit: {0}", [format(totals.credit)]));
	const $difference = $meter
		.find("#adhd-difference")
		.text(__("Difference: {0}", [format(difference)]))
		.toggleClass("adhd-balanced", difference < 0.001)
		.toggleClass("adhd-unbalanced", difference >= 0.001);

	if (difference < 0.001 && (totals.debit || totals.credit)) {
		setBalanceIndicator(frm, __("Balanced ✓"), "green");
	} else if (difference >= 0.001 && frm.is_dirty()) {
		setBalanceIndicator(frm, __("Unbalanced"), "red");
	} else if ($difference.hasClass("adhd-balanced") && frm.doc.docstatus === 0) {
		// nothing to judge yet: give the header back to the standard Draft / Not Saved indicator
		frm.toolbar?.set_indicator?.();
	}
}

function initJournalEntryBalanceMeter(frm) {
	removeJournalEntryBalanceMeter(frm);
	if (!isBalanceMeterEnabled() || frm.doctype !== "Journal Entry") return;

	const field = frm.get_field("accounts");
	if (!field?.wrapper || !field.grid?.wrapper) return;
	$(field.wrapper).after(`
		<div id="adhd-balance-meter" class="adhd-balance-meter" role="status" aria-live="polite">
			<span id="adhd-debit-total">${__("Debit: {0}", [format_currency(0, frm.doc.company_currency)])}</span>
			<span id="adhd-credit-total">${__("Credit: {0}", [format_currency(0, frm.doc.company_currency)])}</span>
			<span id="adhd-difference">${__("Difference: {0}", [format_currency(0, frm.doc.company_currency)])}</span>
		</div>
	`);

	const update = frappe.utils.debounce(() => updateJournalEntryBalanceMeter(frm), 150);
	field.grid.wrapper.on("change.adhdBalanceMeter", "input, select", update);
	frm._adhdUpdateBalanceMeter = update;
	updateJournalEntryBalanceMeter(frm);
}

// debit/credit are recalculated from the account-currency amounts and the exchange rate, which for a
// foreign-currency row happens after a server round trip, so refresh the meter when they change too.
frappe.ui.form.on("Journal Entry Account", {
	debit(frm) {
		frm._adhdUpdateBalanceMeter?.();
	},
	credit(frm) {
		frm._adhdUpdateBalanceMeter?.();
	},
});

erpnext.adhd.getJournalEntryTotals = getJournalEntryTotals;
erpnext.adhd.initJournalEntryBalanceMeter = initJournalEntryBalanceMeter;
erpnext.adhd.updateJournalEntryBalanceMeter = updateJournalEntryBalanceMeter;
erpnext.adhd.removeJournalEntryBalanceMeter = removeJournalEntryBalanceMeter;

// Last-used Cost Center and Accounting Dimension defaults.
(() => {
	let dimensionsPromise = null;
	const originalSave = frappe.ui.form.Form.prototype.save;

	function isActive() {
		return Boolean(frappe.boot?.adhd_mode);
	}

	function getActiveDimensions() {
		if (!dimensionsPromise) {
			dimensionsPromise = frappe
				.call({
					method: "erpnext.accounts.doctype.accounting_dimension.accounting_dimension.get_dimensions",
				})
				.then((response) => (response.message?.[0] || []).map((dimension) => dimension.fieldname))
				.catch((error) => {
					dimensionsPromise = null;
					throw error;
				});
		}
		return dimensionsPromise;
	}

	function markAsLastUsed(frm, fieldname) {
		const field = frm.fields_dict[fieldname];
		const $wrapper = $(field?.wrapper);
		if (!$wrapper.length) return;
		$wrapper.find(".adhd-last-used-tag").remove();
		$wrapper.css("position", "relative").append(
			`<span class="adhd-last-used-tag" style="font-size:.65rem;color:var(--text-muted);
				position:absolute;right:4px;bottom:2px;pointer-events:none;">${__("← last used")}</span>`
		);
		field.$input
			?.off("change.adhdLastUsed")
			.one("change.adhdLastUsed", () => $wrapper.find(".adhd-last-used-tag").remove());
	}

	async function accountingDefaultFields() {
		return ["cost_center", ...(await getActiveDimensions())];
	}

	// A cost center (and most dimensions) belongs to one company, so the last-used value is kept per
	// company; a single shared value fails link validation as soon as the user switches company.
	function lastUsedKey(frm, fieldname) {
		return `adhd_last_${fieldname}::${frm.doc?.company || ""}`;
	}

	async function prefillLastUsed(frm) {
		if (!isActive() || !frm || frm.meta?.istable === 1 || frm.doc?.docstatus !== 0 || !frm.is_new?.()) {
			return;
		}
		const fields = await accountingDefaultFields();
		await Promise.all(
			fields.map(async (fieldname) => {
				if (!Object.hasOwn(frm.fields_dict || {}, fieldname) || frm.doc[fieldname]) return;
				const last = localStorage.getItem(lastUsedKey(frm, fieldname));
				if (!last) return;
				await frm.set_value(fieldname, last);
				markAsLastUsed(frm, fieldname);
			})
		);
	}

	async function saveLastUsed(frm) {
		if (!isActive() || frm.meta?.istable === 1 || frm.doc?.__unsaved) return;
		const fields = await accountingDefaultFields();
		fields.forEach((fieldname) => {
			if (frm.doc[fieldname]) localStorage.setItem(lastUsedKey(frm, fieldname), frm.doc[fieldname]);
		});
	}

	frappe.ui.form.Form.prototype.save = function (...args) {
		const result = originalSave.apply(this, args);
		if (!isActive() || !result?.then) return result;
		return result.then((value) => {
			// remembering a default must never break or fail a save
			saveLastUsed(this).catch((error) => console.warn("[ADHD] Could not remember defaults", error));
			return value;
		});
	};

	const quietly = (promise) =>
		promise?.catch((error) => console.warn("[ADHD] Could not prefill defaults", error));

	$(document).on("form-load.adhdLastUsed form-refresh.adhdLastUsed", (_event, frm) => {
		quietly(prefillLastUsed(frm || cur_frm));
	});
	frappe.router.on("change", () => {
		frappe.after_ajax(() => quietly(prefillLastUsed(cur_frm)));
	});

	window.adhdClearLastUsedDefaults = async function () {
		const fields = await accountingDefaultFields();
		// every company's value, plus the company-less key older versions wrote
		Object.keys(localStorage)
			.filter((key) =>
				fields.some(
					(fieldname) =>
						key === `adhd_last_${fieldname}` || key.startsWith(`adhd_last_${fieldname}::`)
				)
			)
			.forEach((key) => localStorage.removeItem(key));
		frappe.show_alert({
			message: __("ADHD cost center and dimension defaults cleared."),
			indicator: "blue",
		});
	};

	erpnext.adhd.getActiveDimensions = getActiveDimensions;
	erpnext.adhd.prefillLastUsed = prefillLastUsed;
})();
