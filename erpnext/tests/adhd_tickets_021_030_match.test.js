// ADHD-028: Purchase Invoice three-way match badge. Runs the real client module in a vm sandbox with a small fake of
// Frappe's form events, its debounce, its ajax call and jQuery, so what it does to the page and to the server is
// observed, not assumed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const moduleName = "adhd_purchase_invoice_match.js";
const source = fs.readFileSync(path.join(repoRoot, "public/js/adhd", moduleName), "utf8");
const METHOD = "erpnext.accounts.services.adhd_three_way_match.get_three_way_match";

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---- fakes ---------------------------------------------------------------------------------------------------

// Time only moves when the test moves it, so "500 ms" is checked exactly.
function makeClock() {
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	return {
		setTimeout(fn, ms) {
			const id = nextId++;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		tick(ms) {
			const end = now + ms;
			for (;;) {
				const due = [...timers]
					.filter(([, timer]) => timer.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].fn();
			}
			now = end;
		},
		pending: () => timers.size,
	};
}

// The same behaviour as frappe.utils.debounce (frappe/public/js/frappe/utils/utils.js), on the fake clock.
function makeDebounce(clock, waits) {
	return (func, wait) => {
		waits.push(wait);
		let timeout = null;
		const debounced = function (...args) {
			clock.clearTimeout(timeout);
			timeout = clock.setTimeout(() => {
				timeout = null;
				func.apply(this, args);
			}, wait);
		};
		debounced.cancel = () => {
			if (timeout === null) return false;
			clock.clearTimeout(timeout);
			timeout = null;
			return true;
		};
		return debounced;
	};
}

// A tree of nodes, each holding the HTML that was appended to it. Enough jQuery for the module: $(node).append,
// $(node).find(".class").remove(), and an empty collection for something that is not there.
function makeJquery(touched) {
	const firstTagClasses = (html) => (/^\s*<[^>]*class="([^"]*)"/.exec(html || "")?.[1] || "").split(/\s+/);
	const descendants = (node) => (node.children || []).flatMap((child) => [child, ...descendants(child)]);
	return (target) => {
		const node = target && typeof target === "object" ? target : null;
		// the page is only ever reached through $(...), so this counts every time the feature touches it
		if (node) touched.count++;
		const collection = {
			length: node ? 1 : 0,
			append(html) {
				node.children.push({ html, children: [] });
				return collection;
			},
			find(selector) {
				const className = selector.replace(/^\./, "");
				const found = node
					? descendants(node).filter((child) => firstTagClasses(child.html).includes(className))
					: [];
				return {
					length: found.length,
					remove() {
						const drop = (parent) => {
							parent.children = parent.children.filter((child) => !found.includes(child));
							parent.children.forEach(drop);
						};
						if (node) drop(node);
					},
				};
			},
		};
		return collection;
	};
}

