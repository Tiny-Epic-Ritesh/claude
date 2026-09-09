# Bonanza AI CRM — Testing Feedback, Part 3

**Author:** Ritesh (CRM Solutions Architect)
**Date:** 4 September 2026
**Build tested:** labs.tinyepic.in/ai-crm
**Scope:** 44 tickets — bugs, enhancements and new feature requests raised during Round 3 testing.

---

## How to use this document

1. **Work in priority order.** Tickets are grouped into four bands — P0 → P1 → P2 → P3 — and that is the intended build sequence. Do not start a P2 or P3 module while P0 bugs remain open.
2. **Every ticket has a "Done when" clause.** Treat it as the acceptance test. A ticket is not complete until every bullet in that clause passes.
3. **Do not assume anything.** Where a requirement is unclear, raise the question before writing code. Unresolved queries are collected in the *Open Questions* section at the end of this document — add to it rather than guessing.
4. **Ticket IDs are stable.** `P3-01` … `P3-44` correspond to the numbered points in the source feedback sheet. Reference the ID in commits, branches and status updates.
5. **Report progress by ticket ID**, with a status of `Not started` / `In progress` / `Ready for retest` / `Done`.

### Priority bands

| Band | Meaning | Intent |
|---|---|---|
| **P0** | Defects — something is broken, misleading or blocking a user | Fix first. These undermine confidence in the build. |
| **P1** | Quick wins — low-effort UX, filter, export and configuration gaps | Fast, visible improvement across the product. |
| **P2** | Medium modules — contained new functionality on existing screens | Build after P0/P1 are cleared. |
| **P3** | Large builds — new modules requiring their own architecture | Plan properly; expect design review before implementation. |

---

## Execution index

### P0 — Defects (fix first)

| ID | Title | Area |
|---|---|---|
| P3-29 | "Mark as Warm" dropdown omits the product already on the lead | Leads → Lead Details |
| P3-28 | AI Summary action buttons perform no action | Leads → Lead Details |
| P3-30 | No validation messages on incorrectly formatted field values | Leads → Edit Lead |
| P3-31 | App Launcher pop-up does not close on outside click | Global navigation |
| P3-32 | Console switching does not load or give any transition feedback | Global navigation |
| P3-44 | CUBE telephony end-to-end verification (campaign `Bonanza_APITest`) | Telephony integration |

### P1 — Quick wins

| ID | Title | Area |
|---|---|---|
| P3-01 | Filter option in Audit Log | Setup → Audit Log |
| P3-22 | Filters and export in Audit Logs | Setup → Audit Logs |
| P3-02 | User export with selectable fields | Setup → User Settings |
| P3-03 | Missing fields on the Create User form | Setup → User Settings |
| P3-12 | Campaign field mapped against a user | Setup → User Settings |
| P3-11 | Admin-configurable list of maskable fields | Setup → Field Masking |
| P3-04 | Search box in the Advanced Search field selector | Advanced Search |
| P3-05 | Saved Advanced Filters list is unmanageably long | Advanced Search |
| P3-23 | Filter option in API & Logs | Setup → API & Logs |
| P3-24 | Database export with size and row counts | Setup → Database |
| P3-25 | Filters and export in Data Residency | Setup → Data Residency |
| P3-26 | Back button missing on several screens | Global navigation |
| P3-27 | System Activity Log dominates the Admin/Super Admin homepage | Homepage |
| P3-10 | Geolocation capture on lead activity | Activities |
| P3-36 | Sorting on the lead list view | Leads → List View |
| P3-37 | Page-size control and pagination on the lead list view | Leads → List View |
| P3-38 | Column selection on the lead list view | Leads → List View |
| P3-41 | Sample CSV download and file attach on lead import | Leads → Import |

### P2 — Medium modules

| ID | Title | Area |
|---|---|---|
| P3-08 | Sales groups for RM-to-supervisor mapping | Setup → Groups |
| P3-07 | Organisational role hierarchy (reporting tree) | Setup → Roles & Permissions |
| P3-09 | Check-in / check-out for sales users | Attendance |
| P3-13 | Phone call form (configurable disposition form) | Telephony / Activities |
| P3-15 | Product brochure attachment and in-call use | Setup → Products |
| P3-17 | Template creation for Email, SMS and WhatsApp | Setup → Template Management |
| P3-18 | Facebook and Instagram lead-ads integration console | Setup → Social Integration |
| P3-33 | Lead Import module under the Leads tab | Leads → Import |
| P3-34 | Import result summary | Leads → Import |
| P3-35 | Lead export with ownership scope, masking and role control | Leads → Export |
| P3-39 | Bulk update on the lead list view | Leads → List View |
| P3-40 | Lead Details page layout and UI rework | Leads → Lead Details |
| P3-42 | Sales Supervisor — Sales Console, lead access and task assignment | Roles & Permissions |
| P3-43 | Sales Supervisor — lead import and masked export | Roles & Permissions |

### P3 — Large builds

| ID | Title | Area |
|---|---|---|
| P3-06 | Reports module — predefined reports and custom report builder | Reports |
| P3-16 | Advanced automation builder | Automation |
| P3-14 | Call recording, transcription and AI call summary | Telephony / AI |
| P3-20 | Apps marketplace / connectors section | Integrations |
| P3-19 | LAPPS — scriptable custom app framework | Integrations |
| P3-21 | Internal communication module | Collaboration |

---

# P0 — Defects

---

