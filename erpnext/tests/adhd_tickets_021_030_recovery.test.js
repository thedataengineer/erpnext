// ADHD-023: Sales Order / Quotation interruption restore (adhd_draft_recovery.js).
// The module runs in a vm sandbox against a fake localStorage, a fake clock and a fake form. Every test is
// written to fail if the behaviour it names is missing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const jsRoot = path.join(appRoot, "public/js/adhd");
const readAdhd = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");
// values created inside a vm context carry that context's prototypes, which deepStrictEqual rejects
const plain = (value) => JSON.parse(JSON.stringify(value));

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
// 10:00 in Asia/Kolkata (UTC+5:30) is 04:30 UTC
const NOW = Date.UTC(2026, 8, 21, 4, 45, 0);
const MODIFIED_IST = "2026-09-21 10:00:00.123456";
const MODIFIED_MS = Date.UTC(2026, 8, 21, 4, 30, 0, 123);

// moment-timezone is not a dependency of this repo. Use the real one when the bench provides it, otherwise a
// stand-in that knows the zones these tests use.
const OFFSET_MINUTES = { "Asia/Kolkata": 330, "America/New_York": -240 };
function fakeMoment() {
	const moment = () => ({});
	moment.tz = (value, zone) => {
		const text = String(value);
		const ms = Date.parse(`${text.replace(" ", "T")}Z`);
		return { valueOf: () => ms - OFFSET_MINUTES[zone] * MINUTE };
	};
	return moment;
}
function loadMoment() {
	try {
		return require("moment-timezone");
	} catch {
		return fakeMoment();
	}
}

const escapeHtml = (value) => {
	const map = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
		"`": "&#96;",
		"=": "&#61;",
	};
	return String(value).replace(/[&<>"'`=]/g, (char) => map[char] || char);
};
const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text);

// localStorage stand-in. `failWrites` makes every setItem throw like a full quota does.
function makeStorage() {
	const data = new Map();
	const storage = {
		data,
		failWrites: false,
		writes: 0,
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem(key, value) {
			if (storage.failWrites) throw new Error("QuotaExceededError");
			storage.writes += 1;
			data.set(key, String(value));
		},
		removeItem: (key) => data.delete(key),
		key: (index) => [...data.keys()][index] ?? null,
		get length() {
			return data.size;
		},
	};
	return storage;
}

// A jQuery stand-in that only knows the banner: it keeps the banners inside the form layout so tests can count
// them, and records the click handlers.
function makeDom() {
	const banners = [];
	const documentHandlers = {};
	const makeNode = (html) => {
		const node = { html, handlers: {}, length: 1 };
		node.find = (selector) => ({
			on(event, handler) {
				node.handlers[`${selector}:${event}`] = handler;
				return this;
			},
		});
		return node;
	};
	const $ = (arg) => {
		if (typeof arg === "string") return makeNode(arg);
		return {
			on(event, handler) {
				documentHandlers[event] = handler;
				return this;
			},
		};
	};
	const layoutWrapper = {
		find(selector) {
			const marker = `class="${selector.slice(1)}"`;
			const matches = banners.filter((banner) => banner.html.includes(marker));
			return {
				length: matches.length,
				remove() {
					matches.forEach((match) => banners.splice(banners.indexOf(match), 1));
					return this;
				},
			};
		},
		prepend(node) {
			banners.unshift(node);
		},
	};
	return { $, banners, documentHandlers, layoutWrapper };
}

const SALES_ORDER_DOC = {
	customer: "CUST-0001",
	company: "Example Co",
	currency: "USD",
	selling_price_list: "Standard Selling",
	transaction_date: "2026-09-21",
	delivery_date: "2026-10-01",
	po_no: "PO-77",
	// computed by the totals calculation, never snapshotted
	grand_total: 999,
	net_total: 900,
	total_qty: 5,
	items: [
		{
			doctype: "Sales Order Item",
			name: "row1",
			parent: "new-sales-order-1",
			idx: 1,
			docstatus: 0,
			item_code: "ITEM-A",
			item_name: "Item A",
			qty: 2,
			rate: 10,
			uom: "Nos",
			amount: 20,
			net_amount: 20,
			base_amount: 20,
			stock_qty: 2,
			delivery_date: "2026-10-01",
			__unedited: false,
		},
		{
			doctype: "Sales Order Item",
			name: "row2",
			idx: 2,
			item_code: "ITEM-B",
			item_name: "Item B",
			qty: 3,
			rate: 5,
			amount: 15,
		},
		// an empty grid row: not worth keeping
		{ doctype: "Sales Order Item", name: "row3", idx: 3, qty: 1 },
	],
	taxes: [
		{
			doctype: "Sales Taxes and Charges",
			name: "tax1",
			charge_type: "On Net Total",
			account_head: "VAT - EC",
			description: "VAT",
			rate: 5,
			tax_amount: 45,
			total: 945,
			base_tax_amount: 45,
		},
	],
	sales_team: [
		{
			doctype: "Sales Team",
			name: "team1",
			sales_person: "Ann",
			allocated_percentage: 100,
			allocated_amount: 900,
		},
	],
};

