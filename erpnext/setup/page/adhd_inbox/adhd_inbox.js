function is_smart_inbox_enabled() {
	if (frappe.boot && Object.prototype.hasOwnProperty.call(frappe.boot, "adhd_mode")) {
		return Boolean(frappe.boot.adhd_mode);
	}

	return Boolean(erpnext.adhd && erpnext.adhd.isActive && erpnext.adhd.isActive());
}

frappe.pages["adhd-inbox"].on_page_load = function (wrapper) {
	if (!is_smart_inbox_enabled()) return;

	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("ADHD Inbox"),
		single_column: true,
	});

	frappe.adhd_inbox_page = page;
	if (erpnext.adhd && erpnext.adhd.renderSmartInbox) {
		erpnext.adhd.renderSmartInbox(page);
		page.__adhd_inbox_rendered = true;
	}
};

frappe.pages["adhd-inbox"].on_page_show = function () {
	if (!is_smart_inbox_enabled() || !(erpnext.adhd && erpnext.adhd.smartInbox)) return;

	if (frappe.adhd_inbox_page && !frappe.adhd_inbox_page.__adhd_inbox_rendered && erpnext.adhd.renderSmartInbox) {
		erpnext.adhd.renderSmartInbox(frappe.adhd_inbox_page);
		frappe.adhd_inbox_page.__adhd_inbox_rendered = true;
		return;
	}

	erpnext.adhd.smartInbox.refresh();
	erpnext.adhd.smartInbox.startAutoRefresh();
};