## P3-29 · "Mark as Warm" dropdown omits the product already on the lead

**Type:** Bug  **Area:** Leads → Lead Details  **Priority:** P0

**Observed:** On the lead record for **Meera Iyer**, the lead was in the *Closed – Exploring* stage and I wanted to move the **Equity & Derivatives** product to *Warm*. From the product card itself, I was able to mark it as Warm without any problem. However, the AI summary on the same lead displays the prompt *"Qualify the interest, then mark it warm"* along with a **Mark as Warm** button. When I click that button, the system asks me to select the product to mark as Warm — but **Equity & Derivatives does not appear in the dropdown**, even though it is clearly present on the product card.

**Expected:** The product dropdown on the *Mark as Warm* action must list every product currently associated with the lead, so the action can be completed from the summary exactly as it can from the product card.

**Done when:**
- The *Mark as Warm* dropdown lists all products attached to the lead, including Equity & Derivatives on the Meera Iyer record.
- Marking a product as Warm from the summary produces the same result as marking it from the product card.
- Every other action button on the Lead Details page has been retested for the same class of defect, and the results are reported back to me.

---

## P3-28 · AI Summary action buttons perform no action

**Type:** Bug  **Area:** Leads → Lead Details  **Priority:** P0

**Observed:** The Lead Details page shows an AI summary that guides the user on the next step — for example, chasing an open KYC journey, or requesting a product RM. The summary renders buttons such as **"Request a Product RM"** and **"Chase the KYC Journey"**, but clicking them does nothing. No screen opens, no redirect occurs and no action is performed.

**Expected:** Every button surfaced by the AI summary must be wired to a real action. A button must never be decorative.

**Done when:**
- Each AI summary button triggers a defined, working action — opening the relevant screen, raising the relevant request, or updating the relevant record.
- "Request a Product RM", "Chase the KYC Journey" and any similar recommendation buttons (for example, reopening a warm lead) all perform their intended action.
- A list of every AI summary button and the action it now performs is shared with me for review.

**Note:** Where the correct action for a button is not obvious, ask me before implementing. Do not invent behaviour.

---

## P3-30 · No validation messages on incorrectly formatted field values

**Type:** Bug  **Area:** Leads → Edit Lead (applies globally to all forms)  **Priority:** P0

**Observed:** While editing a lead, I deliberately entered an invalid PAN number and attempted to save:
- There was **no inline validation** warning me that the value exceeded the permitted length or did not match the PAN format.
- On clicking **Save Changes**, the record simply did not save. **No error message was displayed** explaining what was wrong or why the save was blocked.

This leaves the user stuck with no idea what the problem is.

**Expected:** Any value entered in an incorrect format must raise a clear, specific error message — at the point of entry where possible, and on save at the latest. This applies across the application, not only to PAN.

**Done when:**
- **PAN:** an incorrectly formatted or over-length PAN raises a message naming the expected format.
- **Mobile number:** a number exceeding 10 digits, or otherwise invalid, raises a message.
- **Email:** an incorrectly formatted email address raises a message.
- **Numeric fields:** entering text where a number is expected raises a specific message — for example, *"Lead Score cannot contain letters."*
- The same rule is applied consistently to every other field with a defined format.
- The error message states which field failed and what the correct format is; a save is never silently rejected.

---

## P3-31 · App Launcher pop-up does not close on outside click

**Type:** Bug  **Area:** Global navigation  **Priority:** P0

**Observed:** After opening the App Launcher, clicking anywhere else on the screen does not close the pop-up. It remains open.

**Expected:** If the App Launcher is opened — including by mistake — clicking anywhere outside the panel should dismiss it.

**Done when:**
- Clicking outside the App Launcher panel closes it.
- The `Esc` key also closes it.
- The behaviour has been tested across the consoles and screens where the launcher is available.

---

## P3-32 · Console switching does not load or give any transition feedback

**Type:** Bug  **Area:** Global navigation  **Priority:** P0

**Observed:** Opening the App Launcher and selecting **Sales Console** correctly loads all the tabs belonging to that console. However, opening the App Launcher again and selecting **Service Console** does not load the page — there is no transition and no visible change.

**Expected:** Switching between consoles must work reliably, and the switch must be visible to the user so they know the new console has loaded and the content they asked for is on screen.

**Done when:**
- Switching to Service Console — and to every other console — loads that console's tabs correctly.
- A clear transition or loading state is shown during the switch, so the change of context is unmistakable.
- The transition is smooth and polished, not an abrupt repaint.

---

## P3-44 · CUBE telephony end-to-end verification

**Type:** Verification  **Area:** Telephony integration  **Priority:** P0

**Context:** The test campaign name configured on CUBE is **`Bonanza_APITest`**. Use this campaign to test calling end to end through the CRM.

**Done when — verified and evidenced:**
- Calls placed from the CRM route correctly through CUBE.
- Call recordings are returned to the CRM.
- Call transcriptions are returned to the CRM.
- The AI summary is generated in the CRM from the transcription and any other CUBE-sourced detail required.

**Note:** This ticket is the prerequisite verification for **P3-13** (phone call form) and **P3-14** (recording, transcription and AI summary). Confirm the pipeline works before building on top of it.

---

# P1 — Quick wins

---

## P3-01 · Filter option in Audit Log

**Type:** Enhancement  **Area:** Setup → Audit Log  **Priority:** P1
**Related:** P3-22 — implement both together.

**Requirement:** Add a filter to the Audit Log so a user can narrow the list to the specific log entries they want to examine, rather than scrolling the full log.

