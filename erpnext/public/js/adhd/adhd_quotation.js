// ADHD-021: a quotation that is about to expire, or already has, says so at the top of its form.
// The list rows are coloured by adhd_list_view.js. The banner uses the deadline banner's look
// (adhd_deadline_banner.js, _adhd_deadline_banner.scss) but is drawn here: that module keeps a fixed list of
// doctypes and needs a Form to have `layout.$wrapper`, which Frappe's Layout does not define (it has `wrapper`).

frappe.provide("erpnext.adhd");

(() => {
	// Two weeks ahead is when a quotation starts to matter; the list only colours the last week.
	const WARN_WITHIN_DAYS = 14;
	// The quotation is settled, or the standard "Expired" status already says so.
	const SETTLED_STATUSES = ["Ordered", "Lost", "Expired", "Cancelled"];
	const BANNER_CLASS = "adhd-quotation-expiry";

	// The banner is one of the "Contextual Form Banners" in ADHD Settings. Without that module it stays as it was.
	function isBannerSettingOn() {
		const settings = erpnext.adhd.ADHDSettings || window.ADHDSettings;
		return !settings || Boolean(settings.get("form_banners"));
	}

	function expiryMessage(days) {
		if (days < -1) return `⚠️ ${__("Quotation expired {0} days ago", [-days])}`;
		if (days === -1) return `⚠️ ${__("Quotation expired yesterday")}`;
		if (days === 0) return `⚠️ ${__("Quotation expires today")}`;
		if (days === 1) return `⏰ ${__("Quotation expires tomorrow")}`;
		return `⏰ ${__("Quotation expires in {0} days", [days])}`;
	}

	// red on the last valid day and after it, amber for the week before (as in the list), blue beyond that
	function urgencyClass(days) {
		return days <= 0
			? "adhd-deadline--overdue"
			: days <= 7
			? "adhd-deadline--soon"
			: "adhd-deadline--normal";
	}

	// Frappe's Layout holds its element as `wrapper` (a jQuery object)
	const layoutOf = (frm) => frm && frm.layout && frm.layout.wrapper;

	// A dismissed banner stays away for the rest of the browser session, like the other deadline banners.
	function dismissKey(frm) {
		return `adhd_banner_dismissed_${frm.doctype}_${frm.docname}`;
	}
	function isDismissed(frm) {
		try {
			return Boolean(sessionStorage.getItem(dismissKey(frm)));
		} catch (error) {
			return false;
		}
	}

	function renderQuotationBanner(frm) {
		// a valid_till set while the form is still loading arrives before it has a layout
		const $layout = layoutOf(frm);
		if (!$layout) return;
		// the old banner goes first, so a refresh, a save or a date edit cannot leave two, and switching the mode
		// off removes it from the form it was on
		$layout.find(`.${BANNER_CLASS}`).remove();
		if (!(frappe.boot && frappe.boot.adhd_mode) || !isBannerSettingOn() || frm.is_new()) return;
		const doc = frm.doc;
		if (cint(doc.docstatus) === 2 || SETTLED_STATUSES.includes(doc.status) || !doc.valid_till) return;
		const days = frappe.datetime.get_diff(doc.valid_till, frappe.datetime.get_today());
		if (!Number.isFinite(days) || days > WARN_WITHIN_DAYS || isDismissed(frm)) return;

		const $banner = $("<div>")
			.addClass(`adhd-deadline-banner ${BANNER_CLASS} ${urgencyClass(days)}`)
			.attr("role", "status");
		$("<span>").addClass("adhd-deadline-msg").text(expiryMessage(days)).appendTo($banner);
		$("<button>")
			.attr("type", "button")
			.addClass("adhd-deadline-dismiss")
			.attr("aria-label", __("Dismiss"))
			.text("✕")
			.on("click", () => {
				try {
					sessionStorage.setItem(dismissKey(frm), "1");
				} catch (error) {
					// the banner still goes away for now
				}
				$banner.remove();
			})
			.appendTo($banner);
		$layout.prepend($banner);
	}

	function renderOnScreen(frm) {
		if (frm && frm.doctype === "Quotation" && frm.doc) renderQuotationBanner(frm);
	}

	frappe.ui.form.on("Quotation", {
		refresh: renderQuotationBanner,
		// the banner follows the date as it is edited, before the save
		valid_till: renderQuotationBanner,
	});

	// Switching ADHD mode on or off, or the banners switch, changes the form on screen at once. onStateChange calls
	// this once as it registers, when no form is open yet. `detail` is { key, value } for one settings switch and
	// undefined for a reset, which can change all of them.
	erpnext.adhd.onStateChange?.(() => renderOnScreen(window.cur_frm));
	if (typeof $ === "function") {
		$(document).on?.("adhd_setting_changed adhd_settings_reset", (_event, detail) => {
			if (detail && detail.key !== "form_banners") return;
			renderOnScreen(window.cur_frm);
		});
	}

	erpnext.adhd.QUOTATION_WARN_WITHIN_DAYS = WARN_WITHIN_DAYS;
	erpnext.adhd.renderQuotationBanner = renderQuotationBanner;
})();
