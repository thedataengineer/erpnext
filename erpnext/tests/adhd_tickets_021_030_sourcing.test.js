// ADHD-025 (RFQ comparison) and ADHD-026 (Purchase Order supplier scorecard nudge).
// The client modules run in a vm against small stand-ins for the Frappe pieces they use. Nothing here needs a
// browser, but nothing here is a browser check either: see docs/adhd_mode_features.md.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const readSource = (relative) => fs.readFileSync(path.join(appRoot, relative), "utf8");
// values made inside the vm carry another realm's prototypes, which deepStrictEqual rejects
const plain = (value) => JSON.parse(JSON.stringify(value));

const ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
	"`": "&#x60;",
	"=": "&#x3D;",
};

function load(name, { adhdMode = true, canRead = true } = {}) {
	const handlers = {}; // doctype -> handlers registered with frappe.ui.form.on
	const stateCallbacks = [];
	const calls = [];
	const dialogs = [];
	const messages = [];
	const routes = [];
	const control = { respond: async () => ({ message: {} }) };

	class FakeDialog {
		constructor(options) {
			Object.assign(this, options);
			this.html = "";
			this.hidden = 0;
			this.shown = false;
			this.events = {};
			const self = this;
			this.fields_dict = { comparison: { $wrapper: { html: (value) => (self.html = value) } } };
			this.$wrapper = {
				on: (event, selector, handler) => (self.events[`${event} ${selector}`] = handler),
			};
			dialogs.push(this);
		}
		show() {
			this.shown = true;
		}
		hide() {
			this.hidden += 1;
			this.shown = false;
		}
	}

	const sandbox = {
		console,
		Promise,
		Set,
		Number,
		String,
		Math,
		JSON,
		window: {},
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.split(`{${index}}`).join(String(value)), text),
		cint: (value) => Number.parseInt(value || 0, 10) || 0,
		flt: (value) => Number.parseFloat(value || 0) || 0,
		format_currency: (value, currency) => `${currency} ${Number(value).toFixed(2)}`,
		format_number: (value) => String(value),
		erpnext: {
			adhd: {
				onStateChange: (callback) => {
					stateCallbacks.push(callback);
					callback(sandbox.frappe.boot.adhd_mode);
				},
			},
		},
		frappe: {
			boot: { adhd_mode: adhdMode },
			provide() {},
			call: (request) => {
				calls.push(request);
				return control.respond(request);
			},
			msgprint: (options) => messages.push(options),
			set_route: (...args) => routes.push(args),
			datetime: { str_to_user: (value) => value.split("-").reverse().join("-") },
			model: { can_read: () => canRead },
			ui: {
				Dialog: FakeDialog,
				form: { on: (doctype, registered) => (handlers[doctype] = registered) },
			},
			utils: {
				escape_html: (value) => String(value ?? "").replace(/[&<>"'`=]/g, (char) => ESCAPES[char]),
				get_form_link: (doctype, name) =>
					`/desk/${encodeURIComponent(
						doctype.toLowerCase().replace(/ /g, "-")
					)}/${encodeURIComponent(name)}`,
			},
		},
	};
	vm.runInNewContext(readSource(`public/js/adhd/${name}`), sandbox, { filename: name });
	return {
		sandbox,
		adhd: sandbox.erpnext.adhd,
		handlers,
		calls,
		dialogs,
		messages,
		routes,
		control,
		setMode(on) {
			sandbox.frappe.boot.adhd_mode = on;
			stateCallbacks.forEach((callback) => callback(on));
		},
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ---------------------------------------------------------------- ADHD-025

function makeRfq(env, { docstatus = 1, name = "PUR-RFQ-2026-00001" } = {}) {
	const frm = {
		doctype: "Request for Quotation",
		docname: name,
		doc: { name, docstatus, company: "Acme", transaction_date: "2026-09-01" },
		custom_buttons: {},
		added: [],
		removed: [],
		add_custom_button(label, action, group) {
			this.added.push({ label, action, group });
			this.custom_buttons[label] = {};
		},
		remove_custom_button(label, group) {
			this.removed.push({ label, group });
			delete this.custom_buttons[label];
		},
	};
	env.sandbox.window.cur_frm = frm;
	return frm;
}

const rate = (value, extra = {}) => ({
	rate: value,
	base_rate: value,
	unit_base_rate: value,
	uom: "Nos",
	qty: 10,
	...extra,
});

function quotation(name, supplier, rates, extra = {}) {
	return {
		name,
		supplier,
		supplier_name: `${supplier} Ltd`,
		status: "Submitted",
		docstatus: 1,
		valid_till: "2026-12-31",
		expired: false,
		currency: "USD",
		grand_total: 100,
		base_grand_total: 100,
		payment_terms: "Net 30",
		quoted: Object.keys(rates).length,
		rates,
		...extra,
	};
}

function comparison(quotations, extra = {}) {
	return {
		rfq: "PUR-RFQ-2026-00001",
		company: "Acme",
		company_currency: "USD",
		items: [
			{ name: "R1", item_code: "PEN", item_name: "Pen", qty: 10, uom: "Nos" },
			{ name: "R2", item_code: "INK", item_name: "INK", qty: 4, uom: "Nos" },
		],
		quotations,
		awaiting_suppliers: [],
		truncated: { quotations: false, items: false },
		report_filters: {
			company: "Acme",
			request_for_quotation: "PUR-RFQ-2026-00001",
			from_date: "2026-09-01",
			to_date: "2026-09-21",
		},
		...extra,
	};
}

// The table as data: [{ label, cells: [{ best, text }] }] for every <tr> in the body.
function tableRows(html) {
	const rows = [];
	for (const [, body] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
		const label = (body.match(/<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/) || [])[1];
		if (label === undefined) continue;
		const cells = [...body.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(([, attributes, content]) => ({
			best: attributes.includes("adhd-rfq-best"),
			text: content
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		}));
		rows.push({
			label: label
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
			cells,
		});
	}
	return rows;
}

const itemRow = (html, code) => tableRows(html).find((row) => row.label.startsWith(code));
const bestOf = (row) => row.cells.map((cell) => cell.best);

test("ADHD-025 adds Compare Responses to a submitted RFQ in ADHD mode only", () => {
	const env = load("adhd_rfq.js");
	const refresh = env.handlers["Request for Quotation"].refresh;

	const submitted = makeRfq(env);
	refresh(submitted);
	assert.equal(submitted.added.length, 1);
	assert.equal(submitted.added[0].label, "Compare Responses");
	assert.equal(submitted.added[0].group, "Focus");

	for (const docstatus of [0, 2]) {
		const other = makeRfq(env, { docstatus });
		refresh(other);
		assert.equal(other.added.length, 0, `docstatus ${docstatus} must not get the button`);
	}
});

test("ADHD-025 does nothing at all while ADHD mode is off", async () => {
	const env = load("adhd_rfq.js", { adhdMode: false });
	const frm = makeRfq(env);
	env.handlers["Request for Quotation"].refresh(frm);
	assert.equal(frm.added.length, 0);
	assert.equal(frm.removed.length, 0);
	await env.adhd.openRfqComparison(frm);
	assert.equal(env.calls.length, 0, "no server call");
	assert.equal(env.dialogs.length, 0);
	assert.equal(env.messages.length, 0);
});

test("ADHD-025 does not add the button twice", () => {
	const env = load("adhd_rfq.js");
	const frm = makeRfq(env);
	const { refresh } = env.handlers["Request for Quotation"];
	refresh(frm);
	refresh(frm);
	refresh(frm);
	assert.equal(frm.added.length, 1);
});

test("ADHD-025 adds and removes the button when the mode is switched with the form open", () => {
	const env = load("adhd_rfq.js");
	const frm = makeRfq(env);
	env.handlers["Request for Quotation"].refresh(frm);
	assert.equal(frm.added.length, 1);

	env.setMode(false);
	assert.deepEqual(plain(frm.removed), [{ label: "Compare Responses", group: "Focus" }]);
	assert.equal(frm.custom_buttons["Compare Responses"], undefined);

	env.setMode(true);
	assert.equal(frm.added.length, 2, "switching the mode back on puts the button back");
});

test("ADHD-025 loads the comparison through the whitelisted endpoint and shows one dialog", async () => {
	const env = load("adhd_rfq.js");
	env.control.respond = async () => ({
		message: comparison([quotation("SQ-A", "A", { R1: rate(3), R2: rate(2) })]),
	});
	const frm = makeRfq(env);
	await env.adhd.openRfqComparison(frm);

	assert.equal(env.calls.length, 1);
	assert.equal(env.calls[0].method, "erpnext.buying.services.adhd_rfq_compare.get_rfq_supplier_comparison");
	assert.deepEqual(plain(env.calls[0].args), { rfq_name: "PUR-RFQ-2026-00001" });
	assert.equal(env.dialogs.length, 1);
	assert.equal(env.dialogs[0].shown, true);
	assert.equal(env.dialogs[0].size, "extra-large");
	assert.match(env.dialogs[0].html, /adhd-rfq-table/);
});

test("ADHD-025 the client calls a whitelisted endpoint that exists in the module it names", () => {
	const client = readSource("public/js/adhd/adhd_rfq.js");
	const [, module, method] = client.match(/"erpnext\.buying\.services\.(\w+)\.(\w+)"/);
	const server = readSource(`buying/services/${module}.py`);
	assert.match(server, new RegExp(`@frappe\\.whitelist\\(\\)\\s+def ${method}\\(rfq_name: str\\) -> dict`));
});

test("ADHD-025 an RFQ nobody has quoted for says so instead of drawing an empty table", async () => {
	const env = load("adhd_rfq.js");
	env.control.respond = async () => ({
		message: comparison([], {
			awaiting_suppliers: [{ supplier: "S1", supplier_name: "Acme <b>Traders</b>" }],
		}),
	});
	await env.adhd.openRfqComparison(makeRfq(env));
	assert.equal(env.dialogs.length, 0);
	assert.equal(env.messages.length, 1);
	assert.match(env.messages[0].message, /No Supplier Quotations have been made for PUR-RFQ-2026-00001/);
	assert.match(env.messages[0].message, /Acme &lt;b&gt;Traders&lt;\/b&gt;/, "who is awaited is escaped");
	assert.doesNotMatch(env.messages[0].message, /<b>/);
});

test("ADHD-025 a failed load shows no dialog and does not throw", async () => {
	const env = load("adhd_rfq.js");
	env.control.respond = async () => {
		throw new Error("boom");
	};
	const frm = makeRfq(env);
	await env.adhd.openRfqComparison(frm);
	assert.equal(env.dialogs.length, 0);
	assert.equal(env.messages.length, 0);
	// and the button works again afterwards
	env.control.respond = async () => ({ message: comparison([quotation("SQ-A", "A", { R1: rate(1) })]) });
	await env.adhd.openRfqComparison(frm);
	assert.equal(env.dialogs.length, 1);
});

test("ADHD-025 a double click loads once", async () => {
	const env = load("adhd_rfq.js");
	const pending = deferred();
	env.control.respond = () => pending.promise;
	const frm = makeRfq(env);
	const first = env.adhd.openRfqComparison(frm);
	const second = env.adhd.openRfqComparison(frm);
	pending.resolve({ message: comparison([quotation("SQ-A", "A", { R1: rate(1) })]) });
	await Promise.all([first, second]);
	assert.equal(env.calls.length, 1);
	assert.equal(env.dialogs.length, 1);
});

test("ADHD-025 opening it again closes the earlier dialog", async () => {
	const env = load("adhd_rfq.js");
	env.control.respond = async () => ({ message: comparison([quotation("SQ-A", "A", { R1: rate(1) })]) });
	const frm = makeRfq(env);
	await env.adhd.openRfqComparison(frm);
	await env.adhd.openRfqComparison(frm);
	assert.equal(env.dialogs.length, 2);
	assert.equal(env.dialogs[0].hidden, 1);
	assert.equal(env.dialogs[1].shown, true);
});

test("ADHD-025 switching the mode off while the request is out shows nothing", async () => {
	const env = load("adhd_rfq.js");
	const pending = deferred();
	env.control.respond = () => pending.promise;
	const opening = env.adhd.openRfqComparison(makeRfq(env));
	env.setMode(false);
	pending.resolve({ message: comparison([quotation("SQ-A", "A", { R1: rate(1) })]) });
	await opening;
	assert.equal(env.dialogs.length, 0);
});

test("ADHD-025 marks the lowest rate per item, not just the first item's", () => {
	const { adhd } = load("adhd_rfq.js");
	const data = comparison([
		quotation("SQ-A", "A", { R1: rate(3), R2: rate(9) }),
		quotation("SQ-B", "B", { R1: rate(5), R2: rate(2) }),
	]);
	const html = adhd.buildRfqComparisonHtml(data);
	assert.deepEqual(bestOf(itemRow(html, "PEN")), [true, false], "A is cheapest for the first item");
	assert.deepEqual(bestOf(itemRow(html, "INK")), [false, true], "B is cheapest for the second");
});

test("ADHD-025 marks every quotation tied for the lowest rate", () => {
	const { adhd } = load("adhd_rfq.js");
	const data = comparison([
		quotation("SQ-A", "A", { R1: rate(3) }),
		quotation("SQ-B", "B", { R1: rate(3) }),
		quotation("SQ-C", "C", { R1: rate(5) }),
	]);
	assert.deepEqual(bestOf(itemRow(adhd.buildRfqComparisonHtml(data), "PEN")), [true, true, false]);
	assert.deepEqual(plain([...adhd.lowestRateByItem(data).R1]), ["SQ-A", "SQ-B"]);
});

test("ADHD-025 marks nothing when there is nothing to choose between", () => {
	const { adhd } = load("adhd_rfq.js");
	// all equal
	let data = comparison([quotation("SQ-A", "A", { R1: rate(3) }), quotation("SQ-B", "B", { R1: rate(3) })]);
	assert.deepEqual(bestOf(itemRow(adhd.buildRfqComparisonHtml(data), "PEN")), [false, false]);
	// a single quotation
	data = comparison([quotation("SQ-A", "A", { R1: rate(3) })]);
	assert.deepEqual(bestOf(itemRow(adhd.buildRfqComparisonHtml(data), "PEN")), [false]);
	// differences below the sixth decimal are ties, not a winner
	data = comparison([
		quotation("SQ-A", "A", { R1: rate(3, { unit_base_rate: 3.0000001 }) }),
		quotation("SQ-B", "B", { R1: rate(3, { unit_base_rate: 3.0000002 }) }),
	]);
	assert.deepEqual(bestOf(itemRow(adhd.buildRfqComparisonHtml(data), "PEN")), [false, false]);
});

test("ADHD-025 a missing quote shows a dash and never wins or blocks the others", () => {
	const { adhd } = load("adhd_rfq.js");
	const data = comparison([
		quotation("SQ-A", "A", { R1: rate(4), R2: rate(2) }),
		quotation("SQ-B", "B", { R1: rate(6) }), // did not quote INK
		quotation("SQ-C", "C", { R1: rate(5), R2: rate(3) }),
	]);
	const html = adhd.buildRfqComparisonHtml(data);
	const ink = itemRow(html, "INK");
	assert.equal(ink.cells[1].text, "—");
	assert.deepEqual(bestOf(ink), [true, false, false]);
	assert.deepEqual(bestOf(itemRow(html, "PEN")), [true, false, false]);
});

test("ADHD-025 an unpriced (zero) row never counts as the lowest rate", () => {
	const { adhd } = load("adhd_rfq.js");
	const data = comparison([
		quotation("SQ-A", "A", { R1: rate(0) }),
		quotation("SQ-B", "B", { R1: rate(5) }),
	]);
	// only one real price is left, so there is nothing to compare
	assert.deepEqual(bestOf(itemRow(adhd.buildRfqComparisonHtml(data), "PEN")), [false, false]);
});

test("ADHD-025 ranks on the company-currency rate but shows each quote in its own currency", () => {
	const { adhd } = load("adhd_rfq.js");
	// EUR 1.90 looks lower than USD 2.00 but is 2.09 USD, so the dollar quote is the cheaper one
	const data = comparison([
		quotation("SQ-A", "A", { R1: rate(2) }),
		quotation(
			"SQ-B",
			"B",
			{ R1: rate(1.9, { base_rate: 2.09, unit_base_rate: 2.09 }) },
			{ currency: "EUR" }
		),
	]);
	const html = adhd.buildRfqComparisonHtml(data);
	const pen = itemRow(html, "PEN");
	assert.deepEqual(bestOf(pen), [true, false]);
	assert.equal(pen.cells[0].text, "★ USD 2.00 / Nos", "no converted copy for a same-currency quote");
	assert.match(pen.cells[1].text, /^EUR 1\.90/, "shown in the quote's own currency");
	assert.match(pen.cells[1].text, /USD 2\.09/, "with the company-currency price beside it");
	assert.match(html, /own currency/);
	assert.match(html, /converting to USD/);
});

test("ADHD-025 totals are only ranked between quotations that priced every item", () => {
	const { adhd } = load("adhd_rfq.js");
	const data = comparison([
		quotation("SQ-A", "A", { R1: rate(3), R2: rate(2) }, { grand_total: 50, base_grand_total: 50 }),
		quotation("SQ-B", "B", { R1: rate(4), R2: rate(4) }, { grand_total: 80, base_grand_total: 80 }),
		// cheap only because it leaves an item out
		quotation("SQ-C", "C", { R1: rate(1) }, { grand_total: 10, base_grand_total: 10 }),
	]);
	const total = tableRows(adhd.buildRfqComparisonHtml(data)).find((row) => row.label === "Total");
	assert.deepEqual(bestOf(total), [true, false, false]);
	const quoted = tableRows(adhd.buildRfqComparisonHtml(data)).find((row) => row.label === "Items quoted");
	assert.deepEqual(
		quoted.cells.map((cell) => cell.text),
		["2 / 2", "2 / 2", "1 / 2"]
	);
});

test("ADHD-025 shows valid-till, expiry, status and the supplier's default payment terms", () => {
	const { adhd } = load("adhd_rfq.js");
	const data = comparison([
		quotation(
			"SQ-A",
			"A",
			{ R1: rate(3) },
			{ valid_till: "2026-09-20", expired: true, payment_terms: null }
		),
		quotation("SQ-B", "B", { R1: rate(4) }, { status: "Draft", docstatus: 0, valid_till: null }),
	]);
	const html = adhd.buildRfqComparisonHtml(data);
	const rows = tableRows(html);
	assert.match(rows.find((row) => row.label === "Valid till").cells[0].text, /^20-09-2026 Expired$/);
	assert.equal(rows.find((row) => row.label === "Valid till").cells[1].text, "—");
	assert.equal(rows.find((row) => row.label.startsWith("Payment terms")).cells[0].text, "—");
	assert.match(html, /adhd-rfq-status">Draft</);
});

test("ADHD-025 escapes everything that comes from the data", () => {
	const { adhd } = load("adhd_rfq.js");
	const hostile = '<img src=x onerror="alert(1)">';
	const data = comparison(
		[
			quotation(
				'"><script>alert(1)</script>',
				hostile,
				{ R1: rate(3, { uom: hostile }) },
				{ supplier_name: hostile, status: hostile, payment_terms: hostile, currency: hostile }
			),
		],
		{
			items: [{ name: "R1", item_code: hostile, item_name: hostile, qty: 1, uom: hostile }],
			awaiting_suppliers: [{ supplier: hostile, supplier_name: hostile }],
			company_currency: hostile,
			truncated: { quotations: true, items: true },
		}
	);
	const html = adhd.buildRfqComparisonHtml(data);
	assert.doesNotMatch(html, /<img/);
	assert.doesNotMatch(html, /<script/);
	assert.doesNotMatch(html, /onerror="/);
	assert.match(html, /&lt;img src&#x3D;x onerror&#x3D;&quot;alert\(1\)&quot;&gt;/);
	assert.match(html, /data-quotation="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

test("ADHD-025 the dialog title is escaped and names the RFQ", async () => {
	const env = load("adhd_rfq.js");
	env.control.respond = async () => ({ message: comparison([quotation("SQ-A", "A", { R1: rate(1) })]) });
	await env.adhd.openRfqComparison(makeRfq(env, { name: "RFQ <1> & 2" }));
	assert.equal(env.dialogs[0].title, "Supplier responses — RFQ &lt;1&gt; &amp; 2");
});

test("ADHD-025 Select opens the Supplier Quotation and creates nothing", async () => {
	const env = load("adhd_rfq.js");
	env.control.respond = async () => ({
		message: comparison([
			quotation("SQ-A", "A", { R1: rate(3) }),
			quotation("SQ-B", "B", { R1: rate(4) }),
		]),
	});
	await env.adhd.openRfqComparison(makeRfq(env));
	const dialog = env.dialogs[0];
	dialog.events["click .adhd-rfq-select"]({ currentTarget: { dataset: { quotation: "SQ-B" } } });
	assert.equal(dialog.hidden, 1);
	assert.deepEqual(plain(env.routes), [["Form", "Supplier Quotation", "SQ-B"]]);
	assert.equal(env.calls.length, 1, "only the comparison was loaded: no document was made");
	assert.doesNotMatch(readSource("public/js/adhd/adhd_rfq.js"), /open_mapped_doc|new_doc|insert|"\/app\//);
});

test("ADHD-025 links to the standard Supplier Quotation Comparison report for this RFQ", async () => {
	const env = load("adhd_rfq.js");
	const data = comparison([quotation("SQ-A", "A", { R1: rate(3) })]);
	env.control.respond = async () => ({ message: data });
	await env.adhd.openRfqComparison(makeRfq(env));
	const dialog = env.dialogs[0];
	assert.equal(dialog.secondary_action_label, "Open comparison report");
	dialog.secondary_action();
	assert.equal(dialog.hidden, 1);
	assert.deepEqual(plain(env.routes), [
		["query-report", "Supplier Quotation Comparison", data.report_filters],
	]);
});

test("ADHD-025 says when quotations or items were left out", () => {
	const { adhd } = load("adhd_rfq.js");
	const data = comparison([quotation("SQ-A", "A", { R1: rate(3) })], {
		truncated: { quotations: true, items: true },
		awaiting_suppliers: [{ supplier: "S9", supplier_name: "Slow Supplies" }],
	});
	const html = adhd.buildRfqComparisonHtml(data);
	assert.match(html, /Only the 1 most recent quotations are shown/);
	assert.match(html, /more items than are shown/);
	assert.match(html, /Still waiting for: Slow Supplies/);
});

// ---------------------------------------------------------------- ADHD-026

function makePurchaseOrder(env, { supplier = null, isNew = true, name = "new-purchase-order-1" } = {}) {
	const banners = [];
	let layoutLookups = 0;
	const frm = {
		doctype: "Purchase Order",
		docname: name,
		doc: { name, supplier, docstatus: 0 },
		is_new: () => isNew,
		banners,
		get layoutLookups() {
			return layoutLookups;
		},
		// only what real Frappe has: Form.$wrapper wraps the whole form, while Layout has just a jQuery
		// `wrapper` (no `$wrapper`), so code that reaches for `frm.layout.$wrapper` fails here as it does in Desk
		$wrapper: {
			find(selector) {
				layoutLookups += 1;
				return {
					remove() {
						const marker = selector.slice(1);
						for (let index = banners.length - 1; index >= 0; index--) {
							if (banners[index].includes(marker)) banners.splice(index, 1);
						}
					},
				};
			},
		},
		layout: { wrapper: { find: () => assert.fail("the layout wrapper is not used") } },
		fields_dict: { supplier: { $wrapper: { length: 1, after: (html) => banners.push(html) } } },
		setNew(value) {
			isNew = value;
		},
	};
	env.sandbox.window.cur_frm = frm;
	return frm;
}

// what frappe.client.get_value returns: the scorecard's fields, or {} when there is none
const scorecard = (supplier_score, status = "Poor") => ({ message: { supplier_score, status } });
const setSupplier = async (env, frm, supplier) => {
	frm.doc.supplier = supplier;
	await env.handlers["Purchase Order"].supplier(frm);
};

test("ADHD-026 the threshold is a named constant of 50", () => {
	const { adhd } = load("adhd_purchase_order_scorecard.js");
	assert.equal(adhd.SCORECARD_NUDGE_THRESHOLD, 50);
	assert.match(
		readSource("public/js/adhd/adhd_purchase_order_scorecard.js"),
		/const SCORECARD_NUDGE_THRESHOLD = 50;/
	);
});

test("ADHD-026 the nudge appears under the Supplier field for a low score", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => scorecard("38", "Poor");
	const frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Test Supplier A");

	assert.equal(env.calls.length, 1);
	assert.equal(env.calls[0].method, "frappe.client.get_value");
	assert.equal(env.calls[0].args.doctype, "Supplier Scorecard");
	assert.deepEqual(plain(env.calls[0].args.filters), { supplier: "Test Supplier A" });
	assert.deepEqual(plain(env.calls[0].args.fieldname), ["supplier_score", "status"]);
	assert.equal(env.calls[0].silent, true, "a permission failure must not open a dialog");

	assert.equal(frm.banners.length, 1);
	const banner = frm.banners[0];
	assert.match(
		banner,
		/<strong>Test Supplier A<\/strong> has a supplier score of <strong>38<\/strong>\/100 \(Poor\)/
	);
	assert.match(banner, /href="\/desk\/supplier-scorecard\/Test%20Supplier%20A"/);
	assert.match(banner, /target="_blank" rel="noopener"/);
	assert.match(banner, /role="status"/, "a nudge, not an alert that takes over a screen reader");
});

test("ADHD-026 threshold boundary: below 50 nudges, 50 and above do not, and 0 is a score", async () => {
	const cases = [
		["0", true],
		["49.9", true],
		["49.99", true],
		["50", false],
		["50.0", false],
		["50.1", false],
		["100", false],
		["", false], // no score yet
		[null, false],
		["not a number", false],
	];
	for (const [score, nudges] of cases) {
		const env = load("adhd_purchase_order_scorecard.js");
		env.control.respond = async () => scorecard(score);
		const frm = makePurchaseOrder(env);
		await setSupplier(env, frm, "Sup");
		assert.equal(frm.banners.length, nudges ? 1 : 0, `score ${JSON.stringify(score)}`);
	}
});

test("ADHD-026 a score just under the threshold is not rounded up to look like it", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => scorecard("49.6");
	const frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Sup");
	assert.match(frm.banners[0], /<strong>49\.6<\/strong>\/100/);
});

test("ADHD-026 a supplier with no scorecard, or a failed read, shows nothing and throws nothing", async () => {
	let env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => ({ message: {} });
	let frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Sup");
	assert.equal(frm.banners.length, 0);

	env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => {
		throw new Error("403");
	};
	frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Sup");
	assert.equal(frm.banners.length, 0);
	assert.equal(env.calls.length, 1);
});

test("ADHD-026 a user who cannot read Supplier Scorecards is not asked at all", async () => {
	const env = load("adhd_purchase_order_scorecard.js", { canRead: false });
	env.control.respond = async () => scorecard("10");
	const frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Sup");
	assert.equal(env.calls.length, 0);
	assert.equal(frm.banners.length, 0);
});

test("ADHD-026 refresh never asks the server again for the same supplier", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => scorecard("20");
	const frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Sup");
	assert.equal(env.calls.length, 1);

	for (let index = 0; index < 5; index++) await env.handlers["Purchase Order"].refresh(frm);
	assert.equal(env.calls.length, 1, "five refreshes, still one call");
	assert.equal(frm.banners.length, 1, "and still exactly one banner");

	// a refresh redraws the banner if the layout lost it
	frm.banners.length = 0;
	await env.handlers["Purchase Order"].refresh(frm);
	assert.equal(frm.banners.length, 1);
	assert.equal(env.calls.length, 1);
});

test("ADHD-026 a new order that arrives with its supplier already set is asked about once", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => scorecard("20");
	const frm = makePurchaseOrder(env, { supplier: "Sup" }); // e.g. made from a Supplier Quotation
	const pending = env.handlers["Purchase Order"].refresh(frm);
	await env.handlers["Purchase Order"].refresh(frm); // a second refresh while the first is in flight
	await pending;
	assert.equal(env.calls.length, 1);
	assert.equal(frm.banners.length, 1);
});

test("ADHD-026 a refresh with no supplier makes no call", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	const frm = makePurchaseOrder(env);
	await env.handlers["Purchase Order"].refresh(frm);
	assert.equal(env.calls.length, 0);
});

test("ADHD-026 changing the supplier asks again and drops the old banner at once", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async (request) => scorecard(request.args.filters.supplier === "Bad" ? "20" : "90");
	const frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Bad");
	assert.equal(frm.banners.length, 1);

	const pending = deferred();
	env.control.respond = () => pending.promise;
	const changing = setSupplier(env, frm, "Good");
	assert.equal(frm.banners.length, 0, "the old supplier's banner is gone before the answer arrives");
	pending.resolve(scorecard("90"));
	await changing;
	assert.equal(frm.banners.length, 0, "a good score shows no banner");
	assert.equal(env.calls.length, 2);
});

test("ADHD-026 a late answer for a supplier that was since changed is ignored", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	const first = deferred();
	const second = deferred();
	const answers = [first, second];
	env.control.respond = () => answers.shift().promise;
	const frm = makePurchaseOrder(env);

	const askingA = setSupplier(env, frm, "A");
	const askingB = setSupplier(env, frm, "B");
	second.resolve(scorecard("90")); // B is fine
	await askingB;
	first.resolve(scorecard("10")); // A was bad, but A is no longer the supplier
	await askingA;
	assert.equal(frm.banners.length, 0);
});

test("ADHD-026 clearing the supplier removes the banner and makes no call", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => scorecard("20");
	const frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Sup");
	assert.equal(frm.banners.length, 1);
	await setSupplier(env, frm, "");
	assert.equal(frm.banners.length, 0);
	assert.equal(env.calls.length, 1);
	// picking the same supplier again is a change, so it asks again
	await setSupplier(env, frm, "Sup");
	assert.equal(env.calls.length, 2);
	assert.equal(frm.banners.length, 1);
});

test("ADHD-026 a saved order gets no nudge and loses one it had", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => scorecard("20");
	const frm = makePurchaseOrder(env);
	await setSupplier(env, frm, "Sup");
	assert.equal(frm.banners.length, 1);

	frm.setNew(false);
	await env.handlers["Purchase Order"].refresh(frm);
	assert.equal(frm.banners.length, 0);

	const saved = makePurchaseOrder(env, { supplier: "Sup", isNew: false, name: "PUR-ORD-1" });
	env.calls.length = 0;
	await env.handlers["Purchase Order"].refresh(saved);
	await setSupplier(env, saved, "Sup");
	assert.equal(env.calls.length, 0);
	assert.equal(saved.banners.length, 0);
});

test("ADHD-026 the form is reused for the next new order, which is asked about afresh", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	env.control.respond = async () => scorecard("20");
	const frm = makePurchaseOrder(env, { name: "new-purchase-order-1" });
	await setSupplier(env, frm, "Sup");
	assert.equal(env.calls.length, 1);

	frm.docname = frm.doc.name = "new-purchase-order-2"; // same frm object, another new document
	await env.handlers["Purchase Order"].refresh(frm);
	assert.equal(env.calls.length, 2);
});

test("ADHD-026 does nothing at all while ADHD mode is off", async () => {
	const env = load("adhd_purchase_order_scorecard.js", { adhdMode: false });
	env.control.respond = async () => scorecard("5");
	const frm = makePurchaseOrder(env, { supplier: "Sup" });
	await env.handlers["Purchase Order"].supplier(frm);
	await env.handlers["Purchase Order"].refresh(frm);
	assert.equal(env.calls.length, 0, "no server call");
	assert.equal(frm.banners.length, 0);
	assert.equal(frm.layoutLookups, 0, "the form's DOM is not even looked at");
});

test("ADHD-026 switching the mode on shows the nudge and off removes it", async () => {
	const env = load("adhd_purchase_order_scorecard.js", { adhdMode: false });
	env.control.respond = async () => scorecard("20");
	const frm = makePurchaseOrder(env, { supplier: "Sup" });
	await env.handlers["Purchase Order"].refresh(frm);
	assert.equal(frm.banners.length, 0);

	env.setMode(true);
	await settle();
	assert.equal(env.calls.length, 1);
	assert.equal(frm.banners.length, 1);

	env.setMode(false);
	await settle();
	assert.equal(frm.banners.length, 0);
	assert.equal(env.calls.length, 1, "switching off asks nothing");
});

test("ADHD-026 switching the mode off while the read is out shows nothing", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	const pending = deferred();
	env.control.respond = () => pending.promise;
	const frm = makePurchaseOrder(env);
	const asking = setSupplier(env, frm, "Sup");
	env.setMode(false);
	pending.resolve(scorecard("10"));
	await asking;
	assert.equal(frm.banners.length, 0);
});

test("ADHD-026 escapes the supplier name and the standing", async () => {
	const env = load("adhd_purchase_order_scorecard.js");
	const hostile = '<img src=x onerror="alert(1)">';
	env.control.respond = async () => scorecard("20", hostile);
	const frm = makePurchaseOrder(env);
	await setSupplier(env, frm, hostile);
	const banner = frm.banners[0];
	assert.doesNotMatch(banner, /<img/);
	assert.doesNotMatch(banner, /onerror="/);
	assert.match(banner, /&lt;img src&#x3D;x onerror&#x3D;&quot;alert\(1\)&quot;&gt;/);
});

test("ADHD-026 uses form links and read-only Frappe APIs, never a hard-coded desk path", () => {
	const source = readSource("public/js/adhd/adhd_purchase_order_scorecard.js");
	assert.match(source, /frappe\.utils\.get_form_link\(SCORECARD/);
	assert.doesNotMatch(source, /"\/app\/|`\/app\/|"\/desk\//);
	// the scorecard's real fields: the ticket's "total_score" is on Supplier Scorecard Period, not Supplier Scorecard
	assert.match(source, /supplier_score/);
	assert.doesNotMatch(source, /total_score/);
});