**Done when:**
- The Audit Log offers filters on its meaningful attributes (at minimum: user, action/event type and date range).
- Filters can be combined and cleared.
- The filtered result set can be opened to view the detail of any individual entry.

---

## P3-22 · Filters and export in Audit Logs

**Type:** Enhancement  **Area:** Setup → Audit Logs  **Priority:** P1
**Related:** P3-01 — same screen; deliver as one piece of work.

**Requirement:** In the Audit Logs section under Setup, provide both filter and export options so that audit logs can be exported by Admins and Super Admins.

**Done when:**
- Filters are available as described in P3-01.
- An **Export** action is available to Admin and Super Admin roles only.
- The export respects whatever filters are currently applied.

---

## P3-02 · User export with selectable fields

**Type:** Enhancement  **Area:** Setup → User Settings  **Priority:** P1

**Requirement:** In User Settings under Setup, provide an option for Admins and Super Admins to export users. The export must allow the fields to be selected and deselected before download.

The current user record is also missing fields that are needed — particularly when performing user login checks. Additional fields required include **last login date, role, user created on** and other comparable attributes. Review how LeadSquared and Salesforce structure their user records, identify the fields they maintain, and implement the equivalent set here.

**Done when:**
- Admin and Super Admin can export the user list.
- A field selector lets the user include or exclude columns before exporting.
- The user object carries the additional fields — including last login date, role and created-on date — and these are available both on screen and in the export.
- The field set has been benchmarked against LeadSquared and Salesforce, and the proposed list has been shared with me before implementation.

---

## P3-03 · Missing fields on the Create User form

**Type:** Enhancement  **Area:** Setup → User Settings  **Priority:** P1

**Requirement:** The Create New User form does not offer a **mobile number** field, and is missing other attributes that are needed when setting up a user. Review the LeadSquared user-creation pattern, establish which fields are required there, and implement the equivalent set in our form.

**Done when:**
- Mobile number is available on the Create User form, with format validation (see P3-30).
- The remaining fields identified from the LeadSquared benchmark are present.
- The proposed field list has been shared with me for confirmation before it is built.
- Mandatory versus optional fields are clearly indicated on the form.

---

## P3-12 · Campaign field mapped against a user

**Type:** Enhancement  **Area:** Setup → User Settings  **Priority:** P1

**Requirement:** There is currently no campaign detail held in the CRM that can be mapped under User Settings. For a sales CRM — and for any user placing calls from the CRM — the extension or campaign often needs to be configured against the individual user. Provide a campaign field on the user record that can be populated and updated as campaigns change.

**Done when:**
- A campaign field exists on the user record and is editable by Admin and Super Admin.
- The field can be updated at any time as campaign assignments change.
- The value is available to the telephony configuration so that calls dial out under the correct campaign.

---

## P3-11 · Admin-configurable list of maskable fields

**Type:** Enhancement  **Area:** Setup → Field Masking  **Priority:** P1

**Requirement:** Field Masking settings currently expose only a fixed set of fields that can be masked. If the business later asks for additional fields to be masked, there must be a way to add them without a code change. Provide a form through which Admins and Super Admins can add fields to the maskable list.

**Done when:**
- Admin and Super Admin can add a field to the maskable set from the UI.
- A field added this way behaves identically to the fields that ship as maskable — on screen, in exports and in the API.
- Fields can also be removed from the maskable set.

---

## P3-04 · Search box in the Advanced Search field selector

**Type:** Enhancement  **Area:** Advanced Search  **Priority:** P1

**Requirement:** Add a search box to the field-selection list in Advanced Search so a user can find a field by typing instead of scrolling the whole list.

**Done when:** Typing in the search box filters the field list in real time, and clearing it restores the full list.

---

## P3-05 · Saved Advanced Filters list is unmanageably long

**Type:** Enhancement  **Area:** Advanced Search  **Priority:** P1

**Requirement:** The saved Advanced Filters list returns too many records to work with. Either show a shortened list with a **More** link that opens the full set, or provide a search box for saved filters — or both.

**Done when:**
- The saved filters list is capped at a sensible default with a **More** action to reveal the rest.
- A search box allows a saved filter to be located by name.
- Selecting a filter from either path applies it correctly.

---

## P3-23 · Filter option in API & Logs

**Type:** Enhancement  **Area:** Setup → API & Logs  **Priority:** P1

**Requirement:** The API & Logs section offers no way to filter its contents. Anyone debugging an API call or a log entry should be able to narrow the list — searching by the user's name in particular.

**Done when:**
- API and log entries can be filtered, including by user name.
- Additional practical filters (date range, endpoint, status/result) are available.
- The filtered view is usable for debugging a specific request without manual scanning.

---

## P3-24 · Database export with size and row counts

**Type:** Enhancement  **Area:** Setup → Database  **Priority:** P1

**Requirement:** In the Database section, provide an export covering database size, row counts and the other detail shown on screen, so that the database footprint can be exported and shared with the management team for onward decisions.

**Done when:**
- An export is available from the Database section covering size, row counts and all displayed detail.
- The exported file is presentable as-is to a management audience.

---

## P3-25 · Filters and export in Data Residency

**Type:** Enhancement  **Area:** Setup → Data Residency  **Priority:** P1

**Requirement:** In the Data Residency section, provide an export option along with filters, so that the user can narrow to the tabs or fields they need and export only those data residency details.

