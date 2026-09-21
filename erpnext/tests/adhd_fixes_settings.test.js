const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const jsRoot = path.join(appRoot, "public/js/adhd");
const pageRoot = path.join(appRoot, "setup/page/adhd_task_board");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The ADHD Settings panel has a switch for each feature below; these are the six that the features named
// here must honour. Their defaults are the ones in adhd_settings.js (the payment digest is off until turned on).
const DEFAULTS = {
	pomodoro: true,
	task_kanban: true,
	due_date_heatmap: true,
	form_banners: true,
	mandatory_wizard: true,
	payment_digest: false,
};

// Any jQuery-style call returns the same empty collection.
function makeChain() {
	const chain = new Proxy(function () {}, {
		get: (_target, key) => (key === "length" ? 0 : () => chain),
	});
	return chain;
}

// The settings module (get/set/reset) and the way it tells the page: jQuery's trigger() on `document`, so a
// feature hears it only through $(document).on(...). set() and reset() return what the handlers return.
function makeEnv(initial = {}) {
	const values = { ...DEFAULTS, ...initial };
	const listeners = [];
	const trigger = (event, detail) =>
		Promise.all(listeners.filter((item) => item.event === event).map((item) => item.handler({}, detail)));
	const settings = {
		opened: 0,
		get: (key) => Boolean(values[key]),
		set(key, value) {
			values[key] = Boolean(value);
			return trigger("adhd_setting_changed", { key, value: Boolean(value) });
		},
		reset() {
			Object.assign(values, DEFAULTS);
			return trigger("adhd_settings_reset");
		},
		openPanel() {
			settings.opened += 1;
		},
	};
	// $ for a sandbox: $(document) is the event bus, anything else goes to `fallback`
	const dollar =
		(document, fallback = () => makeChain()) =>
		(target, ...rest) =>
			target === document
				? {
						on(events, handler) {
							events.split(/\s+/).forEach((event) => listeners.push({ event, handler }));
							return this;
						},
				  }
				: fallback(target, ...rest);
	return { settings, values, dollar, listenerCount: () => listeners.length };
}

const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text);

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

function run(file, sandbox, dir = jsRoot) {
	vm.runInNewContext(fs.readFileSync(path.join(dir, file), "utf8"), sandbox, { filename: file });
}

// ---- pomodoro: the focus timer in the Focus Panel -----------------------------------------------------

function fakeElement(id) {
	return {
		id,
		textContent: "",
		innerHTML: "",
		value: "",
		checked: false,
		hidden: false,
		dataset: {},
		style: {},
		classList: { add() {}, remove() {}, contains: () => false },
		addEventListener() {},
		querySelectorAll: () => [],
		remove() {},
	};
}

function loadFocusPanel(initial) {
	const env = makeEnv(initial);
	const elements = new Map();
	const appended = [];
	const stateCallbacks = [];
	const calls = [];
	const intervals = [];
	const cleared = [];
	const alerts = [];
	const notification = { permission: "default", asked: 0 };
	notification.requestPermission = () => (notification.asked += 1);
	const document = {
		body: { appendChild: (element) => appended.push(element) },
		getElementById(id) {
			if (id === "adhd-focus-panel") return null;
			if (!elements.has(id)) elements.set(id, fakeElement(id));
			return elements.get(id);
		},
		createElement: () => fakeElement("created"),
		querySelector: () => null,
		querySelectorAll: () => [],
	};
	const sandbox = {
		console,
		document,
		Notification: notification,
		localStorage: new FakeStorage(),
		setInterval: (fn, ms) => intervals.push({ fn, ms }),
		clearInterval: (id) => cleared.push(id),
		setTimeout,
		__: translate,
		$: env.dollar(document),
		window: { ADHDSettings: env.settings },
		frappe: {
			provide() {},
			session: { user: "ann@example.com" },
			call: async (options) => {
				calls.push(options);
				return { message: [] };
			},
			show_alert: (options) => alerts.push(options),
			msgprint() {},
			datetime: { prettyDate: (value) => String(value) },
			utils: { escape_html: (value) => String(value), get_form_link: () => "#" },
		},
		erpnext: {
			adhd: {
				ADHDSettings: env.settings,
				isActive: () => true,
				onStateChange: (fn) => stateCallbacks.push(fn),
			},
		},
	};
	run("focus_panel.js", sandbox);
	// ADHD mode goes on: the panel is built and shown
	stateCallbacks[0](true);
	return {
		env,
		sandbox,
		panel: sandbox.erpnext.adhd.focusPanel,
		elements,
		intervals,
		cleared,
		alerts,
		notification,
		calls,
	};
}