const HTML_ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
	"/": "&#x2F;",
	"`": "&#x60;",
	"=": "&#x3D;",
};
// as frappe.utils.escape_html and frappe.utils.get_form_link do it
const escapeHtml = (text) => String(text).replace(/[&<>"'`=/]/g, (char) => HTML_ESCAPES[char] || char);
const getFormLink = (doctype, name, html = false, displayText = null) => {
	displayText = displayText || escapeHtml(name);
	const route = `/desk/${encodeURIComponent(doctype.toLowerCase().replace(/ /g, "-"))}/${encodeURIComponent(
		name
	)}`;
	return html ? `<a href="${route}">${displayText}</a>` : route;
};

function load({ adhdMode = true } = {}) {
	const clock = makeClock();
	const waits = [];
	const registrations = {};
	const observers = [];
	const calls = [];
	const currencyCalls = [];
	const touched = { count: 0 };

	const sandbox = {
		console: { log() {}, warn() {}, error() {} },
		$: makeJquery(touched),
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.replace(`{${index}}`, value), text),
		flt: (value) => Number.parseFloat(value) || 0,
		cint: (value) => Number.parseInt(value, 10) || 0,
		format_currency: (value, currency) => {
			currencyCalls.push(currency);
			return `${currency} ${Number(value).toFixed(2)}`;
		},
		window: {},
		erpnext: {
			adhd: {
				onStateChange(fn) {
					observers.push(fn);
					fn(Boolean(sandbox.frappe.boot.adhd_mode));
				},
			},
		},
		frappe: {
			boot: { adhd_mode: adhdMode },
			provide() {},
			call: (opts) =>
				new Promise((resolve, reject) => {
					calls.push({ opts, resolve, reject });
				}),
			utils: {
				debounce: makeDebounce(clock, waits),
				escape_html: escapeHtml,
				get_form_link: getFormLink,
			},
			ui: {
				form: {
					on(doctype, handlers) {
						const target = (registrations[doctype] ||= {});
						for (const [event, handler] of Object.entries(handlers))
							(target[event] ||= []).push(handler);
					},
				},
			},
		},
	};
	vm.runInNewContext(source, sandbox, { filename: moduleName });

	return {
		sandbox,
		clock,
		waits,
		calls,
		currencyCalls,
		touched,
		registrations,
		adhd: sandbox.erpnext.adhd,
		fire(doctype, event, frm) {
			(registrations[doctype]?.[event] || []).forEach((handler) =>
				handler(frm, "Purchase Invoice Item", "row-1")
			);
		},
		setMode(active) {
			sandbox.frappe.boot.adhd_mode = active;
			observers.forEach((observer) => observer(active));
		},
	};
}

const ITEM = "Purchase Invoice Item";
const INVOICE = "Purchase Invoice";

function makeRow(overrides = {}) {
	return {
		idx: 1,
		item_code: "WIDGET",
		purchase_order: "PUR-ORD-2026-00001",
		po_detail: "po-row-1",
		purchase_receipt: "",
		pr_detail: "",
		qty: 7,
		rate: 100,
		amount: 700,
		...overrides,
	};
}

function makeForm(doc = {}) {
	const grandTotal = { children: [] };
	return {
		doctype: INVOICE,
		doc: { docstatus: 0, currency: "USD", is_return: 0, items: [makeRow()], ...doc },
		wrapper: { children: [grandTotal] },
		fields_dict: { grand_total: { wrapper: grandTotal } },
		grandTotal,
	};
}

const badges = (frm) => frm.grandTotal.children.map((child) => child.html);

function reference(overrides = {}) {
	return {
		doctype: "Purchase Order",
		name: "PUR-ORD-2026-00001",
		currency: "USD",
		status: "match",
		rows: 1,
		reference_amount: 1000,
		already_billed: 300,
		this_invoice: 700,
		max_allowed: 1000,
		over_by: 0,
		open_amount: 700,
		remaining_after: 0,
		issues: [],
		...overrides,
	};
}

function answer(status, references, extra = {}) {
	return {
		status,
		currency: "USD",
		totals: { remaining_after: 0, over_by: 0 },
		references,
		checked_rows: references.length,
		unreadable_rows: 0,
		...extra,
	};
}

// refresh, wait out the debounce, let the server answer
async function checkWith(env, frm, message, event = ["Purchase Invoice", "refresh"]) {
	env.fire(...event, frm);
	env.clock.tick(500);
	const call = env.calls.at(-1);
	call.resolve({ message });
	await flush();
	return call;
}

// ---- what the module relies on really exists ----------------------------------------------------------------------

test("links are read from the item rows: the invoice header has no purchase_order or purchase_receipt", () => {
	const fieldNames = (doctype, folder) => {
		const file = path.join(repoRoot, folder, "doctype", doctype, `${doctype}.json`);
		return new Set(JSON.parse(fs.readFileSync(file, "utf8")).fields.map((field) => field.fieldname));
	};
	const invoice = fieldNames("purchase_invoice", "accounts");
	const item = fieldNames("purchase_invoice_item", "accounts");

	// the ticket's header fields do not exist, so a handler on them never fires
	assert.equal(invoice.has("purchase_order"), false);
	assert.equal(invoice.has("purchase_receipt"), false);
	for (const field of [
		"purchase_order",
		"po_detail",
		"purchase_receipt",
		"pr_detail",
		"qty",
		"rate",
		"amount",
	]) {
		assert.equal(item.has(field), true, `Purchase Invoice Item has ${field}`);
	}
	for (const field of ["grand_total", "currency", "is_return", "is_internal_supplier", "net_total"]) {
		assert.equal(invoice.has(field), true, `Purchase Invoice has ${field}`);
	}

	const env = load();
	// every event it listens to on a row is a field of that row (or the grid's own "items_remove")
	for (const event of Object.keys(env.registrations[ITEM])) {
		assert.ok(event === "items_remove" || item.has(event), `${event} is a Purchase Invoice Item field`);
	}
	for (const event of Object.keys(env.registrations[INVOICE])) {
		assert.ok(event === "refresh" || invoice.has(event), `${event} is a Purchase Invoice field`);
	}
	assert.ok(
		env.registrations[ITEM].qty && env.registrations[ITEM].rate && env.registrations[ITEM].po_detail
	);
	// the grid triggers items_remove on the CHILD doctype's handlers (script_manager.trigger(..., d.doctype, ...))
	assert.ok(env.registrations[ITEM].items_remove);
});

test("the endpoint the client calls is a whitelisted function that exists", () => {
	const python = fs.readFileSync(path.join(repoRoot, "accounts/services/adhd_three_way_match.py"), "utf8");
	assert.match(python, /@frappe\.whitelist\(\)\s+def get_three_way_match\(/);
	assert.match(source, new RegExp(METHOD.replace(/\./g, "\\.")));
});

// ---- mode off -------------------------------------------------------------------------------------------------------

test("mode off: no request, no timer, nothing on the page", async () => {
	const env = load({ adhdMode: false });
	const frm = makeForm();
	env.fire(INVOICE, "refresh", frm);
	for (const event of ["qty", "rate", "po_detail", "items_remove"]) env.fire(ITEM, event, frm);
	for (const event of ["net_total", "currency"]) env.fire(INVOICE, event, frm);
	env.clock.tick(10_000);
	await flush();

	assert.equal(env.calls.length, 0);
	assert.equal(env.clock.pending(), 0);
	assert.equal(env.waits.length, 0, "not even a debounced function is made");
	assert.deepEqual(badges(frm), []);
	assert.equal(env.touched.count, 0, "the page is not touched at all");

	// including the clean-up a submitted or returned invoice would otherwise get
	for (const doc of [{ docstatus: 1 }, { docstatus: 2 }, { is_return: 1 }, { items: [] }]) {
		env.fire(INVOICE, "refresh", makeForm(doc));
	}
	assert.equal(env.touched.count, 0);
	assert.equal(env.calls.length, 0);
});

test("the mode is read when a handler runs, not once at load", async () => {
	const env = load({ adhdMode: false });
	const frm = makeForm();
	env.fire(INVOICE, "refresh", frm);
	assert.equal(env.clock.pending(), 0);

	env.sandbox.frappe.boot.adhd_mode = true;
	env.fire(INVOICE, "refresh", frm);
	assert.equal(env.clock.pending(), 1);
	env.clock.tick(500);
	assert.equal(env.calls.length, 1);
});

test("switching the mode off removes the badge, cancels a pending check and ignores a late answer", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(env, frm, answer("match", [reference()]));
	assert.equal(badges(frm).length, 1);

	// a check waiting out its debounce, and one whose request is already out
	frm.doc.items[0].amount = 710;
	env.fire(ITEM, "rate", frm);
	env.setMode(false);
	assert.deepEqual(badges(frm), []);
	assert.equal(env.clock.pending(), 0, "the pending check is cancelled");
	env.clock.tick(5_000);
	assert.equal(env.calls.length, 1, "no request after the switch");

	env.sandbox.frappe.boot.adhd_mode = true;
	frm.doc.items[0].amount = 720;
	env.fire(ITEM, "rate", frm);
	env.clock.tick(500);
	assert.equal(env.calls.length, 2);
	env.setMode(false);
	env.calls[1].resolve({ message: answer("match", [reference()]) });
	await flush();
	assert.deepEqual(badges(frm), [], "an answer that arrives after the switch draws nothing");
});

test("switching the mode on shows the badge on the invoice that is already open", async () => {
	const env = load({ adhdMode: false });
	const frm = makeForm();
	env.sandbox.window.cur_frm = frm;
	env.setMode(true);
	env.clock.tick(500);
	assert.equal(env.calls.length, 1);
	env.calls[0].resolve({ message: answer("match", [reference()]) });
	await flush();
	assert.equal(badges(frm).length, 1);
});

// ---- when it asks the server ----------------------------------------------------------------------------------------

test("a draft that references a Purchase Order asks once, 500 ms after the refresh, with only the referenced rows", async () => {
	const env = load();
	const frm = makeForm({
		items: [
			makeRow(),
			makeRow({ idx: 2, item_code: "LOOSE", po_detail: "", purchase_order: "", amount: 5 }),
			makeRow({
				idx: 3,
				item_code: "GADGET",
				po_detail: "",
				pr_detail: "pr-row-9",
				purchase_receipt: "MAT-PRE-1",
			}),
		],
	});
	env.fire(INVOICE, "refresh", frm);
	assert.deepEqual(env.waits, [500]);
	env.clock.tick(499);
	assert.equal(env.calls.length, 0, "nothing yet at 499 ms");
	env.clock.tick(1);
	assert.equal(env.calls.length, 1);

	const { method, args, silent } = env.calls[0].opts;
	assert.equal(method, METHOD);
	assert.equal(silent, true, "a permission failure must not open a dialog");
	assert.equal(args.currency, "USD");
	assert.deepEqual(
		args.items.map((row) => [row.idx, row.po_detail, row.pr_detail]),
		[
			[1, "po-row-1", ""],
			[3, "", "pr-row-9"],
		]
	);
	assert.deepEqual(Object.keys(args.items[0]).sort(), [
		"amount",
		"idx",
		"item_code",
		"po_detail",
		"pr_detail",
		"purchase_order",
		"purchase_receipt",
		"rate",
	]);
});

test("a burst of edits is one request", () => {
	const env = load();
	const frm = makeForm();
	for (let i = 0; i < 6; i++) {
		frm.doc.items[0].amount = 700 + i;
		env.fire(ITEM, "qty", frm);
		env.clock.tick(100);
	}
	assert.equal(env.calls.length, 0, "still inside the debounce");
	env.clock.tick(500);
	assert.equal(env.calls.length, 1);
	assert.equal(env.calls[0].opts.args.items[0].amount, 705, "it sends the values as they are then");
});

test("no reference: no badge and no request", async () => {
	const env = load();
	const frm = makeForm({ items: [makeRow({ po_detail: "", purchase_order: "" })] });
	env.fire(INVOICE, "refresh", frm);
	env.fire(ITEM, "qty", frm);
	env.clock.tick(5_000);
	await flush();
	assert.equal(env.calls.length, 0);
	assert.deepEqual(badges(frm), []);

	// a row that names a Purchase Order but has no row link cannot be compared row by row
	const headerOnly = makeForm({ items: [makeRow({ po_detail: "" })] });
	env.fire(INVOICE, "refresh", headerOnly);
	env.clock.tick(5_000);
	assert.equal(env.calls.length, 0);
});

test("the server saying there is no reference draws nothing either", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(env, frm, answer("no_reference", []));
	assert.deepEqual(badges(frm), []);
	await checkWith(env, makeForm(), null);
});