**Done when:**
- Filters are available on the Data Residency view.
- An export is available and reflects the current filter selection.

---

## P3-26 · Back button missing on several screens

**Type:** Enhancement  **Area:** Global navigation  **Priority:** P1

**Requirement:** Provide a Back button on every screen that currently lacks one, so users can return to the previous view easily. For example, opening the **Active Partner** homepage leaves no way to navigate back to the page you came from.

**Done when:**
- A Back button is present and functional on every screen that is reached from another screen, including the Active Partner homepage.
- The Back button returns the user to the exact previous view, preserving filters and scroll position where practical.
- A list of screens audited and fixed is shared with me.

---

## P3-27 · System Activity Log dominates the Admin/Super Admin homepage

**Type:** Enhancement  **Area:** Homepage  **Priority:** P1

**Observed:** On the Super Admin and Admin homepages, the System Activity Log is very long. Reading the homepage means scrolling past the entire log, which spoils the experience.

**Requirement:** Keep the System Activity Log short on the homepage and use the reclaimed space for something more informative.

**Done when:**
- The homepage shows only a short, recent slice of the System Activity Log, with a link through to the full log.
- The space freed is used for genuinely useful homepage content.
- The homepage no longer requires extended scrolling to read.

**Note:** Propose what should occupy the reclaimed space before building it.

---

## P3-10 · Geolocation capture on lead activity

**Type:** New Feature  **Area:** Activities  **Priority:** P1

**Requirement:** The geolocation feature has still not been added. Capture the user's geolocation at the point they post a lead activity against a lead.

**Done when:**
- Geolocation is captured and stored whenever a user posts an activity on a lead.
- The captured location is visible against the activity record.
- Behaviour when location permission is denied or unavailable is defined and handled gracefully.

**Note:** This was raised previously and remains outstanding. Confirm with me how a denied-permission case should behave before implementing.

---

## P3-36 · Sorting on the lead list view

**Type:** Enhancement  **Area:** Leads → List View  **Priority:** P1

**Requirement:** Provide sorting on the lead list page across all the relevant fields, including:
- Lead name
- Mobile number
- Email ID
- Products
- Age
- Owner
- Any other relevant field

Sorting must support both ascending and descending order.

**Done when:**
- Every listed field can be sorted ascending and descending.
- The active sort is visibly indicated in the column header.
- Sorting works correctly alongside applied filters and pagination.

---

## P3-37 · Page-size control and pagination on the lead list view

**Type:** Enhancement  **Area:** Leads → List View  **Priority:** P1

**Requirement:** Limit how many records display on a single page of the lead list, and let the user choose the page size. Options required:
- 25 leads per page
- 50 leads per page
- 100 leads per page
- 200 leads per page

For example: a user with 1,000 leads in their bucket who selects 200 sees the first 200 on screen, with the remainder distributed across subsequent pages. They can then click page 2, 3, 4 and so on to move through the set.

**Done when:**
- The page-size selector offers 25, 50, 100 and 200.
- Numbered pagination lets the user jump directly to any page.
- The selected page size persists as the user navigates.
- Sorting and filters are respected across all pages.

---

## P3-38 · Column selection on the lead list view

**Type:** Enhancement  **Area:** Leads → List View  **Priority:** P1

**Requirement:** Provide a **Select Columns** option on the lead list view. A default column set applies, but the user can add any available column and remove those they do not need. Certain mandatory columns must not be removable.

**Done when:**
- A column selector lists every available lead field.
- The user can add and remove columns, and the list view updates accordingly.
- Mandatory columns are locked and cannot be deselected — confirm the mandatory list with me before building.
- The user's column selection persists between sessions.

---

## P3-41 · Sample CSV download and file attach on lead import

**Type:** Enhancement  **Area:** Leads → Import  **Priority:** P1
**Related:** P3-33.

**Requirement:** On the lead import screen, provide an option to attach a file from the user's computer in a defined format. Also provide a **sample format** download — a sample `.csv` file the user can refer to in order to understand exactly what details are expected.

**Done when:**
- The user can browse and attach a file from their computer.
- Accepted file formats are stated clearly on screen.
- A sample `.csv` is downloadable from the same screen and reflects the current field set and expected values.

---

# P2 — Medium modules

---

## P3-08 · Sales groups for RM-to-supervisor mapping

**Type:** New Feature  **Area:** Setup → Groups  **Priority:** P2
**Related:** P3-07 — build alongside the role hierarchy.

**Requirement:** There is no option for groups or sales groups in the CRM, so there is currently no way to map RMs to their supervisor. For example, where ten RMs report to a single supervisor, I need to be able to create a group, assign those RMs to it, and designate a manager for that group.

**Done when:**
- Admin and Super Admin can create, edit and delete groups.
- Users can be assigned to and removed from a group.
- A group can be assigned a manager.
- Group membership is available to downstream features — visibility, assignment, reporting and task allocation.

---

## P3-07 · Organisational role hierarchy (reporting tree)

**Type:** New Feature  **Area:** Setup → Roles & Permissions  **Priority:** P2
**Related:** P3-08, P3-42.

**Requirement:** Build a tree-structured organisational hierarchy for roles and permissions, comparable to Salesforce's role hierarchy. The reporting chain is: Sales User → Sales Manager → Regional Manager → Zonal Manager → Sales Head → Business Head, and so on — with the junior role positioned below its manager in the tree.