test("pomodoro on (the default): the timer is shown and Start runs it", () => {
	const { panel, elements, intervals, notification } = loadFocusPanel();
	// the section is never hidden, whatever id it has
	assert.notEqual(elements.get("afp-timer-section")?.hidden, true);
	assert.notEqual(elements.get("afp-timer-section")?.style.display, "none");
	assert.equal(notification.asked, 1);

	panel._timerToggle();
	assert.equal(panel.timerRunning, true);
	assert.equal(intervals.length, 1);
	assert.equal(intervals[0].ms, 1000);
});

test("pomodoro off: the timer is hidden, Start does nothing and no notification permission is asked", async () => {
	const { panel, elements, intervals, notification, calls } = loadFocusPanel({ pomodoro: false });
	const section = elements.get("afp-timer-section");
	assert.equal(section.hidden, true);
	assert.equal(section.style.display, "none");
	assert.equal(notification.asked, 0);

	panel._timerToggle();
	panel._timerStart();
	assert.equal(panel.timerRunning, false);
	assert.equal(intervals.length, 0);

	// the rest of the panel still works
	await sleep(0);
	assert.ok(calls.some((call) => call.method === "frappe.client.get_list"));
});

test("switching pomodoro off stops a running timer and hides it, and switching it on brings it back", async () => {
	const { env, panel, elements, intervals, cleared, alerts } = loadFocusPanel();
	panel._timerToggle();
	assert.equal(panel.timerRunning, true);
	panel.timerSeconds = 600;

	await env.settings.set("pomodoro", false);
	assert.equal(panel.timerRunning, false);
	assert.equal(panel.timerSeconds, 25 * 60);
	assert.ok(cleared.includes(1));
	assert.equal(elements.get("afp-timer-section").hidden, true);
	assert.equal(elements.get("afp-timer-section").style.display, "none");
	panel._timerToggle();
	assert.equal(panel.timerRunning, false);
	assert.equal(intervals.length, 1);
	assert.equal(alerts.length, 0);

	await env.settings.set("pomodoro", true);
	assert.equal(elements.get("afp-timer-section").hidden, false);
	assert.equal(elements.get("afp-timer-section").style.display, "");
	panel._timerToggle();
	assert.equal(panel.timerRunning, true);
	assert.equal(intervals.length, 2);
});

test("a reset to defaults that turns pomodoro back on shows the timer again", async () => {
	const { env, elements } = loadFocusPanel({ pomodoro: false });
	assert.equal(elements.get("afp-timer-section").hidden, true);
	await env.settings.reset();
	assert.equal(elements.get("afp-timer-section").hidden, false);
});

test("a tick after pomodoro was switched off elsewhere neither counts down nor announces the end", () => {
	const { env, panel, intervals, alerts } = loadFocusPanel();
	panel._timerToggle();
	panel.timerSeconds = 1;
	// another tab switched it off: no event reached this page
	env.values.pomodoro = false;
	intervals[0].fn();
	assert.equal(panel.timerRunning, false);
	assert.equal(panel.timerSeconds, 25 * 60);
	assert.equal(alerts.length, 0);
});

// ---- task_kanban: the Task Board page and the board -----------------------------------------------------

function loadTaskBoardPage({ mode = true, ...initial } = {}) {
	const env = makeEnv(initial);
	const state = { built: 0, refreshed: 0, texts: [], clicks: [] };
	const document = {};
	const chain = () => {
		const el = {
			css: () => el,
			append: () => el,
			appendTo: () => el,
			text(value) {
				state.texts.push(value);
				return el;
			},
			on(_event, handler) {
				state.clicks.push(handler);
				return el;
			},
			0: {},
		};
		return el;
	};
	const sandbox = {
		console,
		document,
		__: translate,
		$: env.dollar(document, chain),
		window: { ADHDSettings: env.settings },
		frappe: {
			boot: { adhd_mode: mode },
			pages: { "adhd-task-board": {} },
			get_route_str: () => "adhd-task-board",
			ui: { make_app_page: () => ({ body: { empty() {} } }) },
		},
		erpnext: {
			adhd: {
				ADHDSettings: env.settings,
				isActive: () => mode,
				onStateChange: (fn) => fn(mode),
				TaskKanban: class {
					constructor() {
						state.built += 1;
					}
					refresh() {
						state.refreshed += 1;
					}
				},
			},
		},
	};
	run("adhd_task_board.js", sandbox, pageRoot);
	const page = sandbox.frappe.pages["adhd-task-board"];
	page.on_page_load({});
	page.on_page_show();
	return { env, sandbox, state, page };
}

