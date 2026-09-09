# Bonanza AI CRM — Testing Feedback & Change Requests

**Prepared by:** Ritesh
**Date:** 26 August 2026
**Round:** 1
**Scope tested:** Login, homepage / role cockpits, Leads, Product Cards, Market, Pipeline, Lead Lists, Clients, Setup, App Launcher, Partner Portal and DKYC.

---

## 1. Purpose

While testing the portal developed so far, I identified a number of issues that need to be addressed. I have also suggested several changes and enhancements. Please review every point below and implement the necessary fixes and improvements.

## 2. Ground rules — please read before starting

1. **Do not make any assumptions.** If a requirement is unclear, incomplete or open to interpretation, stop and ask me before implementing. Clarifying upfront is far cheaper than reworking later.
2. **Raise your questions in one batch, up front.** Section 4 lists the points where I already expect you will need clarification, along with the specific questions. Please answer or challenge those first, before starting development.
3. **Apply changes consistently.** Where a fix or pattern applies to more than one screen, object or role, apply it everywhere it is relevant — not only on the screen where I happened to notice it. Each item states its intended scope.
4. **Do not break what already works.** Where an item asks for a layout change, verify that surrounding components, tabs and cards are not displaced or visually broken.
5. **Keep it configurable and maintainable.** Where I have asked for admin control over a behaviour, build it as a setting in Setup rather than hard-coding it. Other administrators need to be able to take this over later.
6. **Report back per item ID.** When you respond, please reference the item IDs below (e.g. `BUG-20`, `ENH-10c`) so we can track status cleanly.

## 3. How to read this list

| Field | Meaning |
| --- | --- |
| **ID** | Stable reference. `BUG-` = defect, `ENH-` = enhancement / new requirement. The number matches my original numbering, so `ENH-10c` is point 10(c). |
| **Area** | Screen or module affected. |
| **Priority** | ⚠️ **Suggested by Claude, not confirmed by Ritesh — please treat as a proposal and confirm with me before sequencing.** `P0` = broken or unusable, `P1` = significant functional or usability gap, `P2` = polish / lower impact. |
| **Issue** | What I observed. |
| **Expected** | What it should do instead. |
| **Scope** | Where the change must be applied. |
| **Q-xx** | A cross-reference to an open question in Section 5 that must be answered before this item is built. |

### Suggested priority summary

| Priority | Count | Item IDs |
| --- | --- | --- |
| **P0** — broken / unusable | 7 | 07, 13, 20, 21, 25, 26, 27 |
| **P1** — significant gap | 26 | 02, 05, 05a, 06, 08, 10a, 10b, 10c, 10d, 12, 14, 15, 16, 17, 18, 21a, 21b, 21c, 23b, 24, 24a, 24b, 28, 28a, 28b, 28c |
| **P2** — polish | 10 | 01, 03, 04, 09, 10, 11, 19, 22, 23, 23a |
| | **43 total** | |

---

## 4. Items

---

### `BUG-01` — Email field is not aligned with the password field
**Area:** Login page · **Priority:** P2

- **Issue:** On the login page, the Email ID input box is not the same size as the Password input box, so the two fields do not align.
- **Expected:** Both input fields should be identical in width, height and alignment.
- **Scope:** Login page; also check any other paired input fields for the same inconsistency.

---

### `BUG-02` — Email value is unreadable in dark theme
**Area:** Login page · **Priority:** P1

- **Issue:** On the login page in dark theme, the Email ID field renders as a bright white box and the entered value is washed out. Once focus moves away from the field, the value is not visible at all.
- **Expected:** Field background, text colour and contrast must respect the dark theme so the entered value stays clearly readable in both the focused and unfocused states.
- **Scope:** Login page. Related dark-theme contrast issues elsewhere are covered in `BUG-18`.

---

### `ENH-03` — Replace the static market-updates ticker with a scrolling ticker
**Area:** Login page → global · **Priority:** P2

- **Issue:** The simulated market-updates feed on the login page is not useful in its current form, because only a subset of the updates is ever visible.
- **Expected:** Convert it into a continuously scrolling (marquee-style) ticker so that all updates in the feed are shown in rotation.
- **Scope:** The scrolling ticker should be available across all pages, not just the login page.
- **Read together with `ENH-04`** — visibility per role is controlled there. See **Q-03**.