test("a return (debit note) is not checked", () => {
	const env = load();
	const frm = makeForm({ is_return: 1 });
	env.fire(INVOICE, "refresh", frm);
	env.clock.tick(5_000);
	assert.equal(env.calls.length, 0);
	assert.deepEqual(badges(frm), []);
});

test("submitted and cancelled invoices get no badge and no request", async () => {
	for (const docstatus of [1, 2]) {
		const env = load();
		const frm = makeForm({ docstatus });
		env.fire(INVOICE, "refresh", frm);
		env.fire(ITEM, "rate", frm);
		env.clock.tick(5_000);
		assert.equal(env.calls.length, 0, `docstatus ${docstatus}`);
		assert.deepEqual(badges(frm), []);
	}
});

test("a badge is taken away when the invoice is submitted", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(env, frm, answer("match", [reference()]));
	assert.equal(badges(frm).length, 1);

	frm.doc.docstatus = 1;
	env.fire(INVOICE, "refresh", frm);
	assert.deepEqual(badges(frm), []);
});

// ---- re-checking only when it matters -------------------------------------------------------------------------------

test("it asks again only when rows, rates, quantities, references or the currency change", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(env, frm, answer("match", [reference()]));
	assert.equal(env.calls.length, 1);

	// nothing it compares has changed: totals, taxes, a refresh, a description
	for (const [doctype, event] of [
		[INVOICE, "net_total"],
		[INVOICE, "refresh"],
		[ITEM, "uom"],
		[ITEM, "item_code"],
	]) {
		env.fire(doctype, event, frm);
		env.clock.tick(500);
	}
	frm.doc.items[0].description = "reworded";
	env.fire(ITEM, "item_code", frm);
	env.clock.tick(500);
	assert.equal(env.calls.length, 1, "unchanged inputs are answered from the last result");
	assert.equal(badges(frm).length, 1, "and the badge is still there, once");

	const change = async (mutate, event) => {
		const before = env.calls.length;
		mutate();
		env.fire(...event, frm);
		env.clock.tick(500);
		assert.equal(env.calls.length, before + 1, `asks again after ${event[1]}`);
		env.calls.at(-1).resolve({ message: answer("match", [reference()]) });
		await flush();
	};
	await change(() => (frm.doc.items[0].amount = 1040), [ITEM, "rate"]);
	await change(() => (frm.doc.items[0].amount = 800), [ITEM, "qty"]);
	await change(
		() => frm.doc.items.push(makeRow({ idx: 2, po_detail: "po-row-2", amount: 50 })),
		[ITEM, "po_detail"]
	);
	await change(() => frm.doc.items.pop(), [ITEM, "items_remove"]);
	await change(() => (frm.doc.items[0].pr_detail = "pr-row-1"), [ITEM, "pr_detail"]);
	await change(() => (frm.doc.currency = "EUR"), [INVOICE, "currency"]);
});