test("task board on (the default): the page builds the board", () => {
	const { state } = loadTaskBoardPage();
	assert.equal(state.built, 1);
});

test("task board off: the page says it is switched off in ADHD Settings, says how to switch it on, and builds nothing", () => {
	const { env, sandbox, state } = loadTaskBoardPage({ task_kanban: false });
	assert.equal(state.built, 0);
	assert.ok(state.texts.some((text) => /switched off in ADHD Settings/.test(text)));
	assert.ok(state.texts.some((text) => /right-click.*Focus button.*Task Kanban View/.test(text)));
	assert.ok(!sandbox.erpnext.adhd.taskKanban);
	// it never switches the setting on for the person
	assert.equal(env.values.task_kanban, false);

	// the button in the message opens the settings panel
	state.clicks[0]();
	assert.equal(env.settings.opened, 1);
});

test("task board follows the switch while its page is open", async () => {
	const { env, sandbox, state } = loadTaskBoardPage({ task_kanban: false });
	await env.settings.set("task_kanban", true);
	assert.equal(state.built, 1);
	assert.ok(sandbox.erpnext.adhd.taskKanban);

	const messages = state.texts.length;
	await env.settings.set("task_kanban", false);
	assert.equal(state.built, 1);
	assert.equal(sandbox.erpnext.adhd.taskKanban, null);
	assert.ok(state.texts.length > messages);
	assert.ok(state.texts.slice(messages).some((text) => /switched off in ADHD Settings/.test(text)));

	// another setting changing does not rebuild the page
	const texts = state.texts.length;
	await env.settings.set("pomodoro", false);
	assert.equal(state.texts.length, texts);
});

function loadKanban(initial) {
	const env = makeEnv(initial);
	const calls = [];
	const rendered = [];
	const sandbox = {
		console,
		document: { getElementById: () => null, querySelectorAll: () => [] },
		__: translate,
		$: (target) => {
			rendered.push(target);
			return makeChain();
		},
		window: { ADHDSettings: env.settings },
		frappe: {
			provide() {},
			call: async (options) => {
				calls.push(options);
				return { message: [] };
			},
			utils: { escape_html: (value) => String(value) },
		},
		erpnext: { adhd: { ADHDSettings: env.settings } },
	};
	run("task_kanban.js", sandbox);
	return { env, sandbox, calls, rendered };
}

test("task kanban on: the board is drawn and loads tasks and projects", async () => {
	const { sandbox, calls, rendered } = loadKanban();
	new sandbox.erpnext.adhd.TaskKanban({});
	await sleep(0);
	assert.ok(rendered.length > 0);
	assert.ok(calls.some((call) => call.args.doctype === "Task"));
	assert.ok(calls.some((call) => call.args.doctype === "Project"));
});

test("task kanban off: the board is not drawn, and neither its constructor nor a refresh asks the server", async () => {
	const { env, sandbox, calls, rendered } = loadKanban({ task_kanban: false });
	const board = new sandbox.erpnext.adhd.TaskKanban({});
	await board.refresh();
	await sleep(0);
	assert.equal(rendered.length, 0);
	assert.equal(calls.length, 0);

	// a board that was on screen when the switch went off stops fetching
	await env.settings.set("task_kanban", true);
	const live = new sandbox.erpnext.adhd.TaskKanban({});
	await sleep(0);
	const before = calls.length;
	assert.ok(before > 0);
	await env.settings.set("task_kanban", false);
	await live.refresh();
	assert.equal(calls.length, before);
});

// ---- due_date_heatmap: the list heat map ------------------------------------------------------------