---

### `ENH-04` — Make the market-update banner role- and user-controlled
**Area:** Global · Setup / access control · **Priority:** P2

- **Issue:** The market-update banner is currently shown indiscriminately, but it is only relevant to some roles.
- **Expected:**
  - Show the market-update banner only to roles for which it is relevant.
  - Provide a configuration screen in Setup where an Admin or Super Admin can toggle the market-update feature **on or off, by role and by individual user**.
- **Scope:** All roles and all users. See **Q-04**.

---

### `ENH-05` — Make summary-card figures clickable and drill through to the underlying records
**Area:** Homepage / all role cockpits · **Priority:** P1

- **Issue:** Summary cards on the homepage display counts, but the counts are static text. A user cannot get from the number to the records behind it.
- **Expected:** Every count on every summary card should be a clickable link that navigates to the corresponding object, pre-filtered to exactly the records that card counted.
  - Example: on the Super Admin homepage, the card reads "21 Active Users". Clicking **21** should open the Users list filtered to those 21 active users.
  - Example: clicking **36 Total Leads** should open the Leads list filtered to those 36 leads.
- **Scope:** Every summary card, on every object, across every role. See **Q-05**.

---

### `ENH-05a` — Extend drill-through to every role's cockpit
**Area:** All role cockpits · **Priority:** P1

- **Expected:** The same drill-through behaviour must be configured in each role's own cockpit and for each object that role has access to.
- **Scope:** It must respect that role's data access — a user must only ever land on records they are permitted to see.

---

### `ENH-06` — Make the lead's email address actionable
**Area:** Lead details · **Priority:** P1

- **Issue:** The email address on a lead record is plain, non-interactive text.
- **Expected:** Clicking the email address should open an email composer in a pop-up, pre-addressed to that lead. The composer must expose the full set of email options, including:
  - selecting a saved template as the starting point for a new email,
  - composing free-form content,
  - attaching files,
  - and the other standard sending options.
- **Scope:** Everywhere a lead's email address is displayed. See **Q-06**.

---

### `BUG-07` — "Ask the Copilot" breaks the page layout
**Area:** Global → AI Copilot · **Priority:** P0 (defect) / P2 (polish sub-item)

- **Issue:** The **Ask the Copilot** button does not work properly. Once a question is asked, the layout of the current page spills / breaks.
- **Expected (P0):** Fix the layout defect so the Copilot panel opens and responds without disturbing the underlying page.
- **Expected (P2):** Add subtle animation and visual emphasis to the Copilot button. The AI capability is the USP of this product, so it should stand out enough that users notice it and use it from any tab, at any point in their workflow — without becoming distracting.

---

### `ENH-08` — Show each role only the tabs it needs, and let admins control this
**Area:** Global · Setup / access control · **Priority:** P1

- **Issue:** Roles are currently shown tabs that are not relevant to them. For example, the **Approvals** tab is not applicable to every role, yet it is broadly visible.
- **Expected:**
  - Restrict each role's tab set to the tabs that role actually needs. Apply your judgement to identify tabs a role has no use for and remove them.
  - Provide a configuration screen where an Admin or Super Admin can control tab access for every role.
- **Scope:** All roles, all tabs.
- ⚠️ **Do not assume which tabs belong to which role. Confirm the role-to-tab matrix with me first — see Q-08.**

---

### `ENH-09` — Make Market tab items link to the full article
**Area:** Market · **Priority:** P2

- **Expected:** Each item on the Market tab should be a clickable link that opens the source news page, so the user can read the full story.

---

### `ENH-10` — Rename the "Product Card" object to "Products"
**Area:** Global · **Priority:** P2

- **Expected:** Rename the object from **Product Cards** to **Products** everywhere it appears — tabs, page titles, card headings, buttons, menus, labels and any other user-facing text.
- **Scope:** The entire application, all roles. See **Q-10**.

---

### `ENH-10a` — Replace the dot-based product status summary with something readable at a glance
**Area:** Lead details → Products · **Priority:** P1