test("removing the last reference removes the badge without asking", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(env, frm, answer("over", [reference({ status: "over" })]));
	assert.equal(badges(frm).length, 1);

	frm.doc.items[0].po_detail = "";
	env.fire(ITEM, "po_detail", frm);
	env.clock.tick(500);
	assert.equal(env.calls.length, 1);
	assert.deepEqual(badges(frm), []);
});

// ---- what the badge says --------------------------------------------------------------------------------------------

test("green: matched, and how much is still open when the invoice bills only part of it", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(
		env,
		frm,
		answer("match", [reference({ remaining_after: 200, this_invoice: 500 })], {
			totals: { remaining_after: 200, over_by: 0 },
		})
	);
	const [html] = badges(frm);
	assert.match(html, /class="indicator-pill green adhd-match-badge"/);
	assert.match(html, />✓ Matched · USD 200.00 still open</);
	assert.match(html, /title="[^"]*PUR-ORD-2026-00001/);
	assert.match(html, /Compared in USD/);
	assert.doesNotMatch(html, /adhd-match-lines/, "a match needs no explanation under it");
	assert.match(html, /aria-live="polite"/);
});

test("green with nothing left open says only Matched", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(env, frm, answer("match", [reference()]));
	assert.match(badges(frm)[0], />✓ Matched</);
});

