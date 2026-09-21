const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const jsRoot = path.resolve(__dirname, "../public/js/adhd");
const readAdhd = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Any jQuery-style call returns the same empty collection.
function makeChain() {
	const chain = new Proxy(function () {}, {
		get: (_target, key) => (key === "length" ? 0 : () => chain),
	});
	return chain;
}

// Own enumerable properties are the stored keys, like a browser Storage.
class FakeStorage {
	getItem(key) {
		return Object.hasOwn(this, key) ? this[key] : null;
	}
	setItem(key, value) {
		this[key] = String(value);
	}
	removeItem(key) {
		delete this[key];
	}
}

function makeSandbox(overrides = {}) {
	const registrations = {};
	const { frappe: frappeOverrides = {}, ...rest } = overrides;
	class Form {
		save() {
			return Promise.resolve();
		}
	}
	const sandbox = {
		console: { log() {}, warn() {}, error() {} },
		setTimeout,
		clearTimeout,
		setInterval: () => 1,
		clearInterval() {},
		document: { visibilityState: "visible", getElementById: () => null },
		window: {},
		localStorage: new FakeStorage(),
		$: () => makeChain(),
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.replace(`{${index}}`, value), text),
		flt: (value) => Number.parseFloat(value) || 0,
		format_currency: (value) => String(value),
		erpnext: { adhd: {} },
		frappe: {
			boot: { adhd_mode: true, sysdefaults: { company: "Example Co" } },
			call: async () => ({ message: null }),
			after_ajax: (callback) => callback(),
			datetime: { get_today: () => "2026-09-21", add_days: (date) => date },
			model: { can_read: () => true },
			provide() {},
			router: { on() {}, slug: (value) => value },
			session: { user: "user@example.com" },
			show_alert() {},
			ui: {
				form: {
					Form,
					on: (doctype, handlers) => Object.assign((registrations[doctype] ||= {}), handlers),
				},
			},
			utils: { debounce: (fn) => fn, escape_html: (value) => String(value) },
			...frappeOverrides,
		},
		...rest,
	};
	return { sandbox, registrations };
}

function load(name, overrides) {
	const { sandbox, registrations } = makeSandbox(overrides);
	vm.runInNewContext(readAdhd(name), sandbox, { filename: name });
	return { sandbox, registrations, storage: sandbox.localStorage };
}

// ---- ADHD Journal Entry balance meter ---------------------------------------------------------

function makeMeter() {
	const state = { texts: {}, classes: {} };
	const element = (selector) => ({
		text(value) {
			state.texts[selector] = value;
			return this;
		},
		toggleClass(name, on) {
			state.classes[`${selector}.${name}`] = on;
			return this;
		},
		hasClass: (name) => Boolean(state.classes[`${selector}.${name}`]),
	});
	return { length: 1, find: element, state };
}

function journalEntry(rows, extra = {}) {
	const indicators = [];
	const meter = makeMeter();
	const frm = {
		doc: { docstatus: 0, company_currency: "INR", accounts: rows, ...extra },
		layout: { wrapper: { find: () => meter } },
		// like a real Form: the indicator lives on frm.page (and frm.toolbar), never on frm itself
		page: { set_indicator: (label, color) => indicators.push([label, color]) },
		toolbar: { set_indicator: () => indicators.push(["native"]) },
		is_dirty: () => true,
	};
	return { frm, indicators, meter };
}

test("balance meter balances on company-currency debit/credit, as the server does", () => {
	const { sandbox } = load("adhd_accounts.js");
	const adhd = sandbox.erpnext.adhd;
	// 100 USD at 83: the account-currency amounts (100 vs 8300) disagree, the company-currency ones balance
	const rows = [
		{ debit_in_account_currency: 100, debit: 8300, credit_in_account_currency: 0, credit: 0 },
		{ debit_in_account_currency: 0, debit: 0, credit_in_account_currency: 8300, credit: 8300 },
	];
	assert.deepEqual(JSON.parse(JSON.stringify(adhd.getJournalEntryTotals(rows))), {
		debit: 8300,
		credit: 8300,
	});

	const { frm, indicators, meter } = journalEntry(rows);
	adhd.updateJournalEntryBalanceMeter(frm);
	assert.deepEqual(JSON.parse(JSON.stringify(indicators)), [["Balanced ✓", "green"]]);
	assert.equal(meter.state.classes["#adhd-difference.adhd-balanced"], true);
});

