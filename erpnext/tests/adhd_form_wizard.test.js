const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.resolve(__dirname, "../public/js/adhd/adhd_form_wizard.js"), "utf8");

test("guided save intercepts the Form save method", () => {
	assert.match(source, /frappe\.ui\.form\.Form\.prototype\.save\s*=/);
	assert.match(source, /originalSave\.apply\(this, args\)/);
});

test("guided save excludes hidden and child-table fields", () => {
	assert.match(source, /!df\.hidden/);
	assert.match(source, /df\.fieldtype !== "Table"/);
});

test("guided save cleans field listeners and supports all actions", () => {
	assert.match(source, /removeEventListener\("change", changeHandler\)/);
	assert.match(source, /adhd-wizard-next/);
	assert.match(source, /adhd-wizard-skip/);
	assert.match(source, /adhd-wizard-cancel/);
});

test("guided save displays and updates progress", () => {
	assert.match(source, /adhd-wizard-progress/);
	assert.match(source, /index \+ 1, fields\.length/);
});
