// Regression tests for the review fixes in adhd_tickets_041_061.js and adhd_stock_entry.js.
// Each assertion is written to fail against the code as it was before the fixes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Arrays made inside the vm carry another realm's prototype, which deepStrictEqual would reject.
const plain = (value) => JSON.parse(JSON.stringify(value));
const jsRoot = path.resolve(__dirname, "../public/js/adhd");
const readAdhd = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");

// moment-timezone is not a dependency of this repo. Use the real one when the bench provides it,
// otherwise a stand-in that knows the two zones these tests use.
const OFFSET_MINUTES = { "Asia/Kolkata": 330, "America/New_York": -240 };
function fakeMoment() {
	const parse = (value, zone) => {
		const text = String(value);
		const explicit = /[zZ]$|[+-]\d\d:?\d\d$/.test(text);
		const ms = Date.parse(`${text.replace(" ", "T")}${explicit ? "" : "Z"}`);
		return { valueOf: () => (explicit ? ms : ms - OFFSET_MINUTES[zone] * 60000) };
	};
	const moment = (ms) => {
		let offset = 0;
		const api = {
			tz(zone) {
				offset = OFFSET_MINUTES[zone] || 0;
				return api;
			},
			format: () => new Date(ms + offset * 60000).toISOString().slice(0, 19).replace("T", " "),
		};
		return api;
	};
	moment.tz = parse;
	return moment;
}
function loadMoment() {
	try {
		return require("moment-timezone");
	} catch {
		return fakeMoment();
	}
}

// A small stand-in for jQuery that keeps track of what is inside `.form-layout`.
function makeDom() {
	const layout = [];
	const child = (owner, selector) =>
		new Proxy(
			{},
			{
				get(_target, key) {
					if (key === "on") {
						return (event, handler) => {
							owner.handlers[`${selector}:${event}`] = handler;
							return child(owner, selector);
						};
					}
					return () => child(owner, selector);
				},
			}
		);
	const makeNode = (html) => {
		const node = { html, handlers: {}, length: 1 };
		node.find = (selector) => child(node, selector);
		node.on = () => node;
		node.addClass = () => node;
		node.remove = () => node;
		return node;
	};
	const wrapperSelection = {
		find(selector) {
			return {
				remove() {
					for (let index = layout.length - 1; index >= 0; index--) {
						const marker = selector.slice(1);
						if (layout[index].html.includes(marker)) layout.splice(index, 1);
					}
					return this;
				},
				first() {
					return { prepend: (node) => layout.push(node), before() {}, length: 1 };
				},
				length: 0,
			};
		},
		removeClass: () => wrapperSelection,
		addClass: () => wrapperSelection,
	};
	const $ = (input) => (typeof input === "string" ? makeNode(input) : wrapperSelection);
	return { $, layout, has: (marker) => layout.filter((node) => node.html.includes(marker)).length };
}

