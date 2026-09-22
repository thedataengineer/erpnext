// The seven extension points another app (Hubble, the HR app) uses to plug its own forms and lists into the
// Focus aids: registerChain, registerDeadline, registerTimebox, registerFeature, registerListDate,
// registerInboxModule and registerDraftRecovery. Each module runs in a vm sandbox with a stand-in for the few
// Frappe and jQuery calls it makes at load time and while rendering, and every test here fails if a
// registration is missing, ignored, or applied twice.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const jsRoot = path.join(appRoot, "public/js/adhd");
const read = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");
// values made inside a vm context carry that context's prototypes, which deepStrictEqual rejects
const plain = (value) => JSON.parse(JSON.stringify(value));

const TODAY = "2026-09-21";
const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (later, earlier) => Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);
const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text);
const escapeHtml = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
	);

// A browser Storage stand-in, including the key()/length pair the draft purge walks.
function makeStorage() {
	const data = new Map();
	return {
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => data.set(key, String(value)),
		removeItem: (key) => data.delete(key),
		key: (index) => [...data.keys()][index] ?? null,
		get length() {
			return data.size;
		},
	};
}

// A jQuery stand-in: a string makes a node that remembers its html and the click handlers bound inside it;
// anything else ($(document), a selector) is an inert chain that answers every call with itself.
function makeDollar() {
	const chain = new Proxy(function () {}, {
		get: (_target, key) => (key === "length" ? 0 : () => chain),
	});
	const makeNode = (html) => {
		const node = { html, length: 1, handlers: {} };
		node.find = (selector) => ({
			on(event, handler) {
				node.handlers[`${selector}:${event}`] = handler;
				return this;
			},
		});
		node.remove = () => {};
		return node;
	};
	return (arg) => (typeof arg === "string" ? makeNode(arg) : chain);
}

function makeSandbox() {
	const registrations = [];
	const afterAjax = [];
	const routeHandlers = [];
	const sandbox = {
		console: { log() {}, warn() {}, error() {} },
		Date,
		setTimeout: (fn) => fn(),
		clearTimeout() {},
		setInterval: () => 1,
		clearInterval() {},
		window: {},
		document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
		localStorage: makeStorage(),
		sessionStorage: makeStorage(),
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		moment: { tz: (value) => ({ valueOf: () => Date.parse(`${String(value).replace(" ", "T")}Z`) }) },
		__: translate,
		cint: (value) => parseInt(value, 10) || 0,
		flt: (value) => parseFloat(value) || 0,
		$: makeDollar(),
		frappe: {
			boot: { adhd_mode: true, time_zone: { system: "Asia/Kolkata" } },
			session: { user: "ann@example.com" },
			provide() {},
			after_ajax: (fn) => afterAjax.push(fn),
			get_route: () => [],
			get_route_str: () => "",
			set_route() {},
			re_route: {},
			router: { on: (_event, fn) => routeHandlers.push(fn) },
			show_alert() {},
			pages: {},
			datetime: {
				get_today: () => TODAY,
				get_diff: (later, earlier) => daysBetween(later, earlier),
				str_to_user: (value) => String(value),
			},
			utils: { escape_html: escapeHtml },
			ui: { form: { on: (doctype, handlers) => registrations.push({ doctype, handlers }) } },
			call: async () => ({ message: [] }),
		},
		erpnext: { adhd: {} },
	};
	return { sandbox, registrations, afterAjax, routeHandlers };
}

function run(sandbox, name) {
	vm.runInNewContext(read(name), sandbox, { filename: name });
	return sandbox.erpnext.adhd;
}

const registrationsFor = (registrations, doctype) =>
	registrations.filter((entry) => entry.doctype === doctype);

// A form whose layout wrapper records the banners prepended to it.
function makeForm(doctype, doc, { isNew = false } = {}) {
	const banners = [];
	const wrapper = { find: () => ({ length: 0, remove() {} }), prepend: (node) => banners.push(node) };
	return {
		doctype,
		docname: doc.name,
		doc: { doctype, ...doc },
		is_new: () => isNew,
		layout: { wrapper },
		$wrapper: wrapper,
		banners,
	};
}

