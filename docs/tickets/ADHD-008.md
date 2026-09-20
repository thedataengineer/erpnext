# ADHD-008: Contextual Due-Date Nudges on Document Forms

## Summary
When ADHD mode is active, injects a non-blocking, per-session-dismissible banner at the top of Sales Invoice, Sales Order, Task, and Purchase Order forms that shows a plain-English time-to-deadline message computed from existing date fields — reminding the user of urgency without interrupting their current action.

## Background / Context
ADHD users often hyperfocus on the content of a document — editing items, checking prices, updating notes — while completely losing track of the document's deadline. A Sales Invoice that is "due in 2 days" and an overdue Task can sit open on screen without the deadline registering because the date field is formatted as a raw date string buried in a field row. A contextual banner that translates that date to "Payment due in 2 days" or "Deadline: yesterday" surfaces urgency at the moment of engagement, when something can still be done about it.

## Cognitive Mechanism
Time blindness | working memory

## Prerequisites
- ADHD mode toggle (`adhd_mode.js`, Phase 1) must be active.
- No other ticket dependencies — all required date fields already exist on each doctype.

## Scope
**Create:**
- `erpnext/public/js/adhd/adhd_deadline_banner.js`

**Modify:**
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-deadline-*` styles
- `erpnext/hooks.py` — include `adhd_deadline_banner.js` in `app_include_js`

## What Needs to Be Done

1. **Define the doctype configuration map.** At the top of `adhd_deadline_banner.js`:
   ```js
   const DEADLINE_CONFIG = {
     "Sales Invoice": {
       dateField: "due_date",
       message: (days) => days < 0
         ? `⚠️ Payment overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""}`
         : days === 0
         ? "⚠️ Payment due today"
         : `💳 Payment due in ${days} day${days !== 1 ? "s" : ""}`,
       showWhen: (doc) => doc.docstatus !== 2 && doc.outstanding_amount > 0,
     },
     "Sales Order": {
       dateField: "delivery_date",
       message: (days) => days < 0
         ? `⚠️ Delivery overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""}`
         : days === 0
         ? "⚠️ Delivery due today"
         : `📦 Delivery due in ${days} day${days !== 1 ? "s" : ""}`,
       showWhen: (doc) => doc.docstatus === 1 && doc.status !== "Closed",
     },
     "Task": {
       dateField: "exp_end_date",
       message: (days) => days < 0
         ? `⚠️ Deadline was ${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""} ago`
         : days === 0
         ? "⏰ Deadline: today"
         : days === 1
         ? "⏰ Deadline: tomorrow"
         : `📋 Deadline in ${days} days`,
       showWhen: (doc) => doc.status !== "Completed" && doc.status !== "Cancelled",
     },
     "Purchase Order": {
       dateField: "schedule_date",
       message: (days) => days < 0
         ? `⚠️ Expected delivery overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""}`
         : days === 0
         ? "⚠️ Expected delivery today"
         : `🚚 Expected delivery in ${days} day${days !== 1 ? "s" : ""}`,
       showWhen: (doc) => doc.docstatus === 1 && doc.status !== "Closed",
     },
   };
   ```

2. **Build `renderDeadlineBanner(frm)`.** Called from both `refresh` and `after_save` hooks:
   ```js
   function renderDeadlineBanner(frm) {
     if (!frappe.boot.adhd_mode) return;
     const config = DEADLINE_CONFIG[frm.doctype];
     if (!config) return;
     if (!config.showWhen(frm.doc)) return;
     const dateVal = frm.doc[config.dateField];
     if (!dateVal) return;
     // Check per-session dismissal
     const dismissKey = `adhd_banner_dismissed_${frm.doctype}_${frm.docname}`;
     if (sessionStorage.getItem(dismissKey)) return;
     const today = frappe.datetime.get_today();
     const days  = frappe.datetime.get_diff(dateVal, today);  // positive = future
     const msgText = config.message(days);
     // Remove any existing banner before re-rendering
     frm.layout.$wrapper.find(".adhd-deadline-banner").remove();
     const urgencyClass = days < 0 ? "adhd-deadline--overdue"
                        : days <= 2 ? "adhd-deadline--soon"
                        : "adhd-deadline--normal";
     const $banner = $(`
       <div class="adhd-deadline-banner ${urgencyClass}">
         <span class="adhd-deadline-msg">${msgText}</span>
         <button class="adhd-deadline-dismiss" aria-label="Dismiss">✕</button>
       </div>
     `);
     $banner.find(".adhd-deadline-dismiss").on("click", () => {
       sessionStorage.setItem(dismissKey, "1");
       $banner.remove();
     });
     frm.layout.$wrapper.prepend($banner);
   }
   ```

3. **Register hooks for each configured doctype.** Use a loop:
   ```js
   Object.keys(DEADLINE_CONFIG).forEach((doctype) => {
     frappe.ui.form.on(doctype, {
       refresh:    (frm) => renderDeadlineBanner(frm),
       after_save: (frm) => renderDeadlineBanner(frm),
     });
   });
   ```

4. **Per-session dismissal.** Use `sessionStorage` (not `localStorage`) so banners reappear after a browser session ends. The key format `adhd_banner_dismissed_{doctype}_{docname}` ensures dismissal is scoped to the specific document, not all documents of that type.

5. **CSS in `adhd_mode.scss`:**
   ```scss
   .adhd-deadline-banner {
     display: flex;
     align-items: center;
     justify-content: space-between;
     padding: 8px 14px;
     border-radius: 4px;
     font-size: 0.85rem;
     margin-bottom: 8px;
     
     &.adhd-deadline--overdue {
       background: var(--red-100,  #fff1f0);
       border-left: 4px solid var(--red-500);
       color: var(--red-700, #a61d24);
     }
     &.adhd-deadline--soon {
       background: var(--yellow-100, #fffbe6);
       border-left: 4px solid var(--yellow-500);
       color: var(--yellow-800, #7c5a00);
     }
     &.adhd-deadline--normal {
       background: var(--blue-50,   #e6f7ff);
       border-left: 4px solid var(--blue-400);
       color: var(--blue-700, #0050b3);
     }
   }
   .adhd-deadline-dismiss {
     background: none;
     border: none;
     cursor: pointer;
     color: inherit;
     opacity: 0.6;
     font-size: 0.9rem;
     padding: 0 4px;
     &:hover { opacity: 1; }
   }
   ```

6. **Avoid rendering on new (unsaved) documents.** Check `frm.is_new()` at the start of `renderDeadlineBanner` and return early if true.

7. **Handle missing dates gracefully.** If `dateVal` is falsy (no due date set), skip rendering silently with no error.

## How to Test

1. Enable ADHD mode. Open a submitted Sales Invoice with `outstanding_amount > 0` and `due_date = yesterday`. Confirm a red-border banner appears at the top of the form reading "⚠️ Payment overdue by 1 day".
2. Open a submitted Sales Invoice with `due_date = tomorrow`. Confirm an amber banner appears: "💳 Payment due in 1 day".
3. Open a submitted Sales Invoice with `due_date = 10 days from now`. Confirm a blue banner appears: "💳 Payment due in 10 days".
4. Click the ✕ on any banner. Confirm it dismisses immediately. Reload the page (same session). Confirm it does not reappear.
5. Close the browser tab and reopen it (new session). Open the same document. Confirm the banner reappears.
6. Open a Sales Invoice that is fully paid (`outstanding_amount = 0`). Confirm no banner appears.
7. Open a Task with `exp_end_date = tomorrow`. Confirm "⏰ Deadline: tomorrow" banner appears.
8. Open a Task marked "Completed". Confirm no banner appears.
9. Disable ADHD mode. Open the overdue Sales Invoice. Confirm no banner appears.
10. Open a new (unsaved) Sales Invoice. Confirm no banner appears.
11. Open a doctype not in `DEADLINE_CONFIG` (e.g., Customer). Confirm no banner and no console errors.

## Acceptance Criteria
- [ ] Banner appears on Sales Invoice, Sales Order, Task, and Purchase Order when ADHD mode is active and the document has an applicable date.
- [ ] Overdue documents show a red-border banner with "overdue" language.
- [ ] Documents due within 0–2 days show an amber-border banner.
- [ ] Documents due in 3+ days show a blue-border banner.
- [ ] The ✕ button dismisses the banner and it does not reappear within the same browser session.
- [ ] The banner reappears on a new browser session (sessionStorage cleared).
- [ ] No banner appears on fully paid invoices, closed orders, or completed tasks.
- [ ] No banner appears on new (unsaved) documents.
- [ ] No banner appears when ADHD mode is disabled.
- [ ] No console errors on any of the four target doctypes or on unlisted doctypes.

## Dependencies
- **Blocked by:** ADHD mode toggle (Phase 1, shipped)
- **Blocks:** ADHD-021 (Quotation Expiry — reuses this banner pattern and `renderDeadlineBanner` function)

## Complexity
S — Client-side form hook with computed messaging; no server calls; primary concern is correct sessionStorage scoping and CSS specificity.

## Phase
Phase 3 — Ambient Awareness