function loadTickets({ adhdMode = true, dateFormat, timeZone, calls = [], overrides = {} } = {}) {
	const registrations = [];
	const dom = makeDom();
	const sandbox = {
		console,
		Date,
		Map,
		Promise,
		Set,
		Number,
		String,
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		clearInterval() {},
		clearTimeout() {},
		setInterval: () => 1,
		setTimeout: (fn) => {
			fn();
			return 1;
		},
		localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
		locals: {},
		window: { setTimeout },
		$: dom.$,
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.replace(`{${index}}`, value), text),
		cint: (value) => Number.parseInt(value || 0, 10),
		flt: (value) => Number.parseFloat(value || 0),
		format_currency: (value) => String(value),
		format_number: (value) => String(value),
		moment: loadMoment(),
		erpnext: { adhd: {}, work_order: {} },
		frappe: {
			boot: { adhd_mode: adhdMode, ...(timeZone ? { time_zone: { system: timeZone } } : {}) },
			call: async (request) => {
				calls.push(request);
				return { message: 0 };
			},
			confirm() {},
			datetime: {
				add_days: (value, days) => {
					const date = new Date(`${value}T00:00:00Z`);
					date.setUTCDate(date.getUTCDate() + days);
					return date.toISOString().slice(0, 10);
				},
				get_diff: (later, earlier) =>
					Math.floor(
						(new Date(`${later}T00:00:00Z`) - new Date(`${earlier}T00:00:00Z`)) / 86400000
					),
				get_today: () => "2026-09-20",
				str_to_user: (value) => value,
				...(dateFormat ? { get_user_date_fmt: () => dateFormat } : {}),
			},
			db: { get_list: async () => [], get_value: async () => ({ message: {} }) },
			model: {},
			provide() {},
			session: { user: "user@example.com" },
			show_alert() {},
			msgprint() {},
			ui: { form: { on: (doctype, handlers) => registrations.push({ doctype, handlers }) } },
			utils: { escape_html: (value) => String(value) },
		},
		...overrides,
	};
	const file = "adhd_tickets_041_061.js";
	vm.runInNewContext(readAdhd(file), sandbox, { filename: file });
	const handlers = (doctype) => registrations.find((entry) => entry.doctype === doctype)?.handlers;
	return { sandbox, registrations, handlers, dom, calls };
}

const IST = "Asia/Kolkata";

test("handlers register and follow the mode even when it is off at load", async () => {
	const { sandbox, registrations, handlers, dom } = loadTickets({ adhdMode: false });
	assert.ok(registrations.length >= 17, "handlers must be registered while the mode is off");
	const frm = { doc: { name: "JC-1", docstatus: 0, status: "Open" }, wrapper: {}, is_new: () => false };
	await handlers("Job Card").refresh(frm);
	assert.equal(dom.has("adhd-time-toggle"), 0);
	sandbox.frappe.boot.adhd_mode = true;
	await handlers("Job Card").refresh(frm);
	assert.equal(dom.has("adhd-time-toggle"), 1);
	sandbox.frappe.boot.adhd_mode = false;
	await handlers("Job Card").refresh(frm);
	assert.equal(dom.has("adhd-time-toggle"), 0);
});

test("ADHD-044 timer shows on a saved draft Job Card and not on submitted or completed ones", async () => {
	const { handlers, dom } = loadTickets();
	const show = async (doc) => {
		await handlers("Job Card").refresh({ doc, wrapper: {}, is_new: () => false });
		return dom.has("adhd-time-toggle");
	};
	assert.equal(await show({ name: "JC-1", docstatus: 0, status: "Open" }), 1);
	assert.equal(await show({ name: "JC-1", docstatus: 0, status: "Work In Progress" }), 1);
	assert.equal(await show({ name: "JC-1", docstatus: 1, status: "Submitted" }), 0);
	assert.equal(await show({ name: "JC-1", docstatus: 0, status: "Completed" }), 0);
});

test("ADHD-044 and 045 read and write datetimes in the system time zone", () => {
	const { sandbox } = loadTickets({ timeZone: IST });
	const utc = Date.UTC(2026, 8, 20, 6, 30, 0);
	assert.equal(sandbox.erpnext.adhd.datetimeMs("2026-09-20 12:00:00"), utc);
	assert.equal(sandbox.erpnext.adhd.datetimeMs("2026-09-20 12:00:00.123456"), utc + 123);
	assert.equal(sandbox.erpnext.adhd.datetimeMs("2026-09-20T12:00:00Z"), utc + 5.5 * 3600000);
	// Written back as "YYYY-MM-DD HH:mm:ss", never as an ISO "T...Z" instant.
	assert.equal(sandbox.erpnext.adhd.systemDatetimeAt(utc), "2026-09-20 12:00:00");
	// Without a system zone in boot the browser's zone is the fallback.
	const local = loadTickets().sandbox;
	assert.equal(
		local.erpnext.adhd.datetimeMs("2026-09-20 12:00:00"),
		new Date("2026-09-20T12:00:00").getTime()
	);
});