// ---- registerChain (adhd_chain_navigator.js) --------------------------------------------------------------

const HIRING_CHAIN = [
	{ label: "Job Opening", doctype: "Job Opening", link_field: null },
	{ label: "Job Applicant", doctype: "Job Applicant", link_field: "job_title" },
];

test("registerChain adds another app's chain and its form handlers, and a second call does not double them", () => {
	const { sandbox, registrations } = makeSandbox();
	const adhd = run(sandbox, "adhd_chain_navigator.js");
	const before = registrations.length;

	assert.equal(adhd.registerChain("Job Opening", HIRING_CHAIN), true);
	assert.equal(adhd.CHAIN_MAP["Job Opening"], HIRING_CHAIN);
	const mine = registrationsFor(registrations, "Job Opening");
	assert.equal(mine.length, 1);
	assert.equal(typeof mine[0].handlers.refresh, "function");

	// the chain can be replaced; the handlers stay registered once
	assert.equal(adhd.registerChain("Job Opening", HIRING_CHAIN.slice(0, 1)), true);
	assert.equal(adhd.CHAIN_MAP["Job Opening"].length, 1);
	assert.equal(registrationsFor(registrations, "Job Opening").length, 1);
	assert.equal(registrations.length, before + 1);
});

test("registerChain refuses a missing doctype or an empty chain, and every built-in chain is registered once", () => {
	const { sandbox, registrations } = makeSandbox();
	const adhd = run(sandbox, "adhd_chain_navigator.js");

	assert.equal(adhd.registerChain("", HIRING_CHAIN), false);
	assert.equal(adhd.registerChain("Job Opening", []), false);
	assert.equal(adhd.registerChain("Job Opening", "Job Applicant"), false);
	assert.equal(adhd.registerChain("Job Opening"), false);
	assert.equal(registrationsFor(registrations, "Job Opening").length, 0);
	assert.equal(Object.hasOwn(adhd.CHAIN_MAP, "Job Opening"), false);

	for (const doctype of Object.keys(adhd.CHAIN_MAP)) {
		assert.equal(registrationsFor(registrations, doctype).length, 1, doctype);
	}
});

// ---- registerDeadline (adhd_deadline_banner.js) -----------------------------------------------------------

const INTERVIEW_DEADLINE = {
	dateField: "scheduled_on",
	message: (days) => (days === 0 ? "Interview today" : `Interview in ${days} days`),
	showWhen: (doc) => doc.status !== "Cleared",
};

test("registerDeadline shows another app's banner from its own date field, message and showWhen", () => {
	const { sandbox, registrations } = makeSandbox();
	const adhd = run(sandbox, "adhd_deadline_banner.js");

	assert.equal(adhd.registerDeadline("Interview", INTERVIEW_DEADLINE), true);
	const mine = registrationsFor(registrations, "Interview");
	assert.equal(mine.length, 1);
	assert.equal(typeof mine[0].handlers.refresh, "function");
	assert.equal(typeof mine[0].handlers.after_save, "function");

	const today = makeForm("Interview", { name: "INT-1", scheduled_on: TODAY, status: "Pending" });
	mine[0].handlers.refresh(today);
	assert.equal(today.banners.length, 1);
	assert.match(today.banners[0].html, /Interview today/);
	assert.match(today.banners[0].html, /adhd-deadline--soon/);

	const later = makeForm("Interview", { name: "INT-2", scheduled_on: "2026-09-30", status: "Pending" });
	mine[0].handlers.refresh(later);
	assert.match(later.banners[0].html, /Interview in 9 days/);
	assert.match(later.banners[0].html, /adhd-deadline--normal/);

	// the app's own showWhen decides
	const cleared = makeForm("Interview", { name: "INT-3", scheduled_on: TODAY, status: "Cleared" });
	mine[0].handlers.refresh(cleared);
	assert.equal(cleared.banners.length, 0);

	// and the mode gate still applies
	sandbox.frappe.boot.adhd_mode = false;
	const off = makeForm("Interview", { name: "INT-4", scheduled_on: TODAY, status: "Pending" });
	mine[0].handlers.refresh(off);
	assert.equal(off.banners.length, 0);
});