// Everything a test needs: the module loaded into a sandbox plus handles on the fake browser around it.
function load({
	user = "ann@example.com",
	modeOn = true,
	storage = makeStorage(),
	timeZone = "Asia/Kolkata",
	extra = "",
} = {}) {
	const dom = makeDom();
	const clock = { now: NOW };
	const handlers = {};
	const intervals = new Map();
	let nextInterval = 1;
	const routerHandlers = [];
	const stateHandlers = [];
	const serverCalls = [];
	const alerts = [];
	const confirms = [];
	const warnings = [];
	const log = [];
	const route = { current: ["Form", "Sales Order", "new-sales-order-1"] };
	const confirmation = { answer: true };

	class FakeDate extends Date {
		constructor(...args) {
			if (args.length) super(...args);
			else super(clock.now);
		}
		static now() {
			return clock.now;
		}
	}
	const tripwire = (name) => () => {
		serverCalls.push(name);
		throw new Error(`${name} must never be called by draft recovery`);
	};
	const sandbox = {
		console: { log() {}, error() {}, warn: (...args) => warnings.push(args) },
		Date: FakeDate,
		localStorage: storage,
		moment: loadMoment(),
		setInterval(fn, ms) {
			const id = nextInterval++;
			intervals.set(id, { fn, ms });
			return id;
		},
		clearInterval: (id) => intervals.delete(id),
		document: {},
		window: {},
		$: dom.$,
		__: translate,
		frappe: {
			boot: { adhd_mode: modeOn, time_zone: { system: timeZone } },
			session: { user },
			provide() {},
			get_route: () => route.current,
			router: { on: (_event, fn) => routerHandlers.push(fn) },
			after_ajax: () => Promise.resolve(),
			confirm(message, onYes, onNo) {
				confirms.push(message);
				if (confirmation.answer) onYes();
				else if (onNo) onNo();
			},
			show_alert: (options) => alerts.push(options),
			utils: { escape_html: escapeHtml },
			call: tripwire("frappe.call"),
			xcall: tripwire("frappe.xcall"),
			db: { set_value: tripwire("frappe.db.set_value"), insert: tripwire("frappe.db.insert") },
			model: {
				clear_table(doc, table) {
					log.push(["clear_table", table]);
					doc[table] = [];
				},
				add_child(parent, doctype, table) {
					const rows = (parent[table] ||= []);
					const row = {
						doctype,
						parentfield: table,
						name: `new-${doctype}-${rows.length + 1}`,
						idx: rows.length + 1,
					};
					rows.push(row);
					log.push(["add_child", doctype, table]);
					return row;
				},
			},
			ui: {
				form: {
					on(doctype, registered) {
						handlers[doctype] = { ...(handlers[doctype] || {}), ...registered };
					},
				},
			},
		},
		erpnext: {
			adhd: {
				onStateChange(fn) {
					stateHandlers.push(fn);
					fn(Boolean(sandbox.frappe.boot.adhd_mode));
				},
			},
		},
	};
	vm.runInNewContext(`${readAdhd("adhd_draft_recovery.js")}\n${extra}`, sandbox, {
		filename: "adhd_draft_recovery.js",
	});

	const recovery = sandbox.erpnext.adhd.draftRecovery;
	const harness = {
		sandbox,
		storage,
		dom,
		clock,
		handlers,
		intervals,
		routerHandlers,
		stateHandlers,
		serverCalls,
		alerts,
		confirms,
		confirmation,
		warnings,
		log,
		route,
		recovery,
		hooks: {},
		fire: (doctype, event, frm) => handlers[doctype][event](frm),
		// what the form's own handlers would do to the document after a field is set
		afterSetValue: null,
		setMode(value) {
			sandbox.frappe.boot.adhd_mode = value;
			stateHandlers.forEach((fn) => fn(value));
		},
		setModeSilently(value) {
			sandbox.frappe.boot.adhd_mode = value;
		},
		tick() {
			[...intervals.values()].forEach((entry) => entry.fn());
		},
		key: (doctype, name, forUser = user) =>
			`adhd_draft:${encodeURIComponent(forUser)}:${encodeURIComponent(doctype)}:${encodeURIComponent(
				name
			)}`,
		drafts: () => [...storage.data.keys()].filter((key) => key.startsWith("adhd_draft:")),
		banners: () => dom.banners,
	};

	harness.makeFrm = ({
		doctype = "Sales Order",
		name = "new-sales-order-1",
		isNew = true,
		dirty = true,
		docstatus = 0,
		modified,
		doc = {},
	} = {}) => {
		const config = recovery.SNAPSHOT_FIELDS[doctype];
		const known = new Set([...config.scalars, ...config.lateScalars, ...Object.keys(config.tables)]);
		const frm = {
			doctype,
			docname: name,
			doc: JSON.parse(
				JSON.stringify({
					doctype,
					name,
					docstatus,
					__islocal: isNew ? 1 : 0,
					__unsaved: dirty ? 1 : 0,
					...(modified ? { modified } : {}),
					...doc,
				})
			),
			// Frappe's Layout sets `wrapper`; there is no `layout.$wrapper`, so a fake without it fails a misuse
			layout: { wrapper: dom.layoutWrapper },
			fields_dict: Object.fromEntries([...known].map((field) => [field, { df: { fieldname: field } }])),
			is_dirty: () => Boolean(frm.doc.__unsaved),
			is_new: () => Boolean(frm.doc.__islocal),
			dirty() {
				frm.doc.__unsaved = 1;
			},
			set_value(field, value) {
				log.push(["set_value", field, value]);
				frm.doc[field] = value;
				if (harness.afterSetValue) harness.afterSetValue(frm, field, value);
				return Promise.resolve();
			},
			refresh_field: (table) => log.push(["refresh_field", table]),
			cscript: { calculate_taxes_and_totals: () => log.push(["calculate_taxes_and_totals"]) },
			save: tripwire("frm.save"),
			savesubmit: tripwire("frm.savesubmit"),
		};
		return frm;
	};
	return harness;
}

// Writes a valid snapshot straight into storage, the way an earlier session would have.
function seed(
	harness,
	{ user = "ann@example.com", doctype = "Sales Order", docName = "__new__", ...overrides } = {}
) {
	const snapshot = {
		v: 1,
		user,
		doctype,
		docName,
		isNew: docName === "__new__",
		savedAt: NOW - 5 * MINUTE,
		baseModified: null,
		scalars: { customer: "CUST-0001", currency: "USD" },
		childTables: { items: [{ item_code: "ITEM-A", item_name: "Item A", qty: 2, rate: 10 }] },
		...overrides,
	};
	const key = harness.key(doctype, docName, user);
	harness.storage.data.set(key, JSON.stringify(snapshot));
	return { key, snapshot };
}

const stored = (harness, doctype, name, user) => {
	const text = harness.storage.getItem(harness.key(doctype, name, user));
	return text === null ? null : JSON.parse(text);
};

// --- what is snapshotted, and when ----------------------------------------------------------------------

test("a dirty new Sales Order with a customer and items is snapshotted under a key that carries the user", () => {
	const h = load();
	const frm = h.makeFrm({ doc: SALES_ORDER_DOC });
	assert.equal(h.recovery.snapshotForm(frm), true);

	assert.deepEqual(h.drafts(), ["adhd_draft:ann%40example.com:Sales%20Order:__new__"]);
	const snapshot = stored(h, "Sales Order", "__new__");
	assert.equal(snapshot.user, "ann@example.com");
	assert.equal(snapshot.doctype, "Sales Order");
	assert.equal(snapshot.savedAt, NOW);
	assert.equal(snapshot.scalars.customer, "CUST-0001");
	assert.equal(snapshot.scalars.delivery_date, "2026-10-01");
	assert.equal(snapshot.scalars.po_no, "PO-77");
});

test("the snapshot holds items, taxes and sales team rows, and nothing computed or internal", () => {
	const h = load();
	h.recovery.snapshotForm(h.makeFrm({ doc: SALES_ORDER_DOC }));
	const snapshot = stored(h, "Sales Order", "__new__");

	// the empty grid row is dropped; the two real ones stay in order
	assert.deepEqual(
		snapshot.childTables.items.map((row) => [row.item_code, row.qty, row.rate, row.delivery_date]),
		[
			["ITEM-A", 2, 10, "2026-10-01"],
			["ITEM-B", 3, 5, undefined],
		]
	);
	assert.deepEqual(
		snapshot.childTables.taxes.map((row) => row.account_head),
		["VAT - EC"]
	);
	assert.deepEqual(
		snapshot.childTables.sales_team.map((row) => row.sales_person),
		["Ann"]
	);

	const everyKey = JSON.stringify(snapshot);
	for (const computed of [
		"grand_total",
		"net_total",
		"total_qty",
		"amount",
		"net_amount",
		"base_amount",
		"stock_qty",
	]) {
		assert.ok(!everyKey.includes(`"${computed}"`), `${computed} must not be snapshotted`);
	}
	for (const internal of [
		"__unsaved",
		"__islocal",
		"__unedited",
		"parent",
		"docstatus",
		"idx",
		'"name":"row',
	]) {
		assert.ok(!everyKey.includes(internal), `${internal} must not be snapshotted`);
	}
	assert.ok(!everyKey.includes("allocated_amount"));
	assert.ok(!everyKey.includes('"total":945') && !everyKey.includes("base_tax_amount"));
});

test("a Quotation is snapshotted by its own fields: quotation_to and party_name, no sales team", () => {
	const h = load();
	const frm = h.makeFrm({
		doctype: "Quotation",
		name: "new-quotation-1",
		doc: {
			quotation_to: "Customer",
			party_name: "CUST-0002",
			valid_till: "2026-10-21",
			customer: "not a Quotation field",
			sales_team: [{ sales_person: "Ann" }],
			items: [{ item_code: "ITEM-A", item_name: "Item A", qty: 1, rate: 3 }],
		},
	});
	h.route.current = ["Form", "Quotation", "new-quotation-1"];
	assert.equal(h.recovery.snapshotForm(frm), true);
	const snapshot = stored(h, "Quotation", "__new__");
	assert.equal(snapshot.scalars.quotation_to, "Customer");
	assert.equal(snapshot.scalars.party_name, "CUST-0002");
	assert.equal(snapshot.scalars.valid_till, "2026-10-21");
	assert.equal(snapshot.scalars.customer, undefined);
	assert.deepEqual(Object.keys(snapshot.childTables), ["items", "taxes"]);
});