test("ADHD-045 blocked threshold is two hours in the system time zone", () => {
	const { sandbox } = loadTickets({ timeZone: IST });
	const card = { expected_end_date: "2026-09-20 10:00:00" };
	const endsAt = Date.UTC(2026, 8, 20, 4, 30, 0);
	assert.equal(sandbox.erpnext.adhd.isBlockedJobCard(card, endsAt + 2 * 3600000), false);
	assert.equal(sandbox.erpnext.adhd.isBlockedJobCard(card, endsAt + 2 * 3600000 + 1000), true);
});

test("ADHD-051 SLA countdown uses the system time zone and stops for finished Issues", () => {
	const { sandbox } = loadTickets({ timeZone: IST });
	const doc = { creation: "2026-09-20 08:00:00", sla_resolution_by: "2026-09-20 12:00:00" };
	const deadline = Date.UTC(2026, 8, 20, 6, 30, 0);
	assert.equal(sandbox.erpnext.adhd.slaState(doc, deadline - 3600000).remaining, 3600000);
	assert.equal(sandbox.erpnext.adhd.slaState(doc, deadline + 1000).tone, "red");
	for (const finished of [
		{ status: "Closed" },
		{ status: "Resolved" },
		{ agreement_status: "Fulfilled" },
	]) {
		assert.equal(sandbox.erpnext.adhd.slaState({ ...doc, ...finished }, deadline + 1000), null);
	}
	assert.notEqual(sandbox.erpnext.adhd.slaState({ ...doc, status: "Open" }, deadline), null);
});

test("ADHD-048 only accepts real dates and reads them in the user's date format", () => {
	const monthFirst = loadTickets({ dateFormat: "mm/dd/yyyy" }).sandbox.erpnext.adhd;
	assert.equal(monthFirst.resolvePromiseDate("12/25", "2026-09-20"), "2026-12-25");
	assert.equal(monthFirst.resolvePromiseDate("25/12", "2026-09-20"), null);
	assert.equal(monthFirst.resolvePromiseDate("2/31", "2026-09-20"), null);
	assert.equal(monthFirst.resolvePromiseDate("12/25/27", "2026-09-20"), "2027-12-25");
	assert.equal(monthFirst.resolvePromiseDate("12/25/026", "2026-09-20"), null);
	assert.equal(monthFirst.extractCommitment("I will call back by 25/12").date, null);

	const dayFirst = loadTickets({ dateFormat: "dd-mm-yyyy" }).sandbox.erpnext.adhd;
	assert.equal(dayFirst.resolvePromiseDate("25/12", "2026-09-20"), "2026-12-25");
	assert.equal(dayFirst.resolvePromiseDate("12/25", "2026-09-20"), null);
	assert.equal(dayFirst.resolvePromiseDate("5-3-2027", "2026-09-20"), "2027-03-05");
});

test("ADHD-048 strips HTML from a CRM Note before it becomes the ToDo description", async () => {
	const inserted = [];
	const { sandbox, handlers, dom } = loadTickets({
		overrides: {
			locals: { "CRM Note": { row1: { note: "<p>I'll send the <b>proposal</b> by Friday.</p>" } } },
		},
	});
	sandbox.frappe.db.insert = async (doc) => {
		inserted.push(doc);
		return { name: "TODO-1" };
	};
	const frm = { doc: { name: "OPP-1" }, doctype: "Opportunity", wrapper: {}, is_new: () => false };
	handlers("CRM Note").note(frm, "CRM Note", "row1");
	const banner = dom.layout.find((node) => node.html.includes("adhd-commitment-banner"));
	assert.ok(banner, "commitment banner was not rendered");
	await banner.handlers[".btn-primary:click"]();
	assert.equal(inserted.length, 1);
	assert.doesNotMatch(inserted[0].description, /[<>]/);
	assert.match(inserted[0].description, /send the proposal by Friday/);
});