test("balance meter uses the page indicator, only on drafts", () => {
	const { sandbox } = load("adhd_accounts.js");
	const adhd = sandbox.erpnext.adhd;
	const unbalanced = [
		{ debit: 100, credit: 0 },
		{ debit: 0, credit: 40 },
	];

	const draft = journalEntry(unbalanced);
	adhd.updateJournalEntryBalanceMeter(draft.frm);
	assert.deepEqual(JSON.parse(JSON.stringify(draft.indicators)), [["Unbalanced", "red"]]);

	const submitted = journalEntry(unbalanced, { docstatus: 1 });
	adhd.updateJournalEntryBalanceMeter(submitted.frm);
	assert.deepEqual(submitted.indicators, []);

	// nothing to judge yet: the standard Draft / Not Saved indicator comes back instead of a blank header
	const empty = journalEntry([]);
	adhd.updateJournalEntryBalanceMeter(empty.frm);
	assert.deepEqual(JSON.parse(JSON.stringify(empty.indicators)), [["native"]]);
});

// ---- last-used cost center ------------------------------------------------------------------------

function loadAccountsWithDimensions(call) {
	return load("adhd_accounts.js", { frappe: { call } });
}

test("last-used cost center is stored and read per company", async () => {
	const { sandbox, storage } = loadAccountsWithDimensions(async () => ({ message: [[], {}] }));
	const { Form } = sandbox.frappe.ui.form;
	const saved = {
		doc: { company: "Company A", cost_center: "Main - A", docstatus: 0 },
		meta: {},
	};
	await Form.prototype.save.call(saved);
	await sleep(5);
	assert.equal(storage.getItem("adhd_last_cost_center::Company A"), "Main - A");
	assert.equal(storage.getItem("adhd_last_cost_center"), null);

	const prefill = (company) => {
		const setValues = [];
		const frm = {
			doc: { company, docstatus: 0 },
			meta: {},
			fields_dict: { cost_center: { wrapper: {} } },
			is_new: () => true,
			set_value: async (fieldname, value) => setValues.push([fieldname, value]),
		};
		return sandbox.erpnext.adhd.prefillLastUsed(frm).then(() => setValues);
	};
	assert.deepEqual(await prefill("Company B"), []);
	assert.deepEqual(JSON.parse(JSON.stringify(await prefill("Company A"))), [["cost_center", "Main - A"]]);

	await sandbox.window.adhdClearLastUsedDefaults();
	assert.equal(storage.getItem("adhd_last_cost_center::Company A"), null);
});

test("failing to remember a default neither rejects the save nor leaves an unhandled rejection", async () => {
	const { sandbox } = loadAccountsWithDimensions(async () => {
		throw new Error("dimensions unavailable");
	});
	const unhandled = [];
	const listener = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", listener);
	try {
		const frm = { doc: { company: "Company A", cost_center: "Main - A", docstatus: 0 }, meta: {} };
		await sandbox.frappe.ui.form.Form.prototype.save.call(frm);
		await sleep(20);
	} finally {
		process.off("unhandledRejection", listener);
	}
	assert.deepEqual(unhandled, []);
});

// ---- Pomodoro time log --------------------------------------------------------------------------------

function loadTimeLog({ frappe = {}, nowRef = { value: "2026-09-21 10:00:00" } } = {}) {
	// a stand-in for moment covering exactly the calls the module makes
	const moment = (value) => {
		let time = Date.parse(`${value.replace(" ", "T")}Z`);
		return {
			subtract(amount, unit) {
				assert.equal(unit, "minutes");
				time -= amount * 60000;
				return this;
			},
			format: () => new Date(time).toISOString().slice(0, 19).replace("T", " "),
		};
	};
	const { sandbox } = makeSandbox({
		moment,
		Notification: undefined,
		frappe: {
			defaultDatetimeFormat: "YYYY-MM-DD HH:mm:ss",
			datetime: { get_today: () => "2026-09-21", now_datetime: () => nowRef.value },
			...frappe,
		},
	});
	const context = vm.createContext(sandbox);
	vm.runInContext(readAdhd("focus_panel.js"), context, { filename: "focus_panel.js" });
	vm.runInContext(readAdhd("adhd_time_log.js"), context, { filename: "adhd_time_log.js" });
	const panel = Object.create(sandbox.erpnext.adhd.FocusPanel.prototype);
	Object.assign(panel, {
		timerMode: "work",
		timerSeconds: 25 * 60,
		timerTotalSeconds: 25 * 60,
		timerRunning: false,
		activeTask: { name: "TASK-1", subject: "Write the docs", project: "PROJ-1" },
	});
	const banners = [];
	panel._renderTimeLogBanner = (options) => banners.push(options);
	return { panel, banners, nowRef, sandbox };
}

