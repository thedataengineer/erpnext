# ADHD-017: Friction Logger — Anonymous Behavioral Signal Collection

## Summary
An opt-in friction logger records anonymised interaction signals (tooltip dwell time, form save duration, skipped wizard steps, command bar usage) to help maintainers understand which ADHD features are actually reducing friction.

## Background / Context
Without usage data, it is impossible to know which ADHD features are helping and which are being ignored. Maintainers currently rely on anecdotal feedback, which skews toward vocal users and misses silent pain points. The friction logger captures objective behavioural signals with zero personally-identifiable information — field names but never values — so the ADHD feature roadmap can be evidence-driven. ADHD users benefit indirectly as the data guides future improvements to features they use most.

## Cognitive Mechanism
(meta-feature — supports all cognitive mechanisms indirectly)

## Prerequisites
- ADHD-016 (ADHD Settings Panel) — the opt-in toggle must be wired through the settings panel before this feature is activated

## Scope
**Create:**
- `erpnext/adhd_usage_log/` — new module directory
  - `erpnext/adhd_usage_log/doctype/adhd_usage_log/adhd_usage_log.json` — DocType definition
  - `erpnext/adhd_usage_log/doctype/adhd_usage_log/adhd_usage_log.py` — controller
  - `erpnext/adhd_usage_log/report/adhd_usage_summary/adhd_usage_summary.py` — private report
  - `erpnext/adhd_usage_log/report/adhd_usage_summary/adhd_usage_summary.json` — report definition
- `erpnext/public/js/adhd/adhd_telemetry.js` — client-side event collection and flush logic

**Modify:**
- `erpnext/public/js/adhd/form_focus.js` — emit tooltip dwell events
- `erpnext/public/js/adhd/adhd_mode.js` — emit form save duration events
- relevant wizard files — emit step-skip events
- `erpnext/hooks.py` — register `adhd_usage_log` as an app module

## What Needs to Be Done

1. **Define the `ADHD Usage Log` DocType**
   Fields (all `Data` or `Int` type; no `Link` to user or party):
   - `event_type` (Data, mandatory) — one of: `tooltip_dwell`, `form_save`, `wizard_skip`, `command_intent`
   - `doctype_name` (Data) — e.g. `"Sales Invoice"` (doctype, not record name)
   - `field_name` (Data) — field name string; `null` for non-field events
   - `duration_ms` (Int) — milliseconds; used for `tooltip_dwell` and `form_save`
   - `step_index` (Int) — wizard step number for `wizard_skip` events
   - `intent` (Data) — command bar intent string for `command_intent` events
   - `session_date` (Date, mandatory) — `frappe.datetime.today()` — no time component
   - Permissions: **no** read/write for any role except System Manager.
   - `in_list_view: 0` for all fields (suppress from list view by default).

2. **Create `adhd_usage_log.py` controller**
   - `ADHDUsageLog` class extending `Document`.
   - Override `before_insert`: validate that `event_type` is one of the four allowed values; raise `frappe.ValidationError` otherwise.
   - Add a whitelisted API function:
     ```python
     @frappe.whitelist()
     def log_adhd_event(event_type, doctype_name=None, field_name=None,
                        duration_ms=None, step_index=None, intent=None):
         if not frappe.db.get_single_value('System Settings', 'adhd_telemetry_enabled'):
             return
         doc = frappe.get_doc({
             'doctype': 'ADHD Usage Log',
             'event_type': event_type,
             'doctype_name': doctype_name,
             'field_name': field_name,
             'duration_ms': cint(duration_ms),
             'step_index': cint(step_index),
             'intent': intent,
             'session_date': today(),
         })
         doc.insert(ignore_permissions=True)
     ```
   - Add a `System Settings` custom field `adhd_telemetry_enabled` (Check, default 0) via Custom Field (not hardcoded migration).

3. **Create `adhd_usage_summary` report**
   - Type: Script Report, restricted to System Manager role.
   - Columns: `event_type`, `doctype_name`, `field_name`, `count` (aggregate), `avg_duration_ms`, `session_date`.
   - Query: `SELECT event_type, doctype_name, field_name, COUNT(*) as count, AVG(duration_ms) as avg_duration_ms, session_date FROM \`tabADHD Usage Log\` GROUP BY event_type, doctype_name, field_name, session_date ORDER BY session_date DESC, count DESC`.

