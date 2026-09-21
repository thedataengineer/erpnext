const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const jsRoot = path.join(appRoot, "public/js/adhd");
const read = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeSandbox(overrides = {}) {
	const registrations = [];
	const sandbox = {
		console,
		Date,
		Map,
		Promise,
		Set,
		setTimeout,
		clearTimeout,
		setInterval: () => 0,
		clearInterval() {},
		window: {},
		document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.replace(`{${index}}`, value), text),
		cint: (value) => parseInt(value, 10) || 0,
		$: () => {
			throw new Error("$ is not stubbed for this test");
		},
		frappe: {
			boot: { adhd_mode: true },
			provide() {},
			after_ajax() {},
			pages: {},
			router: { on() {} },
			show_alert() {},
			ui: { form: { on: (doctype, handlers) => registrations.push({ doctype, handlers }) } },
			utils: { escape_html: (value) => String(value) },
		},
		erpnext: { adhd: {} },
		...overrides,
	};
	return { sandbox, registrations };
}

function run(sandbox, name, dir = jsRoot) {
	vm.runInNewContext(fs.readFileSync(path.join(dir, name), "utf8"), sandbox, { filename: name });
}

// ---- item 3: the list view helpers -------------------------------------------------------

function loadListView() {
	const { sandbox } = makeSandbox();
	sandbox.$ = () => ({ length: 0, appendTo() {} });
	run(sandbox, "adhd_list_view.js");
	return sandbox.erpnext.adhd;
}

test("the list on screen is cur_list, and only for a List route of the same doctype", () => {
	const adhd = loadListView();
	const list = { doctype: "Task" };
	assert.equal(adhd.resolveCurrentList(["List", "Task", "List"], list), list);
	assert.equal(adhd.resolveCurrentList(["List", "Task"], list), list);
	assert.equal(adhd.resolveCurrentList(["Form", "Task", "TASK-1"], list), null);
	assert.equal(adhd.resolveCurrentList(["List", "Project"], list), null);
	assert.equal(adhd.resolveCurrentList(["List", "Task"], null), null);
});

test("heat map fields are added as [fieldname, doctype] pairs, never as bare strings", () => {
	const adhd = loadListView();
	const listview = { doctype: "Task", fields: [["name", "Task"]] };
	assert.equal(adhd.hasListField(listview, "name"), true);
	assert.equal(adhd.hasListField(listview, "exp_end_date"), false);
	assert.equal(adhd.ensureListField(listview, "exp_end_date"), true);
	assert.equal(listview.fields.length, 2);
	assert.ok(Array.isArray(listview.fields[1]));
	assert.equal(listview.fields[1][0], "exp_end_date");
	assert.equal(listview.fields[1][1], "Task");
	// already present: nothing added, no refresh needed
	assert.equal(adhd.ensureListField(listview, "exp_end_date"), false);
	assert.equal(listview.fields.length, 2);
});

test("a field the doctype does not have is not forced into the fetch set", () => {
	const adhd = loadListView();
	const listview = { doctype: "Leave Application", fields: [], _add_field() {} };
	assert.equal(adhd.ensureListField(listview, "to_date"), false);
	assert.equal(listview.fields.length, 0);
});

// ---- item 4: the chain navigator ---------------------------------------------------------

function loadChain(linkedDocs = {}) {
	const state = { linkedDocs, docstatus: 0, xcalls: 0, getValues: 0, navs: [], clicks: [], opened: [] };
	const { sandbox, registrations } = makeSandbox();
	sandbox.$ = (html) => {
		const el = {
			append() {
				return el;
			},
			addClass() {
				return el;
			},
			attr() {
				return el;
			},
			text() {
				return el;
			},
			prop() {
				return el;
			},
			on(event, handler) {
				if (String(html).includes("adhd-chain-next")) state.clicks.push(handler);
				return el;
			},
		};
		return el;
	};
	sandbox.frappe.xcall = async () => {
		state.xcalls += 1;
		return state.linkedDocs;
	};
	sandbox.frappe.db = {
		get_value: async () => {
			state.getValues += 1;
			return { message: { docstatus: state.docstatus } };
		},
	};
	sandbox.frappe.model = { open_mapped_doc: (opts) => state.opened.push(opts) };
	sandbox.frappe.new_doc = () => {};
	run(sandbox, "adhd_chain_navigator.js");
	const handlers = (doctype) => registrations.find((entry) => entry.doctype === doctype).handlers;
	return { state, sandbox, adhd: sandbox.erpnext.adhd, handlers };
}

