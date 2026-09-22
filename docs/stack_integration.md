# One product from several apps: integration at three levels

RTB is one Frappe site with several apps on it. Each of them must be integrable at the **code** level (it
extends and is extended through Frappe's hooks and plain imports), at the **database** level (one schema,
its doctypes linked to the others'), and at the **solution** level (one person, one login, one desk, and
flows that cross the apps). `erpnext/tests/test_stack_integration.py` checks all three on whatever site it
runs on and is the contract below made executable.

| App | People call it | Role in the product |
| --- | --- | --- |
| `frappe` | Framework | users, roles, files, mail, the desk |
| `erpnext` | RTB | the business: selling, buying, stock, accounts, projects, the assistant, Focus Mode |
| `hrms` | Hubble | the people: leave, payroll, hiring, appraisal, Journeys, Skills |
| `payments` | Payments | payment gateways, required by Learning |
| `lms` | Learning | courses, batches, certificates |
| `suite` | Frappe Suite | drive, mail, calendar, meet, sheets, writer, slides |
| `raven` | Raven | chat, with channels per department and document notifications |

## Code level

Every app ships hooks Frappe merges at boot, and an app extends another by hanging a handler on that
app's doctype or by importing it. What the test proves: every app's hooks load; every document-event
handler resolves to a function; every desk bundle an app includes is built; the desk boots for
Administrator with every app on it, RTB's script before Hubble's.

Measured on 2026-09-22 (seven apps):

- **Hubble on RTB:** handlers on Company, Employee, Holiday List, Journal Entry, Payment Entry, Project,
  Task and Timesheet; scheduled jobs for leave, payroll, Journeys and Skills.
- **Raven on RTB and Hubble:** handlers on Employee and Department (a channel per department, members
  follow transfers) and on every doctype (document notifications).
- **Suite on the framework:** handlers on User (its role, mail settings, a Drive folder), File and User
  Group.
- **Learning on the framework:** handlers on User (the student role) and Notification Log.
- **RTB into Hubble:** the assistant answers HR questions with Hubble's own leave functions
  (`erpnext/assistant/hr.py`), Hubble's forms and lists register with RTB's Focus aids through
  `erpnext.adhd.register*`, and the Focus inbox takes Hubble's rows through the `focus_urgent_items` hook
  (`hrms.hr.focus.urgent_items`). Each side degrades to a plain sentence when the other is absent.

## Database level

One MariaDB schema holds every app's tables: 1,204 doctypes on the measured site, none without a table.
Apps are joined by Link and Table fields, and the test checks that every such field points at a doctype
that exists, or at a declared optional module that is not installed.

| From | To | Link fields |
| --- | --- | --- |
| RTB | Framework | 428 |
| Hubble | RTB | 275 |
| Hubble | Framework | 78 |
| Learning | Framework | 49 |
| Suite | Framework | 36 |
| Raven | Framework | 15 |
| RTB | Payments | 1 |
| Payments | Framework | 1 |

Hubble is built on RTB's Employee, Company, accounts and projects rather than beside them, which the
275 links show and the test asserts. The only links to nothing are three fields of Hubble's Salary Slip
Loan table naming Loan, Loan Repayment and Loan Product: Frappe's Lending app, which is optional and not
installed. The test allows exactly those and fails on any other dangling link.

## Solution level

One person is one User. The test creates a User inside a transaction and shows every installed app taking
it up: Suite gives it the "Suite User" role and mail settings, Learning the "LMS Student" role, Raven a
Raven User. It then makes that User an Employee and shows RTB answering an HR question for them from
Hubble without the language model, and RTB's Focus inbox listing the leave application Hubble says waits
on their approver. The desk lists all seven apps in its switcher, each app's navigation is a module
sidebar of the same desk, and none of the new apps binds the shortcuts the assistant (⌘K) and Focus Mode
(Alt+A, Alt+J) use.

Found and fixed while writing the test: the Focus inbox raised a permission error for a person with HR
roles and no sales ones; each of its sources now skips what the caller may not read.

## Verifying

```bash
node --test erpnext/tests/*.test.js
```

For the Python suites use a runner that connects to a site, patches `frappe.db.commit` and
`frappe.enqueue`, and rolls back (never `erpnext.tests.utils`, which commits fixtures), then:

```bash
erpnext.tests.test_stack_integration
```

The test needs the site's apps installed and their assets built (`bench build --app <app>`), and after
adding an app to `apps.txt` the bench must be restarted: a scheduler or web process started earlier cannot
import a package installed after it.

## Known limits

- Suite's Drive mails a share notification when a User is created, addressed to the user id
  "Administrator" when the sharer is Administrator, which SMTP servers reject; other users have
  email-shaped ids.
- Learning pins `markdown`, `beautifulsoup4` and `lxml` exactly upstream; the fork uses lower bounds
  because Frappe 17 and Suite need newer versions.
- Frappe's `cssutils` logs CSS errors when an app's Tailwind email template is inlined; harmless noise.
