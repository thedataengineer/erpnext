// ADHD-024 (Installation Note "Confirmed installed?" column) and ADHD-027 (Purchase Receipt "what's still open?").
// The real modules run in a vm against a small stand-in for the parts of Frappe they touch. The stand-in exposes
// only what Frappe really has (`layout.wrapper`, no `layout.$wrapper`), so a misused property fails a test
// instead of quietly doing nothing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const jsRoot = path.resolve(__dirname, "../public/js/adhd");
const readAdhd = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");

// the same mapping as frappe.utils.escape_html
const escapeHtml = (txt) => {
	if (txt == null) return "";
	const map = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
		"`": "&#x60;",
		"=": "&#x3D;",
	};
	return String(txt).replace(/[&<>"'`=]/g, (char) => map[char] || char);
};
const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text);
const cint = (value) => Number.parseInt(value || 0, 10) || 0;
const flt = (value, decimals) => {
	const number = Number.parseFloat(value) || 0;
	return decimals == null ? number : Number(number.toFixed(decimals));
};
const plain = (value) => JSON.parse(JSON.stringify(value));

// A page that records what is put into it. Panels are matched by class token, like a real selector.
function makePage() {
	const panels = [];
	const log = { inserts: 0, removes: 0 };
	const hasClass = (html, selector) =>
		new RegExp(`class="(?:[^"]*\\s)?${selector.slice(1)}(?:\\s[^"]*)?"`).test(html);
	const anchor = { isItemsWrapper: true };
	const $ = (target) => {
		if (target === anchor) {
			const insert = (html) => {
				log.inserts += 1;
				panels.push(html);
			};
			return { length: 1, before: insert, after: insert };
		}
		return { length: 0, before() {}, after() {} };
	};
	const layoutWrapper = {
		find: (selector) => ({
			remove() {
				log.removes += 1;
				for (let index = panels.length - 1; index >= 0; index--) {
					if (hasClass(panels[index], selector)) panels.splice(index, 1);
				}
			},
		}),
	};
	const count = (selector) => panels.filter((html) => hasClass(html, selector)).length;
	const text = (selector) => panels.filter((html) => hasClass(html, selector)).join("\n");
	return { $, anchor, count, layoutWrapper, log, panels, text };
}

function makeSandbox({
	page,
	registrations,
	stateHandlers,
	boot,
	extraFrappe = {},
	translateFn = translate,
}) {
	const window = { cur_frm: null };
	const sandbox = {
		console,
		Promise,
		window,
		$: page.$,
		__: translateFn,
		cint,
		flt,
		format_number: (value, _format, decimals) => Number(value).toFixed(decimals ?? 0),
		erpnext: {
			adhd: {
				onStateChange(fn) {
					stateHandlers.push(fn);
					fn(Boolean(boot.adhd_mode));
				},
			},
		},
		frappe: {
			boot,
			provide() {},
			ui: { form: { on: (doctype, handlers) => registrations.push({ doctype, handlers }) } },
			utils: { escape_html: escapeHtml },
			// anything that would write to the document is a bug in these two features
			model: {
				set_value() {
					throw new Error("the document must not be written to");
				},
			},
			...extraFrappe,
		},
	};
	return sandbox;
}

const handlerFor = (registrations, doctype, event) => {
	const found = registrations.find((entry) => entry.doctype === doctype && entry.handlers[event]);
	return found && found.handlers[event];
};

// ---------------------------------------------------------------------------------------------------------
// ADHD-024: Installation Note
// ---------------------------------------------------------------------------------------------------------

const FIELD = "adhd_confirmed_installed";

function loadInstallation({ adhdMode = true, migrated = true, translateFn } = {}) {
	const page = makePage();
	const registrations = [];
	const stateHandlers = [];
	const alerts = [];
	const boot = { adhd_mode: adhdMode };
	// what the site's meta ships: hidden, off the list view
	const shared = {
		fieldname: FIELD,
		fieldtype: "Check",
		hidden: 1,
		in_list_view: 0,
		width: null,
		read_only: 0,
	};
	const sandbox = makeSandbox({
		page,
		registrations,
		stateHandlers,
		boot,
		translateFn,
		extraFrappe: {
			meta: {
				get_docfield: (doctype, fieldname) =>
					migrated && doctype === "Installation Note Item" && fieldname === FIELD ? shared : null,
			},
			show_alert: (message, seconds) => alerts.push({ message, seconds }),
		},
	});
	vm.runInNewContext(readAdhd("adhd_installation_note.js"), sandbox, {
		filename: "adhd_installation_note.js",
	});
	return { sandbox, page, registrations, stateHandlers, alerts, boot, shared };
}