- **Issue:** The product status summary rendered as a row of dots on the lead details page is not helpful. A user has to hover over each dot individually to find out the status of each product.
- **Expected:** Replace it with a representation that is immediately understandable without any interaction — for example labelled status chips, a colour-coded legend, or a compact list showing each product name alongside its status.
- **Scope:** Everywhere this dots pattern is used for product status.

---

### `ENH-10b` — Rework the product actions so they drive the next step
**Area:** Products · **Priority:** P1

- **Issue:** The current product actions — **Move Forward**, **View** and **Start Engaging** — do not serve their purpose. When a user clicks **Move Forward**, they are given no indication of what the next best action actually is, or what they are supposed to do.
- **Expected:** Make the actions genuinely directive. **Move Forward** should state explicitly what the next step is for that product at its current stage, and let the user act on it there and then.
- **Scope:** All product actions, all roles. See **Q-10b**.

---

### `ENH-10c` — Make the product View pop-up informative
**Area:** Products → View · **Priority:** P1

- **Issue:** The pop-up opened by the **View** button is thin on content and not engaging.
- **Expected:** Redesign the pop-up to be substantially more informative and useful. It should give the user a complete, well-organised picture of that product against that lead, along with the actions they can take from there.

---

### `ENH-10d` — Give "Start Engaging" concrete quick actions
**Area:** Products → Start Engaging · **Priority:** P1

- **Issue:** When a user clicks **Start Engaging**, they are not told what engagement involves or what they should do next.
- **Expected:** Present clear quick-action buttons at that point — for example **Start a Call**, **Send a WhatsApp Message**, **Send an Email**, and similar.
- **Overall note on point 10:** Products is one of the most important sections of the entire CRM. Please invest the effort to make the whole object genuinely engaging and informative, not merely functional.

---

### `ENH-11` — Group the Next Best Action and Start Call buttons
**Area:** Lead details · **Priority:** P2

- **Issue:** The **Next Best Action** and **Start Call** buttons on the lead details page sit loose on the page, with nothing separating them from the surrounding content.
- **Expected:** Place them inside a distinct container with an icon or similar visual treatment, consistent with the existing **Actions** button.

---

### `ENH-12` — Clarify what the "Warm" card is counting
**Area:** Sales RM cockpit · **Priority:** P1

- **Issue:** The "Warm cards" summary shown in the Sales RM view is ambiguous. It is not clear whether it refers to leads at a warm stage or to products with a warm status.
- **Expected:** Relabel and present the card so its meaning is unambiguous at a glance.
- ⚠️ **Confirm the intended definition with me before changing it — see Q-12.**

---

### `BUG-13` — Quick Actions section on the homepage does nothing
**Area:** Homepage → Actions · **Priority:** P0

- **Issue:** The Actions section on the homepage lists actions such as Call, WhatsApp and Send Brochure. Clicking any of them produces no response — nothing opens and nothing is logged.
- **Expected:** Each action must perform its intended function, so that the space we have allocated to it serves its purpose.
- **Scope:** All actions in this section, across all roles that see it. See **Q-13** — I need to tell you which channels are actually integrated before you decide how these behave.

---

### `ENH-14` — Add a contextual AI help button on every tab
**Area:** Global · **Priority:** P1

- **Expected:** Provide an AI assistance button on every tab so users can get help wherever they get stuck — similar in spirit to **Ask the Copilot** and **Next Best Action**. Place it wherever it aligns best on each page.
- **Capabilities required:** The assistant should answer questions about the object or record the user is currently on, **and** questions relating to other tabs and areas of the CRM. Where the answer relates to a specific record or page, it should return a clickable link that takes the user straight there.
- **Note:** Please apply your best judgement and build something genuinely useful — this is a differentiating feature, not a checkbox. See **Q-14**.

---

### `ENH-15` — Make Advanced Search understandable for end users
**Area:** Leads → Advanced Search · **Priority:** P1

- **Issue:** The Advanced Search section under the Leads tab is confusing. Users do not understand what "Add Group" and "Add Condition" mean, how the AND / OR operators work, or how to build a valid filter.
- **Expected:** Redesign the experience so a non-technical user can build a filter confidently — for example through plain-language labels, inline help or tooltips, a visual preview of the logic being built, and sensible defaults or ready-made filter templates.
- **Scope:** Advanced Search wherever it appears, not only on Leads.