// A jQuery-like collection of fake rows, with just what adhd_list_view.js does to them
function makeCollection(elements) {
	const collection = {
		length: elements.length,
		filter: (fn) => makeCollection(elements.filter((element, index) => fn(index, element))),
		first: () => makeCollection(elements.slice(0, 1)),
		removeClass(names) {
			elements.forEach((element) => names.split(" ").forEach((name) => element.classes.delete(name)));
			return collection;
		},
		addClass(names) {
			elements.forEach((element) => names.split(" ").forEach((name) => element.classes.add(name)));
			return collection;
		},
		attr(name, value) {
			elements.forEach((element) => (element.attrs[name] = value));
			return collection;
		},
		removeAttr(name) {
			elements.forEach((element) => delete element.attrs[name]);
			return collection;
		},
		find: () => makeCollection([]),
		map: (fn) => ({ get: () => elements.map((element, index) => fn(index, element)) }),
		each(fn) {
			elements.forEach((element, index) => fn(index, element));
			return collection;
		},
	};
	return collection;
}

function loadListView(doctype, data, initial) {
	const env = makeEnv(initial);
	const observers = [];
	const intervals = [];
	const calls = [];
	const routerHandlers = [];
	class MutationObserver {
		constructor(callback) {
			this.callback = callback;
			this.observing = false;
			this.disconnected = false;
			observers.push(this);
		}
		observe() {
			this.observing = true;
		}
		disconnect() {
			this.disconnected = true;
		}
	}
	const rows = data.map((row) => ({
		dataset: { name: row.name },
		getAttribute: (attribute) => (attribute === "data-name" ? row.name : null),
		classes: new Set(),
		attrs: {},
	}));
	const listview = {
		doctype,
		view: "List",
		data,
		fields: [],
		rows,
		refreshed: 0,
		added: [],
		init_promise: Promise.resolve(),
		$result: { 0: {}, find: () => makeCollection(rows) },
		_add_field(fieldname) {
			this.added.push(fieldname);
			this.fields.push([fieldname, this.doctype]);
		},
		refresh() {
			this.refreshed += 1;
		},
	};
	const document = {};
	const sandbox = {
		console,
		document,
		MutationObserver,
		setTimeout,
		setInterval: (fn, ms) => intervals.push({ fn, ms, cleared: false }),
		clearInterval: (id) => {
			if (intervals[id - 1]) intervals[id - 1].cleared = true;
		},
		__: translate,
		cint: (value) => parseInt(value, 10) || 0,
		$: env.dollar(document),
		window: { ADHDSettings: env.settings, cur_list: listview },
		frappe: {
			boot: { adhd_mode: true, sysdefaults: { company: "Example Co" } },
			provide() {},
			after_ajax: (callback) => callback(),
			get_route: () => ["List", doctype, "List"],
			call: async (options) => {
				calls.push(options);
				return { message: [] };
			},
			datetime: {
				get_today: () => "2026-09-21",
				get_diff: (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000),
				str_to_user: (value) => value,
			},
			defaults: { get_user_default: () => "Stores - EC" },
			router: { on: (_event, handler) => routerHandlers.push(handler) },
			utils: { debounce: (fn) => fn },
		},
		erpnext: { adhd: { ADHDSettings: env.settings } },
	};
	run("adhd_list_view.js", sandbox);
	return {
		env,
		sandbox,
		listview,
		rows,
		observers,
		intervals,
		calls,
		// the route changes to this list, and its heat map and stock health attach
		open: async () => {
			routerHandlers[0]();
			await sleep(10);
		},
	};
}

const OVERDUE_TASK = [{ name: "TASK-1", exp_end_date: "2026-09-20", status: "Open", docstatus: 0 }];

test("heat map on (the default): an overdue task row is marked, and the list is watched and topped up", async () => {
	const { listview, rows, observers, intervals, open } = loadListView("Task", OVERDUE_TASK);
	await open();
	assert.deepEqual([...rows[0].classes], ["adhd-heat--overdue"]);
	assert.deepEqual(listview.added, ["exp_end_date"]);
	assert.equal(observers.filter((observer) => observer.observing).length, 1);
	assert.ok(intervals.some((interval) => interval.ms === 60000));
});