test("nothing is written while ADHD mode is off, and the mode is read when the snapshot is taken", () => {
	const off = load({ modeOn: false });
	assert.equal(off.recovery.snapshotForm(off.makeFrm({ doc: SALES_ORDER_DOC })), false);
	assert.equal(off.recovery.startDraftAutosave(off.makeFrm({ doc: SALES_ORDER_DOC })), false);
	assert.equal(off.intervals.size, 0);
	assert.equal(off.storage.writes, 0);
	assert.equal(off.storage.data.size, 0);

	// on at load time, off by the time the snapshot is due
	const on = load({ modeOn: true });
	const frm = on.makeFrm({ doc: SALES_ORDER_DOC });
	on.setModeSilently(false);
	assert.equal(on.recovery.snapshotForm(frm), false);
	assert.equal(on.storage.writes, 0);
});

test("a form with nothing to lose writes nothing: a clean saved draft, an untouched new form, a submitted one", () => {
	const h = load();
	// saved draft nobody edited: not dirty
	const clean = h.makeFrm({
		isNew: false,
		name: "SAL-ORD-1",
		dirty: false,
		modified: MODIFIED_IST,
		doc: SALES_ORDER_DOC,
	});
	assert.equal(h.recovery.snapshotForm(clean), false);

	// Frappe marks every new document dirty from the start; its defaults alone are not worth keeping
	const untouched = h.makeFrm({
		dirty: true,
		doc: { company: "Example Co", currency: "USD", transaction_date: "2026-09-21", items: [{ qty: 1 }] },
	});
	assert.equal(h.recovery.snapshotForm(untouched), false);

	const submitted = h.makeFrm({ isNew: false, name: "SAL-ORD-2", docstatus: 1, doc: SALES_ORDER_DOC });
	assert.equal(h.recovery.snapshotForm(submitted), false);

	const guest = load({ user: "Guest" });
	assert.equal(guest.recovery.snapshotForm(guest.makeFrm({ doc: SALES_ORDER_DOC })), false);

	assert.equal(h.storage.writes + guest.storage.writes, 0);
});

test("a saved draft that has unsaved edits is snapshotted under its own name with the version it was based on", () => {
	const h = load();
	const frm = h.makeFrm({
		isNew: false,
		name: "SAL-ORD-2026-00001",
		modified: MODIFIED_IST,
		doc: { customer: "CUST-0001", po_no: "PO-1" },
	});
	assert.equal(h.recovery.snapshotForm(frm), true);
	const snapshot = stored(h, "Sales Order", "SAL-ORD-2026-00001");
	assert.equal(snapshot.baseModified, MODIFIED_IST);
	assert.equal(snapshot.isNew, false);
	assert.deepEqual(h.drafts(), ["adhd_draft:ann%40example.com:Sales%20Order:SAL-ORD-2026-00001"]);
});

test("an unchanged form is not written again, a changed one is", () => {
	const h = load();
	const frm = h.makeFrm({ doc: SALES_ORDER_DOC });
	assert.equal(h.recovery.snapshotForm(frm), true);
	assert.equal(h.storage.writes, 1);
	h.clock.now += 30 * 1000;
	assert.equal(h.recovery.snapshotForm(frm), false);
	assert.equal(h.storage.writes, 1);

	frm.doc.po_no = "PO-78";
	assert.equal(h.recovery.snapshotForm(frm), true);
	assert.equal(h.storage.writes, 2);
	assert.equal(stored(h, "Sales Order", "__new__").scalars.po_no, "PO-78");
	assert.equal(stored(h, "Sales Order", "__new__").savedAt, h.clock.now);
});

// --- the interval ---------------------------------------------------------------------------------------

test("the loop runs every 30 seconds, once per document, and each tick snapshots the form", () => {
	const h = load();
	const frm = h.makeFrm({ doc: SALES_ORDER_DOC });
	assert.equal(h.recovery.startDraftAutosave(frm), true);
	assert.equal(h.recovery.startDraftAutosave(frm), true);
	assert.equal(h.intervals.size, 1, "refreshing the same document must not stack loops");
	assert.equal([...h.intervals.values()][0].ms, 30000);
	assert.equal(h.storage.writes, 0, "nothing is written before the first tick");

	h.tick();
	assert.equal(h.storage.writes, 1);
	assert.equal(stored(h, "Sales Order", "__new__").scalars.customer, "CUST-0001");

	// another document on the same form object gets its own loop, and the old one is gone
	const other = h.makeFrm({ doc: SALES_ORDER_DOC, name: "new-sales-order-2" });
	h.recovery.startDraftAutosave(other);
	assert.equal(h.intervals.size, 1);
});

test("the loop stops when ADHD mode goes off, both at once and if a tick finds it off", () => {
	const h = load();
	h.recovery.startDraftAutosave(h.makeFrm({ doc: SALES_ORDER_DOC }));
	assert.equal(h.intervals.size, 1);
	h.setMode(false);
	assert.equal(h.intervals.size, 0);
	h.tick();
	assert.equal(h.storage.writes, 0);

	const late = load();
	late.recovery.startDraftAutosave(late.makeFrm({ doc: SALES_ORDER_DOC }));
	late.setModeSilently(false);
	late.tick();
	assert.equal(late.intervals.size, 0, "a tick that finds the mode off stops the loop");
	assert.equal(late.storage.writes, 0);
});

test("the loop stops on a route change away from the form, on form unload, and on submit", () => {
	const h = load();
	const frm = h.makeFrm({ doc: SALES_ORDER_DOC });

	h.recovery.startDraftAutosave(frm);
	h.route.current = ["List", "Sales Order", "List"];
	h.routerHandlers.forEach((fn) => fn());
	assert.equal(h.intervals.size, 0, "route change");

	h.route.current = ["Form", "Sales Order", "new-sales-order-1"];
	h.recovery.startDraftAutosave(frm);
	h.routerHandlers.forEach((fn) => fn());
	assert.equal(h.intervals.size, 1, "a route change that stays on the form keeps the loop");
	h.dom.documentHandlers["form-unload"]({}, frm);
	assert.equal(h.intervals.size, 0, "form unload");

	h.recovery.startDraftAutosave(frm);
	h.route.current = ["query-report", "Stock Balance"];
	h.tick();
	assert.equal(h.intervals.size, 0, "a tick on another page");
	assert.equal(h.storage.writes, 0, "nothing is snapshotted for a form that is not on screen");

	h.route.current = ["Form", "Sales Order", "new-sales-order-1"];
	h.recovery.startDraftAutosave(frm);
	h.fire("Sales Order", "on_submit", frm);
	assert.equal(h.intervals.size, 0, "submit");
});

// --- purge, cap, size, storage errors -------------------------------------------------------------------

test("snapshots older than seven days are purged, whoever owns them, and unreadable ones too", () => {
	const h = load();
	const week = 7 * DAY;
	seed(h, { docName: "OLD-1", savedAt: NOW - week - MINUTE });
	seed(h, { docName: "FRESH-1", savedAt: NOW - week + MINUTE });
	seed(h, { user: "bob@example.com", docName: "BOB-OLD", savedAt: NOW - 8 * DAY });
	seed(h, { user: "bob@example.com", docName: "BOB-FRESH", savedAt: NOW - DAY });
	h.storage.data.set("adhd_draft:ann%40example.com:Sales%20Order:BROKEN", "{not json");
	h.storage.data.set("unrelated_key", "kept");

	h.recovery.startDraftAutosave(h.makeFrm({ doc: SALES_ORDER_DOC }));
	assert.deepEqual(
		h
			.drafts()
			.map((key) => decodeURIComponent(key.split(":").pop()))
			.sort(),
		["BOB-FRESH", "FRESH-1"]
	);
	assert.equal(h.storage.getItem("unrelated_key"), "kept");
});