function makeChainForm(state, doctype, name) {
	const $wrapper = {
		find(selector) {
			if (selector === ".adhd-chain-nav") return { remove: () => (state.navs.length = 0) };
			if (selector === ".form-page") {
				return { first: () => ({ length: 1, before: ($nav) => state.navs.push($nav) }) };
			}
			return { first: () => ({ length: 0 }) };
		},
		prepend: ($nav) => state.navs.push($nav),
	};
	return { doctype, docname: name, doc: { doctype, name, docstatus: 1 }, $wrapper };
}

test("only one chain nav is inserted when after_save is followed by refresh", async () => {
	const { state, handlers } = loadChain();
	const frm = makeChainForm(state, "Sales Order", "SO-1");
	handlers("Sales Order").after_save(frm);
	handlers("Sales Order").refresh(frm);
	await tick();
	assert.equal(state.navs.length, 1);
});

test("the linked-document cache is dropped on refresh, submit and cancel", async () => {
	const { state, handlers } = loadChain();
	const frm = makeChainForm(state, "Sales Order", "SO-1");
	const events = handlers("Sales Order");
	events.refresh(frm);
	await tick();
	assert.equal(state.xcalls, 1);
	events.refresh(frm);
	await tick();
	assert.equal(state.xcalls, 2);
	events.on_submit(frm);
	await tick();
	assert.equal(state.xcalls, 3);
	events.after_cancel(frm);
	await tick();
	assert.equal(state.xcalls, 4);
});

test("docstatus that linked_with already returned is used without another lookup", async () => {
	const { state, adhd } = loadChain();
	const frm = makeChainForm(state, "Quotation", "QTN-1");
	const submitted = { "Sales Order": { docs: [{ name: "SO-1", docstatus: 1 }] } };
	assert.equal(await adhd.getStepStatus(frm, { doctype: "Sales Order" }, submitted), "done");
	const draft = { "Sales Order": { docs: [{ name: "SO-2", docstatus: 0 }] } };
	assert.equal(await adhd.getStepStatus(frm, { doctype: "Sales Order" }, draft), "pending");
	assert.equal(state.getValues, 0);
});

test("a Quotation maps Delivery Note and Sales Invoice from its submitted Sales Order", async () => {
	const { state, adhd } = loadChain({ "Sales Order": { docs: [{ name: "SO-1", docstatus: 1 }] } });
	const quotation = makeChainForm(state, "Quotation", "QTN-1");
	const steps = adhd.CHAIN_MAP.Quotation;
	const deliveryNote = steps.find((step) => step.doctype === "Delivery Note");
	const salesInvoice = steps.find((step) => step.doctype === "Sales Invoice");
	assert.equal(deliveryNote.source_doctype, "Sales Order");
	assert.equal(salesInvoice.source_doctype, "Sales Order");

	const source = await adhd.resolveMapSource(quotation, deliveryNote);
	assert.equal(source.source_name, "SO-1");
	assert.equal(source.frm, undefined);

	// from the Sales Order itself the form is the source
	const order = makeChainForm(state, "Sales Order", "SO-1");
	const orderStep = adhd.CHAIN_MAP["Sales Order"].find((step) => step.doctype === "Delivery Note");
	assert.equal((await adhd.resolveMapSource(order, orderStep)).frm, order);

	// nothing submitted yet: no source, so nothing is offered to map
	state.linkedDocs = { "Sales Order": { docs: [{ name: "SO-1", docstatus: 0 }] } };
	adhd.invalidateChainCaches();
	assert.equal(await adhd.resolveMapSource(quotation, deliveryNote), null);
});

test("Create Next Step on a Quotation hands the mapper the Sales Order name", async () => {
	const { state, handlers } = loadChain({ "Sales Order": { docs: [{ name: "SO-1", docstatus: 1 }] } });
	const quotation = makeChainForm(state, "Quotation", "QTN-1");
	handlers("Quotation").refresh(quotation);
	await tick();
	assert.equal(state.clicks.length, 1);
	await state.clicks[0]();
	assert.equal(state.opened.length, 1);
	assert.match(state.opened[0].method, /sales_order\.mapper\.make_delivery_note$/);
	assert.equal(state.opened[0].source_name, "SO-1");
	assert.equal(state.opened[0].frm, undefined);
});