const minutesBetween = (from, to) =>
	(Date.parse(to.replace(" ", "T")) - Date.parse(from.replace(" ", "T"))) / 60000;

test("a paused work session is logged for exactly the minutes shown", () => {
	const { panel, banners, nowRef } = loadTimeLog();
	panel._timerStart();
	panel._timerPause();
	nowRef.value = "2026-09-21 10:20:00";
	panel._timerStart(); // resume
	nowRef.value = "2026-09-21 10:45:00"; // 45 minutes of wall clock for a 25 minute session
	panel._timerComplete();

	assert.equal(banners.length, 1);
	const [options] = banners;
	assert.equal(options.hours, 25 / 60);
	assert.equal(options.toTime, "2026-09-21 10:45:00");
	// Timesheet recomputes hours from from/to, so they must agree with the hours shown
	assert.equal(minutesBetween(options.fromTime, options.toTime), 25);
});

test("break sessions are not offered for logging, work sessions after a break are", () => {
	const { panel, banners } = loadTimeLog();

	// the "5m break" preset resets the timer to 300 s but leaves timerMode on "work"
	panel._timerReset(5 * 60, "break");
	panel._timerStart();
	panel._timerComplete();
	assert.equal(banners.length, 0);

	// a normal work session, then its automatic break, then a 25m preset: timerMode is still "break"
	panel._timerReset(25 * 60, "work");
	panel._timerStart();
	panel._timerComplete();
	assert.equal(banners.length, 1);
	assert.equal(panel.timerMode, "break");
	panel._timerStart(); // the automatic 5 minute break
	panel._timerComplete();
	assert.equal(banners.length, 1);

	panel.timerMode = "break";
	panel._timerReset(50 * 60, "work");
	panel._timerStart();
	panel._timerComplete();
	assert.equal(banners.length, 2);
	assert.equal(banners[1].hours, 50 / 60);
});

test("time is logged against the Employee of the signed-in user, and not at all without one", async () => {
	const calls = [];
	const lookups = [];
	let employee = "HR-EMP-00001";
	const { panel, sandbox } = loadTimeLog({
		frappe: {
			db: {
				get_value: async (doctype, filters, fieldname) => {
					lookups.push([doctype, filters, fieldname]);
					return { message: employee ? { name: employee } : {} };
				},
			},
			call: async (options) => {
				calls.push(options);
				return { message: options.method === "frappe.client.get_list" ? [] : { name: "TS-1" } };
			},
		},
	});
	const options = {
		project: "PROJ-1",
		task: { name: "TASK-1" },
		fromTime: "2026-09-21 10:20:00",
		toTime: "2026-09-21 10:45:00",
		hours: 25 / 60,
		activityType: "Execution",
	};
	await panel._saveTimeLog(options);
	assert.deepEqual(JSON.parse(JSON.stringify(lookups)), [
		["Employee", { user_id: "user@example.com", status: "Active" }, "name"],
	]);
	assert.equal(calls[0].args.filters.employee, "HR-EMP-00001");
	assert.equal(calls[1].args.doc.employee, "HR-EMP-00001");

	// no Employee: no Timesheet lookup (it would match any employee-less draft) and no insert
	calls.length = 0;
	employee = null;
	const alerts = [];
	sandbox.frappe.show_alert = (alert) => alerts.push(alert);
	const other = Object.create(Object.getPrototypeOf(panel));
	assert.equal(await other._saveTimeLog(options), null);
	assert.deepEqual(calls, []);
	assert.equal(alerts.length, 1);
});