Take Salesforce's role hierarchy as the reference for how the feature behaves, but the structure and configuration must reflect Bonanza's actual business requirement, not Salesforce's defaults. The functionality and configurability must not be compromised in the process.

**Done when:**
- Roles are arranged in a visual tree showing the reporting line from top to bottom.
- Admin and Super Admin can create roles and place them anywhere in the tree.
- Data visibility and permissions inherit up the hierarchy — a manager can see the records of the roles reporting to them.
- The hierarchy is configurable from the UI and is not hard-coded.
- The proposed hierarchy model is reviewed with me before implementation, to confirm it matches Bonanza's structure.

---

## P3-09 · Check-in / check-out for sales users

**Type:** New Feature  **Area:** Attendance  **Priority:** P2

**Requirement:** This is a mandatory requirement from the sales team. Sales users check in when they start their day and check out when they leave the system.

- When a user logs in, a pop-up prompts them to check in. Check-in time starts counting from that moment.
- When the user is ready to leave, they click **Check Out** and are checked out.
- Total checked-in hours are calculated for each user and made available under the Reports section.

**Visibility:** the user themselves, their manager, Admin and Super Admin.

**Done when:**
- A check-in prompt appears on login for sales users.
- Check-in and check-out times are recorded, and total checked-in duration is calculated per user per day.
- A report shows checked-in hours, visible to the user, their manager, Admin and Super Admin — and scoped so that a manager sees only their own team.
- Behaviour is defined for a session that ends without an explicit check-out — confirm the expected handling with me before building.

---

## P3-13 · Phone call form (configurable disposition form)

**Type:** New Feature  **Area:** Telephony / Activities  **Priority:** P2
**Depends on:** P3-44.

**Requirement:** Introduce a phone call form that opens as a pop-up whenever a user places a call from the CRM through CUBE. While the call is connecting or connected, the form opens and captures the details of the conversation:
- Disposition — connected or not connected; ringing, switched off, and so on.
- What was discussed.

On submission, the entry is stored as a phone call activity against the lead, recording the conversation between the user and the customer.

Alongside this, build a **Forms** section where the phone call form and its fields can be configured and managed by Admins and Super Admins.

**Done when:**
- The phone call form opens automatically on an outbound call from the CRM.
- Disposition options and conversation notes are captured and saved as an activity against the lead.
- The saved activity is visible in the lead's activity history.
- Admin and Super Admin can add, edit, reorder and remove fields on the phone call form from a Forms section, without a code change.

---

## P3-15 · Product brochure attachment and in-call use

**Type:** Enhancement  **Area:** Setup → Products  **Priority:** P2

**Requirement:** Provide an option to create a new product under Product Settings. In addition, allow a **brochure** to be attached to each product — in PDF or other formats.

The brochure must serve two purposes:
1. **Ready reference on a call** — the sales caller can open it while speaking to the client, to look up further detail about the product.
2. **Sharing with the client** — the same brochure can be emailed to the client directly.

**Done when:**
- A new product can be created from Product Settings.
- A brochure can be attached to a product, with the accepted formats stated on screen.
- The brochure is accessible to the sales user during a call, from the calling screen.
- The brochure can be sent to the client by email from within the CRM.

---

## P3-17 · Template creation for Email, SMS and WhatsApp

**Type:** New Feature  **Area:** Setup → Template Management  **Priority:** P2

**Requirement:** Template Management currently offers no way to add or create a template. Provide template creation for **Email, SMS and WhatsApp**.

**WhatsApp template** — build this out in detail, with at minimum:
- Basic details
- Header
- Body
- Footer
- Buttons
- Preview

**Email and SMS templates** — build these in a comparable fashion. Apply current market best practice for how these template builders are constructed and how they connect to the underlying providers.

**Done when:**
- A new template can be created, edited, previewed and deleted for each of Email, SMS and WhatsApp.
- The WhatsApp builder supports basic details, header, body, footer, buttons and live preview.
- The Email and SMS builders are equally complete for their respective channels.
- Templates created here are selectable wherever a message is sent from the CRM, including from automation actions (P3-16).
- The proposed structure for the Email and SMS builders is shared with me before implementation.

---

## P3-18 · Facebook and Instagram lead-ads integration console

**Type:** Enhancement  **Area:** Setup → Social Integration  **Priority:** P2

**Observed:** The Facebook and Instagram management section as built is very basic.

**Requirement:** Build a detailed and advanced integration console through which Facebook and Instagram lead ads flow into the CRM. It must contain:

1. **Manage Accounts and Pages** — connect Facebook accounts, manage the pages under them, and manage the permissions on each page.
2. **Default Mapping** — map Meta field names to CRM field names.
3. **LeadGen Forms** — select an account, select a page, and connect to the lead gen forms on it.
4. **Notification Settings** — configure when and where the user is notified about incoming leads.
5. **Logs and Reports** — view logs and performance reports by account, page and form.

**Done when:**
- All five sections above exist and are functional.
- A lead submitted on a connected LeadGen form arrives in the CRM with fields mapped per the default mapping.
- Notifications fire according to the configured settings.
- Logs and reports show the flow and any failures, broken down by account, page and form.

---

## P3-33 · Lead Import module under the Leads tab

**Type:** New Feature  **Area:** Leads → Import  **Priority:** P2
**Related:** P3-34, P3-41.

**Requirement:** There is no lead import option under the Leads tab. Provide **Lead Import** there, so that users with import rights can import directly from the Leads tab — opening a new page or tab on click.