// ---- item 5: task board ------------------------------------------------------------------

test("task board asks for limit_page_length and does not register itself as a page", async () => {
	const { sandbox } = makeSandbox();
	run(sandbox, "task_kanban.js");
	assert.equal(sandbox.frappe.pages["focus-task-board"], undefined);

	const calls = [];
	sandbox.frappe.call = async (options) => {
		calls.push(options.args);
		return { message: [] };
	};
	const board = Object.create(sandbox.erpnext.adhd.TaskKanban.prototype);
	board.columns = [];
	board.tasks = [];
	await board._loadTasks();
	await board._loadProjects();
	const taskArgs = calls.find((args) => args.doctype === "Task");
	const projectArgs = calls.find((args) => args.doctype === "Project");
	assert.equal(taskArgs.limit_page_length, 100);
	assert.equal(taskArgs.limit, undefined);
	assert.equal(projectArgs.limit_page_length, 50);
	assert.equal(projectArgs.limit, undefined);
});

function loadTaskBoardPage({ active }) {
	const state = { enabled: 0, built: 0, refreshed: 0, texts: [], stateChange: null };
	const { sandbox } = makeSandbox();
	sandbox.frappe.boot.adhd_mode = active;
	sandbox.frappe.pages["focus-task-board"] = {};
	sandbox.frappe.get_route_str = () => "focus-task-board";
	const body = { empty() {} };
	sandbox.frappe.ui.make_app_page = () => ({ body });
	const chain = () => {
		const el = {
			css: () => el,
			append: () => el,
			appendTo: () => el,
			text(value) {
				state.texts.push(value);
				return el;
			},
			0: {},
		};
		return el;
	};
	sandbox.$ = chain;
	sandbox.erpnext.adhd.enable = () => (state.enabled += 1);
	sandbox.erpnext.adhd.isActive = () => Boolean(sandbox.frappe.boot.adhd_mode);
	sandbox.erpnext.adhd.onStateChange = (fn) => {
		state.stateChange = fn;
		fn(sandbox.frappe.boot.adhd_mode);
	};
	sandbox.erpnext.adhd.TaskKanban = class {
		constructor() {
			state.built += 1;
		}
		refresh() {
			state.refreshed += 1;
		}
	};
	run(sandbox, "focus_task_board.js", path.join(appRoot, "setup/page/focus_task_board"));
	return { state, sandbox, page: sandbox.frappe.pages["focus-task-board"] };
}

test("the task board page shows a how-to when ADHD mode is off and never enables it", () => {
	const { state, sandbox, page } = loadTaskBoardPage({ active: false });
	page.on_page_load({});
	page.on_page_show();
	assert.equal(state.enabled, 0);
	assert.equal(state.built, 0);
	assert.ok(state.texts.some((text) => text.includes("Alt+A")));
	assert.equal(sandbox.frappe.boot.adhd_mode, false);
});

test("the task board page builds the board once and refreshes it on later visits", () => {
	const { state, page } = loadTaskBoardPage({ active: true });
	page.on_page_load({});
	page.on_page_show();
	assert.equal(state.built, 1);
	page.on_page_show();
	assert.equal(state.built, 1);
	assert.equal(state.refreshed, 1);
});

test("the task board page json is a standard Setup page for Desk User", () => {
	const dir = path.join(appRoot, "setup/page/focus_task_board");
	const page = JSON.parse(fs.readFileSync(path.join(dir, "focus_task_board.json"), "utf8"));
	assert.equal(page.name, "focus-task-board");
	assert.equal(page.module, "Setup");
	assert.equal(page.standard, "Yes");
	assert.deepEqual(
		page.roles.map((row) => row.role),
		["Desk User"]
	);
	assert.ok(fs.existsSync(path.join(dir, "__init__.py")));
	assert.ok(fs.existsSync(path.join(dir, "focus_task_board.py")));
});

// ---- item 6: guided save -----------------------------------------------------------------