// ---- Payment Entry shortlist ---------------------------------------------------------------------------

function paymentEntryForm(extra = {}) {
	return {
		doc: {
			docstatus: 0,
			name: "ACC-PAY-1",
			company: "Example Co",
			payment_type: "Receive",
			party_type: "Customer",
			party: "Customer A",
			paid_from: "Debtors - EC",
			posting_date: "2026-09-21",
			...extra,
		},
		layout: { wrapper: makeChain() },
		fields_dict: {},
		set_df_property() {},
	};
}

test("the outstanding shortlist is silent, needs the party account and asks once per party", async () => {
	const calls = [];
	const { registrations } = load("adhd_payment_entry.js", {
		frappe: {
			call: async (options) => {
				calls.push(options);
				return { message: [] };
			},
		},
	});
	const handlers = registrations["Payment Entry"];

	// a new entry opened with a party, before ERPNext has set paid_from: nothing to ask the server yet
	handlers.refresh(paymentEntryForm({ paid_from: "" }));
	await sleep(5);
	assert.equal(calls.length, 0);

	const frm = paymentEntryForm();
	handlers.refresh(frm);
	await sleep(5);
	handlers.refresh(frm);
	await sleep(5);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].silent, true);
	assert.equal(calls[0].args.args.party_account, "Debtors - EC");

	// another document loaded into the same form object starts over
	handlers.onload(frm);
	handlers.refresh(frm);
	await sleep(5);
	assert.equal(calls.length, 2);
});

test("on a party change the account is read only after ERPNext's own party handler has set it", async () => {
	const calls = [];
	const { registrations } = load("adhd_payment_entry.js", {
		frappe: {
			call: async (options) => {
				calls.push(options);
				return { message: [] };
			},
		},
	});
	const frm = paymentEntryForm({ party: "Customer B", paid_from: "Old Debtors - EC" });
	frm.set_party_account_based_on_party = true; // raised by ERPNext's party handler while it works
	registrations["Payment Entry"].party(frm);
	await sleep(50);
	assert.equal(calls.length, 0);

	frm.doc.paid_from = "New Debtors - EC";
	frm.set_party_account_based_on_party = false;
	await sleep(450);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args.args.party_account, "New Debtors - EC");
});

// ---- Bank reconciliation progress ----------------------------------------------------------------------

test("bank reconciliation ticks survive rows leaving the DOM and only the reconciled one is dropped", () => {
	const { sandbox, storage } = load("adhd_bank_recon.js");
	const adhd = sandbox.erpnext.adhd;
	// no checkbox is rendered at all: the datatable only keeps rows in view
	const frm = {
		doc: { bank_account: "Checking - EX", bank_statement_from_date: "2026-09-01" },
		get_field: () => ({ wrapper: {} }),
		layout: { wrapper: makeChain() },
		bank_reconciliation_data_table_manager: { transactions: [1, 2, 3] },
	};
	const key = adhd.bankReconStorageKey(frm);
	const saved = () => JSON.parse(storage.getItem(key));

	adhd.setBankReconChecked(frm, "BT-1", true);
	adhd.setBankReconChecked(frm, "BT-2", true);
	adhd.setBankReconChecked(frm, "BT-3", true);
	adhd.setBankReconChecked(frm, "BT-3", false);
	assert.deepEqual(Array.from(saved().checkedIds), ["BT-1", "BT-2"]);
	assert.equal(saved().total, 3);

	adhd.forgetBankReconTransaction(frm, "BT-1");
	assert.deepEqual(Array.from(saved().checkedIds), ["BT-2"]);

	// a session saved earlier is picked up, not overwritten
	frm._adhdReconChecked = null;
	adhd.setBankReconChecked(frm, "BT-4", true);
	assert.deepEqual(Array.from(saved().checkedIds), ["BT-2", "BT-4"]);
});

// ---- month-end close readiness -------------------------------------------------------------------------