test("ADHD-049 pipeline has no Negotiation stage that maps to Closed", async () => {
	const { handlers, dom } = loadTickets();
	await handlers("Opportunity").refresh({ doc: { status: "Quotation" }, wrapper: {} });
	const html = dom.layout.find((node) => node.html.includes("adhd-pipeline")).html;
	assert.doesNotMatch(html, /Negotiation|data-status="Closed"/);
	assert.deepEqual(
		[...html.matchAll(/data-status="([^"]+)"/g)].map((match) => match[1]),
		["Open", "Replied", "Quotation", "Converted", "Lost"]
	);
});

test("ADHD-042 Work Order prompts respect operations and every unfinished Job Card status", async () => {
	const calls = [];
	const { handlers, dom } = loadTickets({ calls });
	const workOrder = (doc) => ({ doc: { name: "WO-1", ...doc }, wrapper: {}, trigger() {} });
	await handlers("Work Order").refresh(
		workOrder({ status: "Submitted", operations: [], __onload: { show_create_job_card_button: true } })
	);
	assert.equal(dom.has("adhd-work-order-next"), 0);
	await handlers("Work Order").refresh(
		workOrder({ status: "Submitted", operations: [{ name: "op" }], __onload: {} })
	);
	assert.equal(dom.has("adhd-work-order-next"), 0);
	await handlers("Work Order").refresh(
		workOrder({
			status: "Submitted",
			operations: [{ name: "op" }],
			__onload: { show_create_job_card_button: true },
		})
	);
	assert.equal(dom.has("adhd-work-order-next"), 1);

	calls.length = 0;
	await handlers("Work Order").refresh(workOrder({ status: "In Process" }));
	const unfinished = calls[0].args.filters.status[1];
	for (const status of ["On Hold", "To Manufacture", "Open", "Work In Progress"]) {
		assert.ok(unfinished.includes(status), `${status} must count as unfinished`);
	}
	assert.ok(!unfinished.includes("Submitted") && !unfinished.includes("Completed"));
});

test("ADHD-046 the overdue count and the list it links to use the same filters", async () => {
	const calls = [];
	const { handlers, dom } = loadTickets({ calls });
	await handlers("Project").refresh({
		doc: { name: "PROJ-1", percent_complete: 10 },
		wrapper: {},
		is_new: () => false,
	});
	const overdueFilters = calls[0].args.filters;
	const html = dom.layout.find((node) => node.html.includes("adhd-project-health")).html;
	const href = html.match(/href="([^"]+)"/)[1];
	const query = new URLSearchParams(href.split("?")[1]);
	assert.equal(query.get("project"), "PROJ-1");
	assert.deepEqual(JSON.parse(query.get("status")), plain(overdueFilters.status));
	assert.deepEqual(JSON.parse(query.get("exp_end_date")), plain(overdueFilters.exp_end_date));
});

test("ADHD-061 counts receipts through the Subcontracting Receipt Item filter", async () => {
	const calls = [];
	const { handlers } = loadTickets({ calls });
	await handlers("Subcontracting Order").refresh({
		doc: { name: "SCO-1", docstatus: 1, status: "Open", per_received: 0, supplied_items: [] },
		wrapper: {},
	});
	const { filters, doctype } = calls[0].args;
	assert.equal(doctype, "Subcontracting Receipt");
	assert.ok(Array.isArray(filters), "child table filters have to be given as a list");
	assert.deepEqual(plain(filters[0]), [
		"Subcontracting Receipt Item",
		"subcontracting_order",
		"=",
		"SCO-1",
	]);
	assert.deepEqual(plain(filters[1]), ["docstatus", "!=", 2]);
});

