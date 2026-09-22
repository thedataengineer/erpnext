# ADHD Feature Testing

Repository-level Node tests verify helper behavior, module registration, bundle imports, and selected schema contracts. They do not prove Desk rendering, site permissions, mapped-document actions, or RPC results.

## Fast repository checks

Run from the repository root:

```bash
node --test erpnext/tests/adhd_form_wizard.test.js
node --test erpnext/tests/adhd_tickets_011_020.test.js
node --test erpnext/tests/adhd_tickets_031_040.test.js
node --test erpnext/tests/adhd_tickets_041_061.test.js
git diff --check
```

The 031-061 suites execute client modules in a Node VM with Frappe stubs. Treat a pass as contract coverage, not browser acceptance.

## Bench checks

Assistant recipes have Frappe tests:

```bash
bench --site <test-site> run-tests --module erpnext.assistant.test_assistant
bench --site <test-site> run-tests --module erpnext.assistant.test_crm
```

These commands require a working bench, installed app, configured test site, and database services. If those prerequisites are unavailable, record the result as **not run**, not passed.

Build validation also requires the parent bench asset pipeline. `package.json` in this repository only delegates build commands to the `banking` package, so `yarn build` here does not validate `erpnext/public/js/erpnext.bundle.js`.

## Browser harness

`erpnext/public/js/adhd/adhd_test_utils.js` exposes stable controls and fixture factories as `window.adhdTest` only when developer mode, Cypress, or Playwright is detected.

Call `reset()` before each browser test to clear ADHD-owned local storage and deactivate the mode. Fixture helpers insert documents through `frappe.client.insert` and resolve to the created document name.

## Cypress example

```js
it("shows a balanced Journal Entry", () => {
	cy.window().then((window) => window.adhdTest.reset());
	cy.window().then((window) => window.adhdTest.enable());
	cy.window()
		.then((window) => window.adhdTest.fixtures.createJournalEntry())
		.then((name) => cy.visit(`/app/journal-entry/${name}`));
	cy.get("#adhd-balance-meter .adhd-balanced").should("exist");
});
```

Delete fixture documents in `afterEach` with `frappe.client.delete`.

## Playwright example

```js
await page.goto("/app");
await page.evaluate(() => window.adhdTest.reset());
await page.evaluate(() => window.adhdTest.enable());
const taskName = await page.evaluate(() => window.adhdTest.fixtures.createTask());
await page.goto(`/app/task/${taskName}`);
expect(await page.evaluate(() => window.adhdTest.isActive())).toBe(true);
```

## `getState()` contract

Every ADHD class that keeps runtime state must implement `getState()`. The method returns a plain, serializable object with no DOM nodes, functions, circular references, or private record values. Tests should prefer this API over reading implementation properties.

Current state-bearing module names are `adhd_mode`, `focus_panel`, and `task_kanban`. New stateful classes should follow the same serializable contract.

## Wizard abandon behavior

Documents created before an onboarding wizard is abandoned remain in ERPNext. The wizard never deletes business records silently. This is accepted behavior, not a defect.

Browser tests must track each created document and delete it in `afterEach` through `frappe.client.delete`. A failed step should assert that the wizard lists the records created before the failure.

## Adding fixtures

Add fixture factories under `adhdTest.fixtures`. Supply minimal valid defaults, merge caller overrides last, call `frappe.client.insert`, and resolve only the created document name. Tests must remain responsible for cleanup and site-specific linked records.

## Required site-level matrix

Record each result as passed, failed, blocked, or not run:

- Toggle ADHD mode, reload Desk, and confirm bundle modules initialize once.
- Exercise forms, list views, dialogs, and page-level features with realistic permissions.
- Verify whitelisted RPC calls for Accounts, Stock, Manufacturing, Quality, and telemetry.
- Verify mapped-document actions for Sales, Buying, and Subcontracting.
- Confirm local-storage restore and cleanup behavior in a supported browser.
- Confirm reduced-motion behavior and keyboard access.

Known constraints:

- ADHD-038 cannot activate reliably because the current Stock Entry Detail schema lacks the assumed `putaway_rule` field.
- ADHD-045 cannot reach the ticket's Plant Floor card structure in this ERPNext version.
- ADHD-048 uses the parent CRM form because CRM Note is a child DocType.
- ADHD-014 and ADHD-057 through ADHD-059 live in Hubble (the HR app, the `hrms` repository): their Node suites are `hrms/tests/adhd_*.test.js` and their Python suites `hrms/tests/test_adhd_*.py`, run the same rollback-only way.

No site-level acceptance evidence is stored in this repository as of 2026-09-21.
