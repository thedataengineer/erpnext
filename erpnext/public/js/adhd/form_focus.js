// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Form Simplification & Progressive Disclosure
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

// Field explanations dictionary — plain English for common ERPNext fields
const FIELD_HELP = {
	"company": "The legal entity this record belongs to",
	"currency": "The currency for money amounts in this document",
	"exchange_rate": "How much 1 unit of foreign currency equals in your base currency",
	"fiscal_year": "The accounting year period (often April–March or Jan–Dec)",
	"naming_series": "The automatic ID/reference number format for this document",
	"is_opening": "Check this if the entry is for an historical 'opening balance'",
	"amended_from": "The previous version of this document before amendment",
	"letter_head": "The letterhead/header to use when printing this document",
	"print_language": "Language to use when printing this document",
	"debit_to": "The accounting ledger where money is debited (received from customer)",
	"credit_to": "The accounting ledger where money is credited (paid to supplier)",
	"taxes_and_charges": "The tax template to apply automatically to this document",
	"total_taxes_and_charges": "Total tax amount calculated from the items",
	"grand_total": "The final total including all taxes and charges",
	"net_total": "The total before taxes and charges are added",
	"tax_category": "A grouping that determines which taxes apply",
	"payment_terms_template": "How payment should be scheduled (e.g. Net 30 = pay within 30 days)",
	"tc_name": "Terms and conditions document to attach",
	"project": "The project this record is associated with",
	"cost_center": "The budget/department this expense or income belongs to",
};

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
		document.querySelectorAll(".adhd-field-help, .adhd-breadcrumb, .adhd-minimal-toggle").forEach(el => el.remove());
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

		// Add tooltips to known fields
		frm.$wrapper.find(".frappe-control label").each(function () {
			const fieldname = $(this).closest(".frappe-control").data("fieldname");
			const help = FIELD_HELP[fieldname];
			if (!help) return;

			if ($(this).find(".adhd-field-help").length) return;

			$(this).append(`
				<span class="adhd-field-help" title="${help}" data-tippy-content="${help}">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="12" cy="12" r="10"/>
						<line x1="12" y1="16" x2="12" y2="12"/>
						<line x1="12" y1="8" x2="12.01" y2="8"/>
					</svg>
				</span>
			`);
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