test("registerDeadline refuses an incomplete config and never doubles the handlers", () => {
	const { sandbox, registrations } = makeSandbox();
	const adhd = run(sandbox, "adhd_deadline_banner.js");
	const { dateField, message, showWhen } = INTERVIEW_DEADLINE;

	assert.equal(adhd.registerDeadline("Interview", { dateField, message }), false);
	assert.equal(adhd.registerDeadline("Interview", { dateField, message: "soon", showWhen }), false);
	assert.equal(adhd.registerDeadline("Interview", { message, showWhen }), false);
	assert.equal(adhd.registerDeadline("", INTERVIEW_DEADLINE), false);
	assert.equal(adhd.registerDeadline("Interview", null), false);
	assert.equal(registrationsFor(registrations, "Interview").length, 0);

	assert.equal(adhd.registerDeadline("Interview", INTERVIEW_DEADLINE), true);
	assert.equal(adhd.registerDeadline("Interview", INTERVIEW_DEADLINE), true);
	assert.equal(registrationsFor(registrations, "Interview").length, 1);
	assert.equal(registrationsFor(registrations, "Sales Invoice").length, 1);
});

// ---- registerTimebox (form_focus.js) ------------------------------------------------------------------------

test("registerTimebox puts the time-box banner on another app's heavy form, once", () => {
	const { sandbox, registrations } = makeSandbox();
	const adhd = run(sandbox, "form_focus.js");

	assert.equal(adhd.TIMEBOX_DOCTYPES.includes("Payroll Entry"), false);
	assert.equal(adhd.registerTimebox("Payroll Entry"), true);
	assert.equal(adhd.registerTimebox("Payroll Entry"), true);
	assert.equal(adhd.registerTimebox(""), false);
	assert.equal(adhd.registerTimebox(), false);
	assert.deepEqual(plain(adhd.TIMEBOX_DOCTYPES.filter((doctype) => doctype === "Payroll Entry")), [
		"Payroll Entry",
	]);
	const mine = registrationsFor(registrations, "Payroll Entry");
	assert.equal(mine.length, 1);
	assert.equal(registrationsFor(registrations, "Item").length, 1);

	const frm = makeForm("Payroll Entry", { name: "HR-PRUN-1", docstatus: 0 });
	mine[0].handlers.refresh(frm);
	assert.equal(frm.banners.length, 1);
	assert.match(frm.banners[0].html, /adhd-timebox-banner/);

	// dismissing it is remembered for that document
	frm.banners[0].handlers[".adhd-timebox-dismiss:click"]();
	const again = makeForm("Payroll Entry", { name: "HR-PRUN-1", docstatus: 0 });
	mine[0].handlers.refresh(again);
	assert.equal(again.banners.length, 0);

	// a new document gets no banner, and neither does anything while the mode is off
	const fresh = makeForm("Payroll Entry", { name: "new-payroll-entry-1", docstatus: 0 }, { isNew: true });
	mine[0].handlers.refresh(fresh);
	assert.equal(fresh.banners.length, 0);
	sandbox.frappe.boot.adhd_mode = false;
	const off = makeForm("Payroll Entry", { name: "HR-PRUN-2", docstatus: 0 });
	mine[0].handlers.refresh(off);
	assert.equal(off.banners.length, 0);
});

// ---- registerFeature (adhd_settings.js) ---------------------------------------------------------------------