---

### `ENH-16` — Unmask fields for privileged roles, and make masking configurable
**Area:** Global · Setup / access control · **Priority:** P1

- **Expected:**
  - All fields currently masked should be **unmasked** for the **Admin**, **Super Admin** and **Marketing Manager** roles.
  - Provide a configuration screen where Admins and Super Admins can select which fields are masked, for whichever roles they choose.
- **Scope:** All objects and all roles. See **Q-16**.

---

### `ENH-17` — Move the record tabs above the summary boxes on Lead Details
**Area:** Lead details · **Priority:** P1

- **Issue:** The Product Cards, Details, Market, Activity, Notes, Tasks and Tickets tabs sit below the summary boxes, the lead detail block and the Start Call / Next Best Action buttons. Users struggle to find them.
- **Expected:** Move this tab strip to the top of the page — above the summary boxes, lead details block and the Start Call / Next Best Action buttons — so users can locate it immediately and move between tabs easily.
- **Scope:** Lead details, and any other record detail page using the same layout.
- ⚠️ **Re-align the page carefully so that no other tab, card or box is displaced or visually broken by this change.**

---

### `BUG-18` — Field values are unreadable in dark theme on the Lead edit page
**Area:** Lead details → Edit · **Priority:** P1

- **Issue:** On the Lead details edit page in dark theme, field values are obscured by an over-bright white background.
- **Expected:** All field values must remain clearly readable in dark theme, with appropriate background and text contrast.
- **Scope:** Please audit this systematically — check every tab, every object and every role for the same dark-theme contrast problem, and fix all occurrences, not just this page.

---

### `ENH-19` — Standardise input field styling on the Lead edit page
**Area:** Lead details → Edit · **Priority:** P2

- **Issue:** The Name, Email and Mobile Number input boxes do not look consistent with the other fields on the page.
- **Expected:** Restyle them to match the existing Stage, Source and Owner fields — the same soft, rounded, glass-edged treatment (iPhone-inspired).
- **Scope:** Every screen where this text-field format appears, so that input styling is consistent across the product.

---

### `BUG-20` — Pipeline tab shows no data
**Area:** Pipeline · **Priority:** P0

- **Issue:** The Pipeline tab is empty — no records are displayed.
- **Expected:** Investigate and fix, so the Pipeline tab loads and displays the correct data for the logged-in user's access.

---

### `BUG-21` — "Log an Activity" does not open from the Actions tab
**Area:** Actions → Log an Activity · **Priority:** P0

- **Issue:** Selecting **Log an Activity** from the Actions tab does nothing.
- **Expected:** It should either open the Log an Activity pop-up or navigate the user to the Log an Activity screen.

---

### `ENH-21a` — Highlight the Connected / Not Connected selection
**Area:** Log an Activity · **Priority:** P1

- **Issue:** The **Connected**, **Not Connected** and related options are visually lost among the other values on the form.
- **Expected:** Present them in a clearly highlighted, visually separated block so the user can see and select them easily.

---

### `ENH-21b` — Improve the overall Log an Activity experience
**Area:** Log an Activity · **Priority:** P1

- **Expected:** Rework the Log an Activity screen to be markedly more user-friendly. This is a high-frequency screen for sales users, so the UX needs to be fast, clear and low-effort.

---

### `ENH-21c` — Make call dispositions configurable in Setup
**Area:** Setup · **Priority:** P1

- **Expected:** Provide configuration in Setup for Admins and Super Admins to define and maintain the **Connected** and **Not Connected** dispositions used when logging an activity. See **Q-21c**.

---

### `ENH-22` — Surface the Setup button outside the App Launcher
**Area:** Global navigation · **Priority:** P2

- **Expected:** Place the **Setup** button directly in the main navigation, outside the App Launcher, for every role that has Setup access.

---

### `ENH-23` — Make the App Launcher more visually engaging
**Area:** Global navigation · **Priority:** P2

