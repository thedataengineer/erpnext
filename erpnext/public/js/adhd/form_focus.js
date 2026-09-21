// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Form Simplification & Progressive Disclosure
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

const FIELD_HELP = erpnext.adhd.FIELD_HELP || {};
const fieldHelpCache = new Map();

const TIMEBOX_DOCTYPES = ["Item", "Account", "BOM", "Print Format", "Custom Field"];
const TIMEBOX_MINUTES = 10;

function getFocusPanel() {
	return frappe.focusPanel || (erpnext.adhd && erpnext.adhd.focusPanel);
}

function startPomodoro(minutes) {
	const panel = getFocusPanel();
	if (panel && typeof panel.startTimer === "function") {
		panel.startTimer(minutes);
		frappe.show_alert({ message: __("{0}-min timer started", [minutes]), indicator: "blue" });
		return;
	}
	frappe.show_alert({ message: __("Open the Focus Panel to start your timer"), indicator: "blue" });
}

function renderTimeboxBanner(frm) {
	frm.layout.$wrapper.find(".adhd-timebox-banner").remove();
	if (!(frappe.boot && frappe.boot.adhd_mode) || frm.is_new()) return;
	const dismissKey = `adhd_timebox_dismissed_${frm.doctype}_${frm.docname}`;
	if (sessionStorage.getItem(dismissKey)) return;
	const $banner = $(`
		<div class="adhd-timebox-banner" role="status">
			<span class="adhd-timebox-icon">⏱️</span>
			<span class="adhd-timebox-msg">${__("Heads up: this form has a lot of options. Consider a {0}-min time-box.", [TIMEBOX_MINUTES])}</span>
			<button type="button" class="btn btn-xs btn-default adhd-timebox-start">${__("Start {0}-min timer", [TIMEBOX_MINUTES])}</button>
			<button type="button" class="adhd-timebox-dismiss" aria-label="${__("Dismiss")}">✕</button>
		</div>
	`);
	const dismiss = () => {
		sessionStorage.setItem(dismissKey, "1");
		$banner.remove();
	};
	$banner.find(".adhd-timebox-start").on("click", () => {
		startPomodoro(TIMEBOX_MINUTES);
		dismiss();
	});
	$banner.find(".adhd-timebox-dismiss").on("click", dismiss);
	frm.layout.$wrapper.prepend($banner);
}

