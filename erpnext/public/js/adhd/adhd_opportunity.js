// ADHD-030: an opportunity nobody has saved for more than two weeks wears a "stale" badge on its form.
// The list rows are coloured by adhd_list_view.js, which also holds the day count both share
// (erpnext.adhd.getDaysSinceModified) and the two-week line (erpnext.adhd.STALE_RED_DAYS).
// `modified` moves when the record is saved, so a call, an email or a note added to it does not reset the count.
// The badge goes into `frm.layout.wrapper`, which is what Frappe's Layout calls its element (there is no `$wrapper`).

frappe.provide("erpnext.adhd");

(() => {
	// The opportunity is settled: staleness is no longer something to act on.
	const SETTLED_STATUSES = ["Converted", "Lost", "Closed"];

	// The badge is one of the "Contextual Form Banners" in ADHD Settings. Without that module it stays as it was.
	function isBannerSettingOn() {
		const settings = erpnext.adhd.ADHDSettings || window.ADHDSettings;
		return !settings || Boolean(settings.get("form_banners"));
	}

	// Its own class, not the deadline banner's, so the banner's refresh cannot remove it.
	function renderStaleBadge(frm) {
		const $layout = frm && frm.layout && frm.layout.wrapper;
		if (!$layout) return;
		// a badge from an earlier refresh goes first, so switching the mode off removes it from the form it was on
		$layout.find(".adhd-stale-badge").remove();
		if (!(frappe.boot && frappe.boot.adhd_mode) || !isBannerSettingOn() || frm.is_new()) return;
		if (SETTLED_STATUSES.includes(frm.doc.status)) return;

		const days = erpnext.adhd.getDaysSinceModified?.(frm.doc.modified);
		if (!Number.isFinite(days) || days <= erpnext.adhd.STALE_RED_DAYS) return;

		const $badge = $("<div>")
			.addClass("adhd-stale-badge")
			.attr("role", "status")
			// the timestamp is converted from the system time zone to the user's by str_to_user
			.attr("title", __("Last modified: {0}", [frappe.datetime.str_to_user(frm.doc.modified)]))
			.text(`🕒 ${__("Stale — no activity for {0} days", [days])}`);
		$layout.prepend($badge);
	}

	function renderOnScreen(frm) {
		if (frm && frm.doctype === "Opportunity" && frm.doc) renderStaleBadge(frm);
	}

	frappe.ui.form.on("Opportunity", { refresh: renderStaleBadge });

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

	erpnext.adhd.renderStaleBadge = renderStaleBadge;
})();
