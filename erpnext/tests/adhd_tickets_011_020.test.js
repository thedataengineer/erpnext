const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const jsRoot = path.resolve(__dirname, "../public/js/adhd");
const read = (name) => fs.readFileSync(path.join(jsRoot, name), "utf8");

test("field help contains exactly eight doctypes and eighty translated entries", () => {
	const context = {
		frappe: { provide() {} },
		erpnext: { adhd: {} },
		window: {},
		__: (text) => text,
	};
	vm.runInNewContext(read("adhd_field_help.js"), context);
	const help = context.erpnext.adhd.FIELD_HELP;
	assert.equal(Object.keys(help).length, 8);
	assert.equal(
		Object.values(help).reduce((count, fields) => count + Object.keys(fields).length, 0),
		80
	);
	for (const fields of Object.values(help)) {
		for (const text of Object.values(fields)) {
			assert.ok(text.trim().split(/\s+/).length <= 15, text);
		}
	}
});

test("balance meter uses the required tolerance and namespaced listener", () => {
	const source = read("adhd_accounts.js");
	assert.match(source, /difference < 0\.001/);
	assert.match(source, /change\.adhdBalanceMeter/);
	assert.match(source, /ADHDSettings\.get\("balance_meter"\)/);
});

test("purchase order status panel exposes lifecycle helpers", () => {
	const source = read("adhd_buying.js");
	assert.match(source, /per_received\) < 100/);
	assert.match(source, /per_billed\) < 100/);
	assert.match(source, /initPurchaseOrderStatusPanel/);
});

test("settings and telemetry remain opt-in and locally persisted", () => {
	const settings = read("adhd_settings.js");
	const telemetry = read("adhd_telemetry.js");
	assert.match(settings, /adhd_setting_/);
	assert.match(settings, /friction_logger.+defaultOn: false/);
	assert.match(telemetry, /setInterval\(.+30000\)/s);
	assert.match(telemetry, /keepalive: true/);
});

test("test harness exposes four fixture factories behind a developer guard", () => {
	const source = read("adhd_test_utils.js");
	for (const fixture of ["createTask", "createSalesInvoice", "createJournalEntry", "createEmployee"]) {
		assert.match(source, new RegExp(`${fixture}\\(`));
	}
	assert.match(source, /frappe\.boot\.developer_mode \|\| window\.Cypress \|\| window\.playwright/);
});