function makeRows(ticks) {
	return ticks.map((ticked, index) => ({
		name: `row-${index + 1}`,
		item_code: `ITEM-${index + 1}`,
		// every other row is a serial-numbered item, with the awkward characters a serial number can carry
		serial_no: index % 2 ? "SN<1>\nSN&2" : "",
		qty: index % 2 ? 2 : 1,
		[FIELD]: ticked ? 1 : 0,
	}));
}

// A form as Frappe builds it: the grid keeps a per-document copy of the docfield and rebuilds on reset_grid.
function makeInstallForm(env, { docstatus = 0, ticks = [0, 0, 0, 0, 0], perDocument = true } = {}) {
	const doc = { doctype: "Installation Note", name: "MAT-INS-0001", docstatus, items: makeRows(ticks) };
	const copy = { ...env.shared };
	const grid = {
		updates: [],
		resets: 0,
		get_docfield: (fieldname) => (fieldname === FIELD ? (perDocument ? copy : env.shared) : undefined),
		update_docfield_property(fieldname, property, value) {
			this.updates.push([fieldname, property, value]);
			copy[property] = value;
		},
		reset_grid() {
			this.resets += 1;
		},
	};
	const frm = {
		doctype: "Installation Note",
		doc,
		copy,
		grid,
		fields_dict: { items: { grid, wrapper: env.page.anchor } },
		// Frappe's Layout has `wrapper` (a jQuery object) and no `$wrapper`
		layout: { wrapper: env.page.layoutWrapper },
		dirty() {
			throw new Error("the form must not be marked dirty by the checklist");
		},
		save() {
			throw new Error("the checklist must not save");
		},
	};
	env.sandbox.window.cur_frm = frm;
	return frm;
}

const refresh = (env, frm) => handlerFor(env.registrations, "Installation Note", "refresh")(frm);
const tick = (env, frm, ...rowIndexes) => {
	rowIndexes.forEach((index) => (frm.doc.items[index][FIELD] = 1));
	handlerFor(env.registrations, "Installation Note Item", FIELD)(frm, "Installation Note Item", "row");
};

test("ADHD-024 with the mode off nothing is revealed, drawn, counted or changed", () => {
	const env = loadInstallation({ adhdMode: false });
	const frm = makeInstallForm(env, { ticks: [1, 0, 1, 0, 0] });
	const before = plain(frm.doc);
	const stockBefore = { ...frm.copy };

	refresh(env, frm);
	handlerFor(env.registrations, "Installation Note Item", FIELD)(frm, "Installation Note Item", "row");
	handlerFor(env.registrations, "Installation Note Item", "items_add")(frm);

	assert.deepEqual(frm.grid.updates, []);
	assert.equal(frm.grid.resets, 0);
	assert.equal(env.page.log.inserts, 0);
	assert.equal(env.page.panels.length, 0);
	assert.deepEqual(env.alerts, []);
	assert.deepEqual({ ...frm.copy }, stockBefore);
	assert.deepEqual(plain(frm.doc), before);
});

test("ADHD-024 with the mode on the hidden column is turned on at run time and the grid rebuilt", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env);
	const sharedBefore = { ...env.shared };

	refresh(env, frm);

	// not merely un-hidden: it must also be in the list view, or the grid builds no column for it
	assert.equal(frm.copy.hidden, 0);
	assert.equal(frm.copy.in_list_view, 1);
	assert.equal(frm.copy.width, 120);
	assert.equal(frm.copy.read_only, 0);
	assert.equal(frm.grid.resets, 1);
	// changed through the grid API, for the rows already drawn as well as the grid's own copy
	assert.ok(
		frm.grid.updates.some(
			([field, prop, value]) => field === FIELD && prop === "in_list_view" && value === 1
		)
	);
	assert.ok(
		frm.grid.updates.some(([field, prop, value]) => field === FIELD && prop === "hidden" && value === 0)
	);
	// the site's shared meta is never touched
	assert.deepEqual({ ...env.shared }, sharedBefore);
});

test("ADHD-024 a refresh that finds the column already on does not rebuild the grid or add a second line", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env, { ticks: [1, 1, 0, 0, 0] });

	refresh(env, frm);
	refresh(env, frm);
	refresh(env, frm);

	assert.equal(frm.grid.resets, 1);
	assert.equal(env.page.count(".adhd-install-progress"), 1);
});