test("registerFeature adds another app's switch with its default, and leaves an existing key as it is", () => {
	const { sandbox } = makeSandbox();
	const adhd = run(sandbox, "adhd_settings.js");
	const count = adhd.ADHD_FEATURES.length;

	assert.equal(adhd.registerFeature({ key: "hr_aids", label: "HR form aids", defaultOn: true }), true);
	assert.equal(adhd.ADHD_FEATURES.length, count + 1);
	assert.equal(adhd.ADHDSettings.get("hr_aids"), true);
	adhd.ADHDSettings.set("hr_aids", false);
	assert.equal(adhd.ADHDSettings.get("hr_aids"), false);

	// the same key again, or one of the built-in keys, changes nothing
	assert.equal(adhd.registerFeature({ key: "hr_aids", label: "Something else", defaultOn: false }), false);
	assert.equal(adhd.registerFeature({ key: "form_banners", label: "Banners again" }), false);
	assert.equal(adhd.ADHD_FEATURES.find((feature) => feature.key === "hr_aids").label, "HR form aids");
	assert.equal(
		adhd.ADHD_FEATURES.find((feature) => feature.key === "form_banners").label,
		"Contextual Form Banners"
	);
	assert.equal(adhd.ADHD_FEATURES.length, count + 1);

	// a switch needs a key and a label; an unstated default is off
	assert.equal(adhd.registerFeature({ label: "No key" }), false);
	assert.equal(adhd.registerFeature({ key: "no_label" }), false);
	assert.equal(adhd.registerFeature({ key: 7, label: "Numeric key" }), false);
	assert.equal(adhd.registerFeature(null), false);
	assert.equal(adhd.ADHD_FEATURES.length, count + 1);
	assert.equal(adhd.registerFeature({ key: "hr_quiet", label: "Quiet HR forms" }), true);
	assert.equal(adhd.ADHDSettings.get("hr_quiet"), false);
});

// ---- registerListDate (adhd_list_view.js) ------------------------------------------------------------------

// A list whose rows record the heat classes applied to them.
function makeList(doctype, data) {
	const rows = {};
	const rowFor = (name) =>
		(rows[name] ||= {
			classes: new Set(),
			length: 1,
			addClass(value) {
				this.classes.add(value);
				return this;
			},
			removeClass() {
				return this;
			},
			attr() {
				return this;
			},
			removeAttr() {
				return this;
			},
		});
	const elements = data.map((row) => ({
		getAttribute: (name) => (name === "data-name" ? row.name : null),
	}));
	const $result = {
		find: () => ({
			filter: (keep) => {
				const hits = elements.filter((element, index) => keep(index, element));
				return {
					first: () =>
						hits.length
							? rowFor(hits[0].getAttribute("data-name"))
							: { length: 0, removeClass() {} },
				};
			},
		}),
	};
	return { listview: { doctype, data, $result, fields: [] }, rowFor };
}

test("registerListDate makes another app's rows glow by its date field, except its closed statuses", () => {
	const { sandbox } = makeSandbox();
	const adhd = run(sandbox, "adhd_list_view.js");

	assert.equal(adhd.registerListDate("Interview", "scheduled_on", ["Cleared", "Rejected"]), true);
	assert.equal(adhd.DATE_FIELD_MAP.Interview, "scheduled_on");

	const { listview, rowFor } = makeList("Interview", [
		{ name: "INT-1", scheduled_on: "2026-09-19", status: "Pending" },
		{ name: "INT-2", scheduled_on: "2026-09-19", status: "Cleared" },
		{ name: "INT-3", scheduled_on: "2026-09-25", status: "Pending" },
	]);
	adhd.applyHeat(listview);
	assert.ok(rowFor("INT-1").classes.has("adhd-heat--overdue"));
	assert.equal(rowFor("INT-2").classes.size, 0);
	assert.ok(rowFor("INT-3").classes.has("adhd-heat--upcoming"));

	// closed statuses are optional
	assert.equal(adhd.registerListDate("Job Offer", "offer_date"), true);
	const offers = makeList("Job Offer", [
		{ name: "HR-OFF-1", offer_date: "2026-09-20", status: "Awaiting Response" },
	]);
	adhd.applyHeat(offers.listview);
	assert.ok(offers.rowFor("HR-OFF-1").classes.has("adhd-heat--overdue"));
});

