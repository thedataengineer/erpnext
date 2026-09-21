// Contributor-facing ADHD test helpers.

frappe.provide("erpnext.adhd");

function insertFixture(doc) {
	return frappe.call("frappe.client.insert", { doc }).then((result) => result.message.name);
}

erpnext.adhd.test = {
	enable() {
		window.ADHDMode?.activate();
	},
	disable() {
		window.ADHDMode?.deactivate();
	},
	reset() {
		Object.keys(localStorage)
			.filter((key) => key.startsWith("adhd_") || key === erpnext.adhd.STORAGE_KEY)
			.forEach((key) => localStorage.removeItem(key));
		window.ADHDMode?.deactivate();
	},
	isActive() {
		return window.ADHDMode?.isActive() ?? false;
	},
	getModuleState(moduleName) {
		const modules = {
			adhd_mode: window.ADHDMode,
			focus_panel: window.FocusPanel,
			task_kanban: window.TaskKanban,
		};
		return modules[moduleName]?.getState?.() ?? null;
	},
	fixtures: {
		createTask(overrides = {}) {
			return insertFixture({
				doctype: "Task",
				subject: "ADHD Test Task",
				status: "Open",
				exp_end_date: frappe.datetime.add_days(frappe.datetime.get_today(), 3),
				...overrides,
			});
		},
		createSalesInvoice(overrides = {}) {
			return insertFixture({
				doctype: "Sales Invoice",
				customer: "__Test Customer",
				posting_date: frappe.datetime.get_today(),
				items: [{ item_code: "__Test Item", qty: 1, rate: 100 }],
				...overrides,
			});
		},
		createJournalEntry(overrides = {}) {
			return insertFixture({
				doctype: "Journal Entry",
				voucher_type: "Journal Entry",
				posting_date: frappe.datetime.get_today(),
				accounts: [
					{ account: "__Test Account AR - _TC", debit_in_account_currency: 100 },
					{ account: "__Test Account AP - _TC", credit_in_account_currency: 100 },
				],
				...overrides,
			});
		},
		createEmployee(overrides = {}) {
			return insertFixture({
				doctype: "Employee",
				first_name: "ADHD",
				last_name: "Test",
				company: frappe.boot.user_info?.default_company || frappe.boot.sysdefaults?.company,
				date_of_joining: frappe.datetime.get_today(),
				gender: "Male",
				date_of_birth: "1990-01-01",
				employment_type: "Full-time",
				...overrides,
			});
		},
	},
};

if (frappe.boot.developer_mode || window.Cypress || window.playwright) {
	window.adhdTest = erpnext.adhd.test;
}