test("ADHD-024 progress reads 0 of 5, 3 of 5 and 5 of 5 from the rows' own ticks", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env);
	refresh(env, frm);
	assert.match(env.page.text(".adhd-install-progress"), /0 of 5 confirmed/);

	tick(env, frm, 0, 2, 4);
	assert.match(env.page.text(".adhd-install-progress"), /3 of 5 confirmed/);
	assert.equal(env.page.count(".adhd-install-progress"), 1);
	assert.doesNotMatch(env.page.text(".adhd-install-progress"), /adhd-install-progress--complete/);
	assert.deepEqual(env.alerts, []);

	tick(env, frm, 1, 3);
	assert.match(env.page.text(".adhd-install-progress"), /5 of 5 confirmed/);
	assert.match(env.page.text(".adhd-install-progress"), /adhd-install-progress--complete/);
	assert.equal(env.page.count(".adhd-install-progress"), 1);
});

test("ADHD-024 serial-numbered rows count like any other row", () => {
	const env = loadInstallation();
	const counted = env.sandbox.erpnext.adhd.countInstallConfirmations(makeRows([1, 1, 0]));
	// row 2 carries serial numbers
	assert.deepEqual(plain(counted), { confirmed: 2, total: 3, complete: false });
	assert.equal(env.sandbox.erpnext.adhd.countInstallConfirmations(makeRows([1, 1, 1])).complete, true);
});

test("ADHD-024 a note with no rows shows no counter and never counts as complete", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env, { ticks: [] });
	refresh(env, frm);
	assert.equal(env.page.count(".adhd-install-progress"), 0);
	assert.equal(env.sandbox.erpnext.adhd.countInstallConfirmations([]).complete, false);
	assert.deepEqual(plain(env.sandbox.erpnext.adhd.countInstallConfirmations(undefined)), {
		confirmed: 0,
		total: 0,
		complete: false,
	});
});

test("ADHD-024 the all-confirmed toast fires once, when the last tick lands, and not on a later refresh", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env, { ticks: [1, 1, 1, 1, 0] });
	refresh(env, frm);
	assert.deepEqual(env.alerts, []);

	tick(env, frm, 4);
	assert.equal(env.alerts.length, 1);
	assert.equal(env.alerts[0].message.indicator, "green");
	assert.match(env.alerts[0].message.message, /All items confirmed installed/);

	// ticking again, or the form refreshing, is not new good news
	tick(env, frm, 4);
	refresh(env, frm);
	assert.equal(env.alerts.length, 1);
});

test("ADHD-024 adding or removing a row updates the line, without a toast", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env, { ticks: [1, 1] });
	refresh(env, frm);

	frm.doc.items.push(...makeRows([0, 0, 0]).map((row, index) => ({ ...row, name: `extra-${index}` })));
	handlerFor(env.registrations, "Installation Note Item", "items_add")(frm);
	assert.match(env.page.text(".adhd-install-progress"), /2 of 5 confirmed/);

	frm.doc.items.splice(2, 3);
	handlerFor(env.registrations, "Installation Note Item", "items_remove")(frm);
	assert.match(env.page.text(".adhd-install-progress"), /2 of 2 confirmed/);
	assert.deepEqual(env.alerts, []);
});

test("ADHD-024 once submitted the column is read-only and a draft's is not", () => {
	const draft = loadInstallation();
	const draftForm = makeInstallForm(draft, { docstatus: 0, ticks: [1, 0] });
	refresh(draft, draftForm);
	assert.equal(draftForm.copy.read_only, 0);

	const submitted = loadInstallation();
	const submittedForm = makeInstallForm(submitted, { docstatus: 1, ticks: [1, 1] });
	refresh(submitted, submittedForm);
	assert.equal(submittedForm.copy.hidden, 0);
	assert.equal(submittedForm.copy.in_list_view, 1);
	assert.equal(submittedForm.copy.read_only, 1);
	// the progress is still shown, as a record of what was confirmed
	assert.match(submitted.page.text(".adhd-install-progress"), /2 of 2 confirmed/);
});

test("ADHD-024 the submit that follows a draft turns the column read-only on the same form", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env, { docstatus: 0, ticks: [1, 1] });
	refresh(env, frm);
	assert.equal(frm.copy.read_only, 0);

	frm.doc.docstatus = 1;
	refresh(env, frm);
	assert.equal(frm.copy.read_only, 1);
	assert.equal(env.page.count(".adhd-install-progress"), 1);
});