test("heat map off: rows are not marked, the list is not watched and no field is added to it", async () => {
	const { sandbox, listview, rows, observers, intervals, open } = loadListView("Task", OVERDUE_TASK, {
		due_date_heatmap: false,
	});
	sandbox.erpnext.adhd.applyHeat(listview);
	assert.equal(rows[0].classes.size, 0);

	await open();
	assert.equal(rows[0].classes.size, 0);
	assert.equal(observers.length, 0);
	assert.equal(intervals.filter((interval) => interval.ms === 60000).length, 0);
	assert.deepEqual(listview.added, []);
	assert.equal(listview.refreshed, 0);
});

test("switching the heat map off clears the list on screen and stops its watchers, and on brings it back", async () => {
	const { env, rows, observers, intervals, open } = loadListView("Task", OVERDUE_TASK);
	await open();
	assert.equal(rows[0].classes.size, 1);

	await env.settings.set("due_date_heatmap", false);
	assert.equal(rows[0].classes.size, 0);
	assert.ok(observers.every((observer) => observer.disconnected));
	assert.ok(intervals.filter((interval) => interval.ms === 60000).every((interval) => interval.cleared));

	await env.settings.set("due_date_heatmap", true);
	assert.deepEqual([...rows[0].classes], ["adhd-heat--overdue"]);
	assert.ok(observers.some((observer) => observer.observing && !observer.disconnected));

	// another setting changing leaves the heat map as it is
	await env.settings.set("pomodoro", false);
	assert.equal(rows[0].classes.size, 1);
});

test("the Asset heat map takes its depreciation title away with its classes", async () => {
	const { env, sandbox, listview, rows, open } = loadListView("Asset", [
		{ name: "AST-1", next_depreciation_date: "2026-09-22", status: "Submitted", docstatus: 1 },
	]);
	await open();
	assert.equal(rows[0].classes.size, 1);
	assert.match(rows[0].attrs.title, /Next depreciation/);
	await env.settings.set("due_date_heatmap", false);
	assert.equal(rows[0].classes.size, 0);
	assert.equal(rows[0].attrs.title, undefined);
	assert.ok(sandbox.erpnext.adhd.applyHeat);
	assert.ok(listview);
});

test("the heat map switch does not touch the Item stock health", async () => {
	const { calls, open } = loadListView("Item", [{ name: "ITEM-1" }], { due_date_heatmap: false });
	await open();
	assert.ok(calls.some((call) => call.method === "erpnext.stock.adhd.get_item_stock_health"));
});

// ---- form_banners: the deadline banner -----------------------------------------------------------------

function loadBanners(initial) {
	const env = makeEnv(initial);
	const registrations = {};
	const state = { removed: 0, prepended: [] };
	const document = {};
	const window = { ADHDSettings: env.settings };
	const sandbox = {
		console,
		document,
		window,
		sessionStorage: { getItem: () => null, setItem() {} },
		__: translate,
		cint: (value) => parseInt(value, 10) || 0,
		flt: (value) => Number.parseFloat(value) || 0,
		$: env.dollar(document, (html) => ({ html, find: () => ({ on() {} }), remove() {} })),
		frappe: {
			boot: { adhd_mode: true },
			provide() {},
			datetime: {
				get_today: () => "2026-09-21",
				get_diff: (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000),
			},
			ui: {
				form: { on: (doctype, handlers) => Object.assign((registrations[doctype] ||= {}), handlers) },
			},
			utils: { escape_html: (value) => String(value) },
		},
		erpnext: { adhd: { ADHDSettings: env.settings } },
	};
	run("adhd_deadline_banner.js", sandbox);
	const frm = {
		doctype: "Task",
		docname: "TASK-1",
		doc: { exp_end_date: "2026-09-22", status: "Open" },
		is_new: () => false,
		layout: {
			wrapper: {
				find: () => ({ remove: () => (state.removed += 1) }),
				prepend: (banner) => state.prepended.push(banner),
			},
		},
	};
	window.cur_frm = frm;
	return { env, registrations, state, frm };
}

test("form banners on (the default): a Task with a deadline gets its banner", () => {
	const { registrations, state, frm } = loadBanners();
	registrations.Task.refresh(frm);
	assert.equal(state.prepended.length, 1);
	assert.match(state.prepended[0].html, /Deadline: tomorrow/);
});

