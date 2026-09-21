const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// ADHD-021 (Quotation expiry) and ADHD-030 (Opportunity staleness): the list heat map in adhd_list_view.js and the
// form banner / badge in adhd_quotation.js / adhd_opportunity.js, run against the real source in a vm sandbox.

const jsRoot = path.resolve(__dirname, "../public/js/adhd");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TODAY = "2026-09-21";

const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text);
const addDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);

// Any jQuery-style call returns the same empty collection.
function makeChain() {
	const chain = new Proxy(function () {}, {
		get: (_target, key) => (key === "length" ? 0 : () => chain),
	});
	return chain;
}

// Own enumerable properties are the stored keys, like a browser Storage; every write is counted.
class FakeStorage {
	writes = 0;
	getItem(key) {
		return Object.hasOwn(this, key) && key !== "writes" ? this[key] : null;
	}
	setItem(key, value) {
		this.writes += 1;
		this[key] = String(value);
	}
	removeItem(key) {
		delete this[key];
	}
}

// Frappe's frappe.datetime as far as these modules use it. convert_to_user_tz moves a server datetime from the
// system time zone (UTC here) into the user's, `userOffsetMinutes` ahead of it, and returns a moment-like object.
function makeDatetime(userOffsetMinutes = 0) {
	const conversions = [];
	return {
		conversions,
		get_today: () => TODAY,
		get_diff: (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000),
		convert_to_user_tz(value, format) {
			conversions.push([value, format]);
			const ms = Date.parse(`${String(value).replace(" ", "T")}Z`);
			const day = new Date(ms + userOffsetMinutes * 60000).toISOString().slice(0, 10);
			return { format: () => day };
		},
		str_to_user: (value) => `user:${value}`,
	};
}

// The settings module and the way it tells the page: jQuery's trigger() on `document`.
function makeSettings(initial = {}) {
	const values = { due_date_heatmap: true, form_banners: true, ...initial };
	const listeners = [];
	const trigger = (event, detail) =>
		Promise.all(listeners.filter((item) => item.event === event).map((item) => item.handler({}, detail)));
	return {
		values,
		listeners,
		get: (key) => Boolean(values[key]),
		set(key, value) {
			values[key] = Boolean(value);
			return trigger("adhd_setting_changed", { key, value: Boolean(value) });
		},
		reset() {
			Object.assign(values, { due_date_heatmap: true, form_banners: true });
			return trigger("adhd_settings_reset");
		},
		// $(document).on(...)
		bus(events, handler) {
			events.split(/\s+/).forEach((event) => listeners.push({ event, handler }));
		},
	};
}

// erpnext.adhd.onStateChange as adhd_mode.js has it: the callback also runs once, as it is registered.
function makeModeBus(sandbox) {
	const handlers = [];
	return {
		handlers,
		onStateChange(fn) {
			handlers.push(fn);
			fn(Boolean(sandbox.frappe.boot.adhd_mode));
		},
		// what the toggle does: set the flag, then tell everyone
		async setMode(on) {
			sandbox.frappe.boot.adhd_mode = on;
			await Promise.all(handlers.map((fn) => fn(on)));
		},
	};
}

function run(file, sandbox) {
	vm.runInNewContext(fs.readFileSync(path.join(jsRoot, file), "utf8"), sandbox, { filename: file });
}

// ---- the list ---------------------------------------------------------------------------------------------

// A jQuery-like collection of fake elements. Like Frappe's list, `data-name` sits on the checkbox inside a row, not
// on the row, and `.list-row` is what the heat CSS styles.
function makeElements(elements) {
	const collection = {
		length: elements.length,
		filter: (fn) => makeElements(elements.filter((element, index) => fn(index, element))),
		first: () => makeElements(elements.slice(0, 1)),
		closest: (selector) =>
			makeElements(selector === ".list-row" ? elements.map((element) => element.row || element) : []),
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
	};
	return collection;
}