test("ADHD-024 a site that has not migrated is left completely alone", () => {
	const env = loadInstallation({ migrated: false });
	const frm = makeInstallForm(env, { ticks: [1, 0] });

	assert.doesNotThrow(() => refresh(env, frm));
	assert.doesNotThrow(() => handlerFor(env.registrations, "Installation Note Item", FIELD)(frm));
	assert.doesNotThrow(() => handlerFor(env.registrations, "Installation Note Item", "items_add")(frm));
	assert.doesNotThrow(() => env.stateHandlers.forEach((fn) => fn(true)));

	assert.deepEqual(frm.grid.updates, []);
	assert.equal(frm.grid.resets, 0);
	assert.equal(env.page.log.inserts, 0);
	assert.deepEqual(env.alerts, []);
});

test("ADHD-024 the shared docfield is never changed, even if the grid hands it out", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env, { perDocument: false });
	const sharedBefore = { ...env.shared };

	refresh(env, frm);

	assert.deepEqual({ ...env.shared }, sharedBefore);
	assert.equal(frm.grid.resets, 0);
});

test("ADHD-024 switching the mode off puts the column back as the site ships it and takes the line away", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env, { ticks: [1, 0, 0] });
	refresh(env, frm);
	assert.equal(frm.copy.in_list_view, 1);
	assert.equal(env.page.count(".adhd-install-progress"), 1);
	const [onSwitch] = env.stateHandlers;

	env.boot.adhd_mode = false;
	onSwitch(false);

	assert.equal(frm.copy.hidden, 1);
	assert.equal(frm.copy.in_list_view, 0);
	assert.equal(frm.copy.width, null);
	assert.equal(frm.copy.read_only, 0);
	assert.equal(frm.grid.resets, 2);
	assert.equal(env.page.count(".adhd-install-progress"), 0);

	// and on again brings it back
	env.boot.adhd_mode = true;
	onSwitch(true);
	assert.equal(frm.copy.in_list_view, 1);
	assert.equal(frm.grid.resets, 3);
	assert.equal(env.page.count(".adhd-install-progress"), 1);
});

test("ADHD-024 a mode switch on another form does nothing", () => {
	const env = loadInstallation();
	const frm = makeInstallForm(env);
	frm.doctype = "Sales Order";
	const [onSwitch] = env.stateHandlers;

	onSwitch(true);

	assert.equal(frm.grid.resets, 0);
	assert.equal(env.page.log.inserts, 0);
});

test("ADHD-024 never blocks a save or a submit and never writes to the document", () => {
	const env = loadInstallation();
	const events = env.registrations.flatMap((entry) => Object.keys(entry.handlers));
	for (const blocking of ["validate", "before_save", "before_submit", "on_submit", "before_cancel"]) {
		assert.ok(!events.includes(blocking), `${blocking} must not be handled`);
	}

	// the form's dirty()/save() and frappe.model.set_value throw in this harness; a full pass over the
	// handlers therefore proves none of them is used, and the rows keep exactly the values they had
	const frm = makeInstallForm(env, { ticks: [1, 0, 1, 0, 1] });
	const before = plain(frm.doc);
	refresh(env, frm);
	handlerFor(env.registrations, "Installation Note Item", FIELD)(frm);
	assert.deepEqual(plain(frm.doc), before);
});

test("ADHD-024 the line is built from escaped text", () => {
	const env = loadInstallation({
		translateFn: (text, values) => `<img src=x onerror=alert(1)> ${translate(text, values)}`,
	});
	const frm = makeInstallForm(env);
	refresh(env, frm);
	const html = env.page.text(".adhd-install-progress");
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /&lt;img/);
});

