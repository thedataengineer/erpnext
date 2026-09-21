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

function updateJournalEntryBalanceMeter(frm) {
	const $meter = frm?.layout?.$wrapper?.find("#adhd-balance-meter");
	if (!$meter?.length) return;

	const totals = (frm.doc.accounts || []).reduce(
		(result, row) => {
			result.debit += flt(row.debit_in_account_currency);
			result.credit += flt(row.credit_in_account_currency);
			return result;
		},
		{ debit: 0, credit: 0 },
	);
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
		frm.set_indicator(__("Balanced ✓"), "green");
	} else if (difference >= 0.001 && frm.is_dirty()) {
		frm.set_indicator(__("Unbalanced"), "red");
	} else if ($difference.hasClass("adhd-balanced")) {
		frm.page?.clear_indicator?.();
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
					method:
						"erpnext.accounts.doctype.accounting_dimension.accounting_dimension.get_dimensions",
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
				position:absolute;right:4px;bottom:2px;pointer-events:none;">${__("← last used")}</span>`,
		);
		field.$input
			?.off("change.adhdLastUsed")
			.one("change.adhdLastUsed", () => $wrapper.find(".adhd-last-used-tag").remove());
	}

	async function accountingDefaultFields() {
		return ["cost_center", ...(await getActiveDimensions())];
	}

	async function prefillLastUsed(frm) {
		if (
			!isActive() ||
			!frm ||
			frm.meta?.istable === 1 ||
			frm.doc?.docstatus !== 0 ||
			!frm.is_new?.()
		) {
			return;
		}
		const fields = await accountingDefaultFields();
		await Promise.all(
			fields.map(async (fieldname) => {
				if (!Object.hasOwn(frm.fields_dict || {}, fieldname) || frm.doc[fieldname]) return;
				const last = localStorage.getItem(`adhd_last_${fieldname}`);
				if (!last) return;
				await frm.set_value(fieldname, last);
				markAsLastUsed(frm, fieldname);
			}),
		);
	}

	async function saveLastUsed(frm) {
		if (!isActive() || frm.meta?.istable === 1 || frm.doc?.__unsaved) return;
		const fields = await accountingDefaultFields();
		fields.forEach((fieldname) => {
			if (frm.doc[fieldname]) localStorage.setItem(`adhd_last_${fieldname}`, frm.doc[fieldname]);
		});
	}

	frappe.ui.form.Form.prototype.save = function (...args) {
		const result = originalSave.apply(this, args);
		if (!result?.then) return result;
		return result.then((value) => {
			saveLastUsed(this);
			return value;
		});
	};

	$(document).on("form-load.adhdLastUsed form-refresh.adhdLastUsed", (_event, frm) => {
		prefillLastUsed(frm || cur_frm);
	});
	frappe.router.on("change", () => {
		frappe.after_ajax(() => prefillLastUsed(cur_frm));
	});

	window.adhdClearLastUsedDefaults = async function () {
		const fields = await accountingDefaultFields();
		fields.forEach((fieldname) => localStorage.removeItem(`adhd_last_${fieldname}`));
		frappe.show_alert({
			message: __("ADHD cost center and dimension defaults cleared."),
			indicator: "blue",
		});
	};

	erpnext.adhd.getActiveDimensions = getActiveDimensions;
	erpnext.adhd.prefillLastUsed = prefillLastUsed;
})();