function loadList(doctype, data, { adhdMode = true, settings = {}, fields = [], userOffset = 0 } = {}) {
	const settingsModule = makeSettings(settings);
	const observers = [];
	const intervals = [];
	const routerHandlers = [];
	class MutationObserver {
		constructor() {
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
	const rows = data.map((row) => {
		const listRow = { classes: new Set(), attrs: {} };
		const checkbox = {
			classes: new Set(),
			attrs: {},
			row: listRow,
			getAttribute: (name) => (name === "data-name" ? row.name : null),
		};
		return { listRow, checkbox };
	});
	const listview = {
		doctype,
		view: "List",
		data,
		fields,
		refreshed: 0,
		added: [],
		init_promise: Promise.resolve(),
		$result: {
			0: {},
			find: (selector) =>
				selector === "[data-name]"
					? makeElements(rows.map((item) => item.checkbox))
					: selector === ".list-row"
					? makeElements(rows.map((item) => item.listRow))
					: makeElements([]),
		},
		_add_field(fieldname) {
			this.added.push(fieldname);
			this.fields.push([fieldname, this.doctype]);
		},
		refresh() {
			this.refreshed += 1;
		},
	};
	const document = {};
	const datetime = makeDatetime(userOffset);
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
		$: (target) => (target === document ? { on: settingsModule.bus } : makeChain()),
		window: { ADHDSettings: settingsModule },
		frappe: {
			boot: { adhd_mode: adhdMode },
			provide() {},
			after_ajax: (callback) => callback(),
			get_route: () => ["List", doctype, "List"],
			call: async () => ({ message: [] }),
			datetime,
			defaults: { get_user_default: () => "Stores - EC" },
			router: { on: (_event, handler) => routerHandlers.push(handler) },
			utils: { debounce: (fn) => fn },
		},
		erpnext: { adhd: { ADHDSettings: settingsModule } },
	};
	const modeBus = makeModeBus(sandbox);
	sandbox.erpnext.adhd.onStateChange = modeBus.onStateChange;
	run("adhd_list_view.js", sandbox);
	return {
		sandbox,
		settings: settingsModule,
		datetime,
		listview,
		rows,
		observers,
		intervals,
		setMode: modeBus.setMode,
		// the route changes to this list: its heat map attaches
		open: async () => {
			sandbox.window.cur_list = listview;
			routerHandlers[0]();
			await sleep(10);
		},
		classesOf: (index) => [...rows[index].listRow.classes],
		heatIntervals: () => intervals.filter((interval) => interval.ms === 60000),
	};
}

const heatRow = (name, fields) => ({ name, docstatus: 0, ...fields });

// name, valid_till, status, the class, the tooltip
const QUOTATION_ROWS = [
	["QTN-past", "2026-09-15", "Open", "adhd-heat--overdue", "Expired 6 days ago"],
	["QTN-yesterday", "2026-09-20", "Open", "adhd-heat--overdue", "Expired yesterday"],
	// valid_till is the last day it can be accepted: red, but not yet "expired"
	["QTN-today", "2026-09-21", "Open", "adhd-heat--overdue", "Expires today"],
	["QTN-tomorrow", "2026-09-22", "Open", "adhd-heat--soon", "Expires tomorrow"],
	["QTN-draft", "2026-09-25", "Draft", "adhd-heat--soon", "Expires in 4 days"],
	["QTN-day7", "2026-09-28", "Open", "adhd-heat--soon", "Expires in 7 days"],
	["QTN-day8", "2026-09-29", "Open", null, null],
	["QTN-far", "2027-01-01", "Open", null, null],
	["QTN-nodate", null, "Open", null, null],
	// still being converted, so still watched
	["QTN-partial", "2026-09-10", "Partially Ordered", "adhd-heat--overdue", "Expired 11 days ago"],
	// finished with: nothing left to warn about
	["QTN-ordered", "2026-09-10", "Ordered", null, null],
	["QTN-lost", "2026-09-10", "Lost", null, null],
	["QTN-expired", "2026-09-10", "Expired", null, null],
];

test("Quotation heat map: red on and after the last valid day, amber for the week before, nothing beyond", async () => {
	const data = QUOTATION_ROWS.map(([name, valid_till, status]) => heatRow(name, { valid_till, status }));
	data.push(heatRow("QTN-cancelled", { valid_till: "2026-09-10", status: "Cancelled", docstatus: 2 }));
	const { rows, open, classesOf } = loadList("Quotation", data, { fields: [["valid_till", "Quotation"]] });
	await open();
	QUOTATION_ROWS.forEach(([name, , , heatClass, title], index) => {
		assert.deepEqual(classesOf(index), heatClass ? [heatClass] : [], name);
		assert.equal(rows[index].listRow.attrs.title, title || undefined, name);
	});
	assert.deepEqual(classesOf(QUOTATION_ROWS.length), [], "a cancelled quotation");
});

test("the heat goes on the .list-row, not on the checkbox or link that carries data-name", async () => {
	const { rows, open } = loadList("Quotation", [
		heatRow("QTN-1", { valid_till: "2026-09-20", status: "Open" }),
	]);
	await open();
	assert.deepEqual([...rows[0].listRow.classes], ["adhd-heat--overdue"]);
	assert.equal(rows[0].checkbox.classes.size, 0);
	assert.equal(rows[0].checkbox.attrs.title, undefined);
});

test("Quotation list: valid_till is fetched when the list lacks it, and only then", async () => {
	const missing = loadList("Quotation", [heatRow("QTN-1", { valid_till: "2026-09-20", status: "Open" })]);
	await missing.open();
	assert.deepEqual(missing.listview.added, ["valid_till"]);
	assert.equal(missing.listview.refreshed, 1);

	const present = loadList("Quotation", [], { fields: [["valid_till", "Quotation"]] });
	await present.open();
	assert.deepEqual(present.listview.added, []);
	assert.equal(present.listview.refreshed, 0);
});

// name, modified (system time zone), status, the class, the tooltip
const OPPORTUNITY_ROWS = [
	["OPP-today", "2026-09-21 09:00:00.123456", "Open", null, null],
	["OPP-3", "2026-09-18 00:00:00", "Open", null, null],
	// exactly a week is still fine; the eighth day is the first amber one
	["OPP-7", "2026-09-14 23:59:59.999999", "Open", null, null],
	["OPP-8", "2026-09-13 00:00:00", "Open", "adhd-heat--soon", "No activity for 8 days."],
	["OPP-10", "2026-09-11 08:00:00", "Replied", "adhd-heat--soon", "No activity for 10 days."],
	["OPP-14", "2026-09-07 08:00:00", "Quotation", "adhd-heat--soon", "No activity for 14 days."],
	["OPP-15", "2026-09-06 08:00:00", "Open", "adhd-heat--overdue", "No activity for 15 days."],
	["OPP-16", "2026-09-05 08:00:00", "Open", "adhd-heat--overdue", "No activity for 16 days."],
	["OPP-nomodified", null, "Open", null, null],
	["OPP-converted", "2026-08-01 08:00:00", "Converted", null, null],
	["OPP-lost", "2026-08-01 08:00:00", "Lost", null, null],
	["OPP-closed", "2026-08-01 08:00:00", "Closed", null, null],
];

test("Opportunity heat map counts days since last save: amber past a week, red past two, closed ones left alone", async () => {
	const data = OPPORTUNITY_ROWS.map(([name, modified, status]) => heatRow(name, { modified, status }));
	const { rows, open, classesOf, listview } = loadList("Opportunity", data, {
		fields: [["modified", "Opportunity"]],
	});
	await open();
	OPPORTUNITY_ROWS.forEach(([name, , , heatClass, title], index) => {
		assert.deepEqual(classesOf(index), heatClass ? [heatClass] : [], name);
		assert.equal(rows[index].listRow.attrs.title, title || undefined, name);
	});
	// `modified` is a standard field the list always has: nothing is added and the list is not reloaded
	assert.deepEqual(listview.added, []);
	assert.equal(listview.refreshed, 0);
});

test("Opportunity staleness reads the server datetime in the system time zone, then counts in the user's", async () => {
	// The user is 5h30 ahead of the server: 23:00 on the 13th on the server is already the 14th for them, seven days
	// ago, not eight. Reading the date part of the string would call it amber.
	const ahead = loadList(
		"Opportunity",
		[heatRow("OPP-1", { modified: "2026-09-13 23:00:00", status: "Open" })],
		{ userOffset: 330 }
	);
	await ahead.open();
	assert.deepEqual(ahead.classesOf(0), []);
	assert.deepEqual(ahead.datetime.conversions[0], ["2026-09-13 23:00:00", false]);

	// and 8 hours behind: 05:00 on the 14th on the server is still the 13th for them, eight days ago
	const behind = loadList(
		"Opportunity",
		[heatRow("OPP-1", { modified: "2026-09-14 05:00:00", status: "Open" })],
		{ userOffset: -480 }
	);
	await behind.open();
	assert.deepEqual(behind.classesOf(0), ["adhd-heat--soon"]);
});

test("heat map off in ADHD mode: no marks, no watcher, no timer, no field, and no reload", async () => {
	const data = [
		heatRow("QTN-1", { valid_till: "2026-09-20", status: "Open" }),
		heatRow("OPP-1", { modified: "2026-08-01 08:00:00", status: "Open" }),
	];
	for (const doctype of ["Quotation", "Opportunity"]) {
		const off = loadList(doctype, data, { adhdMode: false });
		off.sandbox.erpnext.adhd.applyHeat(off.listview);
		await off.open();
		assert.equal(off.rows[0].listRow.classes.size, 0, doctype);
		assert.equal(off.rows[0].listRow.attrs.title, undefined, doctype);
		assert.equal(off.observers.length, 0, doctype);
		assert.equal(off.intervals.length, 0, doctype);
		assert.deepEqual(off.listview.added, [], doctype);
		assert.equal(off.listview.refreshed, 0, doctype);
	}
});

test("switching ADHD mode off takes the marks and tooltips off the open list, stops its timer, and on restores them", async () => {
	const data = [
		heatRow("QTN-1", { valid_till: "2026-09-20", status: "Open" }),
		heatRow("QTN-2", { valid_till: "2026-09-25", status: "Open" }),
	];
	const { rows, observers, setMode, open, heatIntervals } = loadList("Quotation", data);
	await open();
	assert.deepEqual([...rows[0].listRow.classes], ["adhd-heat--overdue"]);
	assert.equal(heatIntervals().length, 1);
	assert.equal(observers.filter((observer) => observer.observing).length, 1);

	await setMode(false);
	assert.equal(rows[0].listRow.classes.size, 0);
	assert.equal(rows[1].listRow.classes.size, 0);
	assert.equal(rows[0].listRow.attrs.title, undefined);
	assert.equal(rows[1].listRow.attrs.title, undefined);
	assert.ok(heatIntervals().every((interval) => interval.cleared));
	assert.ok(observers.every((observer) => observer.disconnected));

	await setMode(true);
	assert.deepEqual([...rows[0].listRow.classes], ["adhd-heat--overdue"]);
	assert.deepEqual([...rows[1].listRow.classes], ["adhd-heat--soon"]);
	assert.equal(rows[1].listRow.attrs.title, "Expires in 4 days");
});

test("the Due-Date Heat Maps switch also governs Quotation and Opportunity", async () => {
	const data = [heatRow("OPP-1", { modified: "2026-08-01 08:00:00", status: "Open" })];
	const { rows, settings, open } = loadList("Opportunity", data);
	await open();
	assert.equal(rows[0].listRow.classes.size, 1);
	await settings.set("due_date_heatmap", false);
	assert.equal(rows[0].listRow.classes.size, 0);
	assert.equal(rows[0].listRow.attrs.title, undefined);
	await settings.set("due_date_heatmap", true);
	assert.deepEqual([...rows[0].listRow.classes], ["adhd-heat--overdue"]);

	const offAtLoad = loadList("Opportunity", data, { settings: { due_date_heatmap: false } });
	await offAtLoad.open();
	assert.equal(offAtLoad.rows[0].listRow.classes.size, 0);
	assert.equal(offAtLoad.intervals.length, 0);
});

// ---- forms ------------------------------------------------------------------------------------------------

// The elements a form module builds with jQuery: a class list, attributes, text, handlers and children. remove() takes
// the element off the form it was prepended to.
function makeElement(tag, built) {
	const node = {
		tag,
		classes: [],
		attrs: {},
		content: null,
		handlers: {},
		children: [],
		owner: null,
		addClass(names) {
			node.classes.push(...names.split(" "));
			return node;
		},
		attr(name, value) {
			node.attrs[name] = value;
			return node;
		},
		text(value) {
			node.content = value;
			return node;
		},
		on(event, handler) {
			node.handlers[event] = handler;
			return node;
		},
		appendTo(parent) {
			parent.children?.push(node);
			return node;
		},
		remove() {
			if (node.owner && node.owner.includes(node)) node.owner.splice(node.owner.indexOf(node), 1);
			return node;
		},
	};
	built.push(node);
	return node;
}

// A form whose layout keeps what is prepended to it, as the real one keeps it in the DOM. Like Frappe's Layout it
// has `wrapper` (a jQuery object) and no `$wrapper`.
function makeForm(doctype, doc) {
	const banners = [];
	const state = { removals: 0 };
	const frm = {
		doctype,
		docname: "DOC-1",
		doc: { name: "DOC-1", docstatus: 0, ...doc },
		newDoc: false,
		is_new() {
			return this.newDoc;
		},
		layout: {
			wrapper: {
				find: (selector) => ({
					remove: () => {
						state.removals += 1;
						banners
							.filter((node) => node.classes.includes(selector.slice(1)))
							.forEach((node) => banners.splice(banners.indexOf(node), 1));
					},
				}),
				prepend: (node) => {
					node.owner = banners;
					banners.push(node);
				},
			},
		},
	};
	return { frm, banners, state };
}

// what a leftover from an earlier refresh looks like to the form
const leftover = (className) => ({ classes: [className], owner: null });

function makeFormSandbox({ adhdMode = true, settings = {}, userOffset = 0, files }) {
	const settingsModule = makeSettings(settings);
	const registrations = {};
	const sessionStorage = new FakeStorage();
	const localStorage = new FakeStorage();
	const document = {};
	const built = [];
	const targets = [];
	const datetime = makeDatetime(userOffset);
	const sandbox = {
		console,
		document,
		MutationObserver: class {},
		setTimeout,
		setInterval: () => 1,
		clearInterval() {},
		window: { ADHDSettings: settingsModule },
		sessionStorage,
		localStorage,
		__: translate,
		cint: (value) => parseInt(value, 10) || 0,
		$: (target) => {
			if (target === document) return { on: settingsModule.bus };
			targets.push(target);
			// markup is only ever a bare tag: class, attributes and text are set one by one
			return /^<\w+>$/.test(target) ? makeElement(target, built) : makeChain();
		},
		frappe: {
			boot: { adhd_mode: adhdMode },
			provide() {},
			after_ajax: (callback) => callback(),
			get_route: () => ["Form", "Quotation", "QTN-1"],
			datetime,
			ui: {
				form: {
					on(doctype, handlers) {
						Object.assign((registrations[doctype] ||= {}), handlers);
					},
				},
			},
			router: { on() {} },
			utils: { escape_html: (value) => String(value), debounce: (fn) => fn },
		},
		erpnext: { adhd: { ADHDSettings: settingsModule } },
	};
	const modeBus = makeModeBus(sandbox);
	sandbox.erpnext.adhd.onStateChange = modeBus.onStateChange;
	files.forEach((file) => run(file, sandbox));
	// what loading the files built (the list view's stylesheet) is not what the tests are about
	built.length = 0;
	targets.length = 0;
	return {
		sandbox,
		registrations,
		sessionStorage,
		localStorage,
		built,
		targets,
		datetime,
		settings: settingsModule,
		...modeBus,
	};
}

// ---- the Quotation form -----------------------------------------------------------------------------------

const loadQuotationForm = (options = {}) => makeFormSandbox({ files: ["adhd_quotation.js"], ...options });

const quotationIn = (days, extra = {}) => ({ valid_till: addDays(TODAY, days), status: "Open", ...extra });
const messageOf = (banner) => banner.children[0].content;

test("Quotation form: the banner says how long is left, and switches to expired once valid_till has passed", () => {
	const { registrations } = loadQuotationForm();
	const expectations = [
		[3, "⏰ Quotation expires in 3 days"],
		[1, "⏰ Quotation expires tomorrow"],
		[0, "⚠️ Quotation expires today"],
		[-1, "⚠️ Quotation expired yesterday"],
		[-2, "⚠️ Quotation expired 2 days ago"],
		[14, "⏰ Quotation expires in 14 days"],
	];
	for (const [days, text] of expectations) {
		const { frm, banners } = makeForm("Quotation", quotationIn(days));
		registrations.Quotation.refresh(frm);
		assert.equal(banners.length, 1, `${days} days`);
		assert.equal(messageOf(banners[0]), text);
		assert.equal(banners[0].attrs.role, "status");
	}
});

test("Quotation form: it looks like the deadline banner, red on the last day, amber within a week, blue beyond", () => {
	const { registrations } = loadQuotationForm();
	const classesFor = (days) => {
		const { frm, banners } = makeForm("Quotation", quotationIn(days));
		registrations.Quotation.refresh(frm);
		return banners[0].classes;
	};
	assert.deepEqual(classesFor(-3), [
		"adhd-deadline-banner",
		"adhd-quotation-expiry",
		"adhd-deadline--overdue",
	]);
	assert.deepEqual(classesFor(0), [
		"adhd-deadline-banner",
		"adhd-quotation-expiry",
		"adhd-deadline--overdue",
	]);
	assert.deepEqual(classesFor(1), ["adhd-deadline-banner", "adhd-quotation-expiry", "adhd-deadline--soon"]);
	assert.deepEqual(classesFor(7), ["adhd-deadline-banner", "adhd-quotation-expiry", "adhd-deadline--soon"]);
	assert.deepEqual(classesFor(8), [
		"adhd-deadline-banner",
		"adhd-quotation-expiry",
		"adhd-deadline--normal",
	]);
});

test("Quotation form: nothing beyond 14 days, without a valid_till, or once the quotation is settled or new", () => {
	const { registrations } = loadQuotationForm();
	const cases = [
		["15 days away", quotationIn(15)],
		["a year away", quotationIn(365)],
		["no valid_till", { valid_till: null, status: "Open" }],
		["ordered", quotationIn(2, { status: "Ordered" })],
		["lost", quotationIn(2, { status: "Lost" })],
		["expired status", quotationIn(-5, { status: "Expired" })],
		["cancelled", quotationIn(2, { status: "Cancelled", docstatus: 2 })],
	];
	for (const [name, doc] of cases) {
		const { frm, banners } = makeForm("Quotation", doc);
		assert.doesNotThrow(() => registrations.Quotation.refresh(frm), name);
		assert.equal(banners.length, 0, name);
	}
	const unsaved = makeForm("Quotation", quotationIn(2));
	unsaved.frm.newDoc = true;
	registrations.Quotation.refresh(unsaved.frm);
	assert.equal(unsaved.banners.length, 0, "a new, unsaved quotation");

	// still watched: a draft, a submitted open one, a partly ordered one
	for (const status of ["Draft", "Open", "Replied", "Partially Ordered"]) {
		const { frm, banners } = makeForm("Quotation", quotationIn(-2, { status }));
		registrations.Quotation.refresh(frm);
		assert.equal(banners.length, 1, status);
	}
});

test("Quotation form: any number of refreshes, saves and date edits leave one banner", () => {
	const { registrations } = loadQuotationForm();
	const { frm, banners } = makeForm("Quotation", quotationIn(3));
	for (let index = 0; index < 4; index++) registrations.Quotation.refresh(frm);
	registrations.Quotation.valid_till(frm);
	assert.equal(banners.length, 1);

	// editing the date moves the banner with it, and past the window takes it away
	frm.doc.valid_till = addDays(TODAY, 1);
	registrations.Quotation.valid_till(frm);
	assert.equal(banners.length, 1);
	assert.match(messageOf(banners[0]), /expires tomorrow/);
	frm.doc.valid_till = addDays(TODAY, 30);
	registrations.Quotation.valid_till(frm);
	assert.equal(banners.length, 0);
});

test("Quotation form: a form without a layout yet (valid_till set while it loads) is left alone", () => {
	const { registrations } = loadQuotationForm();
	const { frm } = makeForm("Quotation", quotationIn(3));
	delete frm.layout;
	assert.doesNotThrow(() => registrations.Quotation.valid_till(frm));
});

test("Quotation form: dismissing hides the banner for the session, and only the click writes to storage", () => {
	const { registrations, sessionStorage, localStorage } = loadQuotationForm();
	const { frm, banners } = makeForm("Quotation", quotationIn(3));
	registrations.Quotation.refresh(frm);
	assert.equal(sessionStorage.writes, 0);
	const dismiss = banners[0].children[1];
	assert.equal(dismiss.tag, "<button>");
	assert.equal(dismiss.attrs.type, "button");
	assert.equal(dismiss.attrs["aria-label"], "Dismiss");
	dismiss.handlers.click();
	assert.equal(banners.length, 0);
	assert.equal(sessionStorage.getItem("adhd_banner_dismissed_Quotation_DOC-1"), "1");
	assert.equal(localStorage.writes, 0);

	registrations.Quotation.refresh(frm);
	assert.equal(banners.length, 0);
	// another quotation is not affected
	const other = makeForm("Quotation", quotationIn(3));
	other.frm.docname = "DOC-2";
	registrations.Quotation.refresh(other.frm);
	assert.equal(other.banners.length, 1);
});

test("Quotation form with ADHD mode off: no banner, the old one is removed, and nothing is stored or built", () => {
	const { registrations, sessionStorage, localStorage, built } = loadQuotationForm({ adhdMode: false });
	const { frm, banners } = makeForm("Quotation", quotationIn(2));
	banners.push(leftover("adhd-quotation-expiry"));
	registrations.Quotation.refresh(frm);
	registrations.Quotation.valid_till(frm);
	assert.equal(banners.length, 0);
	assert.equal(built.length, 0);
	assert.equal(sessionStorage.writes + localStorage.writes, 0);
});

test("switching ADHD mode off or on updates the Quotation form on screen; another doctype's form is left alone", async () => {
	const { registrations, sandbox, setMode } = loadQuotationForm();
	const { frm, banners } = makeForm("Quotation", quotationIn(2));
	registrations.Quotation.refresh(frm);
	sandbox.window.cur_frm = frm;
	assert.equal(banners.length, 1);

	await setMode(false);
	assert.equal(banners.length, 0);
	await setMode(true);
	assert.equal(banners.length, 1);

	const other = makeForm("Sales Order", { delivery_date: addDays(TODAY, 1), status: "To Deliver" });
	sandbox.window.cur_frm = other.frm;
	await setMode(false);
	assert.equal(other.state.removals, 0);
});

test("the Contextual Form Banners switch removes and restores the Quotation banner on the open form", async () => {
	const { registrations, sandbox, settings } = loadQuotationForm();
	const { frm, banners, state } = makeForm("Quotation", quotationIn(2));
	registrations.Quotation.refresh(frm);
	sandbox.window.cur_frm = frm;
	assert.equal(banners.length, 1);

	await settings.set("form_banners", false);
	assert.equal(banners.length, 0);
	await settings.set("form_banners", true);
	assert.equal(banners.length, 1);

	// another switch changing leaves the form as it is
	const before = state.removals;
	await settings.set("due_date_heatmap", false);
	assert.equal(state.removals, before);
	assert.equal(banners.length, 1);

	// a reset can change any of them
	await settings.set("form_banners", false);
	await settings.reset();
	assert.equal(banners.length, 1);

	const off = loadQuotationForm({ settings: { form_banners: false } });
	const hidden = makeForm("Quotation", quotationIn(2));
	off.registrations.Quotation.refresh(hidden.frm);
	assert.equal(hidden.banners.length, 0);
});

test("the Quotation banner is text and attributes only, and does not depend on the deadline banner module", () => {
	const { registrations, targets, sandbox } = loadQuotationForm();
	// the shared deadline banner module is not loaded: nothing here reaches into its config
	assert.equal(sandbox.erpnext.adhd.DEADLINE_CONFIG, undefined);
	targets.length = 0;
	const { frm } = makeForm("Quotation", quotationIn(2));
	registrations.Quotation.refresh(frm);
	assert.deepEqual(targets, ["<div>", "<span>", "<button>"]);
});

test("loaded next to the deadline banner module, the Quotation form still gets exactly one banner", () => {
	const { registrations, sandbox } = makeFormSandbox({
		files: ["adhd_deadline_banner.js", "adhd_quotation.js"],
	});
	assert.equal(sandbox.erpnext.adhd.DEADLINE_CONFIG.Quotation, undefined);
	const { frm, banners } = makeForm("Quotation", quotationIn(2));
	registrations.Quotation.refresh(frm);
	assert.equal(banners.length, 1);
});

// ---- the Opportunity form ---------------------------------------------------------------------------------

// the day count and the two-week line come from the list view module, which the bundle imports first
const loadOpportunityForm = (options = {}) =>
	makeFormSandbox({ files: ["adhd_list_view.js", "adhd_opportunity.js"], ...options });

const opportunityAgo = (days, extra = {}) => ({
	status: "Open",
	modified: `${addDays(TODAY, -days)} 10:30:15.482913`,
	...extra,
});

test("Opportunity form: a badge with the day count and the exact last-modified time once past 14 days", () => {
	const { registrations } = loadOpportunityForm();
	for (const days of [15, 16, 90]) {
		const doc = opportunityAgo(days);
		const { frm, banners } = makeForm("Opportunity", doc);
		registrations.Opportunity.refresh(frm);
		assert.equal(banners.length, 1, `${days} days`);
		const badge = banners[0];
		assert.deepEqual(badge.classes, ["adhd-stale-badge"]);
		assert.equal(badge.content, `🕒 Stale — no activity for ${days} days`);
		assert.equal(badge.attrs.title, `Last modified: user:${doc.modified}`);
		assert.equal(badge.attrs.role, "status");
	}
});

test("Opportunity form: the badge threshold is more than 14 days, not 7 and not 14", () => {
	const { registrations } = loadOpportunityForm();
	for (const [days, shown] of [
		[0, false],
		[7, false],
		[8, false],
		[14, false],
		[15, true],
	]) {
		const { frm, banners } = makeForm("Opportunity", opportunityAgo(days));
		registrations.Opportunity.refresh(frm);
		assert.equal(banners.length, shown ? 1 : 0, `${days} days`);
	}
});

test("Opportunity form: no badge on a new, settled or never-saved opportunity, and no error", () => {
	const { registrations } = loadOpportunityForm();
	for (const status of ["Converted", "Lost", "Closed"]) {
		const { frm, banners } = makeForm("Opportunity", opportunityAgo(60, { status }));
		registrations.Opportunity.refresh(frm);
		assert.equal(banners.length, 0, status);
	}
	for (const status of ["Open", "Replied", "Quotation"]) {
		const { frm, banners } = makeForm("Opportunity", opportunityAgo(60, { status }));
		registrations.Opportunity.refresh(frm);
		assert.equal(banners.length, 1, status);
	}
	const unsaved = makeForm("Opportunity", opportunityAgo(60));
	unsaved.frm.newDoc = true;
	registrations.Opportunity.refresh(unsaved.frm);
	assert.equal(unsaved.banners.length, 0);

	const noDate = makeForm("Opportunity", { status: "Open", modified: null });
	assert.doesNotThrow(() => registrations.Opportunity.refresh(noDate.frm));
	assert.equal(noDate.banners.length, 0);
});

test("Opportunity form: saving refreshes `modified`, and the next refresh drops the badge", () => {
	const { registrations } = loadOpportunityForm();
	const { frm, banners } = makeForm("Opportunity", opportunityAgo(20));
	registrations.Opportunity.refresh(frm);
	assert.equal(banners.length, 1);
	frm.doc.modified = `${TODAY} 09:00:00.000000`;
	registrations.Opportunity.refresh(frm);
	assert.equal(banners.length, 0);
});

test("Opportunity form: repeated refreshes leave one badge, and the count follows the doc", () => {
	const { registrations } = loadOpportunityForm();
	const { frm, banners } = makeForm("Opportunity", opportunityAgo(20));
	for (let index = 0; index < 5; index++) registrations.Opportunity.refresh(frm);
	assert.equal(banners.length, 1);
	frm.doc.modified = opportunityAgo(30).modified;
	registrations.Opportunity.refresh(frm);
	assert.equal(banners.length, 1);
	assert.equal(banners[0].content, "🕒 Stale — no activity for 30 days");
});

test("Opportunity form counts in the user's time zone, from the server's datetime", () => {
	// 23:30 on the 6th on the server is the 7th for a user 5h30 ahead: 14 days ago, which is not stale
	const ahead = loadOpportunityForm({ userOffset: 330 });
	const one = makeForm("Opportunity", { status: "Open", modified: "2026-09-06 23:30:00.000000" });
	ahead.registrations.Opportunity.refresh(one.frm);
	assert.equal(one.banners.length, 0);
	assert.deepEqual(ahead.datetime.conversions.at(-1), ["2026-09-06 23:30:00.000000", false]);

	// and the same instant for a user 8 hours behind is the 6th: 15 days
	const behind = loadOpportunityForm({ userOffset: -480 });
	const two = makeForm("Opportunity", { status: "Open", modified: "2026-09-06 23:30:00.000000" });
	behind.registrations.Opportunity.refresh(two.frm);
	assert.equal(two.banners.length, 1);
});

test("Opportunity form with ADHD mode off: no badge, an old one is removed, and nothing is built or stored", () => {
	const { registrations, built, sessionStorage, localStorage } = loadOpportunityForm({ adhdMode: false });
	const { frm, banners } = makeForm("Opportunity", opportunityAgo(40));
	banners.push(leftover("adhd-stale-badge"));
	registrations.Opportunity.refresh(frm);
	assert.equal(banners.length, 0);
	assert.equal(built.length, 0);
	assert.equal(sessionStorage.writes + localStorage.writes, 0);
});

test("switching ADHD mode off or on updates the Opportunity form on screen", async () => {
	const { registrations, sandbox, setMode } = loadOpportunityForm();
	const { frm, banners } = makeForm("Opportunity", opportunityAgo(40));
	registrations.Opportunity.refresh(frm);
	sandbox.window.cur_frm = frm;
	assert.equal(banners.length, 1);
	await setMode(false);
	assert.equal(banners.length, 0);
	await setMode(true);
	assert.equal(banners.length, 1);

	// a form of another doctype on screen is not touched
	const other = makeForm("Quotation", quotationIn(2));
	sandbox.window.cur_frm = other.frm;
	await setMode(false);
	assert.equal(other.state.removals, 0);
});

test("the Contextual Form Banners switch removes and restores the badge on the open form, at once", async () => {
	const { registrations, sandbox, settings } = loadOpportunityForm();
	const { frm, banners, state } = makeForm("Opportunity", opportunityAgo(40));
	registrations.Opportunity.refresh(frm);
	sandbox.window.cur_frm = frm;
	assert.equal(banners.length, 1);

	await settings.set("form_banners", false);
	assert.equal(banners.length, 0);
	await settings.set("form_banners", true);
	assert.equal(banners.length, 1);

	// another switch changing leaves the form as it is
	const before = state.removals;
	await settings.set("due_date_heatmap", false);
	assert.equal(state.removals, before);
	assert.equal(banners.length, 1);

	// a reset can change any of them
	await settings.set("form_banners", false);
	await settings.reset();
	assert.equal(banners.length, 1);

	const off = loadOpportunityForm({ settings: { form_banners: false } });
	const hidden = makeForm("Opportunity", opportunityAgo(40));
	off.registrations.Opportunity.refresh(hidden.frm);
	assert.equal(hidden.banners.length, 0);
});

test("the badge is built from text and attributes: whatever the server sent never becomes markup", () => {
	const hostile = `"><img src=x onerror=alert(1)>`;
	const { registrations, targets, sandbox } = loadOpportunityForm();
	sandbox.frappe.datetime.str_to_user = () => hostile;
	targets.length = 0;
	const { frm, banners } = makeForm("Opportunity", opportunityAgo(40));
	registrations.Opportunity.refresh(frm);
	assert.equal(banners.length, 1);
	assert.equal(banners[0].attrs.title, `Last modified: ${hostile}`);
	assert.ok(!banners[0].content.includes("<"));
	// the only thing ever handed to $() as markup is a bare "<div>"
	assert.deepEqual(targets, ["<div>"]);
});

test("adhd_opportunity.js loaded without the list view module does nothing and does not throw", () => {
	const { registrations } = makeFormSandbox({ files: ["adhd_opportunity.js"] });
	const { frm, banners } = makeForm("Opportunity", opportunityAgo(40));
	assert.doesNotThrow(() => registrations.Opportunity.refresh(frm));
	assert.equal(banners.length, 0);
});
