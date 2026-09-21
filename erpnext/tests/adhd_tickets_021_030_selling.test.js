// ADHD-022 (Customer "Essentials" strip) and ADHD-029 (Sales Order delivery status).
// The client modules run in a vm with a small stand-in for jQuery that remembers which panels are on the page, so
// these tests see what a user would: how many panels there are, what they say, and whether they exist at all.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const jsRoot = path.join(appRoot, "public/js/adhd");
const readAdhd = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

// frappe.utils.escape_html and frappe.utils.get_form_link as Frappe's utils.js defines them
const ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
	"`": "&#x60;",
	"=": "&#x3D;",
};
const escapeHtml = (text) => String(text).replace(/[&<>"'`=]/g, (char) => ESCAPES[char] || char);
const getFormLink = (doctype, name, html = false, displayText = null) => {
	displayText = displayText || escapeHtml(name);
	const route = `/desk/${encodeURIComponent(doctype.toLowerCase().replace(/ /g, "-"))}/${encodeURIComponent(
		name
	)}`;
	return html ? `<a href="${route}">${displayText}</a>` : route;
};

// The page: panels in the order they sit. A panel is found by the class on its root element.
function makeDom() {
	const page = [];
	const isPanel = (node, className) => new RegExp(`^\\s*<div class="${className}[" ]`).test(node.html);
	const node = (html) => {
		const self = { html, handlers: {} };
		self.find = (selector) => ({
			on(event, handler) {
				self.handlers[`${selector}:${event}`] = handler;
				return this;
			},
			get length() {
				return html.includes(selector.slice(1)) ? 1 : 0;
			},
		});
		return self;
	};
	const $ = (input) => (typeof input === "string" ? node(input) : input);
	const wrapper = {
		find: (selector) => ({
			remove() {
				const className = selector.slice(1);
				for (let index = page.length - 1; index >= 0; index--) {
					if (isPanel(page[index], className)) page.splice(index, 1);
				}
			},
			first: () => ({ prepend: (panel) => page.unshift(panel) }),
		}),
	};
	return {
		$,
		page,
		wrapper,
		count: (className) => page.filter((panel) => isPanel(panel, className)).length,
		panel: (className) => page.find((panel) => isPanel(panel, className)),
	};
}

// Everything the modules touch, with counters for what "does nothing" means.
function makeEnvironment({ adhdMode = true, canCreate = true, respond } = {}) {
	const dom = makeDom();
	const state = { calls: [], registrations: [], observers: [], timers: 0, storage: 0, mapped: [] };
	const sandbox = {
		console,
		Promise,
		window: {},
		$: dom.$,
		setTimeout: () => {
			state.timers += 1;
			return 1;
		},
		setInterval: () => {
			state.timers += 1;
			return 1;
		},
		localStorage: {
			getItem: () => {
				state.storage += 1;
				return null;
			},
			setItem: () => {
				state.storage += 1;
			},
			removeItem: () => {
				state.storage += 1;
			},
		},
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.replace(`{${index}}`, value), text),
		flt: (value) => Number.parseFloat(value || 0) || 0,
		cint: (value) => Number.parseInt(value || 0, 10) || 0,
		format_currency: (value, currency) => `${currency || "?"} ${Number(value).toFixed(2)}`,
		format_number: (value, _format, decimals) =>
			Number(value).toFixed(decimals === undefined ? 3 : decimals),
		frappe: {
			boot: { adhd_mode: adhdMode },
			provide() {},
			call: async (request) => {
				state.calls.push(request);
				return respond ? respond(request) : { message: null };
			},
			ui: { form: { on: (doctype, handlers) => state.registrations.push({ doctype, handlers }) } },
			utils: { escape_html: escapeHtml, get_form_link: getFormLink },
			model: {
				can_create: (doctype) => (typeof canCreate === "function" ? canCreate(doctype) : canCreate),
				open_mapped_doc: (options) => state.mapped.push(options),
			},
		},
		erpnext: {
			adhd: {
				onStateChange(fn) {
					state.observers.push(fn);
					fn(sandbox.frappe.boot.adhd_mode);
				},
			},
		},
	};
	// what switching the mode does in adhd_mode.js: set the flag, then tell every observer
	const setMode = (active) => {
		sandbox.frappe.boot.adhd_mode = active;
		state.observers.forEach((observer) => observer(active));
	};
	return { sandbox, state, dom, setMode };
}

function load(name, options = {}) {
	const env = makeEnvironment(options);
	vm.runInNewContext(readAdhd(name), env.sandbox, { filename: name });
	const handlers = env.state.registrations.find((entry) => entry.handlers.refresh);
	return {
		...env,
		adhd: env.sandbox.erpnext.adhd,
		refresh: handlers.handlers.refresh,
		doctype: handlers.doctype,
	};
}

// ---- ADHD-022: the Customer Essentials strip -------------------------------------------------------------------------

const CUSTOMER_DATA = {
	customer: "Acme",
	credit_limit_company: "Demo Co",
	credit_limit: 10000,
	outstanding: 8500,
	currency: "USD",
	over_limit: false,
	includes_open_orders: true,
	payment_terms: "Net 30",
	payment_terms_inherited: false,
	primary_email: "jo@acme.example",
	primary_contact_name: "Jo Buyer",
};

function makeCustomerForm(env, doc = { name: "Acme", __islocal: 0 }) {
	const frm = {
		doctype: "Customer",
		doc,
		$wrapper: env.dom.wrapper,
		layout: { wrapper: { prepend: (panel) => env.dom.page.unshift(panel) } },
		is_new: () => Boolean(doc.__islocal),
	};
	env.sandbox.window.cur_frm = frm;
	return frm;
}

function loadCustomer(options = {}) {
	const env = load("adhd_customer.js", { respond: () => ({ message: CUSTOMER_DATA }), ...options });
	return { ...env, form: (doc) => makeCustomerForm(env, doc) };
}

const PANEL = "adhd-customer-essentials";

test("Customer: refresh, not the non-existent after_load, is the hook", () => {
	const env = loadCustomer();
	assert.equal(env.doctype, "Customer");
	assert.equal(typeof env.refresh, "function");
	const source = readAdhd("adhd_customer.js");
	assert.ok(!/frappe\.ui\.form\.on\("Customer",\s*{[^}]*after_load\s*\(/.test(source));
});

test("Customer: a saved customer gets one strip with the four figures, from one silent server call", async () => {
	const env = loadCustomer();
	const frm = env.form();

	env.refresh(frm);
	await tick();

	assert.equal(env.state.calls.length, 1, "one round trip, not one per field");
	assert.equal(
		env.state.calls[0].method,
		"erpnext.selling.services.adhd_customer_essentials.get_customer_essentials"
	);
	assert.deepEqual(JSON.parse(JSON.stringify(env.state.calls[0].args)), { customer: "Acme" });
	assert.equal(env.state.calls[0].silent, true, "a permission failure must not open a dialog");
	assert.equal(env.dom.count(PANEL), 1);
	const html = env.dom.panel(PANEL).html;
	assert.match(html, /Credit Limit[\s\S]*USD 10000\.00/);
	assert.match(html, /Outstanding[\s\S]*USD 8500\.00/);
	assert.match(html, /Payment Terms[\s\S]*<a href="\/desk\/payment-terms-template\/Net%2030">Net 30<\/a>/);
	assert.match(
		html,
		/Primary Contact[\s\S]*Jo Buyer <a href="mailto:jo@acme\.example">jo@acme\.example<\/a>/
	);
	assert.match(html, /Credit figures are for Demo Co, in USD/);
	assert.ok(!html.includes("/app/"), "routes come from get_form_link, never a hand-built /app/ URL");
});

test("Customer: the strip sits above the form's own sections", async () => {
	const env = loadCustomer();
	const frm = env.form();
	env.dom.page.push({ html: '<div class="form-page">' });

	env.refresh(frm);
	await tick();

	assert.match(env.dom.page[0].html, /adhd-customer-essentials/);
});

test("Customer: ADHD mode off does nothing: no request, no panel, no timer, no storage", async () => {
	const env = loadCustomer({ adhdMode: false });
	const frm = env.form();

	env.refresh(frm);
	await tick();

	assert.equal(env.state.calls.length, 0);
	assert.equal(env.dom.page.length, 0);
	assert.equal(env.state.timers, 0);
	assert.equal(env.state.storage, 0);
});

test("Customer: the mode is checked at run time, so it can be switched on after the page loaded", async () => {
	const env = loadCustomer({ adhdMode: false });
	const frm = env.form();
	env.refresh(frm);
	await tick();
	assert.equal(env.dom.count(PANEL), 0);

	env.setMode(true);
	await tick();

	assert.equal(env.dom.count(PANEL), 1, "the open Customer gets its strip without a reload");
	env.refresh(frm);
	await tick();
	assert.equal(env.dom.count(PANEL), 1);
});

test("Customer: switching the mode off removes the strip that was added", async () => {
	const env = loadCustomer();
	const frm = env.form();
	env.refresh(frm);
	await tick();
	assert.equal(env.dom.count(PANEL), 1);
	const callsBefore = env.state.calls.length;

	env.setMode(false);
	await tick();

	assert.equal(env.dom.count(PANEL), 0);
	assert.equal(env.state.calls.length, callsBefore, "turning it off makes no request");
});

test("Customer: an answer that arrives after the mode was switched off is not drawn", async () => {
	let release;
	const env = loadCustomer({ respond: () => new Promise((resolve) => (release = resolve)) });
	const frm = env.form();
	env.refresh(frm);
	await tick();

	env.setMode(false);
	release({ message: CUSTOMER_DATA });
	await tick();

	assert.equal(env.dom.count(PANEL), 0);
});

test("Customer: the mode switch only touches a Customer form", async () => {
	const env = loadCustomer({ adhdMode: false });
	env.sandbox.window.cur_frm = { doctype: "Lead", doc: { name: "L-1" }, $wrapper: env.dom.wrapper };

	env.setMode(true);
	await tick();

	assert.equal(env.state.calls.length, 0);
	assert.equal(env.dom.page.length, 0);
});

test("Customer: a new, unsaved customer has no strip and no lookup", async () => {
	const env = loadCustomer();
	for (const doc of [
		{ name: "New Customer 1", __islocal: 1 },
		{ name: undefined, __islocal: 1 },
		{ name: "" },
	]) {
		env.refresh(env.form(doc));
		await tick();
	}
	assert.equal(env.state.calls.length, 0);
	assert.equal(env.dom.page.length, 0);
});

test("Customer: overlapping refreshes leave one strip, showing the newest answer", async () => {
	const slow = [];
	const env = loadCustomer({
		respond: () => new Promise((resolve) => slow.push(resolve)),
	});
	const frm = env.form();

	env.refresh(frm); // e.g. the refresh before an after_save
	env.refresh(frm); // and the one that follows it
	await tick();
	// the newer request answers first, then the older one arrives late
	slow[1]({ message: { ...CUSTOMER_DATA, outstanding: 1234 } });
	await tick();
	slow[0]({ message: { ...CUSTOMER_DATA, outstanding: 9999 } });
	await tick();

	assert.equal(env.dom.count(PANEL), 1);
	assert.match(env.dom.panel(PANEL).html, /USD 1234\.00/);
	assert.ok(!env.dom.panel(PANEL).html.includes("9999"));
});

test("Customer: a panel that appeared while waiting is replaced, not doubled", async () => {
	let release;
	const env = loadCustomer({ respond: () => new Promise((resolve) => (release = resolve)) });
	const frm = env.form();
	env.refresh(frm);
	await tick();

	// e.g. a second copy of the script, or another render path, drew one in the meantime
	env.dom.page.unshift({ html: `<div class="${PANEL}" data-state="ready">stale</div>` });
	release({ message: CUSTOMER_DATA });
	await tick();

	assert.equal(env.dom.count(PANEL), 1);
	assert.ok(!env.dom.panel(PANEL).html.includes("stale"));
});

test("Customer: repeated saves and refreshes never stack panels", async () => {
	const env = loadCustomer();
	const frm = env.form();
	for (let index = 0; index < 4; index++) {
		env.refresh(frm);
		await tick();
	}
	assert.equal(env.dom.count(PANEL), 1);
});

test("Customer: an answer for a customer that is no longer open is dropped", async () => {
	let release;
	const env = loadCustomer({ respond: () => new Promise((resolve) => (release = resolve)) });
	const doc = { name: "Acme", __islocal: 0 };
	const frm = env.form(doc);
	env.refresh(frm);
	await tick();

	doc.name = "Globex"; // the same form object is reused for the next customer
	release({ message: CUSTOMER_DATA });
	await tick();

	assert.equal(env.dom.count(PANEL), 0, "Acme's figures must never show on Globex");
});

test("Customer: missing values show a dash or a plain word, never blank and never an error", async () => {
	const env = loadCustomer({
		respond: () => ({
			message: {
				...CUSTOMER_DATA,
				credit_limit: 0,
				outstanding: 0,
				payment_terms: null,
				primary_email: null,
				primary_contact_name: null,
			},
		}),
	});
	env.refresh(env.form());
	await tick();

	const html = env.dom.panel(PANEL).html;
	assert.match(html, /Credit Limit[\s\S]*No limit set/);
	assert.match(html, /Payment Terms[\s\S]*—/);
	assert.match(html, /Primary Contact[\s\S]*—/);
	assert.ok(!html.includes("mailto:"));
	assert.ok(!html.includes("NaN") && !html.includes("undefined") && !html.includes("null"));
	assert.ok(!html.includes("adhd-credit-over") && !html.includes("adhd-credit-warn"));
});

test("Customer: a contact with a name but no email is named without a link", async () => {
	const env = loadCustomer({
		respond: () => ({ message: { ...CUSTOMER_DATA, primary_email: null } }),
	});
	env.refresh(env.form());
	await tick();
	const html = env.dom.panel(PANEL).html;
	assert.match(html, /Jo Buyer/);
	assert.ok(!html.includes("mailto:"));
});

test("Customer: with no default company the credit figures are dashes and the strip says why", async () => {
	const env = loadCustomer({
		respond: () => ({
			message: {
				...CUSTOMER_DATA,
				credit_limit_company: null,
				credit_limit: null,
				outstanding: null,
				currency: null,
			},
		}),
	});
	env.refresh(env.form());
	await tick();

	const html = env.dom.panel(PANEL).html;
	assert.match(html, /Credit Limit[\s\S]*—/);
	assert.match(html, /Outstanding[\s\S]*—/);
	assert.match(html, /Set a default Company/);
	assert.match(html, /jo@acme\.example/, "the parts that do not depend on a company still show");
});

test("Customer: an inherited payment term says so", async () => {
	const env = loadCustomer({
		respond: () => ({ message: { ...CUSTOMER_DATA, payment_terms_inherited: true } }),
	});
	env.refresh(env.form());
	await tick();
	assert.match(env.dom.panel(PANEL).html, /Net 30<\/a> <span class="adhd-essentials-note">\(default\)/);
});

test("Customer: a failed or empty answer gives a quiet note, not an error", async () => {
	for (const respond of [
		() => {
			throw new Error("500");
		},
		() => Promise.reject(new Error("403")),
		() => ({ message: null }),
		() => undefined,
	]) {
		const env = loadCustomer({ respond });
		env.refresh(env.form());
		await tick();
		assert.equal(env.dom.count(PANEL), 1);
		assert.match(env.dom.panel(PANEL).html, /Essentials are not available/);
		assert.ok(!env.dom.panel(PANEL).html.includes("mailto:"));
	}
});

test("Customer: credit level is amber from 80% of the limit and red from 100%", () => {
	const { adhd } = loadCustomer();
	const level = (outstanding, extra = {}) =>
		adhd.getCreditLevel({ credit_limit: 10000, outstanding, ...extra });
	assert.equal(level(0), "ok");
	assert.equal(level(7999.99), "ok");
	assert.equal(level(8000), "warn");
	assert.equal(level(9999.99), "warn");
	assert.equal(level(10000), "over");
	assert.equal(level(12000), "over");
	assert.equal(level(-500), "ok", "a credit balance is not a warning");
	assert.equal(level(100, { over_limit: true }), "over", "the server's over_limit flag wins");
	// nothing to compare
	assert.equal(adhd.getCreditLevel({ credit_limit: 0, outstanding: 5000 }), "none");
	assert.equal(adhd.getCreditLevel({ credit_limit: null, outstanding: 5000 }), "none");
	assert.equal(adhd.getCreditLevel({ credit_limit: 10000, outstanding: null }), "none");
	assert.equal(adhd.getCreditLevel(null), "none");
});

test("Customer: near the limit the outstanding amount is amber, at or over it red, each with words", async () => {
	const render = async (outstanding, extra = {}) => {
		const env = loadCustomer({
			respond: () => ({ message: { ...CUSTOMER_DATA, outstanding, ...extra } }),
		});
		env.refresh(env.form());
		await tick();
		return env.dom.panel(PANEL).html;
	};

	const ok = await render(5000);
	assert.match(ok, /adhd-essentials-value adhd-credit-ok">USD 5000\.00/);
	assert.ok(!ok.includes("adhd-credit-text"), "no warning words when there is nothing to warn about");

	const warn = await render(8500);
	assert.match(warn, /adhd-essentials-value adhd-credit-warn">USD 8500\.00/);
	assert.match(warn, /85% of the credit limit/);

	const atLimit = await render(10000);
	assert.match(atLimit, /adhd-essentials-value adhd-credit-over">USD 10000\.00/);
	assert.match(atLimit, /At the credit limit/);

	const over = await render(10500, { over_limit: true });
	assert.match(over, /adhd-essentials-value adhd-credit-over">USD 10500\.00/);
	assert.match(over, /Over the credit limit/);
});

test("Customer: everything that came from data is escaped", async () => {
	const evil = "<img src=x onerror=alert(1)>\"'";
	const env = loadCustomer({
		respond: () => ({
			message: {
				...CUSTOMER_DATA,
				credit_limit_company: evil,
				payment_terms: evil,
				primary_contact_name: evil,
				primary_email: `"><script>alert(1)</script>`,
			},
		}),
	});
	env.refresh(env.form());
	await tick();

	const html = env.dom.panel(PANEL).html;
	assert.ok(!html.includes("<img"), "no tag from data survives");
	assert.ok(!html.includes("<script"));
	assert.match(html, /&lt;img src&#x3D;x onerror&#x3D;alert\(1\)&gt;/);
	assert.match(
		html,
		/href="mailto:&quot;&gt;&lt;script&gt;/,
		"the address cannot break out of its attribute"
	);
});

test("Customer: none of the mistakes this layer already had to fix are in the source", () => {
	const source = readAdhd("adhd_customer.js");
	assert.ok(!/layout\.\$wrapper/.test(source), "Layout only has .wrapper");
	assert.ok(!/\/app\//.test(source), "hand-built /app/ URL");
	assert.ok(!/frm\.set_indicator/.test(source));
	assert.ok(!/frappe\.datetime\.today\b/.test(source));
	assert.ok(!/after_submit/.test(source));
	assert.ok(
		!/client\.get_value|client\.get_list/.test(source),
		"credit limit/outstanding are not Customer fields"
	);
	assert.ok(/silent:\s*true/.test(source));
	assert.ok(!/localStorage|setInterval|setTimeout/.test(source), "no timer or storage at all");
});

// ---- ADHD-029: the Sales Order delivery status ------------------------------------------------------------------------

const DELIVERY = "adhd-delivery-status";
// the <tr> of one item in the panel, and its cells' text
const rowOf = (html, code) => {
	const match = html.match(new RegExp(`<tr class="[^"]*">\\s*<td>${code}</td>[\\s\\S]*?</tr>`));
	assert.ok(match, `no row for ${code}`);
	return match[0];
};
const cells = (html, code) =>
	[...rowOf(html, code).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim());
const item = (code, qty, delivered, extra = {}) => ({
	item_code: code,
	item_name: `${code} name`,
	qty,
	delivered_qty: delivered,
	...extra,
});

function loadSalesOrder(options = {}) {
	const env = load("adhd_sales_order.js", options);
	return {
		...env,
		form: (doc, extra = {}) => {
			const frm = {
				doctype: "Sales Order",
				doc: {
					docstatus: 1,
					status: "To Deliver and Bill",
					order_type: "Sales",
					per_delivered: 0,
					items: [],
					...doc,
				},
				$wrapper: env.dom.wrapper,
				fields_dict: { items: { grid: { wrapper: { after: (panel) => env.dom.page.push(panel) } } } },
				...extra,
			};
			env.sandbox.window.cur_frm = frm;
			return frm;
		},
	};
}

test("Sales Order: remaining quantity is ordered minus delivered", () => {
	const { adhd } = loadSalesOrder();
	const row = (qty, delivered, extra, order = {}) =>
		adhd.getDeliveryRow(item("A", qty, delivered, extra), order);

	assert.equal(row(10, 6).state, "pending");
	assert.equal(row(10, 6).remaining, 4);
	assert.equal(row(10, 6).delivered, 6);
	assert.equal(row(5, 5).state, "done");
	assert.equal(row(5, 5).remaining, 0);
	assert.equal(row(8, 0).remaining, 8);
	assert.equal(row(8, undefined).remaining, 8, "no delivered_qty yet means nothing delivered");
	assert.equal(row(10.3, 10.1).remaining, 0.2, "floating point noise is rounded away");
	assert.equal(row(1.5, 0.5).remaining, 1);
});

test("Sales Order: over-delivery is never a negative remaining, and says by how much", () => {
	const { adhd } = loadSalesOrder();
	const over = adhd.getDeliveryRow(item("A", 5, 7), {});
	assert.equal(over.state, "over");
	assert.equal(over.remaining, 0);
	assert.equal(over.over_by, 2);
	assert.equal(over.deliverable, false);
});

test("Sales Order: a zero quantity is not divided by, not pending, and not offered for delivery", () => {
	const { adhd } = loadSalesOrder();
	const plain = adhd.getDeliveryRow(item("A", 0, 0), {});
	assert.equal(plain.state, "no_qty");
	assert.equal(plain.deliverable, false);
	assert.equal(plain.remaining, 0);

	// a unit-price order takes a zero-quantity line: the quantity is settled at delivery
	const unit = adhd.getDeliveryRow(item("A", 0, 0), { has_unit_price_items: 1 });
	assert.equal(unit.state, "to_confirm");
	assert.equal(unit.deliverable, true);
	assert.equal(adhd.getDeliveryRow(item("A", 0, 3), { has_unit_price_items: 1 }).deliverable, false);
});

test("Sales Order: quantities are compared by size, as the standard mapper does", () => {
	const { adhd } = loadSalesOrder();
	const row = adhd.getDeliveryRow(item("A", -10, -4), {});
	assert.equal(row.state, "pending");
	assert.equal(row.remaining, 6);
});

test("Sales Order: lines that cannot be delivered from here are never deliverable", () => {
	const { adhd } = loadSalesOrder();
	const closed = adhd.getDeliveryRow(item("A", 10, 0, { closed: 1 }), {});
	assert.equal(closed.state, "closed");
	assert.equal(closed.deliverable, false);

	const service = adhd.getDeliveryRow(item("A", 10, 0, { skip_delivery: 1 }), {});
	assert.equal(service.state, "not_needed");
	assert.equal(service.deliverable, false);
	assert.equal(adhd.getDeliveryRow(item("A", 10, 0), { skip_delivery_note: 1 }).state, "not_needed");

	const dropShip = adhd.getDeliveryRow(item("A", 10, 4, { delivered_by_supplier: 1 }), {});
	assert.equal(dropShip.state, "supplier");
	assert.equal(dropShip.deliverable, false);
	assert.equal(dropShip.remaining, 6, "still reported, but shipped by the supplier");
});

test("Sales Order: the ticket's walk-through: partly delivered, then fully", async () => {
	const env = loadSalesOrder();
	const order = {
		name: "SO-1",
		items: [item("Widget A", 10, 0), item("Widget B", 5, 0), item("Widget C", 8, 0)],
	};
	const frm = env.form(order);

	env.refresh(frm);
	assert.equal(env.dom.count(DELIVERY), 1);
	let html = env.dom.panel(DELIVERY).html;
	assert.equal((html.match(/adhd-delivery-remaining-qty/g) || []).length, 3, "all three are still to go");
	assert.match(html, /adhd-create-dn-btn/);

	// A 6 of 10, B 5 of 5 delivered
	frm.doc.items = [item("Widget A", 10, 6), item("Widget B", 5, 5), item("Widget C", 8, 0)];
	frm.doc.per_delivered = 50;
	env.refresh(frm);
	assert.equal(env.dom.count(DELIVERY), 1, "a refresh replaces the panel instead of adding one");
	html = env.dom.panel(DELIVERY).html;
	assert.deepEqual(cells(html, "Widget A"), ["Widget A", "Widget A name", "10", "6", "4"]);
	assert.match(rowOf(html, "Widget A"), /adhd-delivery-pending/);
	assert.match(rowOf(html, "Widget A"), /adhd-delivery-remaining-qty">4</);
	assert.deepEqual(cells(html, "Widget B"), ["Widget B", "Widget B name", "5", "5", "✓"]);
	assert.match(rowOf(html, "Widget B"), /adhd-delivery-done/);
	assert.ok(
		!rowOf(html, "Widget B").includes("adhd-delivery-remaining-qty"),
		"a finished line is muted, not orange"
	);
	assert.deepEqual(cells(html, "Widget C"), ["Widget C", "Widget C name", "8", "0", "8"]);
	assert.match(html, /2 of 3 lines still to deliver/);
	assert.match(html, /adhd-create-dn-btn/, "items are still pending, so the shortcut stays");

	// everything delivered: the table gives way to one line, and the button goes
	frm.doc.items = [item("Widget A", 10, 10), item("Widget B", 5, 5), item("Widget C", 8, 8)];
	frm.doc.per_delivered = 100;
	frm.doc.status = "To Bill";
	env.refresh(frm);
	assert.equal(env.dom.count(DELIVERY), 1);
	html = env.dom.panel(DELIVERY).html;
	assert.match(html, /✅ All items fully delivered\./);
	assert.ok(!html.includes("<table"));
	assert.ok(!html.includes("adhd-create-dn-btn"));
});

test("Sales Order: over-delivered lines count as delivered and are labelled", () => {
	const env = loadSalesOrder();
	env.refresh(env.form({ name: "SO-1", items: [item("A", 5, 7)], per_delivered: 100 }));
	assert.match(env.dom.panel(DELIVERY).html, /All items fully delivered/);

	const mixed = loadSalesOrder();
	mixed.refresh(mixed.form({ name: "SO-1", items: [item("A", 5, 7), item("B", 4, 0)], per_delivered: 50 }));
	assert.match(mixed.dom.panel(DELIVERY).html, /✓ 2 over/);
});

test("Sales Order: only a submitted order gets the panel", () => {
	for (const docstatus of [0, 2]) {
		const env = loadSalesOrder();
		env.refresh(env.form({ docstatus, items: [item("A", 5, 0)] }));
		assert.equal(env.dom.count(DELIVERY), 0, `docstatus ${docstatus}`);
	}
});

test("Sales Order: an order that is no longer submitted loses the panel it had", () => {
	const env = loadSalesOrder();
	const frm = env.form({ items: [item("A", 5, 0)] });
	env.refresh(frm);
	assert.equal(env.dom.count(DELIVERY), 1);

	frm.doc.docstatus = 2;
	env.refresh(frm);
	assert.equal(env.dom.count(DELIVERY), 0);
});

test("Sales Order: ADHD mode off does nothing: no panel, no request, no timer, no storage", async () => {
	const env = loadSalesOrder({ adhdMode: false });
	env.refresh(env.form({ items: [item("A", 5, 0)] }));
	await tick();

	assert.equal(env.dom.page.length, 0);
	assert.equal(env.state.calls.length, 0);
	assert.equal(env.state.timers, 0);
	assert.equal(env.state.storage, 0);
});

test("Sales Order: switching the mode on or off with the order open adds or removes the panel", () => {
	const env = loadSalesOrder({ adhdMode: false });
	env.form({ items: [item("A", 5, 0)] });
	assert.equal(env.dom.count(DELIVERY), 0);

	env.setMode(true);
	assert.equal(env.dom.count(DELIVERY), 1);

	env.setMode(false);
	assert.equal(env.dom.count(DELIVERY), 0);
});

test("Sales Order: the mode switch only touches a Sales Order form", () => {
	const env = loadSalesOrder({ adhdMode: false });
	env.sandbox.window.cur_frm = { doctype: "Quotation", doc: {}, $wrapper: env.dom.wrapper };
	env.setMode(true);
	assert.equal(env.dom.page.length, 0);
});

test("Sales Order: Create Delivery Note is offered only when the standard button would be", () => {
	const items = [item("A", 5, 0)];
	const offered = (doc, options) => {
		const env = loadSalesOrder(options);
		env.refresh(env.form({ items, ...doc }));
		return env.dom.panel(DELIVERY).html.includes("adhd-create-dn-btn");
	};

	assert.equal(offered({}), true);
	assert.equal(offered({ status: "On Hold" }), false);
	assert.equal(offered({ status: "Closed" }), false);
	assert.equal(offered({ skip_delivery_note: 1 }), false);
	assert.equal(offered({ order_type: "Maintenance" }), false);
	assert.equal(offered({ order_type: "Shopping Cart" }), true);
	assert.equal(offered({ per_delivered: 100 }), false);
	assert.equal(
		offered({}, { canCreate: false }),
		false,
		"a user who cannot create a Delivery Note is not offered one"
	);
	assert.equal(
		offered({}, { canCreate: (doctype) => doctype === "Delivery Note" }),
		true,
		"the permission asked about is Delivery Note"
	);
});

test("Sales Order: nothing is offered for lines that cannot be delivered", () => {
	const shows = (items, doc = {}) => {
		const env = loadSalesOrder();
		env.refresh(env.form({ items, ...doc }));
		return env.dom.panel(DELIVERY).html;
	};

	// only a drop-shipped, a closed and a service line are open: the panel lists them, but offers no delivery
	const stuck = shows([
		item("DROP", 5, 0, { delivered_by_supplier: 1 }),
		item("CLOSED", 5, 0, { closed: 1 }),
		item("SERVICE", 5, 0, { skip_delivery: 1 }),
	]);
	assert.ok(!stuck.includes("adhd-create-dn-btn"));
	assert.match(stuck, /5 from supplier/);
	assert.match(stuck, /Closed/);
	assert.match(stuck, /No delivery needed/);

	// one deliverable line among them is enough
	assert.match(
		shows([item("DROP", 5, 0, { delivered_by_supplier: 1 }), item("GOODS", 2, 0)]),
		/adhd-create-dn-btn/
	);
	// only a zero-quantity line on an order without unit-price items
	assert.ok(!shows([item("ZERO", 0, 0)]).includes("adhd-create-dn-btn"));
	const unitPrice = shows([item("ZERO", 0, 0)], { has_unit_price_items: 1 });
	assert.match(unitPrice, /Quantity to confirm/);
	assert.ok(
		unitPrice.includes("adhd-create-dn-btn"),
		"the standard button is offered for unit-price orders too"
	);
});

test("Sales Order: the button runs the standard delivery-note action of the form", () => {
	const env = loadSalesOrder();
	const calls = [];
	const frm = env.form(
		{ name: "SO-1", items: [item("A", 5, 0)] },
		{ cscript: { make_delivery_note_based_on_delivery_date: (...args) => calls.push(args) } }
	);
	env.refresh(frm);

	env.dom.panel(DELIVERY).handlers[".adhd-create-dn-btn:click"]();

	assert.deepEqual(calls, [[true]], "the same call as Create > Delivery Note in sales_order.js");
	assert.equal(env.state.mapped.length, 0);
});

test("Sales Order: without that form action the standard mapper is called directly", () => {
	const env = loadSalesOrder();
	const frm = env.form({ name: "SO-1", items: [item("A", 5, 0)] }, { cscript: {} });
	env.refresh(frm);

	env.dom.panel(DELIVERY).handlers[".adhd-create-dn-btn:click"]();

	assert.equal(env.state.mapped.length, 1);
	const options = env.state.mapped[0];
	assert.equal(options.method, "erpnext.selling.doctype.sales_order.mapper.make_delivery_note");
	assert.equal(options.frm, frm);
	assert.deepEqual(JSON.parse(JSON.stringify(options.args)), {
		delivery_dates: [],
		for_reserved_stock: true,
	});
});

test("Sales Order: the mapper path is the one sales_order.js really uses, and it exists", () => {
	const { adhd } = loadSalesOrder();
	const method = adhd.SALES_ORDER_DELIVERY_MAPPER;
	const controller = fs.readFileSync(
		path.join(appRoot, "selling/doctype/sales_order/sales_order.js"),
		"utf8"
	);
	assert.ok(controller.includes(`method: "${method}"`), "the standard button calls this exact method");
	assert.ok(controller.includes("make_delivery_note_based_on_delivery_date(true)"));
	const mapper = fs.readFileSync(path.join(appRoot, "selling/doctype/sales_order/mapper.py"), "utf8");
	assert.match(mapper, /@frappe\.whitelist\(\)\ndef make_delivery_note\(/);
	// the file the ticket names, under the doctype folder, is never loaded by the desk
	assert.ok(!fs.existsSync(path.join(appRoot, "selling/doctype/sales_order/adhd_sales_order.js")));
});

test("Sales Order: item data is escaped", () => {
	const env = loadSalesOrder();
	const evil = '<img src=x onerror=alert(1)>"';
	env.refresh(env.form({ items: [item(evil, 5, 0, { item_name: `<script>alert(1)</script>${evil}` })] }));

	const html = env.dom.panel(DELIVERY).html;
	assert.ok(!html.includes("<img"));
	assert.ok(!html.includes("<script"));
	assert.match(html, /&lt;img src&#x3D;x onerror&#x3D;alert\(1\)&gt;/);
});

test("Sales Order: no items, no panel", () => {
	const env = loadSalesOrder();
	env.refresh(env.form({ items: [] }));
	assert.equal(env.dom.page.length, 0);
});

test("Sales Order: the panel goes below the items grid", () => {
	const env = loadSalesOrder();
	env.dom.page.push({ html: '<div class="grid-field">' });
	env.refresh(env.form({ items: [item("A", 5, 0)] }));
	assert.match(env.dom.page[0].html, /grid-field/);
	assert.match(env.dom.page[1].html, /adhd-delivery-status/);
});

test("Sales Order: none of the mistakes this layer already had to fix are in the source", () => {
	const source = readAdhd("adhd_sales_order.js");
	assert.ok(!/layout\.\$wrapper/.test(source), "Layout only has .wrapper");
	assert.ok(!/\/app\//.test(source));
	assert.ok(!/frm\.set_indicator/.test(source));
	assert.ok(!/frappe\.datetime\.today\b/.test(source));
	assert.ok(!/after_submit/.test(source));
	assert.ok(!/frappe\.call|frappe\.db\./.test(source), "the numbers are on the form: no request");
	assert.ok(!/localStorage|setInterval|setTimeout/.test(source), "no timer or storage at all");
	assert.ok(!/sum\(/i.test(source));
});