test("amber: within tolerance, with the amount over and why it is accepted", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(
		env,
		frm,
		answer(
			"within_tolerance",
			[
				reference({
					status: "within_tolerance",
					issues: [{ reason: "within_allowance", idx: 1, item_code: "WIDGET", amount: 40 }],
				}),
			],
			{ totals: { remaining_after: -40, over_by: 0 } }
		)
	);
	const [html] = badges(frm);
	assert.match(html, /class="indicator-pill orange adhd-match-badge"/);
	assert.match(html, />⚠ Within tolerance · Over by USD 40.00</);
	assert.match(html, /adhd-match-lines/);
	assert.match(html, /Row 1: Over by USD 40\.00, within the over-billing allowance/);
});

test("red: a mismatch, naming the amount, and the line says submit would refuse it", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(
		env,
		frm,
		answer("over", [
			reference({
				status: "over",
				issues: [{ reason: "over_billed", idx: 1, item_code: "WIDGET", amount: 200 }],
			}),
		])
	);
	const [html] = badges(frm);
	assert.match(html, /class="indicator-pill red adhd-match-badge"/);
	assert.match(html, />✗ Mismatch · Over by USD 200.00</);
	assert.match(html, /Row 1: Over-billed by USD 200\.00; submit will be refused/);
});

test("red for a rate or currency problem, and the red badge names the reason that makes it red", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(
		env,
		frm,
		answer("over", [
			reference({
				status: "over",
				issues: [
					{ reason: "within_allowance", idx: 1, item_code: "WIDGET", amount: 1 },
					{ reason: "rate", idx: 2, item_code: "GADGET" },
				],
			}),
		])
	);
	assert.match(badges(frm)[0], />✗ Mismatch · Rate differs</);

	const env2 = load();
	const frm2 = makeForm();
	await checkWith(
		env2,
		frm2,
		answer("over", [
			reference({ status: "over", currency: "EUR", issues: [{ reason: "currency", idx: null }] }),
		])
	);
	assert.match(badges(frm2)[0], />✗ Mismatch · Currency differs</);
	assert.match(badges(frm2)[0], /Currency differs from this invoice&#39;s; submit will be refused/);
});

