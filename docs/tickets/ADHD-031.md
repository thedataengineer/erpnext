# ADHD-031: Bank Reconciliation Progress Saver

## Summary
When ADHD mode is active on the Bank Reconciliation Tool, persist the current reconciliation session (bank account, date range, and all checked-off transaction IDs) to localStorage and automatically restore it on next page load — so a user interrupted mid-reconciliation never loses their place.

## Background / Context
Bank reconciliation is one of the most cognitively expensive tasks in ERPNext: it requires holding a running mental tally of which transactions have been matched while scrolling through a long list. ADHD users are highly vulnerable to interruption (a phone call, a browser tab switch, a hyperfocus break), and returning to a half-finished reconciliation with no visible progress marker typically means starting over. The friction lives on the Bank Reconciliation Tool page (`/app/bank-reconciliation-tool`), specifically in the flat transaction list that renders with no saved state between sessions.

## Cognitive Mechanism
Working memory | attention switching | initiation

## Prerequisites
- ADHD mode toggle (Phase 1, `public/js/adhd/adhd_mode.js`) must be shipped and `frappe.boot.adhd_mode` must be readable.
- No backend changes required — the page already loads all transactions on render.

## Scope
**Create:**
- `erpnext/accounts/page/bank_reconciliation/adhd_bank_recon.js`

**No modifications** to existing files are required; the new file is loaded via a `frappe.pages["bank-reconciliation-tool"].on_page_load` hook registered inside the file itself.

## What Needs to Be Done

1. **Guard behind ADHD mode.** At the very top of every exported function:
   ```js
   if (!frappe.boot.adhd_mode) return;
   ```

2. **Build the localStorage key.** After the page renders and the `bank_account`, `from_date`, and `to_date` filter values are populated, compute:
   ```js
   const storageKey = () => {
     const ba   = $('[data-fieldname="bank_account"] input').val() || "";
     const from = $('[data-fieldname="from_date"] input').val()    || "";
     const to   = $('[data-fieldname="to_date"] input').val()      || "";
     return `adhd_bank_recon_${ba}_${from}`;   // from_date is the discriminator; to_date
                                                 // can shift without invalidating matched txns
   };
   ```

3. **Save state on checkbox change.** The Bank Reconciliation Tool renders a checkbox per transaction row. Attach a delegated event listener on the transactions container:
   ```js
   $(document).on("change", ".bank-reconciliation-tool .transaction-checkbox", function () {
     const key = storageKey();
     if (!key.endsWith("__")) saveState(key);
   });

   function saveState(key) {
     const checked = [];
     $(".bank-reconciliation-tool .transaction-checkbox:checked").each(function () {
       checked.push($(this).data("name") || $(this).closest("tr").data("name"));
     });
     localStorage.setItem(key, JSON.stringify({
       savedAt: new Date().toISOString(),
       checkedIds: checked,
       total: $(".bank-reconciliation-tool .transaction-checkbox").length,
     }));
   }
   ```

4. **Restore state on page load.** Hook into the page's `refresh` event (or `frappe.pages["bank-reconciliation-tool"].on_page_show`). After a 400 ms debounce (to allow the transaction list to fully render):
   ```js
   setTimeout(() => {
     const key = storageKey();
     const raw = localStorage.getItem(key);
     if (!raw) return;
     const state = JSON.parse(raw);
     let restored = 0;
     state.checkedIds.forEach(id => {
       const $cb = $(`.bank-reconciliation-tool [data-name="${id}"] .transaction-checkbox,
                      .bank-reconciliation-tool tr[data-name="${id}"] .transaction-checkbox`);
       if ($cb.length) { $cb.prop("checked", true); restored++; }
     });
     if (restored > 0) showResumeBanner(state, restored);
   }, 400);
   ```