function loadMonthEnd({
	call,
	canRead = () => true,
	visible = true,
	panelOpen = true,
	adhdActive = true,
} = {}) {
	const handlers = {};
	const checks = [];
	const htmls = [];
	const body = {
		length: 1,
		html(value) {
			htmls.push(value);
			return this;
		},
		find: () => makeChain(),
	};
	const section = {
		length: 1,
		find: (selector) => (selector === ".adhd-readiness-body" ? body : makeChain()),
		closest: () => ({ length: 1, hasClass: () => panelOpen }),
		is: () => visible,
		data:
			() =>
			(...args) =>
				checks.push(args),
	};
	const document = { visibilityState: "visible" };
	const calls = [];
	const loaded = load("adhd_month_end.js", {
		document,
		$: (arg) => {
			if (arg === document) {
				return {
					off() {
						return this;
					},
					on(event, handler) {
						handlers[event] = handler;
						return this;
					},
				};
			}
			return arg === "#adhd-close-readiness" ? section : makeChain();
		},
		erpnext: { adhd: { isActive: () => adhdActive } },
		frappe: {
			call: async (options) => {
				calls.push(options);
				return call
					? call(options)
					: { message: { ready: true, summary: "Ready to close.", issues: [] } };
			},
			model: { can_read: canRead },
			confirm() {},
		},
	});
	return { ...loaded, handlers, checks, htmls, calls, document };
}

test("refocusing the tab rechecks only after a check was run, while the section is visible and ADHD is on", async () => {
	const { sandbox, handlers, checks } = loadMonthEnd();
	const refocus = () => handlers["visibilitychange.adhdReadiness"]();

	refocus(); // Check Now was never clicked
	assert.equal(checks.length, 0);

	await sandbox.erpnext.adhd.runReadinessCheck("Example Co", "2026-09-01", "2026-09-30");
	refocus();
	assert.equal(checks.length, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(checks[0])), [null, { silent: true }]);

	const shouldRecheck = sandbox.erpnext.adhd.shouldRecheckReadiness;
	assert.equal(shouldRecheck({ hasRun: true, sectionVisible: true, adhdActive: true }), true);
	assert.equal(shouldRecheck({ hasRun: false, sectionVisible: true, adhdActive: true }), false);
	assert.equal(shouldRecheck({ hasRun: true, sectionVisible: false, adhdActive: true }), false);
	assert.equal(shouldRecheck({ hasRun: true, sectionVisible: true, adhdActive: false }), false);
});

test("no recheck while the panel is closed or ADHD mode is off", async () => {
	for (const options of [{ panelOpen: false }, { visible: false }, { adhdActive: false }]) {
		const { sandbox, handlers, checks } = loadMonthEnd(options);
		await sandbox.erpnext.adhd.runReadinessCheck("Example Co", "2026-09-01", "2026-09-30");
		handlers["visibilitychange.adhdReadiness"]();
		assert.equal(checks.length, 0, JSON.stringify(options));
	}
});

test("a background recheck is silent, skipped without read access and keeps the last results", async () => {
	const denied = loadMonthEnd({ canRead: (doctype) => doctype !== "Bank Transaction" });
	await denied.sandbox.erpnext.adhd.runReadinessCheck("Example Co", "2026-09-01", "2026-09-30", null, {
		silent: true,
	});
	assert.equal(denied.calls.length, 0);
	assert.equal(denied.htmls.length, 0);

	const failing = loadMonthEnd({
		call: async (options) => {
			if (options.silent) throw new Error("not permitted");
			return { message: { ready: true, summary: "Ready to close.", issues: [] } };
		},
	});
	const check = (options) =>
		failing.sandbox.erpnext.adhd.runReadinessCheck(
			"Example Co",
			"2026-09-01",
			"2026-09-30",
			null,
			options
		);
	await check({});
	const shown = failing.htmls.length;
	await check({ silent: true });
	assert.equal(failing.calls.at(-1).silent, true);
	assert.equal(failing.htmls.length, shown, "a failed background recheck must not replace the results");
});