test("form banners off: no banner is added, and the one already there is taken away", () => {
	const { registrations, state, frm } = loadBanners({ form_banners: false });
	registrations.Task.refresh(frm);
	registrations.Task.after_save(frm);
	assert.equal(state.prepended.length, 0);
	assert.equal(state.removed, 2);
});

test("switching the banners off takes the banner off the open form, and on puts it back", async () => {
	const { env, registrations, state, frm } = loadBanners();
	registrations.Task.refresh(frm);
	assert.equal(state.prepended.length, 1);
	const removed = state.removed;

	await env.settings.set("form_banners", false);
	assert.equal(state.removed, removed + 1);
	assert.equal(state.prepended.length, 1);

	await env.settings.set("form_banners", true);
	assert.equal(state.prepended.length, 2);

	// another setting changing leaves the form alone
	const removedAgain = state.removed;
	await env.settings.set("pomodoro", false);
	assert.equal(state.removed, removedAgain);
});

// ---- mandatory_wizard: the guided mandatory-field save ----------------------------------------------------

function loadWizard(initial) {
	const env = makeEnv(initial);
	const state = { stockSaves: [], banners: 0, removed: 0 };
	// what the stock save returns: the guided save must hand back exactly this when it steps aside
	const stockResult = { stock: true };
	function Form() {}
	Form.prototype.save = function (...args) {
		state.stockSaves.push(args);
		return stockResult;
	};
	const document = {};
	const sandbox = {
		console,
		document,
		setTimeout,
		window: { ADHDSettings: env.settings },
		__: translate,
		$: env.dollar(document, () => {
			state.banners += 1;
			return { find: () => ({ on() {} }) };
		}),
		frappe: {
			boot: { adhd_mode: true },
			provide() {},
			ui: { form: { Form, on() {} } },
			utils: { escape_html: (value) => String(value) },
		},
		erpnext: { adhd: { ADHDSettings: env.settings } },
	};
	run("adhd_form_wizard.js", sandbox);
	const frm = Object.create(Form.prototype);
	frm.doctype = "Task";
	frm.doc = { name: "TASK-1" };
	frm.meta = { fields: [{ fieldname: "subject", label: "Subject", reqd: 1 }] };
	frm.layout = {
		wrapper: { find: () => ({ remove: () => (state.removed += 1) }), prepend() {} },
	};
	frm.get_field = () => ({ $input: null });
	frm.scroll_to_field = () => {};
	return { env, state, frm, stockResult };
}

test("mandatory wizard on (the default): saving with a required field empty starts the wizard", () => {
	const { state, frm, stockResult } = loadWizard();
	const result = frm.save("Save");
	result.catch(() => null);
	assert.notEqual(result, stockResult);
	assert.equal(state.banners, 1);
	assert.equal(state.stockSaves.length, 0);
});

test("mandatory wizard off: Form.save is exactly the stock save", () => {
	const { state, frm, stockResult } = loadWizard({ mandatory_wizard: false });
	assert.equal(frm.save("Save"), stockResult);
	assert.deepEqual(state.stockSaves, [["Save"]]);
	assert.equal(state.banners, 0);
});

test("switching the wizard off while it asks removes its banner, rejects the held save, and saving again is stock", async () => {
	const { env, state, frm, stockResult } = loadWizard();
	let outcome = "pending";
	frm.save("Save").then(
		() => (outcome = "resolved"),
		() => (outcome = "rejected")
	);
	assert.equal(state.banners, 1);
	const removed = state.removed;

	await env.settings.set("mandatory_wizard", false);
	await sleep(0);
	assert.equal(outcome, "rejected");
	assert.ok(state.removed > removed);
	// the held save is not run behind the person's back
	assert.equal(state.stockSaves.length, 0);

	assert.equal(frm.save("Save"), stockResult);
	assert.equal(state.stockSaves.length, 1);
});

test("another setting changing leaves a running wizard alone", async () => {
	const { env, state, frm } = loadWizard();
	let outcome = "pending";
	frm.save("Save").then(
		() => (outcome = "resolved"),
		() => (outcome = "rejected")
	);
	await env.settings.set("pomodoro", false);
	await sleep(0);
	assert.equal(outcome, "pending");
	assert.equal(state.stockSaves.length, 0);
});

// ---- payment_digest: the receivables summary in the Focus Panel ---------------------------------------------