test("registerListDate refuses a missing doctype or a date field that is not a field name", () => {
	const { sandbox } = makeSandbox();
	const adhd = run(sandbox, "adhd_list_view.js");

	assert.equal(adhd.registerListDate("", "scheduled_on"), false);
	assert.equal(adhd.registerListDate("Job Offer", ""), false);
	assert.equal(adhd.registerListDate("Job Offer", ["offer_date"]), false);
	assert.equal(adhd.registerListDate("Job Offer"), false);
	assert.equal(Object.hasOwn(adhd.DATE_FIELD_MAP, "Job Offer"), false);

	// a list nobody registered stays cold
	const { listview, rowFor } = makeList("Job Offer", [
		{ name: "HR-OFF-1", offer_date: "2026-09-01", status: "Open" },
	]);
	adhd.applyHeat(listview);
	assert.equal(rowFor("HR-OFF-1").classes.size, 0);
});

// ---- registerInboxModule (adhd_smart_inbox.js) -------------------------------------------------------------

test("registerInboxModule lets another app's module count in the visit ranking", () => {
	const { sandbox, routeHandlers } = makeSandbox();
	const adhd = run(sandbox, "adhd_smart_inbox.js");

	assert.equal(adhd.registerInboxModule("HR"), true);
	assert.equal(adhd.registerInboxModule("HR"), true);
	assert.equal(adhd.registerInboxModule(""), false);
	assert.equal(adhd.registerInboxModule({ name: "Payroll" }), false);
	assert.equal(routeHandlers.length, 1);

	sandbox.frappe.get_route = () => ["hr"];
	routeHandlers[0]();
	routeHandlers[0]();
	assert.deepEqual(plain(adhd.smartInbox.getRankedModules()), ["HR"]);

	// a module nobody registered is not counted, and a workspace route counts like a module route
	sandbox.frappe.get_route = () => ["payroll"];
	routeHandlers[0]();
	assert.deepEqual(plain(adhd.smartInbox.getRankedModules()), ["HR"]);
	sandbox.frappe.get_route = () => ["Workspaces", "selling"];
	routeHandlers[0]();
	assert.deepEqual(plain(adhd.smartInbox.getRankedModules()), ["HR", "Selling"]);
});

// ---- registerDraftRecovery (adhd_draft_recovery.js) --------------------------------------------------------

const EXPENSES_TABLE = {
	doctype: "Expense Claim Detail",
	identity: ["expense_type"],
	fields: ["expense_type", "amount", "description"],
};
const EXPENSE_CLAIM_SNAPSHOT = {
	party: ["employee"],
	scalars: ["company", "employee", "posting_date"],
	tables: { expenses: EXPENSES_TABLE },
	contentTables: ["expenses"],
};

function makeClaim(name, doc) {
	return {
		doctype: "Expense Claim",
		docname: name,
		doc: { doctype: "Expense Claim", name, docstatus: 0, __islocal: 1, ...doc },
		is_new: () => true,
		is_dirty: () => true,
	};
}

test("registerDraftRecovery snapshots another app's form by its own fields and tables", () => {
	const { sandbox, registrations } = makeSandbox();
	sandbox.frappe.get_route = () => ["Form", "Expense Claim", "new-expense-claim-1"];
	const adhd = run(sandbox, "adhd_draft_recovery.js");
	const recovery = adhd.draftRecovery;

	assert.equal(adhd.registerDraftRecovery("Expense Claim", EXPENSE_CLAIM_SNAPSHOT), true);
	assert.ok(recovery.RECOVERY_DOCTYPES.includes("Expense Claim"));
	assert.deepEqual(plain(recovery.SNAPSHOT_FIELDS["Expense Claim"].lateScalars), []);
	assert.deepEqual(plain(recovery.SNAPSHOT_FIELDS["Expense Claim"].contentTables), ["expenses"]);
	const mine = registrationsFor(registrations, "Expense Claim");
	assert.equal(mine.length, 1);
	assert.equal(typeof mine[0].handlers.refresh, "function");

	// a new claim with an expense row but no employee yet is worth keeping: the rows are the work
	const claim = makeClaim("new-expense-claim-1", {
		company: "YS",
		expenses: [{ expense_type: "Travel", amount: 42, description: "Taxi", idx: 1 }, { idx: 2 }],
	});
	assert.equal(recovery.snapshotForm(claim), true);
	const saved = JSON.parse(
		sandbox.localStorage.getItem(recovery.storageKey("Expense Claim", recovery.NEW_DOC_NAME))
	);
	assert.equal(saved.doctype, "Expense Claim");
	assert.deepEqual(saved.scalars, { company: "YS" });
	assert.deepEqual(saved.childTables, {
		expenses: [{ expense_type: "Travel", amount: 42, description: "Taxi" }],
	});

	// nothing of the person's own yet: no snapshot
	const empty = makeClaim("new-expense-claim-2", { company: "YS", expenses: [] });
	assert.equal(recovery.snapshotForm(empty), false);
});