test("the month-end checklist follows the server on Period Close and never raises a dialog for it", async () => {
	const date = new Date();
	const key = `adhd_me_user@example.com_${date.getFullYear()}_${String(date.getMonth() + 1).padStart(
		2,
		"0"
	)}`;

	const open = loadMonthEnd({ call: async () => ({ message: false }) });
	open.storage.setItem(key, JSON.stringify({ period_close: true }));
	await open.sandbox.erpnext.adhd.initMonthEndChecklist({});
	assert.equal(open.calls[0].silent, true);
	assert.equal(JSON.parse(open.storage.getItem(key)).period_close, false);

	const denied = loadMonthEnd({
		call: async () => {
			throw new Error("Not permitted to read Period Closing Vouchers.");
		},
	});
	denied.storage.setItem(key, JSON.stringify({ period_close: true }));
	await denied.sandbox.erpnext.adhd.initMonthEndChecklist({});
	assert.equal(JSON.parse(denied.storage.getItem(key)).period_close, true);
});

// ---- Payment digest -------------------------------------------------------------------------------------

test("the payment digest call is silent and a failure becomes a quiet unavailable state", async () => {
	class FocusPanel {
		show() {}
		hide() {}
		destroy() {}
	}
	const calls = [];
	let fail = true;
	const { sandbox } = makeSandbox({
		erpnext: { adhd: { FocusPanel } },
		frappe: {
			defaults: { get_default: () => null },
			call: async (options) => {
				calls.push(options);
				if (fail) throw new Error("Set a default Company to load the payment summary.");
				return { message: { total_outstanding: 0 } };
			},
		},
	});
	vm.runInNewContext(readAdhd("adhd_payment_digest.js"), sandbox, { filename: "adhd_payment_digest.js" });
	const rendered = [];
	const panel = new FocusPanel();
	panel._renderPaymentDigest = (data) => rendered.push(data);

	await panel._loadPaymentDigest();
	assert.equal(calls[0].silent, true);
	assert.deepEqual(rendered, [null]);

	fail = false;
	await panel._loadPaymentDigest();
	assert.equal(rendered[1].total_outstanding, 0);

	// no Sales Invoice access: the server would refuse, so it is not even asked
	sandbox.frappe.model.can_read = () => false;
	calls.length = 0;
	await panel._loadPaymentDigest();
	assert.equal(calls.length, 0);
	assert.equal(rendered[2], null);
});

// ---- Purchase Order lifecycle ---------------------------------------------------------------------------

test("purchase order steps: pending approval is a draft state, cancelled is not 'Created'", () => {
	const { sandbox } = load("adhd_buying.js");
	const step = sandbox.erpnext.adhd.getPurchaseOrderStep;
	assert.equal(step({ docstatus: 0 }), "created");
	assert.equal(step({ docstatus: 0, workflow_state: "Pending Approval" }), "approved");
	assert.equal(step({ docstatus: 0, workflow_state: "Waiting for Approval" }), "approved");
	assert.equal(step({ docstatus: 0, workflow_state: "Draft" }), "created");
	assert.equal(step({ docstatus: 2, status: "Cancelled" }), null);
	assert.equal(step({ docstatus: 1, per_received: 0, per_billed: 0 }), "receipt_pending");
	assert.equal(step({ docstatus: 1, per_received: 100, per_billed: 40 }), "invoice_pending");
	assert.equal(step({ docstatus: 1, status: "Closed" }), "closed");
});

// ---- test fixtures --------------------------------------------------------------------------------------

test("test fixtures use frappe.datetime.get_today, the only helper Frappe has", async () => {
	const docs = [];
	const { sandbox } = load("adhd_test_utils.js", {
		window: { Cypress: true },
		frappe: {
			boot: { developer_mode: true, sysdefaults: { company: "Example Co" } },
			// deliberately no datetime.today: it does not exist
			datetime: { get_today: () => "2026-09-21", add_days: (date, days) => `${date}+${days}` },
			call: async (_method, args) => {
				docs.push(args.doc);
				return { message: { name: `${args.doc.doctype}-1` } };
			},
		},
	});
	const { fixtures } = sandbox.erpnext.adhd.test;
	for (const create of ["createTask", "createSalesInvoice", "createJournalEntry", "createEmployee"]) {
		assert.match(await fixtures[create](), /-1$/);
	}
	assert.equal(docs[0].exp_end_date, "2026-09-21+3");
	assert.equal(docs[1].posting_date, "2026-09-21");
	assert.equal(docs[2].posting_date, "2026-09-21");
	assert.equal(docs[3].date_of_joining, "2026-09-21");
});