test("overlapping renders leave a single banner", async () => {
	const pending = [];
	const { sandbox, handlers, dom } = loadTickets();
	// A call that only resolves when released, so two renders are in flight together.
	sandbox.frappe.call = () => new Promise((resolve) => pending.push(() => resolve({ message: 0 })));
	const subcontracting = {
		doc: { name: "SCO-1", docstatus: 1, status: "Open", per_received: 0, supplied_items: [] },
		wrapper: {},
	};
	const invoice = {
		doc: { name: "PINV-1", docstatus: 1, items: [{ is_fixed_asset: 1, item_code: "A", name: "row" }] },
		wrapper: {},
	};
	const runs = [
		handlers("Subcontracting Order").refresh(subcontracting),
		handlers("Subcontracting Order").refresh(subcontracting),
		handlers("Purchase Invoice").refresh(invoice),
		handlers("Purchase Invoice").after_save(invoice),
	];
	pending.splice(0).forEach((release) => release());
	await Promise.all(runs);
	assert.equal(dom.has('id="adhd-subcon-chain"'), 1);
	assert.equal(dom.has('id="adhd-asset-prompt"'), 1);
});

test("SLA badge label is escaped once, not twice", () => {
	const source = readAdhd("adhd_tickets_041_061.js");
	assert.doesNotMatch(source, /\.text\(html\)/);
	assert.doesNotMatch(source, /\.text\(esc\(/);
});

function loadStockEntry(calls = []) {
	const chain = new Proxy(
		{ length: 0 },
		{ get: (target, key) => (key in target ? target[key] : () => chain) }
	);
	const sandbox = {
		console,
		Map,
		Promise,
		Set,
		$: () => chain,
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.replace(`{${index}}`, value), text),
		format_number: (value) => String(value),
		erpnext: { adhd: {} },
		frappe: {
			boot: { adhd_mode: true },
			call: async (request) => {
				calls.push(request);
				return {
					message: request.args.pairs.map((pair) => ({ ...pair, actual_qty: 5 })),
				};
			},
			provide() {},
			ui: { form: { on() {} } },
			utils: { debounce: (fn) => fn, escape_html: (value) => String(value) },
		},
	};
	vm.runInNewContext(readAdhd("adhd_stock_entry.js"), sandbox, { filename: "adhd_stock_entry.js" });
	return sandbox;
}

test("ADHD-035 accumulates rows for the same item and warehouse", () => {
	const { erpnext } = loadStockEntry();
	const rows = erpnext.adhd.buildStockPreviewRows(
		[
			{ item_code: "A", s_warehouse: "Stores", qty: 8 },
			{ item_code: "A", s_warehouse: "Stores", qty: 8 },
			{ item_code: "A", t_warehouse: "Stores", qty: 1 },
		],
		{ "A::Stores": 10 }
	);
	assert.deepEqual(
		Array.from(rows, (row) => [row.current_qty, row.change, row.after]),
		[
			[10, -8, 2],
			[2, -8, -6],
			[-6, 1, -5],
		]
	);
});

test("ADHD-035 sends at most 400 pairs per request and keeps every result", async () => {
	const calls = [];
	const { erpnext } = loadStockEntry(calls);
	const pairs = Array.from({ length: 950 }, (_, index) => ({ item_code: `ITEM-${index}`, warehouse: "W" }));
	const chunks = erpnext.adhd.chunkStockPairs(pairs);
	assert.deepEqual(plain(chunks.map((chunk) => chunk.length)), [400, 400, 150]);
	assert.deepEqual(plain(chunks.flat()), pairs);
	const map = await erpnext.adhd.fetchBinQuantities(pairs);
	assert.equal(calls.length, 3);
	assert.ok(calls.every((call) => call.args.pairs.length <= 400));
	assert.equal(Object.keys(map).length, 950);
	assert.equal(map["ITEM-949::W"], 5);
	assert.deepEqual(plain(await erpnext.adhd.fetchBinQuantities([])), {});
});

test("highlight colours use tokens that exist in Frappe", () => {
	for (const file of ["adhd_stock_entry.js", "adhd_batch_picker.js"]) {
		const source = readAdhd(file);
		assert.doesNotMatch(source, /--(red|yellow)-rgb/);
		assert.match(source, /color-mix\(in srgb,var\(--(red|yellow)-500\)/);
	}
});