4. **Create `adhd_telemetry.js`**
   - Export `ADHDTelemetry` singleton.
   - `ADHDTelemetry.isEnabled()` — returns `ADHDSettings.get('friction_logger')` (add `friction_logger` key to `ADHD_FEATURES` in ADHD-016 with `defaultOn: false`).
   - `ADHDTelemetry.emit(event)` — if not enabled, no-op. Otherwise push `event` to an internal queue array.
   - Background flush: `setInterval` every 30 seconds calls `flushQueue()`.
   - `flushQueue()` — if queue is empty, no-op. Otherwise call `frappe.call({ method: 'erpnext.adhd_usage_log.doctype.adhd_usage_log.adhd_usage_log.log_adhd_event', args: event })` for each queued item, then clear the queue.
   - On page unload (`window.addEventListener('beforeunload')`), call `flushQueue()` synchronously using `navigator.sendBeacon` if available, otherwise `frappe.call` (best-effort).

5. **Instrument tooltip dwell in `form_focus.js`**
   - On tooltip show: `const t0 = Date.now();`
   - On tooltip hide: `ADHDTelemetry.emit({ event_type: 'tooltip_dwell', doctype_name: frm.doctype, field_name: fieldname, duration_ms: Date.now() - t0 });`
   - Only emit if dwell > 2000 ms (2 seconds).

6. **Instrument form save duration in `adhd_mode.js`**
   - Hook `frappe.ui.form.on('*', { before_save(frm) { frm._adhdSaveStart = Date.now(); } })`.
   - Hook `frappe.ui.form.on('*', { after_save(frm) { ADHDTelemetry.emit({ event_type: 'form_save', doctype_name: frm.doctype, duration_ms: Date.now() - frm._adhdSaveStart }); } })`.

7. **Instrument wizard step skips**
   - In the Employee Onboarding Wizard (ADHD-014) and any other wizard's skip handler, call:
     `ADHDTelemetry.emit({ event_type: 'wizard_skip', doctype_name: STEP.doctype, step_index: currentStepIndex });`

8. **Instrument command bar intents**
   - Hook the command bar's `frappe.search.utils.handle_command` or equivalent event.
   - Emit: `ADHDTelemetry.emit({ event_type: 'command_intent', intent: intentString });`

## How to Test

1. Log in as System Manager. Navigate to **Settings → System Settings**. Confirm a custom field `adhd_telemetry_enabled` (checkbox) exists. Check it.
2. Log in with ADHD mode **enabled**. Open the ADHD Settings Panel. Enable "Friction Logger".
3. Open **Accounts → Sales Invoice → New**. Hover over the `customer` field tooltip for > 2 seconds. Do not dismiss it.
4. Save the Sales Invoice.
5. Wait 30 seconds (or trigger a page navigation).
6. As System Manager, navigate to **Reports → ADHD Usage Summary**. Confirm rows exist for `tooltip_dwell` (field_name = `customer`) and `form_save` (doctype_name = `Sales Invoice`).
7. Confirm the `ADHD Usage Log` DocType list view shows new records (System Manager only).
8. Log in as a non-System-Manager user. Navigate to **ADHD Usage Log** in the URL directly. Confirm access is denied.
9. In **System Settings**, uncheck `adhd_telemetry_enabled`. Repeat steps 3–5. Confirm no new records are written to `ADHD Usage Log`.
10. In ADHD Settings Panel, disable "Friction Logger". Repeat steps 3–5. Confirm no records written even if `adhd_telemetry_enabled` is on (client gate must also block).

## Acceptance Criteria
- [ ] `ADHD Usage Log` DocType exists with all specified fields and System Manager–only permissions.
- [ ] `log_adhd_event` whitelisted Python function inserts records only when `adhd_telemetry_enabled` is on.
- [ ] `before_insert` validation rejects unknown `event_type` values.
- [ ] Client queue flushes every 30 seconds and on page unload.
- [ ] Tooltip dwell events are only emitted for dwells > 2 seconds.
- [ ] `ADHD Usage Summary` report is visible to System Manager and hidden from other roles.
- [ ] No user names, document names, or field values appear anywhere in the logged data.
- [ ] Disabling the client-side toggle prevents any events from being emitted, regardless of server setting.

## Dependencies
- Blocked by: ADHD-016 (settings panel + opt-in toggle)
- Blocks: ADHD-018 (Personalized Focus Suggestions) — may consume aggregated data in future iterations
- Related: ADHD-015 — tooltip dwell instrumentation requires consistent field name keys

## Complexity
M — new DocType, whitelisted API, event queue with flush logic, and instrumentation across multiple JS files.

## Phase
Phase 5 — Personalisation & Observability