test("at most 20 snapshots are kept per user, the newest, and other users' are left alone", () => {
	const h = load();
	seed(h, { user: "bob@example.com", docName: "BOB-1", savedAt: NOW - 6 * DAY });
	for (let index = 1; index <= 24; index++) {
		h.clock.now = NOW + index * MINUTE;
		const frm = h.makeFrm({
			isNew: false,
			name: `SAL-ORD-${index}`,
			modified: "2026-09-01 09:00:00",
			doc: { customer: "CUST-0001", po_no: `PO-${index}` },
		});
		assert.equal(h.recovery.snapshotForm(frm), true);
	}
	const mine = h.drafts().filter((key) => key.startsWith("adhd_draft:ann%40example.com:"));
	assert.equal(mine.length, 20);
	assert.ok(
		mine.some((key) => key.endsWith(":SAL-ORD-24")),
		"the newest survives"
	);
	assert.ok(!mine.some((key) => key.endsWith(":SAL-ORD-1")), "the oldest was evicted");
	assert.ok(!mine.some((key) => key.endsWith(":SAL-ORD-4")));
	assert.ok(mine.some((key) => key.endsWith(":SAL-ORD-5")));
	assert.ok(
		h.storage.getItem(h.key("Sales Order", "BOB-1", "bob@example.com")),
		"another user's snapshot stays"
	);
});

test("a snapshot that is too large is not written, and the previous one is kept", () => {
	const h = load();
	const frm = h.makeFrm({ doc: SALES_ORDER_DOC });
	assert.equal(h.recovery.snapshotForm(frm), true);
	const before = h.storage.getItem(h.key("Sales Order", "__new__"));

	frm.doc.items[0].description = "x".repeat(200 * 1000);
	assert.equal(h.recovery.snapshotForm(frm), false);
	assert.equal(h.storage.getItem(h.key("Sales Order", "__new__")), before);
});

test("a full quota is swallowed: no error, no console warning, and the next tick tries again", () => {
	const h = load();
	const frm = h.makeFrm({ doc: SALES_ORDER_DOC });
	h.storage.failWrites = true;
	assert.doesNotThrow(() => assert.equal(h.recovery.snapshotForm(frm), false));
	assert.equal(h.warnings.length, 0);

	h.storage.failWrites = false;
	assert.equal(h.recovery.snapshotForm(frm), true, "an unwritten snapshot is not remembered as written");
});

test("storage that throws on access (private mode) degrades silently", () => {
	const h = load();
	Object.defineProperty(h.sandbox, "localStorage", {
		get() {
			throw new Error("SecurityError");
		},
	});
	const frm = h.makeFrm({ doc: SALES_ORDER_DOC });
	assert.doesNotThrow(() => {
		assert.equal(h.recovery.snapshotForm(frm), false);
		assert.equal(h.recovery.checkAndOfferDraftRestore(frm), false);
		h.recovery.clearDraftSnapshot(frm);
		h.recovery.purgeDraftSnapshots();
		h.fire("Sales Order", "refresh", frm);
		h.fire("Sales Order", "after_save", frm);
	});
	assert.equal(h.banners().length, 0);
});

// --- the banner: who sees what, and when ----------------------------------------------------------------

test("another person on the same browser is never offered the first person's snapshot", () => {
	const storage = makeStorage();
	const ann = load({ user: "ann@example.com", storage });
	ann.recovery.snapshotForm(ann.makeFrm({ doc: SALES_ORDER_DOC }));
	assert.equal(ann.drafts().length, 1);

	const bob = load({ user: "bob@example.com", storage });
	const blank = bob.makeFrm({ name: "new-sales-order-9" });
	assert.equal(bob.recovery.checkAndOfferDraftRestore(blank), false);
	assert.equal(bob.banners().length, 0);

	// Bob's own work goes to a key of his own and Ann's is untouched
	const before = storage.getItem(ann.key("Sales Order", "__new__"));
	bob.recovery.snapshotForm(
		bob.makeFrm({ doc: { customer: "CUST-BOB", items: [{ item_code: "X", item_name: "X", qty: 1 }] } })
	);
	assert.equal(storage.getItem(ann.key("Sales Order", "__new__")), before);
	assert.equal(bob.drafts().length, 2);
	assert.equal(stored(bob, "Sales Order", "__new__", "bob@example.com").scalars.customer, "CUST-BOB");
	assert.notEqual(bob.key("Sales Order", "__new__", "bob@example.com"), ann.key("Sales Order", "__new__"));

	// even a snapshot copied under Bob's key with Ann's name inside is refused
	const forged = JSON.parse(before);
	storage.data.set(bob.key("Sales Order", "__new__", "bob@example.com"), JSON.stringify(forged));
	assert.equal(bob.recovery.checkAndOfferDraftRestore(blank), false);
});

test("a blank new form is offered the snapshot; the banner says how old it is and what it holds", () => {
	const h = load();
	seed(h, { savedAt: NOW - 2 * 60 * MINUTE - MINUTE, scalars: { customer: "Acme Ltd" } });
	const frm = h.makeFrm();
	assert.equal(h.recovery.checkAndOfferDraftRestore(frm), true);
	assert.equal(h.banners().length, 1);
	const html = h.banners()[0].html;
	assert.match(html, /Unsaved Sales Order draft found \(last edited 2 hours ago\)\. Resume it\?/);
	assert.match(html, /Acme Ltd/);
	assert.match(html, /Items: 1/);
	assert.match(html, /adhd-restore-btn/);
	assert.match(html, /adhd-discard-btn/);
});

test("nothing is offered with the mode off, for a form that already has content, a saved-and-clean one, or a submitted one", () => {
	const off = load({ modeOn: false });
	seed(off);
	assert.equal(off.recovery.checkAndOfferDraftRestore(off.makeFrm()), false);
	assert.equal(off.banners().length, 0);

	const h = load();
	seed(h);
	// opened from a Quotation or typed into: not a blank form
	assert.equal(h.recovery.checkAndOfferDraftRestore(h.makeFrm({ doc: { customer: "CUST-9" } })), false);
	assert.equal(
		h.recovery.checkAndOfferDraftRestore(h.makeFrm({ doc: { items: [{ item_code: "A", qty: 1 }] } })),
		false
	);
	// a submitted document has no draft
	assert.equal(
		h.recovery.checkAndOfferDraftRestore(h.makeFrm({ isNew: false, name: "SAL-ORD-3", docstatus: 1 })),
		false
	);
	assert.equal(h.banners().length, 0);
	// a saved document nobody snapshotted
	assert.equal(
		h.recovery.checkAndOfferDraftRestore(
			h.makeFrm({ isNew: false, name: "SAL-ORD-4", dirty: false, modified: MODIFIED_IST })
		),
		false
	);
	// Quotation slot is separate from the Sales Order one
	h.route.current = ["Form", "Quotation", "new-quotation-1"];
	assert.equal(
		h.recovery.checkAndOfferDraftRestore(h.makeFrm({ doctype: "Quotation", name: "new-quotation-1" })),
		false
	);
});

