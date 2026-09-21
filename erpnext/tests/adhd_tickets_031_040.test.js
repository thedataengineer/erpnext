const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const jsRoot = path.join(appRoot, "public/js/adhd");
const readAdhd = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");

function addDays(value, days) {
	const date = new Date(`${value}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function makeChain() {
	const chain = {
		length: 0,
		0: undefined,
		append() {
			return this;
		},
		appendTo() {
			return this;
		},
		addBack() {
			return this;
		},
		attr() {
			return this;
		},
		before() {
			return this;
		},
		data() {
			return this;
		},
		each() {
			return this;
		},
		filter() {
			return this;
		},
		find() {
			return this;
		},
		first() {
			return this;
		},
		get() {
			return [];
		},
		html() {
			return this;
		},
		map() {
			return { get: () => [] };
		},
		off() {
			return this;
		},
		on() {
			return this;
		},
		prepend() {
			return this;
		},
		prop() {
			return this;
		},
		remove() {
			return this;
		},
		removeAttr() {
			return this;
		},
		removeClass() {
			return this;
		},
		siblings() {
			return this;
		},
		text() {
			return this;
		},
		toggleClass() {
			return this;
		},
	};
	return chain;
}

function load(name, overrides = {}) {
	const registrations = [];
	const storage = new Map();
	const sandbox = {
		console,
		Date,
		Map,
		MutationObserver: class {},
		Promise,
		Set,
		clearTimeout,
		document: {},
		setTimeout,
		localStorage: {
			getItem: (key) => storage.get(key) ?? null,
			removeItem: (key) => storage.delete(key),
			setItem: (key, value) => storage.set(key, value),
		},
		$: () => makeChain(),
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.replace(`{${index}}`, value), text),
		format_currency: (value) => String(value),
		format_number: (value) => String(value),
		frappe: {
			boot: { adhd_mode: true, sysdefaults: { company: "Example Co" } },
			call: async () => ({ message: [] }),
			datetime: { add_days: addDays, get_today: () => "2026-09-20" },
			defaults: { get_user_default: () => null },
			model: {},
			provide() {},
			router: { on() {}, slug: (value) => value.toLowerCase().replaceAll(" ", "-") },
			ui: {
				form: {
					ControlLink: function () {},
					on: (doctype, handlers) => registrations.push({ doctype, handlers }),
				},
			},
			utils: {
				debounce: (fn) => fn,
				escape_html: (value) => String(value),
			},
		},
		erpnext: { adhd: {} },
		...overrides,
	};
	sandbox.frappe.ui.form.ControlLink.prototype.open_advanced_search = function () {};
	vm.runInNewContext(readAdhd(name), sandbox, { filename: name });
	return { sandbox, registrations, storage };
}

test("ADHD-031 builds account/date keys and discards corrupt saved state", () => {
	const { sandbox, storage } = load("adhd_bank_recon.js");
	const frm = {
		doc: { bank_account: "Checking - EX", bank_statement_from_date: "2026-09-01" },
	};
	assert.equal(
		sandbox.erpnext.adhd.bankReconStorageKey(frm),
		"adhd_bank_recon_Checking - EX_2026-09-01",
	);
	storage.set("broken", "{");
	assert.equal(sandbox.erpnext.adhd.readBankReconState("broken"), null);
	assert.equal(storage.has("broken"), false);
});

test("ADHD-032 buckets and sorts invoices at the exact date boundaries", () => {
	const { sandbox } = load("adhd_payment_entry.js");
	const result = sandbox.erpnext.adhd.bucketInvoices(
		[
			{ voucher_no: "LATE", due_date: "2026-09-19" },
			{ voucher_no: "TODAY", due_date: "2026-09-20" },
			{ voucher_no: "WEEK-END", due_date: "2026-09-26" },
			{ voucher_no: "LATER", due_date: "2026-10-01" },
		],
		"2026-09-20",
	);
	assert.deepEqual(
		Array.from(result.urgent, (row) => row.voucher_no),
		["LATE", "TODAY"],
	);
	assert.deepEqual(Array.from(result.thisWeek, (row) => row.voucher_no), ["WEEK-END"]);
	assert.deepEqual(Array.from(result.other, (row) => row.voucher_no), ["LATER"]);
});

test("ADHD-035 deduplicates stock queries and uses stock-unit transfer quantity", () => {
	const { sandbox } = load("adhd_stock_entry.js");
	const frm = {
		doc: {
			items: [
				{
					item_code: "ITEM-1",
					s_warehouse: "Stores",
					t_warehouse: "Transit",
					qty: 2,
					transfer_qty: 4,
				},
				{ item_code: "ITEM-1", s_warehouse: "Stores", qty: 1, transfer_qty: 2 },
			],
		},
	};
	const pairs = sandbox.erpnext.adhd.getItemWarehousePairs(frm);
	assert.equal(pairs.length, 2);
	const rows = sandbox.erpnext.adhd.buildStockPreviewRows(frm.doc.items, {
		"ITEM-1::Stores": 10,
		"ITEM-1::Transit": 3,
	});
	assert.deepEqual(
		Array.from(rows, (row) => [row.warehouse, row.change, row.after]),
		[
			["Stores", -4, 6],
			["Transit", 4, 7],
			// the second Stores row starts from what the first one left (10 - 4), not from the bin's 10
			["Stores", -2, 4],
		],
	);
});

test("ADHD-036 applies critical and 125-percent stock boundaries", () => {
	const { sandbox } = load("adhd_list_view.js");
	const classify = sandbox.erpnext.adhd.classifyStockHealth;
	assert.equal(classify(null, 10), "adhd-stock-unknown");
	assert.equal(classify(10, 10), "adhd-stock-critical");
	assert.equal(classify(12.5, 10), "adhd-stock-low");
	assert.equal(classify(12.51, 10), null);
});

test("ADHD-039 flags either percentage or absolute variance", () => {
	const { sandbox } = load("adhd_stock_reconciliation.js");
	const calculate = sandbox.erpnext.adhd.calculateStockVariance;
	assert.equal(calculate(11, 10).isHigh, false);
	assert.equal(calculate(12, 10).isHigh, true);
	assert.equal(calculate(60, 0).isHigh, true);
	assert.equal(calculate("", 10), null);
});

test("ADHD-040 computes unique-note packages and first stop", async () => {
	const { sandbox } = load("adhd_delivery_trip.js");
	sandbox.frappe.call = async ({ args }) => {
		assert.deepEqual(Array.from(args.delivery_notes), ["DN-1", "DN-2"]);
		return { message: 7 };
	};
	const stats = await sandbox.erpnext.adhd.computeRouteSummary({
		doc: {
			delivery_stops: [
				{ delivery_note: "DN-1", customer_address: "100 First St" },
				{ delivery_note: "DN-1", customer_address: "200 Second St" },
				{ delivery_note: "DN-2", customer_address: "300 Third St" },
			],
			total_distance: 42,
			uom: "km",
		},
	});
	assert.equal(stats.totalStops, 3);
	assert.equal(stats.totalPackages, 7);
	assert.equal(stats.firstAddress, "100 First St");
	assert.equal(stats.totalDistance, "42 km");
});

test("tickets 034, 037, and 038 use valid server and schema contracts", () => {
	const period = fs.readFileSync(
		path.join(appRoot, "accounts/services/adhd_period_close_check.py"),
		"utf8",
	);
	for (const doctype of ["Journal Entry", "Bank Transaction", "Purchase Invoice", "Sales Invoice"]) {
		assert.match(period, new RegExp(`"${doctype}"`));
	}
	const stock = fs.readFileSync(path.join(appRoot, "stock/adhd.py"), "utf8");
	assert.match(stock, /"Item Reorder"/);
	assert.match(stock, /warehouse_reorder_level/);
	assert.match(stock, /get_batch_qty\(item_code=item_code, warehouse=warehouse, for_stock_levels=True\)/);
	const putaway = readAdhd("adhd_stock_entry.js");
	assert.match(putaway, /"item_code"/);
	assert.doesNotMatch(putaway, /rule\.strategy/);
});

test("ADHD-033 and ADHD-034 expose lifecycle, clear, and refresh integration", () => {
	const accounts = readAdhd("adhd_accounts.js");
	assert.match(accounts, /frappe\.ui\.form\.Form\.prototype\.save/);
	assert.match(accounts, /window\.adhdClearLastUsedDefaults/);
	assert.match(accounts, /frm\.doc\[fieldname\]/);
	assert.match(accounts, /frm\.set_value\(fieldname, last\)/);
	assert.match(readAdhd("adhd_settings.js"), /window\.adhdClearLastUsedDefaults/);
	const monthEnd = readAdhd("adhd_month_end.js");
	assert.match(monthEnd, /get_period_close_readiness/);
	assert.match(monthEnd, /visibilitychange\.adhdReadiness/);
	assert.match(monthEnd, /adhd-recheck-btn/);
});

test("ADHD-037 wraps only batch link controls and preserves the standard fallback", () => {
	const picker = readAdhd("adhd_batch_picker.js");
	assert.match(picker, /this\.df\?\.fieldname !== "batch_no"/);
	assert.match(picker, /originalOpenAdvancedSearch\.apply\(this, args\)/);
	assert.match(picker, /get_available_batches/);
	assert.match(picker, /expiry_date/);
});

test("all new client modules are included in the ERPNext bundle", () => {
	const bundle = fs.readFileSync(path.join(appRoot, "public/js/erpnext.bundle.js"), "utf8");
	for (const module of [
		"adhd_bank_recon",
		"adhd_payment_entry",
		"adhd_stock_entry",
		"adhd_batch_picker",
		"adhd_stock_reconciliation",
		"adhd_delivery_trip",
	]) {
		assert.match(bundle, new RegExp(`./adhd/${module}`));
	}
});
