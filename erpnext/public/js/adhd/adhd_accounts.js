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
