// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

frappe.provide("erpnext.adhd");

(() => {
	const DATE_FIELD_MAP = {
		"Sales Order": "delivery_date",
		"Purchase Order": "schedule_date",
		Task: "exp_end_date",
		"Sales Invoice": "due_date",
		"Leave Application": "to_date",
		Issue: "response_by",
	};
	const HEAT_CLASSES = "adhd-heat--overdue adhd-heat--soon adhd-heat--upcoming";
	let observer = null;

	function getUrgencyClass(dateValue) {
		if (!dateValue) return null;
		const diff = frappe.datetime.get_diff(dateValue, frappe.datetime.get_today());
		if (diff < 0) return "adhd-heat--overdue";
		if (diff <= 2) return "adhd-heat--soon";
		if (diff <= 7) return "adhd-heat--upcoming";
		return null;
	}

	function isClosed(row) {
		return cint(row.docstatus) === 2 || ["Closed", "Completed", "Cancelled", "Paid"].includes(row.status);
	}

	function applyHeat(listview) {
		if (!(frappe.boot && frappe.boot.adhd_mode) || !listview) return;
		const dateField = DATE_FIELD_MAP[listview.doctype];
		if (!dateField || !listview.$result) return;
		(listview.data || []).forEach((row) => {
			const $row = listview.$result
				.find("[data-name]")
				.filter((_, element) => element.getAttribute("data-name") === row.name)
				.first();
			$row.removeClass(HEAT_CLASSES);
			if ($row.length && !isClosed(row)) {
				const heatClass = getUrgencyClass(row[dateField]);
				if (heatClass) $row.addClass(heatClass);
			}
		});
	}

	function attachHeatMap(listview) {
		if (observer) observer.disconnect();
		observer = null;
		if (!(frappe.boot && frappe.boot.adhd_mode) || !DATE_FIELD_MAP[listview && listview.doctype]) return;

		const dateField = DATE_FIELD_MAP[listview.doctype];
		listview.fields ||= [];
		const hasField = listview.fields.some((field) => (field.fieldname || field) === dateField);
		if (!hasField) listview.fields.push(dateField);

		const wrapper = listview.$result && listview.$result[0];
		if (!wrapper) return;
		observer = new MutationObserver(() => applyHeat(listview));
		observer.observe(wrapper, { childList: true, subtree: true });
		applyHeat(listview);
	}

	frappe.router.on("change", () => {
		if (observer) observer.disconnect();
		observer = null;
		frappe.after_ajax(() => {
			const listview = frappe.views && frappe.views.list_view;
			if (listview) attachHeatMap(listview);
		});
	});

	erpnext.adhd.DATE_FIELD_MAP = DATE_FIELD_MAP;
	erpnext.adhd.getUrgencyClass = getUrgencyClass;
	erpnext.adhd.applyHeat = applyHeat;
})();