test("a saved document is offered a snapshot only if it is newer than the document's modified time, in the system time zone", () => {
	const h = load({ timeZone: "Asia/Kolkata" });
	// modified is 04:30 UTC. Read as UTC it would be 10:00 UTC, making both of these look older.
	const newer = seed(h, {
		docName: "SAL-ORD-5",
		savedAt: MODIFIED_MS + 15 * MINUTE,
		baseModified: MODIFIED_IST,
	});
	const frmNewer = h.makeFrm({ isNew: false, name: "SAL-ORD-5", dirty: false, modified: MODIFIED_IST });
	assert.equal(h.recovery.checkAndOfferDraftRestore(frmNewer), true, "newer than modified");
	assert.equal(h.banners().length, 1);
	assert.ok(h.storage.data.has(newer.key));

	// saved after the snapshot: it must not be offered, and it is thrown away
	const stale = seed(h, {
		docName: "SAL-ORD-6",
		savedAt: MODIFIED_MS - 15 * MINUTE,
		baseModified: MODIFIED_IST,
	});
	const frmOlder = h.makeFrm({ isNew: false, name: "SAL-ORD-6", dirty: false, modified: MODIFIED_IST });
	assert.equal(h.recovery.checkAndOfferDraftRestore(frmOlder), false, "older than modified");
	assert.equal(h.banners().length, 0, "the banner of the previous document is gone");
	assert.equal(h.storage.data.has(stale.key), false);
});

test("a snapshot taken from an older version of the document is not offered", () => {
	const h = load();
	// newer by the clock, but the document was saved elsewhere after this snapshot's base version
	seed(h, {
		docName: "SAL-ORD-7",
		savedAt: MODIFIED_MS + MINUTE,
		baseModified: "2026-09-20 08:00:00.000000",
	});
	const frm = h.makeFrm({ isNew: false, name: "SAL-ORD-7", dirty: false, modified: MODIFIED_IST });
	assert.equal(h.recovery.checkAndOfferDraftRestore(frm), false);
});

test("a saved document whose modified time cannot be read is never offered a snapshot", () => {
	const h = load();
	seed(h, { docName: "SAL-ORD-8", savedAt: NOW });
	assert.equal(
		h.recovery.checkAndOfferDraftRestore(h.makeFrm({ isNew: false, name: "SAL-ORD-8", dirty: false })),
		false
	);
	assert.equal(
		h.recovery.checkAndOfferDraftRestore(
			h.makeFrm({ isNew: false, name: "SAL-ORD-8", dirty: false, modified: "garbage" })
		),
		false
	);
});

test("a saved document that still holds its unsaved edits on screen is not offered the older snapshot", () => {
	const h = load();
	seed(h, { docName: "SAL-ORD-9", savedAt: MODIFIED_MS + MINUTE, baseModified: MODIFIED_IST });
	const frm = h.makeFrm({ isNew: false, name: "SAL-ORD-9", dirty: true, modified: MODIFIED_IST });
	assert.equal(h.recovery.checkAndOfferDraftRestore(frm), false);
});

test("a corrupt, foreign or outdated-format snapshot is not offered and is removed", () => {
	const h = load();
	const key = h.key("Sales Order", "__new__");
	for (const bad of [
		"{oops",
		JSON.stringify([1, 2]),
		JSON.stringify({ v: 2 }),
		JSON.stringify({
			v: 1,
			user: "ann@example.com",
			doctype: "Quotation",
			savedAt: NOW,
			scalars: {},
			childTables: {},
		}),
	]) {
		h.storage.data.set(key, bad);
		assert.equal(h.recovery.checkAndOfferDraftRestore(h.makeFrm()), false, bad);
		assert.equal(h.storage.data.has(key), false, `${bad} is removed`);
	}
});

test("the same banner is never shown twice, whichever hook asks and however often", () => {
	const h = load();
	seed(h);
	const frm = h.makeFrm();
	h.fire("Sales Order", "refresh", frm);
	h.recovery.checkAndOfferDraftRestore(frm);
	h.sandbox.erpnext.adhd.checkAndOfferDraftRestore(frm);
	h.fire("Sales Order", "refresh", frm);
	assert.equal(h.banners().length, 1);

	// another snapshot for the same form replaces the banner instead of stacking one
	seed(h, { savedAt: NOW - MINUTE, scalars: { customer: "Second" } });
	h.recovery.checkAndOfferDraftRestore(frm);
	assert.equal(h.banners().length, 1);
	assert.match(h.banners()[0].html, /Second/);
});

test("switching the form to a document with no snapshot removes the previous banner", () => {
	const h = load();
	seed(h);
	const frm = h.makeFrm();
	h.recovery.checkAndOfferDraftRestore(frm);
	assert.equal(h.banners().length, 1);

	frm.doc.name = "new-sales-order-2";
	h.storage.data.delete(h.key("Sales Order", "__new__"));
	h.recovery.checkAndOfferDraftRestore(frm);
	assert.equal(h.banners().length, 0);

	h.setMode(false);
	seed(h);
	h.recovery.checkAndOfferDraftRestore(frm);
	assert.equal(h.banners().length, 0);
});

test("everything shown on the banner is escaped", () => {
	const h = load();
	seed(h, {
		scalars: { customer: '<img src=x onerror="alert(1)"> & "quoted" \'single\'' },
		childTables: { items: [{ item_code: "<script>alert(2)</script>" }] },
	});
	h.recovery.checkAndOfferDraftRestore(h.makeFrm());
	const html = h.banners()[0].html;
	assert.ok(!html.includes("<img"), "no raw tag from the stored customer name");
	assert.ok(!html.includes("<script"), "no raw script tag");
	assert.ok(!html.includes('onerror="'), "no attribute injection");
	assert.match(
		html,
		/&lt;img src&#61;x onerror&#61;&quot;alert\(1\)&quot;&gt; &amp; &quot;quoted&quot; &#39;single&#39;/
	);
	assert.equal((html.match(/</g) || []).length, (html.match(/>/g) || []).length);
	assert.equal((html.match(/<button/g) || []).length, 2, "only the two real buttons");
});

// --- Restore and Discard --------------------------------------------------------------------------------

const FULL_SNAPSHOT = {
	scalars: {
		company: "Example Co",
		customer: "CUST-0001",
		currency: "EUR",
		selling_price_list: "Wholesale",
		transaction_date: "2026-09-21",
		delivery_date: "2026-10-01",
		po_no: "PO-77",
		additional_discount_percentage: 5,
	},
	childTables: {
		items: [
			{
				item_code: "ITEM-A",
				item_name: "Item A",
				qty: 2,
				rate: 10,
				uom: "Nos",
				conversion_factor: 1,
				delivery_date: "2026-10-15",
			},
			{
				item_code: "ITEM-B",
				item_name: "Item B",
				qty: 3,
				rate: 5,
				uom: "Nos",
				conversion_factor: 1,
				delivery_date: "2026-10-20",
			},
		],
		taxes: [{ charge_type: "On Net Total", account_head: "VAT - EC", description: "VAT", rate: 5 }],
		sales_team: [{ sales_person: "Ann", allocated_percentage: 100 }],
	},
};

// The handlers of the real form that can rewrite other fields after one is set
function installFormHandlers(h) {
	h.afterSetValue = (frm, field, value) => {
		if (field === "customer") {
			// party details are fetched and overwrite what is already on the form
			frm.doc.currency = "USD";
			frm.doc.selling_price_list = "Standard Selling";
			frm.doc.company = "Example Co";
		}
		if (field === "transaction_date") frm.doc.delivery_date = "";
		if (field === "delivery_date") (frm.doc.items || []).forEach((row) => (row.delivery_date = value));
		if (field === "currency") frm.doc.currency_handler_ran = true;
	};
}

