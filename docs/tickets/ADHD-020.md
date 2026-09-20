# ADHD-020: Contributor Toolkit — ADHD Feature Test Harness

## Summary
A dedicated test harness provides fixture helpers, enable/disable utilities, and `getState()` introspection methods so contributors can write reliable automated and manual tests for all ADHD features.

## Background / Context
As the ADHD feature set grows across phases, each feature is tested in isolation by its author with no shared conventions. Without a harness, tests are hard to write, break silently when features interact, and reviewers cannot verify behaviour from the outside. ADHD features are client-heavy (DOM manipulation, localStorage, event hooks) and particularly difficult to test without a structured way to inspect internal state. This ticket establishes the shared infrastructure all future ADHD feature tests depend on.

## Cognitive Mechanism
(meta-feature — enables verification of all cognitive mechanism implementations)

## Prerequisites
- All Phase 1 ADHD files (shipped) — the harness wraps existing classes; they must exist

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_test_utils.js` — test harness public API
- `docs/adhd_testing.md` — contributor documentation

**Modify:**
- `erpnext/public/js/adhd/adhd_mode.js` — add `getState()` method to `ADHDMode`
- `erpnext/public/js/adhd/focus_panel.js` — add `getState()` method to `FocusPanel`
- `erpnext/public/js/adhd/task_kanban.js` — add `getState()` method to `TaskKanban`
- Any other Phase 1–4 ADHD class that holds meaningful internal state

## What Needs to Be Done

1. **Create `adhd_test_utils.js` — public API**
   Export `erpnext.adhd.test` as a namespace object with these methods:

   ```js
   export const adhdTest = {
     enable()  { window.ADHDMode?.activate(); },
     disable() { window.ADHDMode?.deactivate(); },
     reset()   {
       // Clears all adhd_* localStorage keys for the current user
       Object.keys(localStorage)
         .filter(k => k.startsWith('adhd_'))
         .forEach(k => localStorage.removeItem(k));
       window.ADHDMode?.deactivate();
     },
     isActive() { return window.ADHDMode?.isActive() ?? false; },
     getModuleState(moduleName) {
       // Returns the getState() result for a named ADHD module
       const modules = {
         adhd_mode:   window.ADHDMode,
         focus_panel: window.FocusPanel,
         task_kanban: window.TaskKanban,
       };
       return modules[moduleName]?.getState() ?? null;
     },
     fixtures: {
       createTask(overrides = {}) { /* see step 3 */ },
       createSalesInvoice(overrides = {}) { /* see step 3 */ },
       createJournalEntry(overrides = {}) { /* see step 3 */ },
       createEmployee(overrides = {}) { /* see step 3 */ },
     }
   };

   // Attach to global for Cypress / Playwright access
   if (typeof window !== 'undefined') window.adhdTest = adhdTest;
   ```

2. **Add `getState()` to `ADHDMode` (`adhd_mode.js`)**
   ```js
   getState() {
     return {
       isActive:          this._active,
       enabledSettings:   Object.fromEntries(
                            ADHD_FEATURES.map(f => [f.key, ADHDSettings.get(f.key)])
                          ),
       pomodoroRunning:   this._pomodoro?.isRunning() ?? false,
       currentForm:       cur_frm?.doctype ?? null,
     };
   }
   ```

3. **Add `getState()` to `FocusPanel` (`focus_panel.js`)**
   ```js
   getState() {
     return {
       isOpen:      this._isOpen,
       activeTab:   this._activeTab,
       taskCount:   this._tasks?.length ?? 0,
     };
   }
   ```

4. **Add `getState()` to `TaskKanban` (`task_kanban.js`)**
   ```js
   getState() {
     return {
       columns:    this._columns.map(c => ({ name: c.name, cardCount: c.cards.length })),
       dragActive: this._dragging,
     };
   }
   ```

5. **Implement fixture helpers in `adhd_test_utils.js`**
   Each helper calls `frappe.call('frappe.client.insert', { doc: { ... } })` and resolves with the created doc name. Provide minimal valid defaults, allow `overrides`:
   - `createTask(overrides)`:
     ```js
     { doctype: 'Task', subject: 'ADHD Test Task', status: 'Open',
       exp_end_date: frappe.datetime.add_days(frappe.datetime.today(), 3),
       ...overrides }
     ```
   - `createSalesInvoice(overrides)`:
     ```js
     { doctype: 'Sales Invoice', customer: '__Test Customer', posting_date: frappe.datetime.today(),
       items: [{ item_code: '__Test Item', qty: 1, rate: 100 }], ...overrides }
     ```
   - `createJournalEntry(overrides)`:
     ```js
     { doctype: 'Journal Entry', voucher_type: 'Journal Entry',
       posting_date: frappe.datetime.today(),
       accounts: [
         { account: '__Test Account AR - _TC', debit_in_account_currency: 100 },
         { account: '__Test Account AP - _TC', credit_in_account_currency: 100 },
       ], ...overrides }
     ```
   - `createEmployee(overrides)`:
     ```js
     { doctype: 'Employee', first_name: 'ADHD', last_name: 'Test', company: frappe.boot.user_info.default_company,
       date_of_joining: frappe.datetime.today(), gender: 'Male', employment_type: 'Full-time', ...overrides }
     ```
   All helpers return a `Promise<string>` (resolved with the new doc's `name`).

6. **Expose `adhdTest` conditionally**
   - Wrap the global assignment:
     ```js
     if (frappe.boot.developer_mode || window.Cypress || window.playwright) {
       window.adhdTest = adhdTest;
     }
     ```
   - In production without developer mode, the harness is still bundled (for browser console debugging) but not auto-attached.

7. **Write `docs/adhd_testing.md`**
   Include the following sections:
   - **Overview** — what the test harness provides and why it exists
   - **Cypress example**:
     ```js
     it('balance meter shows balanced after equal debit/credit', () => {
       cy.window().then(w => w.adhdTest.enable());
       cy.visit('/app/journal-entry/new-journal-entry-1');
       cy.window().then(w => w.adhdTest.fixtures.createJournalEntry());
       cy.get('#adhd-balance-meter .adhd-balanced').should('exist');
     });
     ```
   - **Playwright example**
   - **Convention: `getState()` contract** — every ADHD class that holds runtime state must implement `getState()` returning a plain serialisable object; no DOM elements, no functions.
   - **Acceptable behaviour on wizard abandon** — documents created in a partial wizard run are not automatically rolled back; contributors should document this in the wizard's own ticket and handle cleanup in tests by calling `frappe.call('frappe.client.delete', ...)` in `afterEach`.
   - **Adding new fixtures** — how to extend `adhd_test_utils.fixtures`.

8. **Bundle inclusion**
   - Add `adhd_test_utils.js` to `hooks.py` under `app_include_js` behind a `if frappe.conf.developer_mode` guard, or include unconditionally and rely on the conditional global attachment in step 6.

## How to Test

1. In a development ERPNext instance, open the browser console on any page.
2. Confirm `window.adhdTest` is defined (requires developer mode or Cypress/Playwright context).
3. Run `adhdTest.enable()`. Confirm ADHD mode activates (🧠 toggle lights up).
4. Run `adhdTest.getModuleState('adhd_mode')`. Confirm it returns an object with `isActive: true`.
5. Run `adhdTest.disable()`. Confirm ADHD mode deactivates.
6. Run `adhdTest.fixtures.createTask()`. Confirm a Promise is returned; await it and confirm a Task document was created (check via **Projects → Tasks**).
7. Run `adhdTest.reset()`. Confirm all `adhd_*` localStorage keys are removed (verify in DevTools → Application → Local Storage) and ADHD mode is off.
8. Navigate to a Journal Entry form with ADHD mode on. Run `adhdTest.getModuleState('adhd_mode')`. Confirm `currentForm` is `"Journal Entry"`.
9. Open `docs/adhd_testing.md`. Confirm all four documented sections are present and the Cypress example references `adhdTest.enable()` and `adhdTest.fixtures.createJournalEntry()`.
10. Run the Cypress example snippet (modified to match a real item/account in the test site). Confirm it passes.

## Acceptance Criteria
- [ ] `window.adhdTest` is available in developer mode / Cypress / Playwright contexts.
- [ ] `adhdTest.enable()` and `.disable()` toggle ADHD mode reliably.
- [ ] `adhdTest.reset()` clears all `adhd_*` localStorage keys and deactivates ADHD mode.
- [ ] `adhdTest.getModuleState('adhd_mode')` returns a plain object with `isActive`, `enabledSettings`, `pomodoroRunning`, `currentForm`.
- [ ] `adhdTest.getModuleState('focus_panel')` returns a plain object with `isOpen`, `activeTab`, `taskCount`.
- [ ] `adhdTest.getModuleState('task_kanban')` returns a plain object with `columns` array and `dragActive`.
- [ ] All four fixture helpers create documents and resolve with the new doc name.
- [ ] `getState()` methods return serialisable plain objects (no DOM refs, no functions).
- [ ] `docs/adhd_testing.md` covers all four required sections including wizard-abandon acceptable behaviour.
- [ ] No runtime errors when harness is loaded in a production build (conditional global guard prevents attachment).

## Dependencies
- Blocked by: all Phase 1 ADHD files (shipped); the harness wraps existing classes
- Blocks: all future ADHD automated tests
- Related: ADHD-014 (Wizard) — documents wizard-abandon behaviour convention in `adhd_testing.md`

## Complexity
M — requires coordinated changes across multiple JS classes to add `getState()`, plus new documentation.

## Phase
Phase 5 — Personalisation & Observability