- **Expected:** Add animation and colour to the App Launcher button on hover, so it feels responsive and inviting.

---

### `ENH-23a` — Resize and reposition the App Launcher icon
**Area:** Global navigation · **Priority:** P2

- **Issue:** The App Launcher dots icon is too small.
- **Expected:** Increase its size and reposition it so it sits comfortably within the existing header alignment and improves the overall look. Take design inspiration from the Salesforce App Launcher and deliver the best equivalent for our layout.

---

### `ENH-23b` — Restrict App Launcher contents by role
**Area:** Global navigation · **Priority:** P1

- **Expected:** The App Launcher should list only the tabs and apps the logged-in role actually has access to. No additional or inaccessible entries should be shown.

---

### `ENH-24` — Introduce a Dashboard
**Area:** Dashboard · **Priority:** P1

- **Issue:** There is no Dashboard tab in the portal.
- **Expected:** Introduce a Dashboard containing graphs and summaries of the records the logged-in user has access to.
- **Scope:** All roles, each seeing only their own permitted data. See **Q-24**.

---

### `ENH-24a` — Let users choose the dashboard date range
**Area:** Dashboard · **Priority:** P1

- **Expected:** Where applicable, allow users to select the date range / timeframe for the data shown on each dashboard.

---

### `ENH-24b` — Decide the Dashboard's placement
**Area:** Dashboard · **Priority:** P1

- **Expected:** Placing the Dashboard within the homepage is acceptable and preferred if it works well there. If it does not fit cleanly, create a separate **Dashboard** tab instead.

---

### `BUG-25` — Lead Lists tab does not work
**Area:** Lead Lists · **Priority:** P0

- **Issue:** The Lead Lists tab is not functioning correctly.
- **Expected:** Make the tab fully functional:
  - Users must be able to add leads to a list.
  - Users must be able to apply the relevant actions to a list and to the leads within it.
  - Provide options to create different list types, including a blank (static) list, a refreshable list and a dynamic list.
- **Scope:** All roles that have access to Lead Lists. See **Q-25**.

---

### `BUG-26` — Clients tab shows no data, and its visibility is not restricted
**Area:** Clients · **Priority:** P0

- **Issue:** The Clients tab displays no data.
- **Expected:**
  - Investigate and fix, so client data loads correctly.
  - Restrict visibility of the Clients tab to only those roles that genuinely need to see client data. No other role should see the tab at all.
- **Scope:** All roles. See **Q-26**.

---

### `BUG-27` — Partner Portal and DKYC links point to the wrong URLs
**Area:** Partner Portal · DKYC · **Priority:** P0

- **Issue:** Both links currently resolve to URLs that are missing the `/ai-crm` path segment.
- **Expected:**

| Module | Current (incorrect) | Required |
| --- | --- | --- |
| DKYC | `https://labs.tinyepic.in/dkyc` | `https://labs.tinyepic.in/ai-crm/dkyc` |
| Partner Portal | `https://labs.tinyepic.in/portal` | `https://labs.tinyepic.in/ai-crm/portal` |

- ⚠️ **Confirm this mapping with me before deploying — see Q-27.**

---

### `ENH-28` — Make the Partner Portal usable
**Area:** Partner Portal · **Priority:** P1

- **Issue:** The Partner Portal is not user-friendly. Nothing on the page is clickable or interactive.
- **Expected:** Rework it into a genuinely usable interface, where the key elements are interactive and lead somewhere meaningful.

---

### `ENH-28a` — Clarify the Commission Trend view
**Area:** Partner Portal → Commission · **Priority:** P1

- **Issue:** The commission trend is confusing and hard to interpret.
- **Expected:** Present it so a partner can immediately understand how their commission is trending and what is driving it — clear labelling, a clear time axis, and a plain-language summary where helpful.

---

### `ENH-28b` — Allow drill-down into a client from the Partner Portal
**Area:** Partner Portal → Clients · **Priority:** P1

- **Expected:** Clicking a client box should open a detail view with more information about that client.

---

### `ENH-28c` — Show training module detail
**Area:** Partner Portal → Training · **Priority:** P1

- **Expected:** Clicking **Training Modules** should show the detail of the pending modules, so the partner can see what is outstanding and complete them.

