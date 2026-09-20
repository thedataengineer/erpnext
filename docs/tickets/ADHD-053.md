# ADHD-053: Issue Reply Draft Autosave

## Summary
Autosave a support agent's in-progress reply on an Issue to localStorage every 20 seconds and offer to restore it if the agent returns after navigating away, preventing catastrophic loss of composed text.

## Background / Context
An ADHD support agent composing a detailed reply to a customer can be pulled away mid-sentence by a notification, a colleague, or a hyperfocus derail. ERPNext's reply composer has no autosave — closing the tab or navigating to another form discards everything typed. Returning to the Issue and finding the reply box empty triggers significant RSD and often means the reply never gets sent. The friction point is the Communication/Reply panel on the Issue form.

## Cognitive Mechanism
Working memory | RSD (rejection-sensitive dysphoria) | Initiation

## Prerequisites
- ADHD mode toggle (shipped)

## Scope
Files to create or modify:
- **Create** `erpnext/support/doctype/issue/adhd_issue_reply_autosave.js`

## What Needs to Be Done

1. **Create `adhd_issue_reply_autosave.js`**. Guard the entire file with `if (!frappe.boot.adhd_mode) return;` at the top.

2. **Register `frappe.ui.form.on('Issue', { refresh(frm) { ... } })`**. On each refresh, call `initReplyAutosave(frm)`.

3. **`initReplyAutosave(frm)`**:
   a. Clear any previous interval stored at `frm._adhdReplyAutosaveInterval`.
   b. Determine the storage key: `const key = \`adhd_issue_reply_${frm.doc.name}\``.
   c. Check `localStorage.getItem(key)`. If a value exists, call `showRestoreBanner(frm, key)`.
   d. Hook into the reply textarea. The ERPNext reply box is rendered inside `.reply-area` or a `frappe-comment` widget that may be lazy-rendered. Use a MutationObserver on `.form-page` to detect when `.reply-area textarea` appears, then attach the autosave logic once the element is found.
   e. Once the textarea is found, start a `setInterval` of 20 000 ms:
      - Read `textarea.value`. If non-empty, `localStorage.setItem(key, JSON.stringify({ text: textarea.value, savedAt: new Date().toISOString() }))`.
      - If empty, remove the key.
   f. Store the interval at `frm._adhdReplyAutosaveInterval`.

4. **`showRestoreBanner(frm, key)`**:
   a. Parse the stored value: `const { text, savedAt } = JSON.parse(localStorage.getItem(key))`.
   b. Format `savedAt` with `frappe.datetime.prettyDate(savedAt)` or `moment(savedAt).fromNow()`.
   c. Build HTML:
      ```html
      <div id="adhd-reply-restore" style="...">
        📝 You have an unsaved reply draft from {timeAgo}.
        <button id="adhd-restore-btn">Restore</button>
        <button id="adhd-discard-btn">Discard</button>
      </div>
      ```
   d. Inject above the reply area. Use `frm.dashboard.set_headline_alert(html)` or prepend to `.form-body`.
   e. Bind `#adhd-restore-btn` click:
      - Wait for the textarea to appear (use the same MutationObserver logic).
      - Set `textarea.value = text` and trigger an `input` event so ERPNext's internal state is aware.
      - Remove the banner and remove the localStorage key.
   f. Bind `#adhd-discard-btn` click:
      - `localStorage.removeItem(key)`.
      - Remove the banner.

5. **Cleanup on navigation**: in a `frappe.router.on('change', ...)` listener, call `clearInterval(frm._adhdReplyAutosaveInterval)` and disconnect the MutationObserver.

6. **Do NOT save**: the autosave is to `localStorage` only. Never auto-submit or auto-save the ERPNext document.

7. **Bundle**: add `adhd_issue_reply_autosave.js` to `hooks.py` under `doctype_js["Issue"]` (append alongside `adhd_issue.js` from ADHD-051 if that ticket is also in scope).

## How to Test

1. Enable ADHD mode. Open **Support → Issue** on an existing open Issue.
2. Click **Reply**. Type a multi-sentence reply in the reply textarea. Wait 20 seconds.
3. Open the browser's DevTools → Application → localStorage. Confirm a key `adhd_issue_reply_{issue_name}` exists with the typed text and a timestamp.
4. Navigate to the ERPNext desk home. Return to the same Issue.
5. Confirm a yellow/amber banner appears: "📝 You have an unsaved reply draft from X seconds/minutes ago. Restore | Discard".
6. Click **Restore**. Confirm the reply textarea is populated with the previously typed text.
7. Clear the textarea. Wait 20 seconds. Confirm the localStorage key is removed.
8. Repeat step 2–4. Click **Discard**. Confirm the banner disappears and localStorage key is removed.
9. Disable ADHD mode. Open the Issue. Confirm no banner and no autosave interval runs.
10. Open the Issue in a second browser tab. Confirm the draft from the first tab restores correctly (both read the same localStorage key).

## Acceptance Criteria
- [ ] Reply text is saved to `localStorage` under `adhd_issue_reply_{docname}` within 20 seconds of typing.
- [ ] Returning to the Issue shows a restore banner if a draft exists.
- [ ] "Restore" populates the reply textarea with the saved text.
- [ ] "Discard" removes the banner and clears the localStorage key.
- [ ] Empty textarea removes the localStorage key on the next autosave tick.
- [ ] No interval leak across navigations.
- [ ] Feature is entirely absent when ADHD mode is off.
- [ ] No JS errors when the reply area is not yet rendered on form load.

## Dependencies
- Blocks: none
- Blocked by: none (ADHD mode toggle already shipped)

## Complexity
S — localStorage read/write, MutationObserver, and a setInterval; no server-side code.

## Phase
Phase 7 — Module-by-Module Expansion
