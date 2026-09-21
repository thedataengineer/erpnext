# ADHD-016: ADHD Settings Panel

## Current implementation record

- **Status:** Implemented.
- **Implementation:** `erpnext/public/js/adhd/adhd_settings.js` stores namespaced local preferences.
- **Verification:** `node --test erpnext/tests/adhd_tickets_011_020.test.js` provides structural coverage; site behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
A per-user settings panel accessible from the ADHD mode toggle lets users enable or disable individual ADHD features without touching system configuration.

## Background / Context
Different ADHD users have different needs: some benefit from the Pomodoro timer but find due-date heat maps distracting; others want field help tooltips but not the persistent form banners. Without per-feature toggles, ADHD mode is all-or-nothing, which reduces its value for heterogeneous teams. The settings panel gives each user fine-grained control stored in their local session so no data leaves their browser.

## Cognitive Mechanism
hyperfocus | attention switching

## Prerequisites
- ADHD mode toggle (shipped) — the settings panel extends the existing toggle button

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_settings.js` — settings panel logic, storage helpers, and public API

**Modify:**
- `erpnext/public/js/adhd/adhd_mode.js` — wire long-press / right-click on the 🧠 toggle to open the settings panel
- `erpnext/public/scss/adhd_mode.scss` — settings panel styles

## What Needs to Be Done

1. **Define the feature registry in `adhd_settings.js`**
   ```js
   export const ADHD_FEATURES = [
     { key: 'pomodoro',          label: 'Pomodoro Timer',            defaultOn: true  },
     { key: 'task_kanban',       label: 'Task Kanban View',          defaultOn: true  },
     { key: 'due_date_heatmap',  label: 'Due-Date Heat Maps',        defaultOn: true  },
     { key: 'timebox_warnings',  label: 'Time-Boxing Warnings',      defaultOn: true  },
     { key: 'form_banners',      label: 'Contextual Form Banners',   defaultOn: true  },
     { key: 'mandatory_wizard',  label: 'Mandatory Field Wizard',    defaultOn: true  },
     { key: 'auto_timelog',      label: 'Auto Time-Log Prompt',      defaultOn: false },
     { key: 'payment_digest',    label: 'Daily Payment Digest',      defaultOn: false },
   ];
   ```

2. **Storage key convention**
   - Namespace: `adhd_setting_{key}` (e.g. `adhd_setting_pomodoro`).
   - Read with `ADHDSettings.get(key)`: `localStorage.getItem('adhd_setting_' + key) ?? feature.defaultOn`.
   - Write with `ADHDSettings.set(key, value)`: `localStorage.setItem('adhd_setting_' + key, value)`.
   - Export `ADHDSettings` as a singleton with `get`, `set`, `reset` (restores all to `defaultOn`) methods.

3. **Render the settings panel as a Frappe Dialog**
   - Create a `frappe.ui.Dialog` with title "🧠 ADHD Mode Settings".
   - Body: a vertical list of toggle rows, one per feature in `ADHD_FEATURES`.
   - Each row: `<div class="adhd-setting-row">` containing:
     - Feature label `<span>`
     - A toggle switch `<input type="checkbox" class="adhd-toggle-switch">` pre-checked from `ADHDSettings.get(key)`
     - On `change`, call `ADHDSettings.set(key, checked)` and emit `frappe.broadcast` event `adhd_setting_changed` with `{ key, value }`.
   - Footer buttons: "Reset to Defaults" (calls `ADHDSettings.reset()` then re-renders toggles), "Done" (closes dialog).

4. **Wire the trigger in `adhd_mode.js`**
   - Locate the existing 🧠 toggle button element.
   - Add a `contextmenu` event listener: `e.preventDefault(); ADHDSettings.openPanel();`
   - Add a long-press listener: set a `setTimeout` of 600 ms on `mousedown`; cancel it on `mouseup`; on timeout fire `ADHDSettings.openPanel()`.
   - Normal click still toggles ADHD mode on/off (existing behaviour unchanged).

5. **Make each ADHD feature respect its setting**
   - Every Phase 2–4 feature's `init*` function should wrap its activation in:
     ```js
     if (!ADHDSettings.get('feature_key')) return;
     ```
   - Listen for `frappe.realtime.on('adhd_setting_changed', ({ key, value }) => { if (key === 'my_feature_key') { value ? activate() : deactivate(); } })` where applicable.

6. **CSS (in `adhd_mode.scss`)**
   - `.adhd-setting-row` — `display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color);`
   - `.adhd-toggle-switch` — style as a pill toggle (use Frappe's existing `.toggle-switch` class if available).

7. **`ADHDSettings.openPanel()` public method**
   - Instantiates and shows the dialog if not already open.
   - If already open, brings it to front.

## How to Test

1. Log in with ADHD mode **enabled**.
2. Right-click the 🧠 toggle button in the navbar. Confirm the "ADHD Mode Settings" dialog opens.
3. Confirm all 8 feature toggles are listed with their default states (6 on, 2 off).
4. Toggle "Pomodoro Timer" off. Close the dialog. Refresh the page. Confirm the Pomodoro timer is no longer visible.
5. Reopen the settings panel (right-click 🧠). Confirm "Pomodoro Timer" is still shown as off (state persisted in localStorage).
6. Long-press the 🧠 button for 600+ ms. Confirm the settings panel opens via long-press too.
7. Normal single-click the 🧠 button. Confirm it still toggles ADHD mode on/off without opening the settings panel.
8. Click "Reset to Defaults" in the panel. Confirm all toggles revert to their default states.
9. Toggle "Payment Digest" on. Close the dialog. Open browser DevTools → Application → Local Storage. Confirm `adhd_setting_payment_digest` is `"true"`.
10. Disable ADHD mode entirely. Confirm the settings panel is still accessible via right-click (settings should be editable regardless of mode state).

## Acceptance Criteria
- [ ] Settings panel opens via right-click or long-press on the 🧠 toggle.
- [ ] All 8 feature toggles are listed with correct labels and default states.
- [ ] Toggle state is persisted in `localStorage` under namespaced keys.
- [ ] State survives page reload.
- [ ] Normal single-click on 🧠 still toggles ADHD mode (no regression).
- [ ] "Reset to Defaults" restores all features to `defaultOn` values.
- [ ] At least one Phase 2–4 feature (e.g. ADHD-011 balance meter) respects its toggle state from this panel.
- [ ] No console errors during panel open, toggle change, or reset.

## Dependencies
- Blocked by: ADHD mode toggle (shipped)
- Blocks: all Phase 2–4 features should add their per-feature `ADHDSettings.get()` guard after this ships
- Related: ADHD-017 (Friction Logger) — opt-in toggle must route through this panel

## Complexity
S — localStorage persistence + Dialog UI; no server-side work.

## Phase
Phase 5 — Personalisation & Observability
