const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const modulePath = path.join(appRoot, "public/js/adhd/adhd_tickets_041_061.js");

function chain() {
	return new Proxy(
		{ length: 0 },
		{
			get(target, key) {
				if (key in target) return target[key];
				if (key === "val") return () => "";
				if (key === "is") return () => false;
				return () => target;
			},
		},
	);
}

function loadModule() {
	const registrations = [];
	const sandbox = {
		console,
		Date,
		Map,
		Promise,
		Set,
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		clearInterval() {},
		setInterval() {
			return 1;
		},
		localStorage: {
			getItem() {
				return null;
			},
			removeItem() {},
			setItem() {},
		},
		window: { setTimeout },
		$: () => chain(),
		__: (text, values = []) =>
			values.reduce((result, value, index) => result.replace(`{${index}}`, value), text),
		cint: (value) => Number.parseInt(value || 0, 10),
		flt: (value) => Number.parseFloat(value || 0),
		format_currency: (value) => String(value),
		format_number: (value) => String(value),
		erpnext: { adhd: {}, work_order: {} },
		frappe: {
			boot: { adhd_mode: true },
			call: async () => ({ message: 0 }),
			confirm() {},
			datetime: {
				add_days: (value, days) => {
					const date = new Date(`${value}T00:00:00Z`);
					date.setUTCDate(date.getUTCDate() + days);
					return date.toISOString().slice(0, 10);
				},
				get_diff: (later, earlier) =>
					Math.floor((new Date(`${later}T00:00:00Z`) - new Date(`${earlier}T00:00:00Z`)) / 86400000),
				get_today: () => "2026-09-20",
				str_to_user: (value) => value,
			},
			db: { get_list: async () => [], get_value: async () => ({ message: {} }) },
			model: {},
			provide() {},
			ui: { form: { on: (doctype, handlers) => registrations.push({ doctype, handlers }) } },
			utils: { escape_html: (value) => String(value) },
		},
	};
	vm.runInNewContext(fs.readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
	return { registrations, sandbox };
}

test("ADHD-043 uses actual Production Plan quantity fields", () => {
	const { sandbox } = loadModule();
	const summary = sandbox.erpnext.adhd.productionPlanSummary({
		po_items: [
			{ item_code: "A", planned_qty: 2, sales_order: "SO-1", planned_start_date: "2026-09-22" },
			{ item_code: "A", planned_qty: 3, sales_order: "SO-1", planned_start_date: "2026-09-21" },
		],
		mr_items: [{ item_code: "B", quantity: 4, schedule_date: "2026-09-20" }],
	});
	assert.deepEqual(
		{ count: summary.count, salesOrders: summary.salesOrders, qty: summary.qty, date: summary.date },
		{ count: 2, salesOrders: 1, qty: 9, date: "2026-09-20" },
	);
});

test("ADHD-044 elapsed timer preserves hours, minutes, and seconds", () => {
	const { sandbox } = loadModule();
	const start = "2026-09-20T12:00:00.000Z";
	const now = new Date("2026-09-20T13:02:03.000Z").getTime();
	assert.deepEqual(
		{ ...sandbox.erpnext.adhd.elapsedParts(start, now) },
		{ hours: 1, minutes: 2, seconds: 3, totalSeconds: 3723 },
	);
});

test("ADHD-046 classifies overdue and near deadlines", () => {
	const { sandbox } = loadModule();
	assert.equal(sandbox.erpnext.adhd.deadlineState(null, "2026-09-20").tone, "muted");
	assert.equal(sandbox.erpnext.adhd.deadlineState("2026-09-19", "2026-09-20").tone, "danger");
	assert.equal(sandbox.erpnext.adhd.deadlineState("2026-09-27", "2026-09-20").tone, "warning");
	assert.equal(sandbox.erpnext.adhd.deadlineState("2026-09-28", "2026-09-20").tone, "normal");
});

test("ADHD-045 uses Job Card expected_end_date at the exact two-hour boundary", () => {
	const { sandbox } = loadModule();
	const now = new Date("2026-09-20T14:00:00Z").getTime();
	assert.equal(
		sandbox.erpnext.adhd.isBlockedJobCard({ expected_end_date: "2026-09-20T12:00:00Z" }, now),
		false,
	);
	assert.equal(
		sandbox.erpnext.adhd.isBlockedJobCard({ expected_end_date: "2026-09-20T11:59:59Z" }, now),
		true,
	);
});

test("ADHD-048 extracts child-table commitments and calendar dates", () => {
	const { sandbox } = loadModule();
	const result = sandbox.erpnext.adhd.extractCommitment("Client call. I'll send the proposal by Friday.");
	assert.match(result.description, /send the proposal/);
	assert.equal(result.date, "2026-09-25");
	assert.equal(sandbox.erpnext.adhd.extractCommitment("Client approved the budget."), null);
	const crm = fs.readFileSync(path.join(appRoot, "public/js/utils/crm_activities.js"), "utf8");
	assert.equal((crm.match(/attachCommitmentDetector/g) || []).length, 2);
});

test("ADHD-051 tracks response first and uses the 25-percent boundary", () => {
	const { sandbox } = loadModule();
	const doc = {
		creation: "2026-09-20T12:00:00Z",
		response_by: "2026-09-20T16:00:00Z",
		sla_resolution_by: "2026-09-21T12:00:00Z",
	};
	assert.equal(sandbox.erpnext.adhd.slaState(doc, new Date("2026-09-20T15:00:00Z")).tone, "amber");
	assert.equal(sandbox.erpnext.adhd.slaState(doc, new Date("2026-09-20T16:00:01Z")).tone, "red");
	doc.first_responded_on = "2026-09-20T13:00:00Z";
	assert.equal(sandbox.erpnext.adhd.slaState(doc, new Date("2026-09-20T15:00:00Z")).target, doc.sla_resolution_by);
});

test("ADHD-061 derives sent progress from supplied-item schema", () => {
	const { sandbox } = loadModule();
	const partial = sandbox.erpnext.adhd.subcontractingState({
		status: "Open",
		per_received: 0,
		supplied_items: [{ required_qty: 10, supplied_qty: 5 }],
	});
	assert.equal(partial.index, 1);
	assert.equal(partial.sentPercent, 50);
	assert.equal(
		sandbox.erpnext.adhd.subcontractingState(
			{ status: "Open", per_received: 0, supplied_items: [{ required_qty: 10, supplied_qty: 10 }] },
			1,
		).index,
		3,
	);
});

test("forms in the safe in-repo scope are registered", () => {
	const { registrations } = loadModule();
	const doctypes = new Set(registrations.map((entry) => entry.doctype));
	for (const doctype of [
		"BOM",
		"Work Order",
		"Production Plan",
		"Job Card",
		"Project",
		"Timesheet",
		"CRM Note",
		"Opportunity",
		"Task",
		"Issue",
		"Warranty Claim",
		"Purchase Invoice",
		"Asset Capitalization",
		"Purchase Receipt",
		"Delivery Note",
		"Stock Entry",
		"Subcontracting Order",
	]) {
		assert.ok(doctypes.has(doctype), `${doctype} registration missing`);
	}
});

test("BOM endpoint enforces permissions, cycle detection, and a depth cap", () => {
	const source = fs.readFileSync(
		path.join(appRoot, "manufacturing/services/adhd_bom_ancestry.py"),
		"utf8",
	);
	assert.match(source, /@frappe\.whitelist\(\)/);
	assert.match(source, /frappe\.has_permission\("BOM", "read"/);
	assert.match(source, /visited = \{bom_name\}/);
	assert.match(source, /min\(max\(cint\(max_depth\), 0\), 10\)/);
});

test("ADHD-051 and ADHD-055 use current Issue and Asset schema fields", () => {
	const source = fs.readFileSync(path.join(appRoot, "public/js/adhd/adhd_list_view.js"), "utf8");
	assert.match(source, /Issue: "sla_resolution_by"/);
	assert.match(source, /Asset: "next_depreciation_date"/);
	assert.match(source, /remaining \/ windowMs <= 0\.25/);
	assert.match(source, /days <= 7/);
	assert.match(source, /days <= 30/);
	assert.match(source, /setInterval\(\(\) => applyHeat\(listview\), 60000\)/);
});

test("ADHD-060 batches QI summaries and rejected reading counts", () => {
	const source = fs.readFileSync(path.join(appRoot, "stock/adhd_quality.py"), "utf8");
	assert.match(source, /get_quality_inspection_summaries/);
	assert.match(source, /"Quality Inspection Reading"/);
	assert.match(source, /"status": "Rejected"/);
	assert.match(source, /"docstatus"/);
	assert.match(fs.readFileSync(modulePath, "utf8"), /erpnext\.stock\.adhd_quality\.get_quality_inspection_summaries/);
});

test("bundle includes the ticket module", () => {
	const bundle = fs.readFileSync(path.join(appRoot, "public/js/erpnext.bundle.js"), "utf8");
	assert.match(bundle, /\.\/adhd\/adhd_tickets_041_061/);
});