This must not be a basic feature. Build an informative, detailed, step-by-step import process, covering at minimum:
1. **Import your file** — upload the source file.
2. **Map the fields** — map the columns in the spreadsheet to the corresponding CRM fields.
3. **Validation rules** — choose whether to update the fields of an existing lead or import as a new lead; choose whether to add the imported leads to a new list; and any other useful options.

**Done when:**
- Lead Import is available under the Leads tab, and visible only to roles with import rights.
- The import runs as a guided, multi-step flow with the steps above.
- Field mapping handles both matched and unmatched columns, and the user can correct a mapping before proceeding.
- The user can choose between creating new leads and updating existing ones, and can assign the imported leads to a list.
- Each step explains what is expected of the user.

---

## P3-34 · Import result summary

**Type:** Enhancement  **Area:** Leads → Import  **Priority:** P2
**Related:** P3-33.

**Requirement:** Once leads have been imported or updated, show the result of the request — how many leads were imported and how many were updated — either in the same tab or in a separate one.

**Done when:**
- On completion, a summary shows the counts of leads imported, leads updated and rows that failed.
- Failed rows are identifiable, with the reason for failure stated.
- The summary is retrievable after the fact, not only immediately on completion.

---

## P3-35 · Lead export with ownership scope, masking and role control

**Type:** New Feature  **Area:** Leads → Export  **Priority:** P2

**Requirement:** Provide a lead export feature in the Leads tab, subject to the following controls:

- **Ownership scope** — a user exports only the leads they own, unless they hold elevated access permitting them to view or download their team members' leads.
- **Masking carries into the file** — if mobile number, email ID, PAN card or any other field is masked for that user on screen, it must be masked in the exported file too. Actual values must never appear in the export.
- **Role control** — Admins and Super Admins control which roles are permitted to export data, for leads and for every other object. Provide this control in a dedicated section under the relevant tab.

**Done when:**
- A user's export contains only the leads within their ownership scope, or their team's leads where they hold elevated access.
- Masked fields are masked in the exported file, verified by inspecting a downloaded file.
- Admin and Super Admin can grant or revoke export rights per role, per object.
- Attempting to export without the right produces a clear, permission-based message.

---

## P3-39 · Bulk update on the lead list view

**Type:** New Feature  **Area:** Leads → List View  **Priority:** P2
**Depends on:** P3-37.

**Requirement:** Once a user selects leads on the lead list — all of them or a subset — a **Bulk Update** option must appear on screen. The bulk update panel offers the following selection scopes:

1. **Update only the selected leads on this page.** The label reflects the actual count — "Update 25 leads", "Update 50 leads", "Update 100 leads" — matching what the user has selected.
2. **Select all leads across all pages.** For example, where the result set is 1,500 leads: *"Select all 1,500 leads across 34 pages"* (or however many pages the result spans).
3. **Enter a specific number.** An empty box in which the user types how many leads the action should apply to. If there are 1,500 leads in the result and the user wants to act on 900, they enter 900. **Validation:** the entered number must not exceed the number of leads available in the result — 1,501 must be rejected where only 1,500 exist.

At the bottom of the panel, the user chooses **which lead field to update** and then the **value** to set:
- The value field stays frozen and unchangeable until a lead field has been selected.
- Once a field is chosen — say *Lead Stage* — the value field presents that field's valid values.
- The user picks a value and clicks **Update** / **Save**, and the bulk update applies to that selected set of leads only.

**Done when:**
- The Bulk Update option appears as soon as one or more leads are selected.
- All three selection scopes work, with labels reflecting the real counts.
- The numeric entry is validated against the size of the result set, and an over-count is rejected with a clear message.
- The value field is disabled until a lead field is selected, then populated with that field's valid values.
- The update applies only to the selected set, and the outcome is confirmed on screen.

---

## P3-40 · Lead Details page layout and UI rework

**Type:** Enhancement  **Area:** Leads → Lead Details  **Priority:** P2

**Observed:** On the Lead Details page, **Lead Score, AUM, Owner, Last Contact** and **Risk** are not presented well. There are also empty gaps in the layout, which look unfinished.

**Requirement:** Rework the page so the layout is clean and the interface is genuinely good to use:
- Align these elements properly and fill the empty space with something worthwhile.
- Make the Back button to the Leads list prominent enough that users find it easily.
- Do not disturb the other fields and data already on the page, specifically: **Products**, the tab strip as a whole, **Product Details**, **Market Activity Notes**, and everything else currently present.

Overall: align all the detail on the Lead Details page into an outstanding, engaging interface. Apply your own judgement and deliver the best result you can.

**Done when:**
- Lead Score, AUM, Owner, Last Contact and Risk are laid out cleanly and consistently.
- No unexplained empty space remains in the layout.
- The Back button is easy to locate.
- Products, the tabs, Product Details, Market Activity Notes and all existing data remain intact and fully functional.
- A design preview is shared with me before the change is finalised.

---

## P3-42 · Sales Supervisor — Sales Console, lead access and task assignment

**Type:** Enhancement  **Area:** Roles & Permissions  **Priority:** P2
**Related:** P3-07, P3-08.

**Observed:** On the Sales Supervisor login, neither the **Sales Console** nor **Lead object access** is available.

**Requirement:** The Sales Supervisor plays a central role in managing the sales team — the sales RMs report to them — so this access is essential:

