// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
// ADHD-022: an "Essentials" strip on the Customer form that answers "can I take this order?" without a trip
// through the tabs: credit limit, outstanding amount, payment terms and the primary contact's email.
//
// The credit limit is a per-company child table and the outstanding amount is computed, so neither can be read
// from the Customer with get_value. One whitelisted call (erpnext/selling/services/adhd_customer_essentials.py)
// works both out with the functions ERPNext's own credit-limit check uses, in the default company's currency.

frappe.provide("erpnext.adhd");

(() => {
	const PANEL_CLASS = "adhd-customer-essentials";
	const METHOD = "erpnext.selling.services.adhd_customer_essentials.get_customer_essentials";
	// outstanding as a share of the credit limit: from WARN_AT it is amber, from 1 (the whole limit) red
	const WARN_AT = 0.8;
	const NONE = "—";

	// Read at run time, never once at load: the mode can be switched on and off while a form is open.
	function isActive() {
		return Boolean(frappe.boot && frappe.boot.adhd_mode);
	}

	function esc(value) {
		return frappe.utils.escape_html(value == null ? "" : value);
	}

	// "none" (no limit, or no balance to compare), "ok", "warn" (80% or more of the limit) or "over" (the whole
	// limit or more). The server's own over_limit flag, which is what ERPNext enforces, always means "over".
	function getCreditLevel(data) {
		const limit = flt(data && data.credit_limit);
		if (!data || data.outstanding == null || limit <= 0) return "none";
		if (data.over_limit || flt(data.outstanding) >= limit) return "over";
		return flt(data.outstanding) >= limit * WARN_AT ? "warn" : "ok";
	}

	function utilisationText(data, level) {
		const limit = flt(data.credit_limit);
		if (level === "over") {
			return flt(data.outstanding) > limit ? __("Over the credit limit") : __("At the credit limit");
		}
		if (level === "warn") {
			return __("{0}% of the credit limit", [Math.round((flt(data.outstanding) / limit) * 100)]);
		}
		return "";
	}

	function item(label, valueHtml, extraHtml = "") {
		return `<div class="adhd-essentials-item">
			<span class="adhd-essentials-key">${esc(label)}</span>
			<span class="adhd-essentials-value">${valueHtml}</span>${extraHtml}
		</div>`;
	}

	// `data` is what the server returned, or null when it could not be loaded. Everything that came from the
	// database is escaped; the strings written here are translated but not user data.
	function buildEssentialsHtml(data) {
		if (!data) {
			return `<div class="${PANEL_CLASS}" data-state="unavailable">
				<span class="adhd-essentials-label">${esc(__("Essentials"))}</span>
				<p class="adhd-essentials-note">${esc(__("Essentials are not available."))}</p>
			</div>`;
		}

		const hasCompany = Boolean(data.credit_limit_company);
		const currency = data.currency;
		const level = getCreditLevel(data);

		let creditLimit = NONE;
		if (hasCompany) {
			creditLimit =
				flt(data.credit_limit) > 0
					? esc(format_currency(data.credit_limit, currency))
					: esc(__("No limit set"));
		}

		let outstanding = NONE;
		let outstandingNote = "";
		if (hasCompany && data.outstanding != null) {
			const levelText = utilisationText(data, level);
			outstanding = esc(format_currency(data.outstanding, currency));
			if (levelText) {
				outstandingNote = `<span class="adhd-essentials-note adhd-credit-text adhd-credit-${level}">${esc(
					levelText
				)}</span>`;
			}
		}

		let paymentTerms = NONE;
		if (data.payment_terms) {
			paymentTerms = frappe.utils.get_form_link("Payment Terms Template", data.payment_terms, true);
			if (data.payment_terms_inherited) {
				paymentTerms += ` <span class="adhd-essentials-note">(${esc(__("default"))})</span>`;
			}
		}

		let contact = NONE;
		if (data.primary_email) {
			const email = esc(data.primary_email);
			const name = data.primary_contact_name ? `${esc(data.primary_contact_name)} ` : "";
			contact = `${name}<a href="mailto:${email}">${email}</a>`;
		} else if (data.primary_contact_name) {
			contact = esc(data.primary_contact_name);
		}

		const note = hasCompany
			? __("Credit figures are for {0}, in {1}.", [data.credit_limit_company, currency])
			: __("Set a default Company to see the credit limit and the outstanding amount.");

		const outstandingClass = level === "none" ? "" : ` adhd-credit-${level}`;
		return `<div class="${PANEL_CLASS}" data-state="ready">
			<span class="adhd-essentials-label">${esc(__("Essentials"))}</span>
			<div class="adhd-essentials-grid">
				${item(__("Credit Limit"), creditLimit)}
				<div class="adhd-essentials-item">
					<span class="adhd-essentials-key">${esc(__("Outstanding"))}</span>
					<span class="adhd-essentials-value${outstandingClass}">${outstanding}</span>${outstandingNote}
				</div>
				${item(__("Payment Terms"), paymentTerms)}
				${item(__("Primary Contact"), contact)}
			</div>
			<p class="adhd-essentials-note">${esc(note)}</p>
		</div>`;
	}

	function removeEssentials(frm) {
		if (frm && frm.$wrapper) frm.$wrapper.find(`.${PANEL_CLASS}`).remove();
	}

	function insertEssentials(frm, $panel) {
		// above the form's own tabs and sections
		const $layout =
			frm.layout && frm.layout.wrapper ? frm.layout.wrapper : frm.$wrapper.find(".form-layout").first();
		$layout.prepend($panel);
	}

	async function fetchEssentials(customer) {
		try {
			// silent: a permission or server problem must not open a dialog on every Customer
			const response = await frappe.call({ method: METHOD, args: { customer }, silent: true });
			return (response && response.message) || null;
		} catch (error) {
			return null;
		}
	}

	async function renderCustomerEssentials(frm) {
		if (!frm || !frm.doc) return;
		// a render that starts after another one wins: an older request that answers late is dropped
		const token = (frm._adhdEssentialsToken || 0) + 1;
		frm._adhdEssentialsToken = token;
		removeEssentials(frm);

		// a new, unsaved Customer has a temporary name and nothing to look up
		if (!isActive() || !frm.doc.name || frm.doc.__islocal || (frm.is_new && frm.is_new())) return;

		const customer = frm.doc.name;
		const data = await fetchEssentials(customer);

		// the mode may have been switched off, or another render or another Customer taken over, while waiting
		if (token !== frm._adhdEssentialsToken || !isActive() || !frm.doc || frm.doc.name !== customer)
			return;
		removeEssentials(frm);
		insertEssentials(frm, $(buildEssentialsHtml(data)));
	}

	frappe.ui.form.on("Customer", {
		// Frappe has no "after_load" form event; refresh runs on the first open, after a save and on reload
		refresh(frm) {
			renderCustomerEssentials(frm);
		},
	});

	// Switching the mode on or off with a Customer open takes effect at once, without a reload.
	// (onStateChange calls back immediately with the current state, when no form is open yet.)
	if (erpnext.adhd.onStateChange) {
		erpnext.adhd.onStateChange(() => {
			const frm = window.cur_frm;
			if (frm && frm.doctype === "Customer") renderCustomerEssentials(frm);
		});
	}

	erpnext.adhd.CUSTOMER_ESSENTIALS_METHOD = METHOD;
	erpnext.adhd.getCreditLevel = getCreditLevel;
	erpnext.adhd.buildCustomerEssentialsHtml = buildEssentialsHtml;
	erpnext.adhd.renderCustomerEssentials = renderCustomerEssentials;
	erpnext.adhd.removeCustomerEssentials = removeEssentials;
})();