test("several references: every one is listed, each linked with the router's own link", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(
		env,
		frm,
		answer("over", [
			reference({
				status: "over",
				issues: [{ reason: "over_billed", idx: 1, amount: 12.5 }],
			}),
			reference({ doctype: "Purchase Receipt", name: "MAT-PRE-2026-00007" }),
		])
	);
	const [html] = badges(frm);
	assert.match(html, /<a href="\/desk\/purchase-order\/PUR-ORD-2026-00001">PUR-ORD-2026-00001<\/a>/);
	assert.match(html, /<a href="\/desk\/purchase-receipt\/MAT-PRE-2026-00007">MAT-PRE-2026-00007<\/a>/);
	assert.doesNotMatch(html, /\/app\//);
	assert.match(html, /Bills USD 700\.00 of the USD 700\.00 still open/);
});

test("money is formatted in the currency the server compared in", async () => {
	const env = load();
	const frm = makeForm({ currency: "EUR" });
	await checkWith(
		env,
		frm,
		answer("match", [reference({ remaining_after: 5 })], {
			currency: "EUR",
			totals: { remaining_after: 5 },
		})
	);
	assert.ok(env.currencyCalls.length > 0);
	assert.ok(env.currencyCalls.every((currency) => currency === "EUR"));
});

test("documents the user cannot read are said to be unchecked, not silently counted as matching", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(env, frm, answer("match", [reference()], { unreadable_rows: 2 }));
	const [html] = badges(frm);
	assert.match(html, /2 row\(s\) point at documents you cannot read and were not checked/);
	assert.match(html, /adhd-match-lines/);
});

// ---- safety ---------------------------------------------------------------------------------------------------------