function loadWizard() {
	const state = { saves: [], resolveSave: null, banners: [] };
	const { sandbox, registrations } = makeSandbox();
	sandbox.$ = () => {
		const banner = {
			handlers: {},
			find(selector) {
				return { on: (event, handler) => (banner.handlers[selector] = handler) };
			},
		};
		state.banners.push(banner);
		return banner;
	};
	function Form() {}
	Form.prototype.save = function (...args) {
		state.saves.push(args);
		return new Promise((resolve) => (state.resolveSave = resolve));
	};
	sandbox.frappe.ui.form.Form = Form;
	run(sandbox, "adhd_form_wizard.js");

	const frm = Object.create(Form.prototype);
	frm.doctype = "Task";
	frm.doc = { name: "TASK-1" };
	frm.meta = { fields: [{ fieldname: "subject", label: "Subject", reqd: 1 }] };
	frm.layout = { wrapper: { find: () => ({ remove() {} }), prepend() {} } };
	frm.get_field = () => ({ $input: null });
	frm.scroll_to_field = () => {};
	const save = (...args) => {
		const promise = Form.prototype.save.apply(frm, args);
		promise.catch(() => null);
		return promise;
	};
	const wildcard = registrations.find((entry) => entry.doctype === "*")?.handlers;
	return { state, frm, save, wildcard };
}

test("guided save resolves only when the real save has finished", async () => {
	const { state, save } = loadWizard();
	let settled = false;
	const promise = save("Save").then(() => (settled = true));
	await tick();
	assert.equal(state.saves.length, 0);
	assert.equal(settled, false);

	// answer the only missing field by skipping it: the wizard now runs the real save
	state.banners.at(-1).handlers[".adhd-wizard-skip"]();
	assert.equal(state.saves.length, 1);
	await tick();
	assert.equal(settled, false);

	state.resolveSave();
	await promise;
	assert.equal(settled, true);
});

test("a cancelled guided save rejects instead of pretending it saved", async () => {
	const { state, save } = loadWizard();
	let outcome = "pending";
	save("Save").then(
		() => (outcome = "resolved"),
		() => (outcome = "rejected")
	);
	state.banners.at(-1).handlers[".adhd-wizard-cancel"]();
	await tick();
	assert.equal(outcome, "rejected");
	assert.equal(state.saves.length, 0);
});

test("one cancel does not switch the wizard off for the rest of the session", async () => {
	const { state, frm, save, wildcard } = loadWizard();
	save("Save");
	state.banners.at(-1).handlers[".adhd-wizard-cancel"]();
	await tick();

	// still cancelled while the same fields are missing: the real save runs straight away
	const shown = state.banners.length;
	save("Save");
	assert.equal(state.saves.length, 1);
	assert.equal(state.banners.length, shown);

	// the next refresh (a load, a save, a reload) clears the cancel
	wildcard?.refresh(frm);
	save("Save");
	assert.equal(state.banners.length, shown + 1);
	assert.equal(state.saves.length, 1);
});

test("a cancel is forgotten when the set of missing required fields changes", async () => {
	const { state, frm, save } = loadWizard();
	save("Save");
	state.banners.at(-1).handlers[".adhd-wizard-cancel"]();
	await tick();

	frm.meta.fields.push({ fieldname: "project", label: "Project", reqd: 1 });
	const shown = state.banners.length;
	save("Save");
	assert.equal(state.banners.length, shown + 1);
	assert.equal(state.saves.length, 0);
});

// ---- item 7: field help ------------------------------------------------------------------

test("every canonical help key exists on the doctype it describes", () => {
	const { sandbox } = makeSandbox();
	sandbox.window = {};
	run(sandbox, "adhd_field_help.js");
	const help = sandbox.erpnext.adhd.FIELD_HELP;
	const doctypeJson = {
		"Sales Invoice": "accounts/doctype/sales_invoice/sales_invoice.json",
		"Purchase Order": "buying/doctype/purchase_order/purchase_order.json",
		"Payment Entry": "accounts/doctype/payment_entry/payment_entry.json",
		"Work Order": "manufacturing/doctype/work_order/work_order.json",
		BOM: "manufacturing/doctype/bom/bom.json",
		"Stock Entry": "stock/doctype/stock_entry/stock_entry.json",
		"Journal Entry": "accounts/doctype/journal_entry/journal_entry.json",
	};
	// Salary Slip belongs to HRMS, which is not part of this repository
	for (const [doctype, file] of Object.entries(doctypeJson)) {
		const meta = JSON.parse(fs.readFileSync(path.join(appRoot, file), "utf8"));
		const fieldnames = new Set(meta.fields.map((field) => field.fieldname));
		const missing = Object.keys(help[doctype]).filter((key) => !fieldnames.has(key));
		assert.deepEqual(missing, [], `${doctype} has help for fields it does not have`);
	}
	assert.equal(typeof help["Payment Entry"].paid_from, "string");
	assert.equal(typeof help["Payment Entry"].paid_to, "string");
});