test("registerDraftRecovery counts only the app's named content tables as work", () => {
	const { sandbox } = makeSandbox();
	sandbox.frappe.get_route = () => ["Form", "Expense Claim", "new-expense-claim-1"];
	const adhd = run(sandbox, "adhd_draft_recovery.js");
	const recovery = adhd.draftRecovery;

	// without contentTables the default is the `items` table, which a claim does not have
	const { contentTables, ...withoutContentTables } = EXPENSE_CLAIM_SNAPSHOT;
	assert.equal(contentTables.length, 1);
	assert.equal(adhd.registerDraftRecovery("Expense Claim", withoutContentTables), true);
	const claim = makeClaim("new-expense-claim-1", {
		company: "YS",
		expenses: [{ expense_type: "Travel", amount: 42, description: "Taxi" }],
	});
	assert.equal(recovery.snapshotForm(claim), false);
	const withEmployee = makeClaim("new-expense-claim-1", {
		company: "YS",
		employee: "HR-EMP-1",
		expenses: [],
	});
	assert.equal(recovery.snapshotForm(withEmployee), true);
});

test("registerDraftRecovery refuses names that are not plain field names, and a doctype already covered", () => {
	const { sandbox, registrations } = makeSandbox();
	const adhd = run(sandbox, "adhd_draft_recovery.js");
	const base = { party: ["employee"], scalars: ["company"], tables: { expenses: EXPENSES_TABLE } };

	for (const bad of [
		{ ...base, party: ["__proto__"] },
		{ ...base, scalars: ["company", "a b"] },
		{ ...base, lateScalars: ["Total"] },
		{ ...base, tables: { "expenses.rows": EXPENSES_TABLE } },
		{ ...base, tables: { expenses: { ...EXPENSES_TABLE, fields: ["amount", "toString()"] } } },
		{ ...base, tables: { expenses: { ...EXPENSES_TABLE, identity: "expense_type" } } },
		{ ...base, tables: { expenses: { identity: ["expense_type"], fields: ["amount"] } } },
		{ ...base, contentTables: ["Expenses"] },
		{ party: ["employee"], scalars: ["company"] },
		{ ...base, party: "employee" },
		null,
	]) {
		assert.equal(adhd.registerDraftRecovery("Expense Claim", bad), false, JSON.stringify(bad));
	}
	assert.equal(Object.hasOwn(adhd.draftRecovery.SNAPSHOT_FIELDS, "Expense Claim"), false);
	assert.equal(adhd.draftRecovery.RECOVERY_DOCTYPES.includes("Expense Claim"), false);
	assert.equal(registrationsFor(registrations, "Expense Claim").length, 0);

	// the built-in forms cannot be redefined from outside, and a doctype is registered once
	assert.equal(adhd.registerDraftRecovery("Sales Order", base), false);
	assert.deepEqual(plain(adhd.draftRecovery.SNAPSHOT_FIELDS["Sales Order"].party), ["customer"]);
	assert.equal(adhd.registerDraftRecovery("Expense Claim", base), true);
	assert.equal(adhd.registerDraftRecovery("Expense Claim", base), false);
	assert.equal(registrationsFor(registrations, "Expense Claim").length, 1);
	assert.equal(registrationsFor(registrations, "Sales Order").length, 1);
});
