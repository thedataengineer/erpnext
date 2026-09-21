# ADHD Feature Testing

## Overview

The browser harness exposes stable controls, serializable runtime state, and fixture factories for ADHD features. In developer mode, Cypress, or Playwright, access it through `window.adhdTest`.

Call `reset()` before each browser test to clear ADHD-owned local storage and deactivate the mode. Fixture helpers insert test documents through `frappe.client.insert` and resolve to the created document name.

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

Current module names are `adhd_mode`, `focus_panel`, and `task_kanban`.

## Wizard abandon behavior

Documents created before an onboarding wizard is abandoned remain in ERPNext. The wizard never deletes business records silently. This is accepted behavior, not a defect.

Browser tests must track each created document and delete it in `afterEach` through `frappe.client.delete`. A failed step should assert that the wizard lists the records created before the failure.

## Adding fixtures

Add fixture factories under `adhdTest.fixtures`. Supply minimal valid defaults, merge caller overrides last, call `frappe.client.insert`, and resolve only the created document name. Tests must remain responsible for cleanup and site-specific linked records.
