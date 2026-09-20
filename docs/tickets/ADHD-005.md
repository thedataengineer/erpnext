# ADHD-005: Keyboard Shortcut Reference Panel

## Summary
A searchable modal panel, triggered by `Alt+?`, that lists all ADHD-mode custom shortcuts plus the top 20 native ERPNext shortcuts grouped by context, giving users instant in-app access to the keyboard vocabulary without needing external documentation.

## Background / Context
ADHD users are often strong candidates for keyboard-driven workflows — shortcuts reduce mouse hunting and decision overhead. But discovering and memorising shortcuts has a high upfront cost that prevents adoption. Without an in-app reference, shortcuts that are learned in one session are forgotten before the next. The `Alt+?` panel provides a zero-friction, always-available cheat sheet that reinforces the habit loop without requiring the user to leave the application or consult external docs.

## Cognitive Mechanism
Working memory | initiation

## Prerequisites
- ADHD mode toggle (`adhd_mode.js`, Phase 1) must be active. The panel should be visible only when ADHD mode is on (to avoid cluttering standard desks), but the `Alt+?` listener registers regardless and shows an "Enable ADHD mode to unlock custom shortcuts" message when mode is off.

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_help.js`

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-help-modal-*` styles
- `erpnext/hooks.py` — include `adhd_help.js` in `app_include_js`

## What Needs to Be Done

1. **Define the shortcut registry.** At the top of `adhd_help.js`, define a `SHORTCUTS` array of objects:
   ```js
   const SHORTCUTS = [
     // ADHD Mode shortcuts
     { context: "ADHD Mode", key: "Alt+?",     description: "Open this shortcut reference" },
     { context: "ADHD Mode", key: "Alt+F",     description: "Open Focus Panel / Pomodoro timer" },
     { context: "ADHD Mode", key: "Alt+N",     description: "Open command bar (new document / action)" },
     { context: "ADHD Mode", key: "Alt+R",     description: "Resume — jump to last edited document" },
     // Global ERPNext shortcuts
     { context: "Global",    key: "Ctrl+G",    description: "Open Awesomebar (go to any module)" },
     { context: "Global",    key: "Ctrl+S",    description: "Save current document" },
     { context: "Global",    key: "Ctrl+E",    description: "Toggle Edit mode" },
     { context: "Global",    key: "Ctrl+/",    description: "Focus global search" },
     // List View
     { context: "List View", key: "Ctrl+N",    description: "New document from list" },
     { context: "List View", key: "Shift+↑/↓", description: "Select multiple rows" },
     { context: "List View", key: "Ctrl+A",    description: "Select all visible rows" },
     { context: "List View", key: "Delete",    description: "Delete selected rows (with confirmation)" },
     // Form View
     { context: "Form",      key: "Ctrl+S",    description: "Save" },
     { context: "Form",      key: "Ctrl+Z",    description: "Discard unsaved changes" },
     { context: "Form",      key: "Alt+→",     description: "Next document in list" },
     { context: "Form",      key: "Alt+←",     description: "Previous document in list" },
     { context: "Form",      key: "F5",        description: "Reload / refresh document" },
   ];
   ```
   Add any additional shortcuts already registered by `adhd_mode.js`.

2. **Register the `Alt+?` global listener.**
   ```js
   document.addEventListener("keydown", (e) => {
     if (e.altKey && e.key === "?") {
       e.preventDefault();
       openHelpModal();
     }
   });
   ```

3. **Build `openHelpModal()`.** Check if a `.adhd-help-modal` element already exists in the DOM; if so, focus its search input and return (toggle pattern). Otherwise:
   - Create a modal overlay `<div class="adhd-help-modal-overlay">` covering the full viewport.
   - Inside it, render `<div class="adhd-help-modal">` with:
     - A header: "Keyboard Shortcuts" + an × close button.
     - A `<input class="adhd-help-search" type="search" placeholder="Search shortcuts…">`.
     - A `<div class="adhd-help-list">` populated by `renderShortcuts(SHORTCUTS)`.
   - Append to `document.body`.
   - Focus the search input.

