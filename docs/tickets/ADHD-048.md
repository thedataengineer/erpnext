# ADHD-048: CRM Note "Promised Action" Extractor

## Current implementation record

- **Status:** Partial.
- **Implementation:** Detection lives in `erpnext/public/js/adhd/adhd_tickets_041_061.js` and attaches from `erpnext/public/js/utils/crm_activities.js`. CRM Note is a child DocType here, so it creates a parent-linked ToDo instead of the standalone flow described below.
- **Verification:** `node --test erpnext/tests/adhd_tickets_041_061.test.js` covers extraction and attachment points; dialog behavior remains unverified.
- **Acceptance:** Site-level acceptance has not been recorded; the original business intent and criteria below remain authoritative.

## Summary
When a CRM Note is created or edited, scan the note text client-side for commitment language patterns (regex-based) and — if a match is found — offer a one-click "Create ToDo" button that pre-fills the ToDo with the matched phrase and any detected date, so verbal commitments made during calls never slip through the cracks.

## Background / Context
ADHD users frequently conduct sales or support conversations, make verbal commitments ("I'll send the proposal by Friday", "Call back next week"), and then lose track of those commitments because capturing them requires an immediate context switch to a separate ToDo or Task — a switch that rarely happens. CRM Notes are often written in a stream-of-consciousness style immediately after a call, which is exactly when the commitment language is present in the text. Detecting it automatically and surfacing a one-click capture action meets the user in the moment without requiring a deliberate meta-step.

## Cognitive Mechanism
Working memory | initiation

## Prerequisites
- Conversational command bar (`feat/conversational-crm-assistant`) must be merged and functional for the trigger pathway described in the scope. The fallback (detecting on manual note save) works independently.
- The CRM Note doctype must have a `note` text field (standard ERPNext CRM field).
- The ToDo doctype must have `description` and `date` fields (standard frappe fields).

## Scope
**Create:**
- `erpnext/crm/doctype/crm_note/adhd_crm_note.js` — primary implementation file

**Modify:**
- `erpnext/hooks.py` — add `adhd_crm_note.js` to `doctype_js` under `"CRM Note"`
- `erpnext/public/scss/adhd_mode.scss` — add `.adhd-commitment-banner` styles

## What Needs to Be Done

1. **Define the promise pattern regex** at the top of `adhd_crm_note.js`:
   ```js
   // Matches commitment-indicating phrases (case-insensitive)
   const PROMISE_REGEX = /\b(will|i'll|i will|send|call back|follow up|follow-up|schedule|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|eod|end of day|end of week|\d{1,2}[\/\-]\d{1,2}))\b/i;

   // Simple date extraction: looks for common date patterns in text
   const DATE_REGEX = /\b(tomorrow|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?|by\s+(eod|end of day|end of week))\b/i;
   ```

2. **Hook into form events** in `adhd_crm_note.js`:
   ```js
   frappe.ui.form.on("CRM Note", {
     note(frm) {
       // Re-evaluate on every keystroke (debounced)
       if (!frappe.boot.adhd_mode) return;
       clearTimeout(frm._adhd_promise_timer);
       frm._adhd_promise_timer = setTimeout(() => {
         check_for_commitments(frm);
       }, 800); // 800ms debounce — don't fire on every character
     },
     after_save(frm) {
       if (!frappe.boot.adhd_mode) return;
       check_for_commitments(frm);
     },
   });
   ```

3. **Implement `check_for_commitments(frm)`**:
   ```js
   function check_for_commitments(frm) {
     $(frm.wrapper).find(".adhd-commitment-banner").remove();

     const note_text = frm.doc.note || "";
     if (!note_text.trim()) return;

     const promise_match = PROMISE_REGEX.exec(note_text);
     if (!promise_match) return;

     // Extract surrounding context: up to 80 chars around the match for the ToDo description
     const match_index = promise_match.index;
     const start = Math.max(0, match_index - 20);
     const end = Math.min(note_text.length, match_index + 80);
     const matched_phrase = note_text.slice(start, end).replace(/\n/g, " ").trim();

     // Attempt to extract a date from the note text
     const date_match = DATE_REGEX.exec(note_text);
     const suggested_date = date_match
       ? resolve_relative_date(date_match[0])
       : null;

     show_commitment_banner(frm, matched_phrase, suggested_date);
   }
   ```

4. **Implement `resolve_relative_date(phrase)`**:
   ```js
   function resolve_relative_date(phrase) {
     const today = frappe.datetime.nowdate(); // "YYYY-MM-DD"
     const lower = phrase.toLowerCase().trim();

     if (lower === "tomorrow") {
       return frappe.datetime.add_days(today, 1);
     }
     if (lower.includes("next week") || lower.includes("next monday")) {
       return frappe.datetime.add_days(today, 7);
     }
     const day_offsets = {
       "next tuesday": 2, "next wednesday": 3, "next thursday": 4,
       "next friday": 5, "next saturday": 6, "next sunday": 7,
     };
     for (const [key, offset] of Object.entries(day_offsets)) {
       if (lower.includes(key)) return frappe.datetime.add_days(today, offset);
     }
     if (lower === "eod" || lower.includes("end of day")) {
       return today;
     }
     if (lower.includes("end of week")) {
       return frappe.datetime.add_days(today, 5 - new Date().getDay() || 5);
     }
     // Attempt numeric date parse: M/D or M-D format
     const num_match = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/.exec(phrase);
     if (num_match) {
       const year = num_match[3]
         ? (num_match[3].length === 2 ? "20" + num_match[3] : num_match[3])
         : frappe.datetime.nowdate().slice(0, 4);
       const month = String(num_match[1]).padStart(2, "0");
       const day = String(num_match[2]).padStart(2, "0");
       return `${year}-${month}-${day}`;
     }
     return null;
   }
   ```