erpnext.adhd.FormFocus = class FormFocus {
	constructor() {
		this._boundHandler = null;
		this._applyToCurrentForm = this._applyToCurrentForm.bind(this);
	}

	enable() {
		// Hook into frappe's form rendering
		frappe.ui.form.on_each_form && frappe.ui.form.on_each_form(this._applyToCurrentForm);

		// Apply to current form if one is open
		if (cur_frm) {
			this._applyToCurrentForm(cur_frm);
		}

		// Listen for page changes
		this._boundHandler = () => {
			setTimeout(() => {
				if (cur_frm) this._applyToCurrentForm(cur_frm);
			}, 500);
		};

		$(document).on("frappe.route_change", this._boundHandler);
		$(document).on("page-change", this._boundHandler);
	}

	disable() {
		if (this._boundHandler) {
			$(document).off("frappe.route_change", this._boundHandler);
			$(document).off("page-change", this._boundHandler);
		}

		// Remove ADHD form enhancements from current form
		document
			.querySelectorAll(
				".adhd-field-help, .adhd-field-help-tip, .adhd-breadcrumb, .adhd-minimal-toggle"
			)
			.forEach((el) => el.remove());
		document.querySelectorAll(".adhd-form-enhanced").forEach(el => el.classList.remove("adhd-form-enhanced"));
	}

	_applyToCurrentForm(frm) {
		if (!frm || !frm.$wrapper) return;
		if (frm.$wrapper.find(".adhd-form-enhanced").length) return; // Already enhanced

		frm.$wrapper.addClass("adhd-form-enhanced");

		this._addBreadcrumb(frm);
		this._addFieldTooltips(frm);
		this._setupAutosave(frm);
	}

	_addBreadcrumb(frm) {
		const existing = frm.$wrapper.find(".adhd-breadcrumb");
		if (existing.length) {
			existing.find(".adhd-bc-doctype").text(frm.doctype);
			existing.find(".adhd-bc-docname").text(frm.docname || "New");
			return;
		}

		const isNew = !frm.docname || frm.is_new();
		const colors = {
			"Task": "#4CAF50",
			"Project": "#2196F3",
			"Sales Invoice": "#FF9800",
			"Purchase Invoice": "#9C27B0",
			"Customer": "#00BCD4",
			"Supplier": "#F44336",
			"Sales Order": "#FF5722",
			"Purchase Order": "#795548",
			"Payment Entry": "#607D8B",
		};

		const color = colors[frm.doctype] || "#2D7D9A";
		const statusBadge = frm.doc.docstatus === 1 ? '<span class="adhd-bc-badge submitted">Submitted</span>'
			: frm.doc.docstatus === 2 ? '<span class="adhd-bc-badge cancelled">Cancelled</span>'
			: isNew ? '<span class="adhd-bc-badge draft new">New</span>'
			: '<span class="adhd-bc-badge draft">Draft</span>';

		const bc = $(`
			<div class="adhd-breadcrumb" style="--adhd-bc-color: ${color}">
				<span class="adhd-bc-icon">📄</span>
				<span class="adhd-bc-doctype">${__(frm.doctype)}</span>
				<span class="adhd-bc-sep">›</span>
				<span class="adhd-bc-docname">${frm.docname || __("New")}</span>
				${statusBadge}
			</div>
		`);

		frm.$wrapper.find(".page-head, .page-heading, form-page").first().before(bc);
	}

	_addFieldTooltips(frm) {
		if (!frm.$wrapper) return;
		if (frm._adhdHelpBound) return;
		frm._adhdHelpBound = true;

		const hideTip = ($control, fieldname) => {
			$control.find(".adhd-field-help-tip").remove();
			const started = $control.data("adhd-help-start");
			if (started && Date.now() - started > 2000) {
				window.ADHDTelemetry?.emit({
					event_type: "tooltip_dwell",
					doctype_name: frm.doctype,
					field_name: fieldname,
					duration_ms: Date.now() - started,
				});
			}
			$control.removeData("adhd-help-start");
		};

		const showTip = ($control, fieldname, text) => {
			if (!text || !erpnext.adhd.isActive()) return;
			hideTip($control, fieldname);
			$("<div>").addClass("adhd-field-help-tip").text(text).appendTo($control);
			$control.data("adhd-help-start", Date.now());
		};

		frm.$wrapper.on("focusin.adhdFieldHelp", ".frappe-control :input", (event) => {
			const $control = $(event.currentTarget).closest(".frappe-control");
			const fieldname = $control.data("fieldname");
			if (!fieldname) return;

			const canonical = FIELD_HELP[frm.doctype]?.[fieldname];
			if (canonical) {
				showTip($control, fieldname, canonical);
				return;
			}

			const key = `${frm.doctype}.${fieldname}`;
			if (fieldHelpCache.has(key)) {
				showTip($control, fieldname, fieldHelpCache.get(key));
				return;
			}
			fieldHelpCache.set(key, null);
			frappe.call({
				method: "frappe.client.get_value",
				args: {
					doctype: "DocField",
					filters: { parent: frm.doctype, fieldname },
					fieldname: "description",
				},
				callback: (response) => {
					const description = response.message?.description || null;
					fieldHelpCache.set(key, description);
					if (description && document.activeElement === event.currentTarget) {
						showTip($control, fieldname, description);
					}
				},
			});
		});
		frm.$wrapper.on("focusout.adhdFieldHelp", ".frappe-control :input", (event) => {
			const $control = $(event.currentTarget).closest(".frappe-control");
			hideTip($control, $control.data("fieldname"));
		});
	}

	_setupAutosave(frm) {
		if (frm._adhd_autosave_interval) return;

		frm._adhd_autosave_interval = setInterval(() => {
			if (!erpnext.adhd.isActive()) {
				clearInterval(frm._adhd_autosave_interval);
				return;
			}

			if (frm.doc && frm.is_dirty() && !frm.doc.__islocal) {
				frm.save("Save", () => {
					// Show subtle autosave indicator
					const indicator = document.querySelector(".adhd-autosave-indicator");
					if (indicator) {
						indicator.classList.add("saved");
						setTimeout(() => indicator.classList.remove("saved"), 2000);
					}
				});
			}
		}, 60000); // Autosave every 60 seconds
	}
};

// Initialize
let formFocusInstance = null;

erpnext.adhd.onStateChange && erpnext.adhd.onStateChange((active) => {
	if (active) {
		if (!formFocusInstance) {
			formFocusInstance = new erpnext.adhd.FormFocus();
		}
		formFocusInstance.enable();
	} else {
		if (formFocusInstance) {
			formFocusInstance.disable();
		}
	}
});

// Also apply when a new form loads while ADHD mode is already on
frappe.after_ajax(() => {
	$(document).on("page-change", function () {
		if (!erpnext.adhd.isActive()) return;
		setTimeout(() => {
			if (cur_frm && formFocusInstance) {
				formFocusInstance._applyToCurrentForm(cur_frm);
			}
		}, 600);
	});
});

TIMEBOX_DOCTYPES.forEach((doctype) => {
	frappe.ui.form.on(doctype, { refresh: renderTimeboxBanner });
});

document.addEventListener("focuspanel:timercomplete", () => {
	if (!(frappe.boot && frappe.boot.adhd_mode)) return;
	const route = frappe.get_route();
	if (route[0] === "Form" && TIMEBOX_DOCTYPES.includes(route[1])) {
		frappe.show_alert(
			{ message: __("Time's up — did you get what you needed?"), indicator: "orange" },
			10
		);
	}
});

erpnext.adhd.TIMEBOX_DOCTYPES = TIMEBOX_DOCTYPES;
erpnext.adhd.renderTimeboxBanner = renderTimeboxBanner;