- **Sales Console access** — the supervisor must be able to see the status of the leads assigned to their team members.
- **Task creation and assignment** — where an RM has missed a follow-up, or where the supervisor wants a particular lead prioritised, the supervisor must be able to create a task and assign it to that team member.
- **Notification with lead redirection** — the assigned user is notified that their manager has assigned them a task for a lead. The notification carries a link to the lead; clicking it opens that lead, so the user can see exactly which record to work on.

**Done when:**
- The Sales Supervisor login has Sales Console access and Lead object access, scoped to their team.
- The supervisor can create a task and assign it to a team member.
- The assignee receives a notification naming the manager and the lead, containing a working link that opens the correct lead record.

---

## P3-43 · Sales Supervisor — lead import and masked export

**Type:** Enhancement  **Area:** Roles & Permissions  **Priority:** P2
**Related:** P3-33, P3-35, P3-42.

**Requirement:** The Sales Supervisor must also be able to **export** and **import** leads, with the full set of lead import capabilities described in P3-33.

For export, apply masking to sensitive fields — **mobile number, email ID, PAN number, bank account details** and similar — so that these are masked in any file the Sales Supervisor exports.

**Done when:**
- The Sales Supervisor can run a lead import with the complete feature set of P3-33.
- The Sales Supervisor can export leads, and the exported file has mobile number, email ID, PAN number and bank account details masked.
- Masking behaviour is verified by inspecting an actual downloaded file.

---

# P3 — Large builds

---

## P3-06 · Reports module — predefined reports and custom report builder

**Type:** New Feature  **Area:** Reports  **Priority:** P3

**Observed:** There is no Reports section in the CRM — neither predefined reports nor a custom report capability.

**Requirement:** Build a full, detailed Reports module containing:

1. **Predefined reports** — a standard library available out of the box. Take Salesforce and LeadSquared as the reference for which reports a CRM of this kind should ship with.
2. **Custom report builder** — allow a user to build their own report on a filter basis, in the manner Salesforce offers.

The builder must be genuinely easy to use. Guide the user through each step: what to select, how to select it, which values to use — and offer suggestions as they go. The whole module should be easy to reach and use, with outstanding UI and UX.

**Done when:**
- A Reports section exists, accessible from the main navigation.
- A library of predefined reports ships with the module, benchmarked against Salesforce and LeadSquared; the proposed list is shared with me before build.
- A custom report builder allows a report to be assembled on a filter basis, step by step.
- Each step of the builder carries guidance on what to select and why, with suggested values.
- Reports can be saved, re-run, shared and exported.
- Report visibility respects the role hierarchy and ownership rules.

**Note:** This is a large module. Present the module design and the predefined report list for approval before implementation begins.

---

## P3-16 · Advanced automation builder

**Type:** Enhancement  **Area:** Automation  **Priority:** P3

**Observed:** The automation rule builder currently in the product is very basic. I was expecting something considerably more advanced — comparable to what Salesforce and LeadSquared offer, where automation can be built against any record or object.

**Requirement:** Rebuild the automation builder as a detailed, multi-stage, genuinely user-friendly tool with excellent UI and UX. The structure below describes what I expect.

### 1. Triggers

Automation should be able to start from any of the following trigger types:

- **Activity-based trigger**
- **Lead-based trigger**
- **User-based trigger**
- **Task-based trigger**

Each trigger type then offers its own options. For example:

| Trigger type | Example options |
|---|---|
| Lead | New lead; lead updated; lead added to a list on a specific date |
| Activity | New activity on a lead (form submission, page visit, etc.); activity updated on a lead (sales activity, etc.); new activity on an activity (service date, etc.) |
| User | Start of workday; end of workday; on a specific date |
| Task | Task created on a lead; task reminder for a lead; task updated on a lead; task completed on a lead; task created for an opportunity |

These are examples of the conditions I expect, not an exhaustive list. The current opportunity automation is very basic by comparison.

### 2. Conditions and flow control

Once a trigger is selected, the user adds conditions to it. The condition and flow-control set should include:

- If lead exists
- If / Else card
- Multi If / Else card
- Split test
- Wait card
- Wait (Advanced) card
- Wait until activity
- Wait until workday

### 3. Actions

Actions follow the conditions, organised into categories:

| Category | Actions |
|---|---|
| **Messaging** | Send email; send SMS; send opt-in email; send WhatsApp |
| **Lead actions** | Add activity; add lead to list; remove lead from list; star lead; update lead |
| **Sales execution** | Create task; distribute lead; notify user; notify owner by SMS |
| **Custom** | Call a LAPP; nudge users; webhook |
| **Online meetings** | Online meeting provider — e.g. Zoom |
| **Sub-automations** | Send to sub-automation |

### 4. Automation reporting

An automation report is required, showing how many leads have been affected by an automation and how many leads have triggered it.

### Direction

Take the structure above as the reference and build something matching this concept — it need not be identical, but it must reach this level of capability. The builder must be more informative, more detailed and more user-friendly than what exists today. Apply your own judgement, and study how the Salesforce automation builder works, so that these requirements are met properly.

**Done when:**
- All four trigger types are available, each with its own option set.
- The condition and flow-control cards listed above are available and can be nested.
- All action categories and actions listed above are available.
- An automation report shows leads affected and leads triggered, per automation.
- Automations can be saved as drafts, activated, paused and versioned.
- The builder design is presented to me for review before implementation begins.

---

## P3-14 · Call recording, transcription and AI call summary

**Type:** New Feature  **Area:** Telephony / AI  **Priority:** P3
**Depends on:** P3-44, P3-13.