5. **Implement `show_commitment_banner(frm, phrase, suggested_date)`**:
   ```js
   function show_commitment_banner(frm, phrase, suggested_date) {
     const date_label = suggested_date
       ? ` by ${frappe.datetime.str_to_user(suggested_date)}`
       : "";

     const $banner = $(`
       <div class="adhd-commitment-banner">
         <span class="adhd-commitment-banner__icon">🤝</span>
         <span class="adhd-commitment-banner__text">
           Looks like a commitment was made${date_label} — create a follow-up ToDo?
         </span>
         <button class="btn btn-xs btn-primary adhd-commitment-banner__btn">Create ToDo</button>
         <button class="btn btn-xs btn-default adhd-commitment-banner__dismiss">Dismiss</button>
       </div>
     `);

     $banner.find(".adhd-commitment-banner__btn").on("click", () => {
       create_todo(frm, phrase, suggested_date);
       $banner.remove();
     });

     $banner.find(".adhd-commitment-banner__dismiss").on("click", () => {
       $banner.remove();
     });

     $(frm.wrapper).find(".form-layout").prepend($banner);
   }
   ```

6. **Implement `create_todo(frm, description, date)`**:
   ```js
   function create_todo(frm, description, date) {
     const todo_doc = {
       doctype: "ToDo",
       description: description,
       date: date || null,
       reference_type: "CRM Note",
       reference_name: frm.doc.name,
       assigned_by: frappe.session.user,
       owner: frappe.session.user,
     };

     frappe.db.insert(todo_doc).then((doc) => {
       frappe.show_alert({
         message: `ToDo created: <a href="/app/todo/${doc.name}">${doc.name}</a>`,
         indicator: "green",
       });
     }).catch(() => {
       frappe.msgprint("Could not create ToDo. Please create it manually.");
     });
   }
   ```

7. **Add CSS** to `adhd_mode.scss`:
   ```scss
   .adhd-commitment-banner {
     display: flex;
     align-items: center;
     gap: 10px;
     padding: 8px 14px;
     background: var(--purple-50, #faf5ff);
     border: 1px solid var(--purple-300, #d8b4fe);
     border-radius: var(--border-radius);
     font-size: 0.85rem;
     margin-bottom: 10px;
     flex-wrap: wrap;

     &__icon { font-size: 1.1rem; flex-shrink: 0; }
     &__text { flex: 1; min-width: 200px; color: var(--text-color); }
     &__btn, &__dismiss { white-space: nowrap; }
   }
   ```

8. **Register in `hooks.py`**:
   ```python
   doctype_js = {
       "CRM Note": "crm/doctype/crm_note/adhd_crm_note.js",
       # ... existing entries
   }
   ```

## How to Test

1. Open ERPNext desk with ADHD mode **enabled**.
2. Open or create a **CRM Note** form.
3. Type a note containing commitment language, e.g.: "Spoke with client. Will send the contract by Friday." After 0.8 seconds (debounce), confirm the purple commitment banner appears: "Looks like a commitment was made by [Friday's date] — create a follow-up ToDo?"
4. Click "Create ToDo". Confirm a ToDo is created with description containing "send the contract by Friday" and `date` set to the coming Friday. Confirm a green alert with a link to the new ToDo appears.
5. Follow the link. Confirm the ToDo opens with the correct description and date.
6. Return to the CRM Note. Click "Dismiss" on the banner. Confirm the banner disappears and no ToDo is created.
7. Type a note with **no** commitment language (e.g., "Discussed budget. Team is satisfied."). Confirm no banner appears.
8. Type a note with "call back next week". Confirm the banner appears with a date approximately 7 days from today.
9. Type a note with "follow up on 12/15". Confirm the banner extracts December 15 as the date.
10. **Save** the note (with commitment language still present). Confirm the banner reappears on save if not already visible.
11. **Disable ADHD mode**. Type the same commitment text in a CRM Note. Confirm no banner appears.
12. Check browser console for JavaScript errors.

## Acceptance Criteria
- [ ] Banner appears within 1 second of entering commitment language in the `note` field (debounced).
- [ ] Banner correctly identifies at least these patterns: "will", "I'll", "send", "call back", "follow up", "schedule", "by [day]".
- [ ] "Create ToDo" button creates a ToDo with the matched phrase as `description` and a detected date (if any) as `date`.
- [ ] ToDo has `reference_type = "CRM Note"` and `reference_name` pointing to the current note.
- [ ] "Dismiss" button removes the banner without creating a ToDo.
- [ ] Banner does not appear for notes without commitment language.
- [ ] No LLM or server-side text analysis is used — pure client-side regex.
- [ ] Banner is absent when ADHD mode is disabled.
- [ ] No duplicate banners appear.
- [ ] No JavaScript errors.

## Dependencies
- **Blocked by:** ADHD mode toggle (must be shipped); conversational command bar (`feat/conversational-crm-assistant`) for the primary trigger pathway, though the `after_save` hook works independently.
- **Blocks:** None

## Complexity
S — Pure client-side JS; regex matching; `frappe.db.insert` for ToDo creation; no new Python or schema changes.

## Phase
Phase 7 — Module-by-Module Expansion
