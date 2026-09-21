// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
// Guided save wizard for mandatory fields in ADHD mode.

frappe.provide("erpnext.adhd");

(() => {
	const originalSave = frappe.ui.form.Form.prototype.save;
	let wizardState = null;

	// The guided save is the "Mandatory Field Wizard" switch in ADHD Settings. Without that module it stays
	// as it was.
	function isWizardSettingOn() {
		const settings = erpnext.adhd.ADHDSettings || window.ADHDSettings;
		return !settings || Boolean(settings.get("mandatory_wizard"));
	}

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
					!hasValue(frm.doc[df.fieldname])
			)
			.map((df) => ({ fieldname: df.fieldname, label: df.label || df.fieldname }));
	}

	// A cancel only holds while the same fields are still missing
	function missingSignature(fields) {
		return fields.map((item) => item.fieldname).join(",");
	}

	function cleanupWizard() {
		if (!wizardState) return;
		const { frm, input, changeHandler } = wizardState;
		if (input && changeHandler) input.removeEventListener("change", changeHandler);
		frm.layout.wrapper.find(".adhd-wizard-banner").remove();
		wizardState = null;
	}

	// The promise handed to whoever called save() settles with the real save
	function finishWizard() {
		const state = wizardState;
		if (!state) return;
		const { frm, saveArgs, settle } = state;
		cleanupWizard();
		const saved = Promise.resolve(originalSave.apply(frm, saveArgs));
		if (settle) saved.then(settle.resolve, settle.reject);
		return saved;
	}

	function cancelWizard() {
		const state = wizardState;
		if (!state) return;
		state.frm.__adhd_guided_save_cancelled = missingSignature(state.fields);
		cleanupWizard();
		if (state.settle) state.settle.reject(new Error("ADHD guided save cancelled"));
	}

	// The form object is reused across documents; drop a wizard that belongs to another one
	function abandonWizard(reason) {
		const state = wizardState;
		if (!state) return;
		cleanupWizard();
		if (state.settle) state.settle.reject(new Error(reason));
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
		frm.layout.wrapper.find(".adhd-wizard-banner").remove();

		const hint = window.ADHD_FIELD_HELP?.[frm.doctype]?.[item.fieldname] || item.label || item.fieldname;
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
		frm.layout.wrapper.prepend($banner);

		const advance = () => {
			if (!wizardState) return;
			wizardState.index += 1;
			showStep();
		};
		$banner.find(".adhd-wizard-next").on("click", advance);
		$banner.find(".adhd-wizard-skip").on("click", () => {
			window.ADHDTelemetry?.emit({
				event_type: "wizard_skip",
				doctype_name: frm.doctype,
				field_name: item.fieldname,
				step_index: index,
			});
			advance();
		});
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

	function startGuidedSave(frm, fields, saveArgs, settle) {
		abandonWizard("ADHD guided save replaced by a new save");
		wizardState = {
			frm,
			docname: frm.doc && frm.doc.name,
			fields,
			index: 0,
			saveArgs,
			settle,
			input: null,
			changeHandler: null,
		};
		showStep();
	}

	frappe.ui.form.Form.prototype.save = function (...args) {
		// mode or wizard off: exactly the stock save
		if (!(frappe.boot && frappe.boot.adhd_mode) || !isWizardSettingOn()) {
			return originalSave.apply(this, args);
		}
		const missing = getMissingRequiredFields(this);
		if (!missing.length) return originalSave.apply(this, args);

		// cancelled earlier and nothing about the missing fields has changed since
		if (this.__adhd_guided_save_cancelled === missingSignature(missing)) {
			return originalSave.apply(this, args);
		}
		this.__adhd_guided_save_cancelled = null;

		const promise = new Promise((resolve, reject) => {
			startGuidedSave(this, missing, args, { resolve, reject });
		});
		// a cancelled save rejects; callers that ignore the result must not log an unhandled rejection
		promise.catch(() => null);
		return promise;
	};

	frappe.ui.form.on("*", {
		refresh(frm) {
			frm.__adhd_guided_save_cancelled = null;
			if (wizardState && wizardState.frm === frm && wizardState.docname !== (frm.doc && frm.doc.name)) {
				abandonWizard("ADHD guided save abandoned: the form moved to another document");
			}
		},
		after_save(frm) {
			frm.__adhd_guided_save_cancelled = null;
		},
	});

	// Switching the wizard off in ADHD Settings while it is asking removes its banner. The save it was
	// holding back is not run behind the person's back: it rejects like a cancel, and saving again is stock.
	// `detail` is { key, value } for one switch and undefined for a reset, which can change all of them.
	if (typeof $ === "function") {
		$(document).on?.("adhd_setting_changed adhd_settings_reset", (_event, detail) => {
			if (detail && detail.key !== "mandatory_wizard") return;
			if (!isWizardSettingOn()) abandonWizard("ADHD guided save switched off in ADHD Settings");
		});
	}

	erpnext.adhd.getMissingRequiredFields = getMissingRequiredFields;
	erpnext.adhd.startGuidedSave = startGuidedSave;
})();