// `hold` keeps every request unanswered until the test answers it through `pending`
function loadPaymentDigest(initial, { hold = false } = {}) {
	const env = makeEnv(initial);
	const calls = [];
	const intervals = [];
	const queries = [];
	const pending = [];
	const section = {
		removed: 0,
		remove() {
			this.removed += 1;
		},
	};
	class FocusPanel {
		show() {
			this._isOpen = true;
		}
		hide() {}
		destroy() {}
	}
	const document = {};
	const sandbox = {
		console,
		document,
		__: translate,
		$: env.dollar(document),
		setInterval: (fn, ms) => intervals.push({ fn, ms, cleared: false }),
		clearInterval: (id) => {
			if (intervals[id - 1]) intervals[id - 1].cleared = true;
		},
		window: { ADHDSettings: env.settings },
		format_currency: (value) => String(value),
		frappe: {
			boot: { adhd_mode: true },
			defaults: { get_default: () => "Example Co" },
			model: { can_read: () => true },
			call: (options) => {
				calls.push(options);
				return new Promise((resolve) => {
					if (hold) pending.push(resolve);
					else resolve({ message: DIGEST });
				});
			},
			utils: { escape_html: (value) => String(value) },
		},
		erpnext: { adhd: { ADHDSettings: env.settings, FocusPanel } },
	};
	run("adhd_payment_digest.js", sandbox);
	const panel = new FocusPanel();
	// the focus panel on screen, which is where the section lives
	panel.panel = {
		querySelector(selector) {
			queries.push(selector);
			return selector === ".adhd-payment-section" ? section : null;
		},
	};
	sandbox.erpnext.adhd.focusPanel = panel;
	return { env, panel, calls, intervals, queries, pending, section };
}

const DIGEST = { currency: "INR", total_outstanding: 0, overdue: [], due_this_week: [] };

test("payment digest on: showing the panel loads the summary and refreshes it every ten minutes", async () => {
	const { panel, calls, intervals } = loadPaymentDigest({ payment_digest: true });
	panel.show();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, "erpnext.accounts.services.adhd_payment_digest.get_payment_digest");
	assert.equal(calls[0].silent, true);
	assert.equal(intervals.length, 1);
	assert.equal(intervals[0].ms, 10 * 60 * 1000);
});

test("payment digest off (the default): no server call, no refresh timer, and no section", async () => {
	const { panel, calls, intervals, queries, section } = loadPaymentDigest();
	panel.show();
	await panel._loadPaymentDigest();
	assert.equal(calls.length, 0);
	assert.equal(intervals.length, 0);
	// it never built one; it only makes sure none is left
	assert.ok(queries.every((selector) => selector === ".adhd-payment-section"));
	assert.ok(section.removed > 0);
});

test("switching the digest on loads it for the open panel, and off stops the timer and removes the section", async () => {
	const { env, panel, calls, intervals, section } = loadPaymentDigest();
	panel.show();
	assert.equal(calls.length, 0);

	await env.settings.set("payment_digest", true);
	assert.equal(calls.length, 1);
	assert.equal(intervals.length, 1);
	assert.equal(intervals[0].cleared, false);

	const removed = section.removed;
	await env.settings.set("payment_digest", false);
	assert.equal(intervals[0].cleared, true);
	assert.ok(section.removed > removed);
	assert.equal(calls.length, 1);

	// a reset to defaults leaves it off; another setting changing does nothing
	await env.settings.reset();
	await env.settings.set("pomodoro", false);
	assert.equal(calls.length, 1);
});

test("switching the digest on does not load it for a panel that is closed", async () => {
	const { env, calls, intervals } = loadPaymentDigest();
	await env.settings.set("payment_digest", true);
	assert.equal(calls.length, 0);
	assert.equal(intervals.length, 0);
});

test("a summary that arrives after the digest was switched off does not bring the section back", async () => {
	const { env, panel, calls, queries, pending } = loadPaymentDigest(
		{ payment_digest: true },
		{ hold: true }
	);
	const loading = panel._loadPaymentDigest();
	assert.equal(calls.length, 1);

	await env.settings.set("payment_digest", false);
	pending[0]({ message: DIGEST });
	await loading;
	assert.ok(!queries.includes(".afp-body"));
});