test("ADHD-024 does not use the Grid API the ticket assumed", () => {
	// `add_custom_column` exists on Query Report, not on Grid, so any call to it would throw on a real form
	const source = readAdhd("adhd_installation_note.js");
	assert.doesNotMatch(source, /\.add_custom_column\(/);
	assert.doesNotMatch(source, /\$wrapper/);
	assert.doesNotMatch(source, /localStorage/);
});

// ---------------------------------------------------------------------------------------------------------
// ADHD-027: Purchase Receipt
// ---------------------------------------------------------------------------------------------------------

const METHOD = "erpnext.buying.services.adhd_receipt_diff.get_receipt_diff";

function loadReceipt({ adhdMode = true, canRead = true, respond } = {}) {
	const page = makePage();
	const registrations = [];
	const stateHandlers = [];
	const calls = [];
	const boot = { adhd_mode: adhdMode };
	const sandbox = makeSandbox({
		page,
		registrations,
		stateHandlers,
		boot,
		extraFrappe: {
			call: (options) => {
				calls.push(options);
				return respond ? respond(options) : Promise.resolve({ message: { rows: [] } });
			},
			model: { can_read: () => canRead },
			msgprint() {
				throw new Error("a background panel must not open a dialog");
			},
		},
	});
	sandbox.frappe.utils.get_form_link = (doctype, name) =>
		`/desk/${encodeURIComponent(doctype.toLowerCase().replace(/ /g, "-"))}/${encodeURIComponent(name)}`;
	vm.runInNewContext(readAdhd("adhd_purchase_receipt.js"), sandbox, {
		filename: "adhd_purchase_receipt.js",
	});
	return { sandbox, page, registrations, stateHandlers, calls, boot };
}

function makeReceiptForm(env, { docstatus = 1, name = "MAT-PRE-0001", withOrder = true } = {}) {
	const frm = {
		doctype: "Purchase Receipt",
		doc: {
			doctype: "Purchase Receipt",
			name,
			docstatus,
			// no purchase_order on the header: the link lives on the item rows
			items: [
				{
					item_code: "ITEM-A",
					purchase_order: withOrder ? "PO-0001" : null,
					purchase_order_item: "abc",
				},
			],
		},
		fields_dict: { items: { wrapper: env.page.anchor } },
		layout: { wrapper: env.page.layoutWrapper },
	};
	env.sandbox.window.cur_frm = frm;
	return frm;
}

const row = (overrides) => ({
	purchase_order: "PO-0001",
	purchase_order_item: "abc",
	item_code: "ITEM-A",
	item_name: "Item A",
	uom: "Nos",
	stock_uom: "Nos",
	conversion_factor: 1,
	ordered: 10,
	this_receipt: 6,
	this_receipt_rejected: 0,
	received: 6,
	returned: 0,
	pending: 4,
	pending_stock_qty: 4,
	over_received: 0,
	state: "open",
	...overrides,
});

const diff = (rows, extra = {}) => ({
	receipt: "MAT-PRE-0001",
	is_return: 0,
	orders: [{ name: "PO-0001", status: "To Receive and Bill", has_unit_price_items: 0 }],
	hidden_orders: [],
	rows,
	open_count: rows.filter((entry) => entry.state === "open").length,
	truncated: false,
	...extra,
});

const build = (env, data) => env.sandbox.erpnext.adhd.buildReceiptDiffHtml(data);
const receiptRefresh = (env, frm) => handlerFor(env.registrations, "Purchase Receipt", "refresh")(frm);
// let the promise chain behind an async handler settle
const settle = async () => {
	for (let index = 0; index < 8; index++) await Promise.resolve();
};

test("ADHD-027 with the mode off nothing is requested or drawn", async () => {
	const env = loadReceipt({ adhdMode: false });
	const frm = makeReceiptForm(env);
	receiptRefresh(env, frm);
	await settle();
	assert.deepEqual(env.calls, []);
	assert.equal(env.page.log.inserts, 0);
});

test("ADHD-027 only a submitted receipt made against an order asks the server", async () => {
	for (const options of [{ docstatus: 0 }, { docstatus: 2 }, { withOrder: false }]) {
		const env = loadReceipt();
		receiptRefresh(env, makeReceiptForm(env, options));
		await settle();
		assert.deepEqual(env.calls, [], JSON.stringify(options));
		assert.equal(env.page.log.inserts, 0);
	}
	const env = loadReceipt({ canRead: false });
	receiptRefresh(env, makeReceiptForm(env));
	await settle();
	assert.deepEqual(env.calls, [], "a user who cannot read Purchase Orders is not asked");
});

test("ADHD-027 a submitted receipt asks for its own name, quietly, and shows the answer once", async () => {
	const env = loadReceipt({ respond: async () => ({ message: diff([row()]) }) });
	const frm = makeReceiptForm(env);

	receiptRefresh(env, frm);
	await settle();
	receiptRefresh(env, frm);
	await settle();

	assert.equal(env.calls.length, 2);
	assert.equal(env.calls[0].method, METHOD);
	assert.deepEqual(plain(env.calls[0].args), { receipt: "MAT-PRE-0001" });
	assert.equal(env.calls[0].silent, true);
	// two refreshes, one panel
	assert.equal(env.page.count(".adhd-receipt-diff"), 1);
});

test("ADHD-027 a permission failure or a dropped connection leaves no panel and opens no dialog", async () => {
	const env = loadReceipt({ respond: async () => Promise.reject(new Error("403")) });
	receiptRefresh(env, makeReceiptForm(env));
	await settle();
	assert.equal(env.page.log.inserts, 0);
	assert.equal(env.calls[0].silent, true);
});

test("ADHD-027 the ticket's partial receipt: A and C still open, B done", () => {
	const env = loadReceipt();
	const html = build(
		env,
		diff([
			row({
				item_code: "ITEM-A",
				item_name: "Item A",
				ordered: 10,
				this_receipt: 6,
				received: 6,
				pending: 4,
			}),
			row({
				item_code: "ITEM-B",
				item_name: "Item B",
				ordered: 5,
				this_receipt: 5,
				received: 5,
				pending: 0,
				state: "complete",
			}),
			row({
				item_code: "ITEM-C",
				item_name: "Item C",
				ordered: 8,
				this_receipt: 3,
				received: 3,
				pending: 5,
			}),
		])
	);

	assert.match(html, /2 lines still open/);
	assert.match(html, /<td class="text-right adhd-diff-open-qty">4<\/td>/);
	assert.match(html, /<td class="text-right adhd-diff-open-qty">5<\/td>/);
	// the finished line is tucked away, with a tick and not a number
	assert.match(html, /1 line complete/);
	assert.match(html, /adhd-diff-done-qty">✓/);
	assert.doesNotMatch(html, /All items fully received/);
	// the open lines come before the finished one
	assert.ok(html.indexOf("ITEM-A") < html.indexOf("ITEM-B"));
	assert.ok(html.indexOf("ITEM-C") < html.indexOf("ITEM-B"));
});

test("ADHD-027 when every line is complete the table is replaced by one message", () => {
	const env = loadReceipt();
	const html = build(
		env,
		diff([
			row({ state: "complete", pending: 0, received: 10 }),
			row({ item_code: "ITEM-B", state: "complete", pending: 0, received: 5, ordered: 5 }),
		])
	);
	assert.match(html, /All items fully received\./);
	assert.doesNotMatch(html, /<table/);
	assert.doesNotMatch(html, /adhd-diff-summary/);
	// the way to the order stays
	assert.match(html, /href="\/desk\/purchase-order\/PO-0001"/);
});

test("ADHD-027 an over-receipt is a tick with the excess, never a negative pending quantity", () => {
	const env = loadReceipt();
	const html = build(
		env,
		diff([
			row({ item_code: "ITEM-A", pending: 4 }),
			row({
				item_code: "ITEM-B",
				ordered: 8,
				received: 10,
				pending: 0,
				over_received: 2,
				state: "complete",
			}),
		])
	);
	assert.match(html, /✓ <span class="adhd-diff-over">2 over<\/span>/);
	assert.doesNotMatch(html, /-2/);
});

test("ADHD-027 returned goods show as returned, and this receipt's own share can be negative", () => {
	const env = loadReceipt();
	const html = build(
		env,
		diff([row({ ordered: 10, this_receipt: -4, received: 6, returned: 4, pending: 4 })], { is_return: 1 })
	);
	assert.match(html, /<td class="text-right">-4<\/td>/);
	assert.match(html, /6 <span class="adhd-diff-muted">\(4 returned\)<\/span>/);
	assert.match(html, /adhd-diff-open-qty">4</);
});

test("ADHD-027 a row in another unit of measure also shows the stock quantity", () => {
	const env = loadReceipt();
	const boxes = build(
		env,
		diff([
			row({ uom: "Box", stock_uom: "Nos", conversion_factor: 12, pending: 4, pending_stock_qty: 48 }),
		])
	);
	assert.match(boxes, /<td>Box<\/td>/);
	assert.match(boxes, /adhd-diff-open-qty">4 <span class="adhd-diff-stock">&#x3D; 48 Nos<\/span>/);

	const same = build(env, diff([row({ uom: "Nos", stock_uom: "Nos" })]));
	assert.doesNotMatch(same, /adhd-diff-stock/);
});

test("ADHD-027 rejected goods are shown next to what arrived, and a line the receipt did not touch has a dash", () => {
	const env = loadReceipt();
	const html = build(
		env,
		diff([
			row({ this_receipt: 6, this_receipt_rejected: 1 }),
			row({ item_code: "ITEM-B", this_receipt: 0, received: 2, ordered: 5, pending: 3 }),
		])
	);
	assert.match(html, /6 <span class="adhd-diff-muted">\(1 rejected\)<\/span>/);
	assert.match(html, /<td class="text-right">—<\/td>/);
});

test("ADHD-027 closed and open-ended lines are not shown as pending and never claim everything arrived", () => {
	const env = loadReceipt();
	const closed = build(
		env,
		diff([
			row({ state: "closed", pending: 0 }),
			row({ item_code: "ITEM-B", state: "complete", pending: 0 }),
		])
	);
	assert.match(closed, /All items fully received\./);

	const openEnded = build(env, diff([row({ state: "open_ended", pending: 0, ordered: 0 })]));
	assert.doesNotMatch(openEnded, /All items fully received/);
	assert.doesNotMatch(openEnded, /adhd-diff-open-qty/);
	assert.match(openEnded, /This line has no fixed quantity/);

	const closedShown = build(env, diff([row(), row({ item_code: "ITEM-B", state: "closed", pending: 0 })]));
	assert.match(closedShown, /<summary>1 line complete<\/summary>/);
	assert.match(closedShown, />Closed</);
});

test("ADHD-027 several orders each get a group and a link, and notes say what is missing", () => {
	const env = loadReceipt();
	const html = build(
		env,
		diff(
			[
				row({ purchase_order: "PO-0001", item_code: "ITEM-A" }),
				row({ purchase_order: "PO-0002", item_code: "ITEM-Z", state: "complete", pending: 0 }),
			],
			{
				orders: [
					{ name: "PO-0001", status: "To Receive and Bill" },
					{ name: "PO-0002", status: "Completed" },
				],
				hidden_orders: ["PO-0003"],
				truncated: true,
			}
		)
	);
	assert.match(html, /href="\/desk\/purchase-order\/PO-0001"/);
	assert.match(html, /href="\/desk\/purchase-order\/PO-0002"/);
	assert.match(html, /target="_blank" rel="noopener noreferrer"/);
	assert.match(html, /Nothing left to receive on this order\./);
	assert.match(html, /You cannot see PO-0003, so its lines are not listed\./);
	assert.match(html, /only the first part of a long list/);
});

test("ADHD-027 an answer with no lines draws nothing", () => {
	const env = loadReceipt();
	assert.equal(build(env, diff([])), "");
	assert.equal(build(env, null), "");
	assert.equal(build(env, {}), "");
});

test("ADHD-027 every value from data is escaped", () => {
	const env = loadReceipt();
	const evil = `<script>alert(1)</script>`;
	const html = build(
		env,
		diff(
			[
				row({
					item_code: evil,
					item_name: `"><img src=x onerror=alert(2)>`,
					uom: `<b>Box</b>`,
					stock_uom: `<i>Nos</i>`,
					purchase_order: `PO"><svg onload=alert(3)>`,
				}),
			],
			{
				orders: [{ name: `PO"><svg onload=alert(3)>`, status: `<u>Open</u>` }],
				hidden_orders: [`<a href=x>PO-9</a>`],
			}
		)
	);
	for (const raw of ["<script", "<img", "<b>", "<i>", "<svg", "<u>", "<a href=x"]) {
		assert.ok(!html.includes(raw), `unescaped ${raw}`);
	}
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /href="\/desk\/purchase-order\/PO%22%3E%3Csvg%20onload%3Dalert\(3\)%3E"/);
});

test("ADHD-027 a reply that arrives after a newer refresh is discarded, and the last refresh wins", async () => {
	const pending = [];
	const env = loadReceipt({
		respond: () => new Promise((resolve) => pending.push(resolve)),
	});
	const frm = makeReceiptForm(env);

	receiptRefresh(env, frm); // first request
	receiptRefresh(env, frm); // second request
	assert.equal(pending.length, 2);

	pending[1]({ message: diff([row({ item_code: "SECOND" })]) });
	await settle();
	pending[0]({ message: diff([row({ item_code: "FIRST" })]) });
	await settle();

	assert.equal(env.page.count(".adhd-receipt-diff"), 1);
	assert.match(env.page.text(".adhd-receipt-diff"), /SECOND/);
	assert.doesNotMatch(env.page.text(".adhd-receipt-diff"), /FIRST/);
});

test("ADHD-027 two replies in the other order still leave one panel", async () => {
	const pending = [];
	const env = loadReceipt({ respond: () => new Promise((resolve) => pending.push(resolve)) });
	const frm = makeReceiptForm(env);
	receiptRefresh(env, frm);
	receiptRefresh(env, frm);

	pending[0]({ message: diff([row({ item_code: "FIRST" })]) });
	await settle();
	pending[1]({ message: diff([row({ item_code: "SECOND" })]) });
	await settle();

	assert.equal(env.page.count(".adhd-receipt-diff"), 1);
	assert.match(env.page.text(".adhd-receipt-diff"), /SECOND/);
});

test("ADHD-027 a panel that appeared while the server was working is replaced, not doubled", async () => {
	const pending = [];
	const env = loadReceipt({ respond: () => new Promise((resolve) => pending.push(resolve)) });
	const frm = makeReceiptForm(env);
	receiptRefresh(env, frm);

	// something else (a second copy of the script, an older panel) drew one in the meantime
	env.sandbox.$(env.page.anchor).after('<div class="adhd-receipt-diff">left over</div>');
	pending[0]({ message: diff([row({ item_code: "FRESH" })]) });
	await settle();

	assert.equal(env.page.count(".adhd-receipt-diff"), 1);
	assert.match(env.page.text(".adhd-receipt-diff"), /FRESH/);
	assert.doesNotMatch(env.page.text(".adhd-receipt-diff"), /left over/);
});

test("ADHD-027 a reply for a document the form has moved on from is not drawn", async () => {
	const pending = [];
	const env = loadReceipt({ respond: () => new Promise((resolve) => pending.push(resolve)) });
	const frm = makeReceiptForm(env, { name: "MAT-PRE-0001" });
	receiptRefresh(env, frm);
	frm.doc.name = "MAT-PRE-0002"; // Frappe reuses the form for the next receipt

	pending[0]({ message: diff([row()]) });
	await settle();

	assert.equal(env.page.log.inserts, 0);
});

test("ADHD-027 switching the mode off removes the panel and a reply still on its way is dropped", async () => {
	const pending = [];
	const env = loadReceipt({ respond: () => new Promise((resolve) => pending.push(resolve)) });
	const frm = makeReceiptForm(env);
	const [onSwitch] = env.stateHandlers;

	receiptRefresh(env, frm);
	pending[0]({ message: diff([row()]) });
	await settle();
	assert.equal(env.page.count(".adhd-receipt-diff"), 1);

	// a second request is in flight when the mode goes off
	receiptRefresh(env, frm);
	env.boot.adhd_mode = false;
	onSwitch(false);
	assert.equal(env.page.count(".adhd-receipt-diff"), 0);
	pending[1]({ message: diff([row()]) });
	await settle();

	assert.equal(env.page.count(".adhd-receipt-diff"), 0);
	// no third request was made by switching off
	assert.equal(env.calls.length, 2);
});

test("ADHD-027 switching the mode on with a receipt open draws the panel at once", async () => {
	const env = loadReceipt({ adhdMode: false, respond: async () => ({ message: diff([row()]) }) });
	const frm = makeReceiptForm(env);
	const [onSwitch] = env.stateHandlers;
	assert.equal(env.calls.length, 0);

	env.boot.adhd_mode = true;
	onSwitch(true);
	await settle();

	assert.equal(env.calls.length, 1);
	assert.equal(env.page.count(".adhd-receipt-diff"), 1);
	assert.equal(frm.doc.name, "MAT-PRE-0001");
});

test("ADHD-027 the receipt form is not held up by the network call", () => {
	const env = loadReceipt({ respond: () => new Promise(() => {}) });
	const returned = receiptRefresh(env, makeReceiptForm(env));
	// a returned promise would make Frappe wait for it before finishing the form's refresh
	assert.equal(returned, undefined);
});

test("ADHD-027 relies on the item rows for the link and on layout.wrapper for cleaning up", () => {
	const source = readAdhd("adhd_purchase_receipt.js");
	assert.doesNotMatch(source, /frm\.doc\.purchase_order/);
	assert.doesNotMatch(source, /\$wrapper/);
	assert.doesNotMatch(source, /frappe\.client\.get/);
	assert.doesNotMatch(source, /["'`]\/app\//);
	assert.doesNotMatch(source, /localStorage/);
});