test("everything that comes from the data is escaped", async () => {
	const env = load();
	const frm = makeForm();
	const evil = '"><img src=x onerror=alert(1)>';
	await checkWith(
		env,
		frm,
		answer(
			"over",
			[
				reference({
					doctype: "Purchase Order",
					name: evil,
					status: "over",
					issues: [{ reason: "over_billed", idx: "<script>alert(2)</script>", amount: 3 }],
				}),
			],
			{ currency: evil }
		)
	);
	const [html] = badges(frm);
	assert.doesNotMatch(html, /<img/i);
	assert.doesNotMatch(html, /<script/i);
	assert.doesNotMatch(html, /"><img/);
	assert.match(html, /&lt;img/);
	// the name is encoded in the link and escaped in its text; nothing can end an attribute early
	assert.equal((html.match(/title="/g) || []).length, 1);
	assert.doesNotMatch(html, /\son\w+=/i);
});

test("a failed request leaves no badge and raises nothing", async () => {
	const env = load();
	const frm = makeForm();
	env.fire(INVOICE, "refresh", frm);
	env.clock.tick(500);
	env.calls[0].reject(new Error("Not permitted"));
	await flush();
	assert.deepEqual(badges(frm), []);
	assert.equal(env.calls[0].opts.silent, true);
});

test("a form without a Grand Total control is left alone", async () => {
	const env = load();
	const frm = makeForm();
	delete frm.fields_dict.grand_total;
	await checkWith(env, frm, answer("match", [reference()]));
	assert.deepEqual(badges(frm), []);
});

// ---- de-duplication -------------------------------------------------------------------------------------------------

test("there is never more than one badge", async () => {
	const env = load();
	const frm = makeForm();
	// a stale badge left by something else is replaced, not added to
	frm.grandTotal.children.push({ html: '<div class="adhd-match">stale</div>', children: [] });
	await checkWith(env, frm, answer("match", [reference()]));
	assert.equal(badges(frm).length, 1);
	assert.doesNotMatch(badges(frm)[0], /stale/);

	// several refreshes that change nothing
	for (let i = 0; i < 4; i++) {
		env.fire(INVOICE, "refresh", frm);
		env.clock.tick(500);
	}
	assert.equal(badges(frm).length, 1);
	assert.equal(env.calls.length, 1);
});

test("a badge put there while a request was out is removed again before the answer is drawn", async () => {
	const env = load();
	const frm = makeForm();
	env.fire(INVOICE, "refresh", frm);
	env.clock.tick(500);
	frm.grandTotal.children.push({ html: '<div class="adhd-match">from a refresh</div>', children: [] });
	env.calls[0].resolve({ message: answer("match", [reference()]) });
	await flush();
	assert.equal(badges(frm).length, 1);
	assert.doesNotMatch(badges(frm)[0], /from a refresh/);
});

test("an answer for rows that have since been edited is dropped, the newer check draws", async () => {
	const env = load();
	const frm = makeForm();
	env.fire(INVOICE, "refresh", frm);
	env.clock.tick(500);
	assert.equal(env.calls.length, 1);

	// the user edits while the first request is out
	frm.doc.items[0].amount = 1040;
	env.fire(ITEM, "rate", frm);
	env.calls[0].resolve({ message: answer("match", [reference()]) });
	await flush();
	assert.deepEqual(badges(frm), [], "the old answer is not shown for the new numbers");

	env.clock.tick(500);
	assert.equal(env.calls.length, 2);
	env.calls[1].resolve({
		message: answer("over", [
			reference({ status: "over", issues: [{ reason: "over_billed", idx: 1, amount: 40 }] }),
		]),
	});
	await flush();
	assert.equal(badges(frm).length, 1);
	assert.match(badges(frm)[0], /Mismatch/);
});

test("answers that arrive out of order cannot leave the older one on screen", async () => {
	const env = load();
	const frm = makeForm();
	env.fire(INVOICE, "refresh", frm);
	env.clock.tick(500);
	frm.doc.items[0].amount = 999;
	env.fire(ITEM, "rate", frm);
	env.clock.tick(500);
	assert.equal(env.calls.length, 2);

	env.calls[1].resolve({
		message: answer("over", [
			reference({ status: "over", issues: [{ reason: "over_billed", amount: 1 }] }),
		]),
	});
	await flush();
	env.calls[0].resolve({ message: answer("match", [reference()]) });
	await flush();
	assert.equal(badges(frm).length, 1);
	assert.match(badges(frm)[0], /Mismatch/);
});

test("without a Grand Total wrapper on screen yet, the last answer is shown once the form refreshes", async () => {
	const env = load();
	const frm = makeForm();
	await checkWith(env, frm, answer("match", [reference()]));
	// the form is rebuilt: the old badge is gone with the old control
	frm.grandTotal.children.length = 0;
	env.fire(INVOICE, "refresh", frm);
	assert.equal(badges(frm).length, 1, "shown again straight away, without waiting or asking");
	assert.equal(env.calls.length, 1);
});

// ---- pure description -----------------------------------------------------------------------------------------------

test("describeMatch gives plain data for each status and nothing for no reference", () => {
	const env = load();
	const describe = env.adhd.describeMatch;
	const summary = (status) => {
		const view = describe(answer(status, [reference({ status })]), "USD");
		return view && [view.css, view.icon, view.label];
	};
	assert.deepEqual(summary("match"), ["green", "✓", "Matched"]);
	assert.deepEqual(summary("within_tolerance"), ["orange", "⚠", "Within tolerance"]);
	assert.deepEqual(summary("over"), ["red", "✗", "Mismatch"]);
	assert.equal(describe(answer("no_reference", []), "USD"), null);
	assert.equal(describe(null, "USD"), null);
	assert.equal(env.adhd.buildMatchBadgeHtml(answer("no_reference", []), "USD"), "");
});

test("collectMatchInputs keeps only referenced rows and skips returns and oversized invoices", () => {
	const env = load();
	const collect = env.adhd.collectMatchInputs;
	assert.equal(collect(makeForm({ items: [] })), null);
	assert.equal(collect(makeForm({ is_return: 1 })), null);
	const rows = Array.from({ length: 301 }, (_, i) => makeRow({ idx: i + 1, po_detail: `po-${i}` }));
	assert.equal(collect(makeForm({ items: rows })), null, "the server refuses more than 300 rows");
	const inputs = collect(makeForm({ is_internal_supplier: 1 }));
	assert.equal(inputs.is_internal_supplier, 1);
	assert.equal(inputs.items.length, 1);
});
