function is_smart_inbox_enabled() {
	if (frappe.boot && Object.prototype.hasOwnProperty.call(frappe.boot, "adhd_mode")) {
		return Boolean(frappe.boot.adhd_mode);
	}

	return Boolean(erpnext.adhd && erpnext.adhd.isActive && erpnext.adhd.isActive());
}

// Frappe calls on_page_load once, when the page is created, and on_page_show straight after it (and on
// every later visit). The page is always built here so a first visit with ADHD mode off still leaves
// something for on_page_show to fill once the mode is on; the content, and its single fetch, come from
// on_page_show.
frappe.pages["focus-inbox"].on_page_load = function (wrapper) {
	frappe.adhd_inbox_page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Focus Inbox"),
		single_column: true,
	});
};

frappe.pages["focus-inbox"].on_page_show = function () {
	if (!is_smart_inbox_enabled()) {
		frappe.set_route("Workspaces");
		return;
	}
	if (!(erpnext.adhd && erpnext.adhd.smartInbox && erpnext.adhd.renderSmartInbox)) return;

	const page = frappe.adhd_inbox_page;
	if (!page) return;

	if (!page.__adhd_inbox_rendered) {
		// renders, fetches once and starts the auto-refresh
		erpnext.adhd.renderSmartInbox(page);
		page.__adhd_inbox_rendered = true;
		return;
	}

	erpnext.adhd.smartInbox.refresh();
	erpnext.adhd.smartInbox.startAutoRefresh();
};
