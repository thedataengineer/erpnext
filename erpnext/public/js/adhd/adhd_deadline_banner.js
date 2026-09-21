// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

frappe.provide("erpnext.adhd");

(() => {
	// The banners are the "Contextual Form Banners" switch in ADHD Settings. Without that module they stay as
	// they were.
	function isBannerSettingOn() {
		const settings = erpnext.adhd.ADHDSettings || window.ADHDSettings;
		return !settings || Boolean(settings.get("form_banners"));
	}

	const plural = (count) => (Math.abs(count) === 1 ? "" : "s");
	const DEADLINE_CONFIG = {
		"Sales Invoice": {
			dateField: "due_date",
			message: (days) =>
				days < 0
					? `⚠️ ${__("Payment overdue by {0} day{1}", [Math.abs(days), plural(days)])}`
					: days === 0
					? __("⚠️ Payment due today")
					: `💳 ${__("Payment due in {0} day{1}", [days, plural(days)])}`,
			showWhen: (doc) => cint(doc.docstatus) !== 2 && flt(doc.outstanding_amount) > 0,
		},
		"Sales Order": {
			dateField: "delivery_date",
			message: (days) =>
				days < 0
					? `⚠️ ${__("Delivery overdue by {0} day{1}", [Math.abs(days), plural(days)])}`
					: days === 0
					? __("⚠️ Delivery due today")
					: `📦 ${__("Delivery due in {0} day{1}", [days, plural(days)])}`,
			showWhen: (doc) => cint(doc.docstatus) === 1 && doc.status !== "Closed",
		},
		Task: {
			dateField: "exp_end_date",
			message: (days) =>
				days < 0
					? `⚠️ ${__("Deadline was {0} day{1} ago", [Math.abs(days), plural(days)])}`
					: days === 0
					? __("⏰ Deadline: today")
					: days === 1
					? __("⏰ Deadline: tomorrow")
					: `📋 ${__("Deadline in {0} days", [days])}`,
			showWhen: (doc) => !["Completed", "Cancelled"].includes(doc.status),
		},
		"Purchase Order": {
			dateField: "schedule_date",
			message: (days) =>
				days < 0
					? `⚠️ ${__("Expected delivery overdue by {0} day{1}", [Math.abs(days), plural(days)])}`
					: days === 0
					? __("⚠️ Expected delivery today")
					: `🚚 ${__("Expected delivery in {0} day{1}", [days, plural(days)])}`,
			showWhen: (doc) => cint(doc.docstatus) === 1 && doc.status !== "Closed",
		},
	};

	function renderDeadlineBanner(frm) {
		frm.layout.$wrapper.find(".adhd-deadline-banner").remove();
		// the banner is gone by now, so switching the setting off removes it from the form it was on
		if (!(frappe.boot && frappe.boot.adhd_mode) || !isBannerSettingOn() || frm.is_new()) return;
		const config = DEADLINE_CONFIG[frm.doctype];
		const dateValue = config && frm.doc[config.dateField];
		if (!config || !dateValue || !config.showWhen(frm.doc)) return;

		const dismissKey = `adhd_banner_dismissed_${frm.doctype}_${frm.docname}`;
		if (sessionStorage.getItem(dismissKey)) return;
		const days = frappe.datetime.get_diff(dateValue, frappe.datetime.get_today());
		const urgencyClass =
			days < 0 ? "adhd-deadline--overdue" : days <= 2 ? "adhd-deadline--soon" : "adhd-deadline--normal";
		const $banner = $(`
			<div class="adhd-deadline-banner ${urgencyClass}" role="status">
				<span class="adhd-deadline-msg">${frappe.utils.escape_html(config.message(days))}</span>
				<button type="button" class="adhd-deadline-dismiss" aria-label="${__("Dismiss")}">✕</button>
			</div>
		`);
		$banner.find(".adhd-deadline-dismiss").on("click", () => {
			sessionStorage.setItem(dismissKey, "1");
			$banner.remove();
		});
		frm.layout.$wrapper.prepend($banner);
	}

	Object.keys(DEADLINE_CONFIG).forEach((doctype) => {
		frappe.ui.form.on(doctype, {
			refresh: renderDeadlineBanner,
			after_save: renderDeadlineBanner,
		});
	});

	// Switching the banners on or off in ADHD Settings changes the form on screen at once. `detail` is
	// { key, value } for one switch and undefined for a reset, which can change all of them.
	if (typeof $ === "function") {
		$(document).on?.("adhd_setting_changed adhd_settings_reset", (_event, detail) => {
			if (detail && detail.key !== "form_banners") return;
			const frm = window.cur_frm;
			if (frm && frm.layout && DEADLINE_CONFIG[frm.doctype]) renderDeadlineBanner(frm);
		});
	}

	erpnext.adhd.DEADLINE_CONFIG = DEADLINE_CONFIG;
	erpnext.adhd.renderDeadlineBanner = renderDeadlineBanner;
})();