test("Restore sets the party first, then the rest, then the child tables, then the discount and a recalculation", async () => {
	const h = load();
	installFormHandlers(h);
	const { snapshot } = seed(h, FULL_SNAPSHOT);
	const frm = h.makeFrm();
	h.recovery.checkAndOfferDraftRestore(frm);
	const restore = h.banners()[0].handlers[".adhd-restore-btn:click"];
	await restore();

	const order = h.log.map(([call, first, second]) =>
		call === "set_value" ? `set:${first}` : `${call}:${second ?? first ?? call}`
	);
	const at = (entry) => {
		const index = order.indexOf(entry);
		assert.ok(index >= 0, `${entry} happened`);
		return index;
	};
	assert.ok(at("set:customer") < at("set:currency"), "customer before currency");
	assert.ok(at("set:customer") < at("set:selling_price_list"));
	assert.ok(
		at("set:transaction_date") < at("set:delivery_date"),
		"transaction_date clears delivery_date, so it goes first"
	);
	assert.ok(
		at("set:delivery_date") < at("add_child:items"),
		"the header delivery date overwrites the rows, so rows come after"
	);
	assert.ok(at("add_child:items") < at("refresh_field:items"));
	assert.ok(
		at("refresh_field:items") < at("set:additional_discount_percentage"),
		"discounts after the rows exist"
	);
	assert.ok(
		at("set:additional_discount_percentage") < at("calculate_taxes_and_totals:calculate_taxes_and_totals")
	);
	assert.ok(at("clear_table:items") < at("add_child:items"));

	// the party's fetch changed currency and price list, and the restore put the person's own back
	assert.equal(frm.doc.customer, "CUST-0001");
	assert.equal(frm.doc.currency, "EUR");
	assert.equal(frm.doc.selling_price_list, "Wholesale");
	assert.equal(frm.doc.delivery_date, "2026-10-01");
	assert.equal(frm.doc.po_no, "PO-77");
	assert.equal(frm.doc.additional_discount_percentage, 5);
	// and the rows kept their own dates, not the header's
	assert.deepEqual(
		frm.doc.items.map((row) => [row.item_code, row.qty, row.rate, row.delivery_date]),
		[
			["ITEM-A", 2, 10, "2026-10-15"],
			["ITEM-B", 3, 5, "2026-10-20"],
		]
	);
	assert.deepEqual(
		frm.doc.items.map((row) => row.idx),
		[1, 2]
	);
	assert.equal(frm.doc.taxes[0].account_head, "VAT - EC");
	assert.equal(frm.doc.sales_team[0].sales_person, "Ann");
	for (const table of ["items", "taxes", "sales_team"]) {
		assert.ok(
			h.log.some(([call, name]) => call === "refresh_field" && name === table),
			`${table} refreshed`
		);
	}
	assert.equal(frm.doc.__unsaved, 1);
	assert.deepEqual(plain(h.alerts), [{ message: "Sales Order draft restored.", indicator: "green" }]);
	assert.equal(h.banners().length, 0, "the banner is gone");
	// the snapshot stays until the document is saved: a crash right after Restore must not lose it
	assert.ok(h.storage.data.has(snapshot ? h.key("Sales Order", "__new__") : ""));
	assert.deepEqual(h.serverCalls, []);
});

test("Restore on a saved draft marks the form unsaved so Frappe asks before leaving and Save is offered", async () => {
	const h = load();
	seed(h, {
		docName: "SAL-ORD-20",
		savedAt: MODIFIED_MS + 10 * MINUTE,
		baseModified: MODIFIED_IST,
		scalars: { po_no: "PO-EDITED" },
		childTables: {},
	});
	const frm = h.makeFrm({
		isNew: false,
		name: "SAL-ORD-20",
		dirty: false,
		modified: MODIFIED_IST,
		doc: { po_no: "PO-1" },
	});
	h.route.current = ["Form", "Sales Order", "SAL-ORD-20"];
	h.fire("Sales Order", "refresh", frm);
	assert.equal(h.banners().length, 1);
	await h.banners()[0].handlers[".adhd-restore-btn:click"]();
	assert.equal(frm.doc.po_no, "PO-EDITED");
	assert.equal(frm.doc.__unsaved, 1);
	assert.equal(frm.doc.name, "SAL-ORD-20");
	assert.deepEqual(h.serverCalls, []);
});

test("Restore of a Quotation sets quotation_to before party_name and has no sales team", async () => {
	const h = load();
	h.route.current = ["Form", "Quotation", "new-quotation-1"];
	seed(h, {
		doctype: "Quotation",
		scalars: {
			quotation_to: "Lead",
			party_name: "CRM-LEAD-1",
			valid_till: "2026-10-21",
			transaction_date: "2026-09-21",
		},
		childTables: {
			items: [{ item_code: "ITEM-A", item_name: "Item A", qty: 1, rate: 3 }],
			sales_team: [{ sales_person: "Ann" }],
		},
	});
	const frm = h.makeFrm({ doctype: "Quotation", name: "new-quotation-1" });
	h.recovery.checkAndOfferDraftRestore(frm);
	await h.banners()[0].handlers[".adhd-restore-btn:click"]();

	const sets = h.log.filter(([call]) => call === "set_value").map(([, field]) => field);
	assert.ok(sets.indexOf("quotation_to") < sets.indexOf("party_name"));
	assert.ok(sets.indexOf("transaction_date") < sets.indexOf("valid_till"));
	assert.equal(frm.doc.party_name, "CRM-LEAD-1");
	assert.equal(frm.doc.items[0].doctype, "Quotation Item");
	assert.equal(frm.doc.sales_team, undefined, "a Quotation has no sales team table");
});

test("Restore writes only the fields this feature saves: a tampered snapshot cannot set a name, parent or docstatus", async () => {
	const h = load();
	seed(h, {
		scalars: {
			customer: "CUST-0001",
			docstatus: 1,
			name: "SAL-ORD-HACK",
			owner: "Administrator",
			constructor: "x",
			grand_total: 1,
		},
		childTables: {
			items: [
				{
					item_code: "A",
					item_name: "A",
					qty: 1,
					name: "row-x",
					parent: "SAL-ORD-HACK",
					docstatus: 1,
					amount: 99,
					__proto__: { polluted: true },
					nested: { a: 1 },
				},
			],
			unknown_table: [{ x: 1 }],
		},
	});
	const frm = h.makeFrm();
	h.recovery.checkAndOfferDraftRestore(frm);
	await h.banners()[0].handlers[".adhd-restore-btn:click"]();
	assert.equal(frm.doc.docstatus, 0);
	assert.equal(frm.doc.name, "new-sales-order-1");
	assert.equal(frm.doc.owner, undefined);
	assert.equal(frm.doc.grand_total, undefined);
	assert.equal(frm.doc.unknown_table, undefined);
	const row = frm.doc.items[0];
	assert.equal(row.item_code, "A");
	assert.equal(row.amount, undefined);
	assert.equal(row.parent, undefined);
	assert.equal(row.docstatus, undefined);
	assert.equal(row.nested, undefined);
	assert.notEqual(row.name, "row-x");
});

test("Restore is abandoned if the form switched to another document while it waited", async () => {
	const h = load();
	seed(h, FULL_SNAPSHOT);
	const frm = h.makeFrm();
	h.recovery.checkAndOfferDraftRestore(frm);
	h.afterSetValue = (form, field) => {
		if (field === "customer") form.doc.name = "SAL-ORD-OTHER";
	};
	await h.banners()[0].handlers[".adhd-restore-btn:click"]();
	assert.deepEqual(
		h.log.filter(([call]) => call === "set_value").map(([, field]) => field),
		["company", "customer"],
		"nothing is written onto the other document"
	);
	assert.equal(
		h.log.some(([call]) => call === "add_child"),
		false
	);
	assert.deepEqual(h.alerts, []);
});

test("Restore over a form the person has already typed into asks first, and does nothing if they decline", async () => {
	const h = load();
	seed(h, FULL_SNAPSHOT);
	const frm = h.makeFrm();
	h.recovery.checkAndOfferDraftRestore(frm);
	frm.doc.customer = "CUST-TYPED";
	h.confirmation.answer = false;
	await h.banners()[0].handlers[".adhd-restore-btn:click"]();
	assert.equal(h.confirms.length, 1);
	assert.equal(h.log.length, 0);
	assert.equal(h.banners().length, 1, "the offer is still there");

	h.confirmation.answer = true;
	await h.banners()[0].handlers[".adhd-restore-btn:click"]();
	assert.equal(h.confirms.length, 2);
	assert.equal(frm.doc.customer, "CUST-0001");
});