4. **`renderShortcuts(shortcuts)`.** Group by `context` and render:
   ```html
   <div class="adhd-help-group">
     <h3 class="adhd-help-group-title">[Context Name]</h3>
     <table class="adhd-help-table">
       <tr><td class="adhd-help-key"><kbd>Alt+?</kbd></td><td>Open this shortcut reference</td></tr>
       ...
     </table>
   </div>
   ```
   Each key combination should be wrapped in `<kbd>` tags.

5. **Live search.** Add an `input` listener to the search box. On each keystroke, filter `SHORTCUTS` where `key` or `description` contains the search term (case-insensitive). Re-render the list with only matching entries. If no matches: show "No shortcuts match '[term]'".

6. **Dismiss on `Escape` or overlay click.** Add a `keydown` listener on the modal for `Escape`. Add a `click` listener on the overlay that dismisses when the click target is the overlay itself (not the modal box). Both remove the `.adhd-help-modal-overlay` element from the DOM.

7. **CSS in `adhd_mode.scss`:**
   - `.adhd-help-modal-overlay` — `position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 2000; display: flex; align-items: center; justify-content: center;`
   - `.adhd-help-modal` — `background: var(--card-bg); border-radius: 8px; width: min(720px, 90vw); max-height: 80vh; overflow-y: auto; padding: 24px; box-shadow: var(--shadow-lg);`
   - `.adhd-help-search` — `width: 100%; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 4px; margin-bottom: 16px; font-size: 0.95rem;`
   - `.adhd-help-key kbd` — `background: var(--subtle-fg); border: 1px solid var(--border-color); border-radius: 3px; padding: 1px 5px; font-family: monospace; font-size: 0.85rem;`
   - `.adhd-help-group-title` — `font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin: 12px 0 4px;`

8. **ADHD mode messaging.** If `!frappe.boot.adhd_mode`, prepend a banner inside the modal: "Enable ADHD Mode in User Settings to unlock ADHD-specific shortcuts."

## How to Test

1. Enable ADHD mode. Open any ERPNext page. Press `Alt+?`. Confirm the shortcut reference modal opens.
2. Confirm shortcuts are grouped by context (ADHD Mode, Global, List View, Form).
3. Confirm `<kbd>` tags render correctly (pill-style styling around key combinations).
4. Type "save" in the search box. Confirm only shortcuts whose key or description contains "save" appear.
5. Clear the search. Confirm all shortcuts reappear.
6. Type "xyzzy" in the search. Confirm "No shortcuts match 'xyzzy'" message appears.
7. Press `Escape`. Confirm the modal closes.
8. Open the modal again. Click outside the modal box (on the overlay). Confirm it closes.
9. Press `Alt+?` while the modal is already open. Confirm focus jumps to the search input (doesn't open a second modal).
10. Disable ADHD mode. Press `Alt+?`. Confirm the modal opens but shows the "Enable ADHD Mode" banner. Confirm ADHD Mode shortcuts are still listed (for discoverability) but the banner is visible.

## Acceptance Criteria
- [ ] `Alt+?` opens the modal from any ERPNext page.
- [ ] Shortcuts are grouped by context: ADHD Mode, Global, List View, Form.
- [ ] All key combinations are rendered inside `<kbd>` elements.
- [ ] The search input filters shortcuts in real time by key or description.
- [ ] An empty-search state message appears when no shortcuts match the query.
- [ ] `Escape` closes the modal.
- [ ] Clicking the overlay (outside the modal box) closes the modal.
- [ ] Pressing `Alt+?` when the modal is open focuses the search input rather than opening a duplicate.
- [ ] When ADHD mode is disabled, the modal opens but displays the "Enable ADHD Mode" prompt banner.
- [ ] No console errors on modal open, search, or close.

## Dependencies
- **Blocked by:** ADHD mode toggle (Phase 1, shipped)
- **Blocks:** None — self-contained discoverability aid

## Complexity
S — Pure client-side UI; no server calls; straightforward DOM manipulation and keyboard event handling.

## Phase
Phase 2 — Core Workflow Clarity