5. **Render the resume banner.** `showResumeBanner(state, restored)`:
   - Build a `<div id="adhd-recon-banner">` with classes `alert alert-info` and inline style `margin: 8px 16px; display: flex; justify-content: space-between; align-items: center;`.
   - Left text: `"Resumed your reconciliation session from [formatted time]. ${restored} of ${state.total} transactions matched."`
   - Format time: `new Date(state.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`.
   - Right side: a plain `<a>` styled link labeled "Clear saved session" which calls `localStorage.removeItem(key)` and removes the banner from the DOM.
   - Prepend the banner inside `.bank-reconciliation-tool` above the transactions table. Check for `#adhd-recon-banner` first and remove it before inserting to prevent duplicates.

6. **Clear stale state on successful reconciliation.** Listen for the success callback that ERPNext fires after reconciliation completes. The existing tool calls `frappe.show_alert` with a success message; intercept via:
   ```js
   const _origAlert = frappe.show_alert.bind(frappe);
   frappe.show_alert = function (opts, ...rest) {
     if (typeof opts === "object" && opts.indicator === "green") {
       localStorage.removeItem(storageKey());
     }
     return _origAlert(opts, ...rest);
   };
   ```
   Restore `frappe.show_alert` to its original value on page hide via `frappe.pages["bank-reconciliation-tool"].on_page_hide`.

7. **Register the module.** Inside `adhd_bank_recon.js`, wrap all initialisation in:
   ```js
   frappe.pages["bank-reconciliation-tool"].on_page_show = (function (original) {
     return function (wrapper) {
       if (original) original.call(this, wrapper);
       initAdhdBankRecon();
     };
   })(frappe.pages["bank-reconciliation-tool"].on_page_show);
   ```
   Also include the file in `erpnext/hooks.py` under `page_js`:
   ```python
   page_js = {
       "bank-reconciliation-tool": "public/js/adhd/adhd_bank_recon.js"
   }
   ```
   (Move the file to `public/js/adhd/adhd_bank_recon.js` if hooks.py's `page_js` path convention requires it.)

## How to Test

1. Open a fresh ERPNext desk with ADHD mode enabled.
2. Navigate to **Accounts → Bank Reconciliation Tool**.
3. Select a `bank_account`, `from_date`, and `to_date` that return at least 5 transactions. Click **Get Data**.
4. Check 3 of the transaction checkboxes. Open DevTools → Application → Local Storage and confirm a key matching `adhd_bank_recon_<account>_<from_date>` exists with a JSON payload containing the 3 checked IDs.
5. Navigate away (e.g., open the Accounts module home). Then navigate back to Bank Reconciliation Tool and re-enter the **same** bank account and date range.
6. Confirm the 3 previously checked boxes are automatically re-checked after the list loads.
7. Confirm the yellow/blue resume banner appears above the transaction list with text matching "Resumed your reconciliation session from [time]. 3 of 5 transactions matched."
8. Click "Clear saved session" in the banner. Confirm the banner disappears and the localStorage key is removed (verify in DevTools).
9. Reload the page. Confirm no banner appears and no boxes are pre-checked (state was cleared).
10. Disable ADHD mode. Repeat steps 3–4. Confirm no localStorage key is written and no banner ever appears.

## Acceptance Criteria
- [ ] Checking a transaction writes the updated ID list to `localStorage` under the correct key immediately.
- [ ] Navigating back to the same bank account + date range automatically restores all previously checked transactions.
- [ ] Resume banner displays with accurate time, count of matched transactions, and total count.
- [ ] "Clear saved session" link removes the localStorage key and the banner from the DOM.
- [ ] State is automatically cleared after a successful reconciliation completes.
- [ ] No banner or localStorage writes occur when ADHD mode is disabled.
- [ ] No duplicate banners appear after multiple page shows.
- [ ] No JavaScript console errors on the Bank Reconciliation Tool page.

## Dependencies
- **Blocks:** Nothing downstream in the current roadmap.
- **Blocked by:** ADHD mode toggle (Phase 1, already shipped); ADHD-001 (chain navigator, for context on file conventions).

## Complexity
S — Pure client-side localStorage read/write with delegated DOM event listeners; no new server endpoints, no changes to existing Python or JS files.

## Phase
Phase 7 — Module-by-Module Expansion