test("Discard removes the snapshot and the banner and leaves the form exactly as it was", () => {
	const h = load();
	const { key } = seed(h, FULL_SNAPSHOT);
	const frm = h.makeFrm({ doc: { company: "Example Co" } });
	const before = JSON.stringify(frm.doc);
	h.recovery.checkAndOfferDraftRestore(frm);
	h.banners()[0].handlers[".adhd-discard-btn:click"]();

	assert.equal(h.storage.data.has(key), false);
	assert.equal(h.banners().length, 0);
	assert.equal(JSON.stringify(frm.doc), before);
	assert.equal(h.log.length, 0);

	// and it does not come back on the next refresh
	h.fire("Sales Order", "refresh", frm);
	assert.equal(h.banners().length, 0);
});

test("after Restore, refreshing the same form does not offer the draft again", async () => {
	const h = load();
	seed(h, FULL_SNAPSHOT);
	const frm = h.makeFrm();
	h.fire("Sales Order", "refresh", frm);
	await h.banners()[0].handlers[".adhd-restore-btn:click"]();
	h.fire("Sales Order", "refresh", frm);
	h.recovery.checkAndOfferDraftRestore(frm);
	assert.equal(h.banners().length, 0);
});

test("a refresh that arrives while Restore is still working does not bring the banner back", async () => {
	const h = load();
	seed(h, FULL_SNAPSHOT);
	const frm = h.makeFrm();
	h.fire("Sales Order", "refresh", frm);
	// the form has no party or items yet at the first field, so it still looks blank to the offer
	h.afterSetValue = (form, field) => {
		if (field === "company") h.fire("Sales Order", "refresh", form);
	};
	await h.banners()[0].handlers[".adhd-restore-btn:click"]();
	assert.equal(h.banners().length, 0);
});

test("while the banner waits for an answer, typing does not overwrite the snapshot it offers", () => {
	const h = load();
	const { key, snapshot } = seed(h, { scalars: { customer: "OLD-DRAFT-CUSTOMER" } });
	const frm = h.makeFrm();
	h.fire("Sales Order", "refresh", frm);
	assert.equal(h.banners().length, 1);

	frm.doc.customer = "NEW-CUSTOMER";
	frm.doc.items = [{ item_code: "Z", item_name: "Z", qty: 1 }];
	h.tick();
	assert.equal(JSON.parse(h.storage.getItem(key)).scalars.customer, snapshot.scalars.customer);

	// once it is answered, snapshots resume
	h.banners()[0].handlers[".adhd-discard-btn:click"]();
	h.tick();
	assert.equal(JSON.parse(h.storage.getItem(key)).scalars.customer, "NEW-CUSTOMER");
});

// --- cleared after save and submit ----------------------------------------------------------------------

test("saving a new document clears its snapshot; saving a saved one leaves the unrelated new-form slot alone", () => {
	const h = load();
	const newFrm = h.makeFrm({ doc: SALES_ORDER_DOC });
	h.recovery.snapshotForm(newFrm);
	assert.equal(h.drafts().length, 1);

	// the server names the document during the save: before_save still sees it as new, after_save does not
	h.fire("Sales Order", "before_save", newFrm);
	newFrm.doc.name = "SAL-ORD-2026-00010";
	newFrm.doc.__islocal = 0;
	newFrm.doc.__unsaved = 0;
	h.fire("Sales Order", "after_save", newFrm);
	assert.equal(h.drafts().length, 0);

	// a different, saved draft is saved while an interrupted new form's snapshot waits in its slot
	seed(h, { docName: "__new__" });
	const saved = h.makeFrm({
		isNew: false,
		name: "SAL-ORD-2026-00011",
		modified: MODIFIED_IST,
		doc: { po_no: "PO-1", customer: "C" },
	});
	h.recovery.snapshotForm(saved);
	assert.equal(h.drafts().length, 2);
	h.fire("Sales Order", "before_save", saved);
	saved.doc.__unsaved = 0;
	h.fire("Sales Order", "after_save", saved);
	assert.deepEqual(h.drafts(), [h.key("Sales Order", "__new__")]);
});

test("saving clears the snapshot even when ADHD mode is off, and a snapshot is not rewritten after it", () => {
	const h = load();
	const frm = h.makeFrm({
		isNew: false,
		name: "SAL-ORD-12",
		modified: MODIFIED_IST,
		doc: { po_no: "PO-1", customer: "C" },
	});
	h.recovery.snapshotForm(frm);
	assert.equal(h.drafts().length, 1);
	h.setMode(false);
	h.fire("Sales Order", "after_save", frm);
	assert.equal(h.drafts().length, 0);
});

test("submitting stops the loop and clears the snapshot; a refresh of a submitted document does the same", () => {
	const h = load();
	const frm = h.makeFrm({
		isNew: false,
		name: "SAL-ORD-13",
		modified: MODIFIED_IST,
		doc: { po_no: "PO-1", customer: "C" },
	});
	h.recovery.startDraftAutosave(frm);
	h.tick();
	assert.equal(h.drafts().length, 1);

	frm.doc.docstatus = 1;
	h.fire("Sales Order", "on_submit", frm);
	assert.equal(h.drafts().length, 0);
	assert.equal(h.intervals.size, 0);
	h.tick();
	assert.equal(h.storage.writes, 1, "no write after the submit");

	seed(h, { docName: "SAL-ORD-14" });
	h.fire("Sales Order", "refresh", h.makeFrm({ isNew: false, name: "SAL-ORD-14", docstatus: 1 }));
	assert.equal(h.storage.data.has(h.key("Sales Order", "SAL-ORD-14")), false);
});

test("the refresh hook starts the loop and offers the draft; the mode is read each time it runs", () => {
	const h = load();
	seed(h);
	h.fire("Sales Order", "refresh", h.makeFrm());
	assert.equal(h.intervals.size, 1);
	assert.equal(h.banners().length, 1);

	const off = load({ modeOn: false });
	seed(off);
	off.fire("Sales Order", "refresh", off.makeFrm());
	assert.equal(off.intervals.size, 0);
	off.setModeSilently(true);
	off.fire("Sales Order", "refresh", off.makeFrm());
	assert.equal(off.intervals.size, 1, "the mode was switched on after the file loaded");
	assert.equal(off.banners().length, 1);
});

// --- it is a local snapshot only ------------------------------------------------------------------------

test("a whole edit, interruption and restore never touches the server", async () => {
	const h = load();
	const frm = h.makeFrm({ doc: SALES_ORDER_DOC });
	h.fire("Sales Order", "refresh", frm);
	h.tick();
	h.tick();
	h.fire("Sales Order", "before_save", frm);
	seed(h, FULL_SNAPSHOT);
	h.recovery.checkAndOfferDraftRestore(h.makeFrm({ name: "new-sales-order-5" }));
	h.fire("Sales Order", "on_submit", frm);
	assert.deepEqual(h.serverCalls, []);
});