---

## 5. Questions I need you to answer before you build

These are the points where my requirement is genuinely open to interpretation. **Please answer or raise all of these in one batch before you start work — do not proceed on an assumption.** If anything else in Section 4 is unclear to you, add it to this list rather than guessing.

| Ref | Item | Question |
| --- | --- | --- |
| **Q-03** | `ENH-03` | Point 3 says the scrolling ticker should be visible to all roles on all pages, while point 4 says the market-update feature should be role-controlled. Which takes precedence? My intent is that the *ticker format* is global, but *who sees it* is governed by the role/user toggle — please confirm. |
| **Q-04** | `ENH-04` | Should the toggle operate at role level, user level, or both (with the user setting overriding the role default)? What should the default be for a newly created user? |
| **Q-05** | `ENH-05` | When a user clicks a summary-card figure, should the filtered list open in the same tab or a new tab? Should the applied filter be visible and editable on the destination list, and should the user be able to save it as a view? |
| **Q-06** | `ENH-06` | (a) Which email service will actually send these emails? (b) Does a template library already exist, or does one need to be built as part of this? (c) Should a sent email be logged automatically as an Activity against the lead? (d) Are there attachment size or file-type restrictions? |
| **Q-08** | `ENH-08` | I need to give you the definitive role-to-tab matrix. Please send me the current list of all tabs and all roles in a table, and I will mark which combinations should be visible. Also confirm: should tab access be controlled at role level only, or should an admin be able to override it for an individual user? |
| **Q-10** | `ENH-10` | Does the "Product Cards → Products" rename apply to display labels only, or should it also extend to internal object names, API names, field names and database references? |
| **Q-10b** | `ENH-10b` | To make "Move Forward" directive, I need to confirm the product stage model with you: what are the defined stages, and what is the expected next best action at each one? Please list what is currently implemented and I will confirm or correct it. |
| **Q-12** | `ENH-12` | Confirm what "Warm" is intended to measure on the Sales RM cockpit — the lead's stage, the product's status, or both as separate cards. Please tell me what the card is computing today before you change the label. |
| **Q-13** | `BUG-13` | For Call, WhatsApp and Send Brochure: which of these have a live integration available (telephony / dialler, WhatsApp business provider, document repository)? For any that do not, confirm with me whether we simulate the action for now or hide it until the integration is ready. |
| **Q-14** | `ENH-14` | Should this be the *same* assistant as "Ask the Copilot", made context-aware and present on every page, or a *separate* assistant? My preference is one assistant, but confirm the technical implication. Also confirm that the assistant will only ever surface records the logged-in user is permitted to see. |
| **Q-16** | `ENH-16` | Please send me the current list of masked fields, per object, with the roles they are masked for. I will confirm the target state from that list. Also confirm whether masking should be role-based only, or whether we also need field-level conditions. |
| **Q-21c** | `ENH-21c` | Please share the Connected / Not Connected disposition values currently hard-coded in the application. I will confirm the list to seed as defaults before you make them configurable. |
| **Q-24** | `ENH-24` | Which metrics and charts should appear on the dashboard for each role? Send me a proposed list per role and I will confirm. Also confirm the default date range to load (e.g. current month). |
| **Q-25** | `BUG-25` | (a) Confirm the exact definition of each list type — blank/static, refreshable, dynamic — and the refresh cadence for a dynamic list. (b) Which bulk actions should be available on a list (e.g. reassign owner, bulk stage update, add to a nurture programme, export)? |
| **Q-26** | `BUG-26` | Which roles should see the Clients tab? Also confirm what defines a Client in our data model versus a converted Lead — is it a separate object or a lead status? |
| **Q-27** | `BUG-27` | Please confirm the URL mapping in the table above. My original note had the two modules listed in the opposite order; my intent is simply that both links gain the `/ai-crm` path segment, so DKYC goes to `/ai-crm/dkyc` and the Partner Portal goes to `/ai-crm/portal`. Confirm before deploying. |
| **Q-GEN** | All UI items | Is there an existing design system, style guide or component library I should be building to? Several items (`ENH-19`, `ENH-23`, `ENH-23a`) reference a visual style, and I want these applied as reusable tokens/components rather than one-off CSS. |

