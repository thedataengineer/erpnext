// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
// Guided save wizard for mandatory fields in ADHD mode.

frappe.provide("erpnext.adhd");

(() => {
	const originalSave = frappe.ui.form.Form.prototype.save;
	let wizardState = null;

	function hasValue(value) {
		return value !== undefined && value !== null && value !== "";
	}

	function getMissingRequiredFields(frm) {
		return (frm.meta.fields || [])
			.filter(
				(df) =>
					df.fieldname &&
					df.reqd &&
					!df.hidden &&
					df.fieldtype !== "Table" &&
					!hasValue(frm.doc[df.fieldname]),
			)
			.map((df) => ({ fieldname: df.fieldname, label: df.label || df.fieldname }));
	}

	function cleanupWizard() {
		if (!wizardState) return;
		const { frm, input, changeHandler } = wizardState;
		if (input && changeHandler) input.removeEventListener("change", changeHandler);
		frm.layout.$wrapper.find(".adhd-wizard-banner").remove();
		wizardState = null;
	}

	function finishWizard() {
		const state = wizardState;
		if (!state) return;
		const { frm, saveArgs } = state;
		cleanupWizard();
		return originalSave.apply(frm, saveArgs);
	}

	function cancelWizard() {
		if (wizardState) wizardState.frm.__adhd_guided_save_cancelled = true;
		cleanupWizard();
	}

	function showStep() {
		if (!wizardState) return;
		const { frm, fields, index } = wizardState;
		if (index >= fields.length) {
			finishWizard();
			return;
		}

		const item = fields[index];
		const field = frm.get_field(item.fieldname);
		if (!field) {
			wizardState.index += 1;
			showStep();
			return;
		}

		if (wizardState.input && wizardState.changeHandler) {
			wizardState.input.removeEventListener("change", wizardState.changeHandler);
		}
		frm.layout.$wrapper.find(".adhd-wizard-banner").remove();

		const hint =
			window.ADHD_FIELD_HELP?.[frm.doctype]?.[item.fieldname] ||
			item.label ||
			item.fieldname;
		const $banner = $(`
			<div class="adhd-wizard-banner" role="status">
				<progress class="adhd-wizard-progress" max="${fields.length}" value="${index}"></progress>
				<strong>${__("Let's fill in the missing details — {0} of {1}", [index + 1, fields.length])}</strong>
				<div class="adhd-wizard-field">${frappe.utils.escape_html(item.label)}</div>
				<p class="adhd-wizard-hint">${frappe.utils.escape_html(hint)}</p>
				<div class="adhd-wizard-actions">
					<button type="button" class="btn btn-primary btn-xs adhd-wizard-next">${__("Next missing field →")}</button>
					<button type="button" class="btn btn-link btn-xs adhd-wizard-skip">${__("Skip this field")}</button>
					<button type="button" class="btn btn-link btn-xs adhd-wizard-cancel">${__("Cancel guided save")}</button>
				</div>
			</div>
		`);
		frm.layout.$wrapper.prepend($banner);

		const advance = () => {
			if (!wizardState) return;
			wizardState.index += 1;
			showStep();
		};
		$banner.find(".adhd-wizard-next, .adhd-wizard-skip").on("click", advance);
		$banner.find(".adhd-wizard-cancel").on("click", cancelWizard);

		const input = field.$input && field.$input[0];
		const changeHandler = () => {
			if (hasValue(frm.doc[item.fieldname])) advance();
		};
		if (input) input.addEventListener("change", changeHandler);
		wizardState.input = input;
		wizardState.changeHandler = changeHandler;

		frm.scroll_to_field(item.fieldname);
		setTimeout(() => field.$input && field.$input.trigger("focus"), 150);
	}

	function startGuidedSave(frm, fields, saveArgs) {
		cleanupWizard();
		wizardState = { frm, fields, index: 0, saveArgs, input: null, changeHandler: null };
		showStep();
	}

	frappe.ui.form.Form.prototype.save = function (...args) {
		if (!(frappe.boot && frappe.boot.adhd_mode) || this.__adhd_guided_save_cancelled) {
			return originalSave.apply(this, args);
		}
		const missing = getMissingRequiredFields(this);
		if (!missing.length) return originalSave.apply(this, args);
		startGuidedSave(this, missing, args);
		return Promise.resolve();
	};

	erpnext.adhd.getMissingRequiredFields = getMissingRequiredFields;
	erpnext.adhd.startGuidedSave = startGuidedSave;
})();