test("the source never saves, calls the server or listens for beforeunload", () => {
	const code = readAdhd("adhd_draft_recovery.js")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
	assert.doesNotMatch(
		code,
		/\.save\s*\(|\.savesubmit\s*\(|frappe\.call|frappe\.xcall|frappe\.db\.|frm\.call/
	);
	assert.doesNotMatch(code, /beforeunload/i);
	assert.doesNotMatch(code, /sessionStorage/);
	assert.match(code, /frappe\.boot && frappe\.boot\.adhd_mode/);
});

// --- the field lists are the real fields ----------------------------------------------------------------

test("every snapshotted field exists on its DocType and none is a computed field", () => {
	const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(appRoot, relative), "utf8"));
	const meta = (relative) =>
		Object.fromEntries(readJson(relative).fields.map((field) => [field.fieldname, field]));
	const parents = {
		"Sales Order": meta("selling/doctype/sales_order/sales_order.json"),
		Quotation: meta("selling/doctype/quotation/quotation.json"),
	};
	const children = {
		"Sales Order Item": meta("selling/doctype/sales_order_item/sales_order_item.json"),
		"Quotation Item": meta("selling/doctype/quotation_item/quotation_item.json"),
		"Sales Taxes and Charges": meta(
			"accounts/doctype/sales_taxes_and_charges/sales_taxes_and_charges.json"
		),
		"Sales Team": meta("selling/doctype/sales_team/sales_team.json"),
	};
	// read-only fields that are fetched once and are inputs, not results, of the totals calculation
	const READ_ONLY_INPUTS = new Set([
		"stock_uom",
		"conversion_factor",
		"price_list_rate",
		"weight_per_unit",
		"weight_uom",
	]);
	const COMPUTED =
		/^(amount|net_amount|net_rate|stock_qty|total_weight|rate_with_margin|total|base_.*|grand_total|net_total|rounded_total|rounding_adjustment|in_words|total_taxes_and_charges|allocated_amount|commission_rate|customer_name|status|per_.*|billed_amt|.*_qty)$/;
	const { SNAPSHOT_FIELDS } = load().recovery;

	for (const [doctype, config] of Object.entries(SNAPSHOT_FIELDS)) {
		const fields = parents[doctype];
		for (const field of [...config.scalars, ...config.lateScalars]) {
			assert.ok(fields[field], `${doctype}.${field} does not exist`);
			assert.ok(!fields[field].read_only, `${doctype}.${field} is read-only`);
			assert.ok(
				!["Table", "Section Break", "Column Break"].includes(fields[field].fieldtype),
				`${doctype}.${field}`
			);
			assert.ok(!COMPUTED.test(field), `${doctype}.${field} looks computed`);
		}
		for (const party of config.party)
			assert.ok(config.scalars.includes(party), `${doctype} party ${party}`);
		for (const [table, spec] of Object.entries(config.tables)) {
			assert.equal(fields[table]?.fieldtype, "Table", `${doctype}.${table} is not a table`);
			assert.equal(fields[table].options, spec.doctype, `${doctype}.${table} child doctype`);
			const child = children[spec.doctype];
			for (const field of [...spec.fields, ...spec.identity]) {
				assert.ok(child[field], `${spec.doctype}.${field} does not exist`);
				assert.ok(
					!child[field].read_only || READ_ONLY_INPUTS.has(field),
					`${spec.doctype}.${field} is read-only and not a fetched input`
				);
				if (!READ_ONLY_INPUTS.has(field)) {
					assert.ok(
						!COMPUTED.test(field) || field === "tax_amount",
						`${spec.doctype}.${field} looks computed`
					);
				}
			}
		}
	}
	// the ticket listed sales_team for Sales Order only
	assert.deepEqual(Object.keys(SNAPSHOT_FIELDS["Sales Order"].tables), ["items", "taxes", "sales_team"]);
	assert.deepEqual(Object.keys(SNAPSHOT_FIELDS.Quotation.tables), ["items", "taxes"]);
	assert.ok(!("sales_team" in parents.Quotation), "the fact this relies on");
});

// --- the Smart Inbox hook -------------------------------------------------------------------------------

// The smart inbox file and the recovery file in one sandbox, the way the bundle loads them.
function loadBoth() {
	const h = load({
		extra: "",
	});
	return h;
}

function loadSmartInbox({ withRecovery }) {
	const inboxHandlers = [];
	const calls = [];
	function ScriptManager() {}
	ScriptManager.prototype.trigger = function (...args) {
		calls.push(args[0]);
		return Promise.resolve();
	};
	const storage = makeStorage();
	const afterAjax = [];
	const sandbox = {
		console: { log() {}, warn() {}, error() {} },
		localStorage: storage,
		sessionStorage: makeStorage(),
		setTimeout: (fn) => fn(),
		setInterval: () => 1,
		clearInterval() {},
		$: () =>
			new Proxy(
				{ length: 0 },
				{ get: (target, key) => (key in target ? target[key] : () => sandbox.$()) }
			),
		__: translate,
		frappe: {
			boot: { adhd_mode: true },
			session: { user: "ann@example.com" },
			provide() {},
			get_route: () => [],
			get_route_str: () => "",
			set_route() {},
			router: { on: (_event, fn) => inboxHandlers.push(fn) },
			after_ajax: (fn) => afterAjax.push(fn),
			datetime: { get_today: () => "2026-09-21", prettyDate: String },
			call: async () => ({ message: [] }),
			utils: { escape_html: escapeHtml },
			ui: { form: { ScriptManager } },
		},
		erpnext: { adhd: {} },
	};
	const offers = [];
	if (withRecovery) {
		sandbox.erpnext.adhd.draftRecovery = { checkAndOfferDraftRestore: (frm) => offers.push(frm.doctype) };
	}
	vm.runInNewContext(readAdhd("adhd_smart_inbox.js"), sandbox, { filename: "adhd_smart_inbox.js" });
	afterAjax.forEach((fn) => fn());
	return { sandbox, calls, offers, storage, ScriptManager };
}

test("the Smart Inbox form hook asks for the draft offer on refresh, and still tracks saves", () => {
	const inbox = loadSmartInbox({ withRecovery: true });
	const manager = { frm: { doctype: "Sales Order", doc: { name: "SAL-ORD-1", title: "T" } } };
	inbox.sandbox.frappe.ui.form.ScriptManager.prototype.trigger.call(manager, "refresh");
	inbox.sandbox.frappe.ui.form.ScriptManager.prototype.trigger.call(manager, "customer");
	assert.deepEqual(inbox.offers, ["Sales Order"], "only refresh asks, once per refresh");

	inbox.sandbox.frappe.ui.form.ScriptManager.prototype.trigger.call(manager, "after_save");
	assert.ok(
		inbox.storage.data.has("adhd_recent_docs_ann@example.com"),
		"the Resume panel still records the save"
	);
	assert.deepEqual(inbox.offers, ["Sales Order"], "a save is not a refresh");
});

test("the Smart Inbox form hook is harmless without the recovery module and when the offer throws", () => {
	const alone = loadSmartInbox({ withRecovery: false });
	const manager = { frm: { doctype: "Sales Order", doc: { name: "SAL-ORD-1" } } };
	assert.doesNotThrow(() =>
		alone.sandbox.frappe.ui.form.ScriptManager.prototype.trigger.call(manager, "refresh")
	);

	const throwing = loadSmartInbox({ withRecovery: true });
	throwing.sandbox.erpnext.adhd.draftRecovery.checkAndOfferDraftRestore = () => {
		throw new Error("boom");
	};
	assert.doesNotThrow(() =>
		throwing.sandbox.frappe.ui.form.ScriptManager.prototype.trigger.call(manager, "refresh")
	);
});

test("with both hooks asking on every refresh there is still exactly one banner", () => {
	const h = loadBoth();
	seed(h);
	const frm = h.makeFrm();
	// the Smart Inbox hook and the form's own refresh handler, in either order, twice
	h.sandbox.erpnext.adhd.draftRecovery.checkAndOfferDraftRestore(frm);
	h.fire("Sales Order", "refresh", frm);
	h.sandbox.erpnext.adhd.draftRecovery.checkAndOfferDraftRestore(frm);
	h.fire("Sales Order", "refresh", frm);
	assert.equal(h.banners().length, 1);
});