**Requirement:** When a user completes a phone call, pull both the **transcription** and the **call recording** for that conversation from CUBE into the CRM. The recording must be playable within the CRM, and an **AI summary** of the call must be generated from the transcription pulled from CUBE.

**Done when:**
- The call recording is retrieved from CUBE and attached to the corresponding call activity.
- The recording plays inside the CRM without requiring a download.
- The transcription is retrieved and stored against the same activity.
- An AI summary is generated from the transcription and displayed alongside the call record.
- The behaviour when a recording or transcription is unavailable from CUBE is defined and handled.

---

## P3-20 · Apps marketplace / connectors section

**Type:** New Feature  **Area:** Integrations  **Priority:** P3

**Requirement:** Introduce an apps marketplace — in effect a connectors section — where third-party applications can be connected with a single click, each with its own configuration screen. Connectors to cover include:

- Freshdesk connector
- Nudges connector
- R2win Digital SMS connector
- Kaleyra SMS
- Facebook
- Instagram
- Google Ads Lead Form connector
- Zoom Meeting connector
- WhatsApp Business connector
- Universal Telephony connector
- and others

**Direction:** Analyse how a connectors section can be introduced into our CRM so that connecting external applications — WhatsApp, Google, Facebook and the rest — becomes straightforward. Study how Salesforce and LeadSquared implement this, assess whether we can build the equivalent, and develop it for our CRM.

**Done when:**
- A connectors section exists, listing available connectors with a clear connected/not-connected state.
- Each connector has its own configuration screen and can be connected, reconfigured and disconnected.
- Credentials are stored securely and are not exposed in the UI or in logs.
- Connection health and errors are visible per connector.
- A feasibility assessment covering the listed connectors is shared with me before build, identifying which are viable in this phase.

---

## P3-19 · LAPPS — scriptable custom app framework

**Type:** New Feature  **Area:** Integrations  **Priority:** P3

**Requirement:** Introduce a feature for managing **LAPPS**. LAPPS are the LeadSquared Apps the team used to integrate third-party tools with the CRM, written as JavaScript running on Node.js 22.x. I want to build an equivalent capability here.

**Direction:** Research how LeadSquared uses LAPPS — what they are used for and how they benefit the business — assess whether the same capability is valuable for our business, and, if so, build the equivalent in our CRM.

**Done when:**
- A feasibility assessment covering purpose, business value for Bonanza, and the security and execution model is shared with me *before* any implementation.
- Subject to my approval of that assessment: a LAPPS management section exists where a script can be created, edited, versioned and executed.
- Scripts run in a sandboxed environment with defined resource and permission limits.
- Execution logs and errors are visible per script.
- A LAPP can be invoked from an automation action (see P3-16, *Custom → Call a LAPP*).

---

## P3-21 · Internal communication module

**Type:** New Feature  **Area:** Collaboration  **Priority:** P3

**Requirement:** Build a Slack-style internal communication module inside the CRM, so all CRM users can message one another — under controls set by administrators.

- **Admin controls** — administrators determine who may message whom. Sensitive conversations can be monitored and restricted.
- **Lead transfer and escalation in context** — when a lead is transferred or escalated, that should be visible inside the CRM. A user who wants a lead transferred to their ownership can message the relevant manager or colleague directly from the CRM. The message reaches that person as a raised request.
- **Request outcome notifications** — if the request is fulfilled, the requester is notified that the lead has been transferred to them. If it is declined, they are notified that it has not been transferred.

**Done when:**
- Users can send and receive direct messages within the CRM.
- Admins can configure who may message whom, and can monitor and restrict sensitive conversations.
- A lead transfer request can be raised from a conversation and is delivered to the target user as an actionable request.
- The requester is notified of the outcome in both the approved and the declined case.
- Lead transfers and escalations conducted this way are recorded against the lead.
- The module design is reviewed with me before implementation begins.

---

# Open questions

Raise these with me before starting the affected tickets. **Do not assume anything** — where a requirement is unclear, ask.

| # | Ticket | Question |
|---|---|---|
| Q1 | P3-01 / P3-22 | These two points cover the same Audit Log screen. Confirm they should be delivered as a single piece of work. |
| Q2 | P3-02 / P3-03 | Share the proposed user-field list drawn from the LeadSquared and Salesforce benchmark for my sign-off before building. |
| Q3 | P3-07 | Confirm the full Bonanza role hierarchy, level by level, before the tree is modelled. |
| Q4 | P3-09 | What should happen if a user's session ends without an explicit check-out? |
| Q5 | P3-10 | How should the system behave when the user denies location permission or location is unavailable? |
| Q6 | P3-28 | For each AI summary button, confirm the exact action it should perform. |
| Q7 | P3-38 | Which columns are mandatory and must not be deselectable on the lead list view? |
| Q8 | P3-27 | What should occupy the homepage space freed by shortening the System Activity Log? |
| Q9 | P3-06 | Approve the predefined report list and the module design before build. |
| Q10 | P3-16 | Approve the automation builder design before build. |
| Q11 | P3-19 | Present the LAPPS feasibility assessment — value, security model, execution sandbox — before any build. |
| Q12 | P3-20 | Confirm which connectors are in scope for this phase. |

---

**Closing note:** Please review every point above and implement the required fixes and changes in the stated priority order. Where any requirement is unclear, contact me for clarification before proceeding. **Do not make assumptions while implementing.** Any uncertainty must be resolved before work begins.