---

## 6. Re-testing checklist

I will walk the portal again against this list once the fixes land. Please confirm each line as Done, Partially Done or Blocked (with the reason), and note which role and screen you verified it on.

**Login**

- [ ] `BUG-01` Email and password fields are the same size and aligned
- [ ] `BUG-02` Email value stays readable in dark theme, focused and unfocused
- [ ] `ENH-03` Market ticker scrolls continuously and shows all updates
- [ ] `ENH-04` Market banner appears only for permitted roles/users; toggle exists in Setup

**Homepage / cockpits**

- [ ] `ENH-05` Every summary-card figure is clickable and lands on the correct filtered records
- [ ] `ENH-05a` Drill-through verified in each role's cockpit, honouring data access
- [ ] `BUG-13` Call, WhatsApp and Send Brochure all perform their intended action
- [ ] `ENH-12` "Warm" card label is unambiguous in the Sales RM view

**Leads**

- [ ] `ENH-06` Clicking a lead's email opens the composer with templates and attachments
- [ ] `ENH-15` Advanced Search is understandable without training
- [ ] `ENH-17` Record tabs sit above the summary boxes; nothing else is displaced
- [ ] `BUG-18` No dark-theme contrast issues on Lead edit — and none found on other objects/roles
- [ ] `ENH-19` Name, Email and Mobile inputs match the Stage/Source/Owner styling everywhere
- [ ] `BUG-20` Pipeline tab loads data
- [ ] `BUG-25` Lead Lists works: add leads, apply actions, create static/refreshable/dynamic lists
- [ ] `BUG-26` Clients tab loads data and is visible only to the agreed roles

**Products**

- [ ] `ENH-10` No instance of "Product Card" remains in the UI
- [ ] `ENH-10a` Product status is readable at a glance, no hover required
- [ ] `ENH-10b` "Move Forward" states the next best action explicitly
- [ ] `ENH-10c` View pop-up is informative and complete
- [ ] `ENH-10d` "Start Engaging" offers concrete quick actions

**AI, navigation and access control**

- [ ] `BUG-07` Copilot answers without breaking the page layout; button is visually prominent
- [ ] `ENH-08` Each role sees only its permitted tabs; admin tab-control screen works
- [ ] `ENH-09` Market items link out to the source article
- [ ] `ENH-11` Next Best Action and Start Call are grouped in a styled container
- [ ] `ENH-14` AI help button present on every tab, answers cross-object questions, returns working links
- [ ] `ENH-16` Fields unmasked for Admin / Super Admin / Marketing Manager; masking control works
- [ ] `ENH-22` Setup button appears outside the App Launcher for permitted roles
- [ ] `ENH-23` App Launcher animates and colours on hover
- [ ] `ENH-23a` App Launcher icon is larger and well positioned
- [ ] `ENH-23b` App Launcher lists only the role's permitted tabs

**Activity logging**

- [ ] `BUG-21` Log an Activity opens from the Actions tab
- [ ] `ENH-21a` Connected / Not Connected options are in a highlighted block
- [ ] `ENH-21b` Log an Activity flow is fast and clear
- [ ] `ENH-21c` Dispositions are configurable in Setup

**Dashboard**

- [ ] `ENH-24` Dashboard exists with graphs and summaries scoped to the user's access
- [ ] `ENH-24a` Date-range selection works on all applicable dashboards
- [ ] `ENH-24b` Placement agreed and implemented (homepage or separate tab)

**Partner Portal / DKYC**

- [ ] `BUG-27` Both links resolve to the `/ai-crm/...` URLs
- [ ] `ENH-28` Partner Portal elements are interactive and lead somewhere useful
- [ ] `ENH-28a` Commission trend is understandable
- [ ] `ENH-28b` Clicking a client box opens client detail
- [ ] `ENH-28c` Training Modules shows pending module detail

---

## 7. Closing note

Please come back to me with your answers to Section 5 before starting development. Once we have agreed those, work through the items in the priority order we confirm, and report progress against the item IDs.

**Again: do not assume anything. Where you are unsure, ask.**