// ---- items 1, 2 and 8: form focus --------------------------------------------------------

function loadFormFocus({ active = true } = {}) {
	const state = { active, serverCalls: 0, shown: [], bound: 0, unbound: 0, badges: [], fieldname: "" };
	const { sandbox } = makeSandbox();
	sandbox.erpnext.adhd.FIELD_HELP = { Task: { subject: "Canonical help" } };
	sandbox.erpnext.adhd.isActive = () => state.active;
	sandbox.frappe.call = () => (state.serverCalls += 1);
	sandbox.frappe.get_meta = () => ({
		fields: [{ fieldname: "notes", description: "Notes help" }, { fieldname: "plain" }],
	});
	const store = new Map();
	const control = {
		data(key, value) {
			if (value !== undefined) {
				store.set(key, value);
				return control;
			}
			return key === "fieldname" ? state.fieldname : store.get(key);
		},
		find: () => ({ remove() {} }),
		removeData: (key) => store.delete(key),
	};
	sandbox.$ = (arg) => {
		if (typeof arg === "string") {
			const tip = {
				text(value) {
					tip.value = value;
					return tip;
				},
				addClass: () => tip,
				appendTo() {
					state.shown.push(tip.value);
					return tip;
				},
			};
			return tip;
		}
		return { closest: () => control, on() {}, off() {} };
	};
	run(sandbox, "form_focus.js");

	const handlers = {};
	const breadcrumb = {
		length: 1,
		find: () => ({ text() {}, replaceWith: (html) => state.badges.push(html) }),
	};
	const classes = new Set();
	const $wrapper = {
		hasClass: (name) => classes.has(name),
		addClass(name) {
			classes.add(name);
			return $wrapper;
		},
		find: (selector) =>
			selector === ".adhd-breadcrumb" ? breadcrumb : { length: 0, first: () => ({ before() {} }) },
		on(event, selector, handler) {
			handlers[event.split(".")[0]] = handler;
			state.bound += 1;
			return $wrapper;
		},
		off() {
			state.unbound += 1;
			return $wrapper;
		},
	};
	const frm = {
		doctype: "Task",
		docname: "TASK-1",
		doc: { docstatus: 1 },
		is_new: () => false,
		$wrapper,
	};
	return { state, frm, handlers, focusFormFocus: new sandbox.erpnext.adhd.FormFocus() };
}

test("form focus never autosaves through the server", () => {
	const source = read("form_focus.js");
	assert.doesNotMatch(source, /frm\.save\(/);
	assert.doesNotMatch(source, /setInterval/);
	assert.doesNotMatch(source, /_adhd_autosave/);
});

test("field help falls back to the client meta and makes no server call", () => {
	const { state, frm, handlers, focusFormFocus } = loadFormFocus();
	focusFormFocus._applyToCurrentForm(frm);
	state.fieldname = "notes";
	handlers.focusin({ currentTarget: {} });
	assert.deepEqual(Array.from(state.shown), ["Notes help"]);
	assert.equal(state.serverCalls, 0);
});

test("field help does nothing while ADHD mode is off, and is unbound when it turns off", () => {
	const { state, frm, handlers, focusFormFocus } = loadFormFocus();
	focusFormFocus._applyToCurrentForm(frm);
	state.active = false;
	state.fieldname = "notes";
	handlers.focusin({ currentTarget: {} });
	assert.equal(state.shown.length, 0);
	assert.equal(state.serverCalls, 0);

	focusFormFocus.disable();
	assert.equal(state.unbound, 1);
	assert.equal(frm._adhdHelpBound, false);
});

test("a form is enhanced once, and its breadcrumb badge follows the document status", () => {
	const { state, frm, focusFormFocus } = loadFormFocus();
	focusFormFocus._applyToCurrentForm(frm);
	focusFormFocus._applyToCurrentForm(frm);
	assert.equal(state.bound, 2, "focusin and focusout are bound once, not on every re-render");
	assert.equal(state.badges.length, 2);
	assert.match(state.badges[0], /submitted/);

	frm.doc.docstatus = 0;
	focusFormFocus._applyToCurrentForm(frm);
	assert.match(state.badges[2], /draft/);
});

test("the unreferenced public/js/form_focus.js module is gone", () => {
	assert.equal(fs.existsSync(path.join(appRoot, "public/js/form_focus.js")), false);
});
