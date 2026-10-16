# Part 4, item 8.4 -- every action says what it did

Ritesh's Part 4, item 8.4: "When an action is initiated or completed, clearly explain its actual outcome ... Users must be able to acknowledge or dismiss the message." Ruled 16 Oct 2026: every action button in the CRM, not only the lead and product screens.

**How.** The client's write calls were listed mechanically -- 283 in 73 screens -- and each one read with what happens after the server answers. Where nothing said what had happened, the screen now calls `announce(title, lines)` (client/src/components/ui.jsx) with what the server's answer says happened, never a guess at it; one `<OutcomeHost />` in the CRM and one in the partner portal shows it until it is closed with OK. Actions whose result was already said, or is the change itself in front of the person (a column appearing, a tick, a message in a thread), were left as they were, and say so below.

**What each row means.** *already said* -- a message with the result was there before. *shown in place* -- the change is the thing on screen where it was made. *opens what it made* -- the new record or conversation opens. *not a change* -- a search, a preview or a question; nothing is written. Anything else is what the screen says now, where it said nothing before.

| Screen | Action | Before | Now |
|---|---|---|---|
| components/AdvancedSearch | Count / run a search | the results show | not a change -- a search |
| components/ColumnChooser | Show or hide a column; reset | the column appears or goes | shown in place |
| components/Corrections | Correct a note, interaction or reply | the correction appears, marked Corrected | shown in place |
| components/Lifecycle | Archive / delete | a message | already said |
| crm/ActionModals | Bulk reassign / bulk stage | "Reassigned N" / "Moved N" notice | already said |
| crm/ActionModals | Bulk message | "Sent to N" | already said |
| crm/ActivityComposer | Log an interaction | confirmation line under the form | already said |
| crm/ActivityComposer | Log an interaction | a confirmation line | already said |
| crm/admin/Automations | New automation | opens it in the builder | opens what it made |
| crm/admin/Automations | Convert a rule | list reloaded, nothing said | says it is a draft automation with N steps, and any warnings |
| crm/admin/Calendars | Add / remove a holiday | the list changed | says how the calendar now treats the day |
| crm/admin/Campaigns | Send | a note only when somebody was skipped | says how many it reached, and who was skipped |
| crm/admin/Campaigns | Test send | "Sent to you only" | already said |
| crm/admin/Campaigns | Duplicate / pause / resume / delete | the list changed, nothing said | says what each did (a sent campaign's archive note already said) |
| crm/admin/Campaigns | Save / create | the dialog closed | says it is saved, and whether it is scheduled |
| crm/admin/CaptureForms | Save the form | nothing said | says how many fields the form now asks, in this order |
| crm/admin/CaptureForms | New field | added to the list, nothing said | says it is added at the end and the form needs saving |
| crm/admin/FlowBuilder | Canvas edits (move, connect, add, copy, note, delete, tidy) | the canvas changes, "Saving…", Undo/Redo say what they undid | shown in place, with Undo |
| crm/admin/FlowBuilder | Activate / Pause | nothing said | says it is active (acts from now on) or paused |
| crm/admin/Handover | Preview a handover | the preview shows | not a change -- a preview |
| crm/admin/Handover | Run a handover | the dialog closed | says how many records moved (screen: crm/admin/users) |
| crm/admin/Journeys | Retire / add back a KYC step | a message with the new version | already said |
| crm/admin/MessagingSetup | Who may message whom (the grid) | the cell changes | shown in place |
| crm/admin/MessagingSetup | Freeze / reopen a conversation; suspend / restore a person | nothing said | says what each now can or cannot do |
| crm/admin/MetaConnector | Form settings and field mapping | the choice shows in the row | shown in place |
| crm/admin/MetaConnector | New lead source while mapping | nothing said | says the source now exists in that business |
| crm/admin/MetaConnector | Create a Meta campaign | nothing said | says it is created paused, and whether Meta is really connected |
| crm/admin/MetaConnector | Push an audience | nothing said | says how many went to Meta as hashed identifiers, that opt-outs were left out, and that they left India |
| crm/admin/MetaConnector | Say who a Messenger sender is | the lead's name appears in the row | shown in place |
| crm/admin/Promotion | Package / inspect / apply a bundle | the bundle, the preview or the applied result is shown | already said |
| crm/admin/Rules | Duplicate / enable / disable / save a rule | the list changed | says what it now does, or that nothing runs until enabled |
| crm/admin/Rules | Dry run; archive | the dry-run result / the archive message | already said |
| crm/admin/Sla | Restore / rename / retire a case category | the list changed | says what it now means for cases |
| crm/admin/Sla | Save a compliance flag | the row saved | says it is updated |
| crm/admin/StepDrawer | Save a trigger or step | the card changes on the canvas | shown in place, with Undo |
| crm/admin/Templates | Retire / delete | the server message | already said |
| crm/admin/Templates | Save | said only when approval was reset | says it is saved either way |
| crm/admin/Templates | Preview while typing | the preview shows | not a change -- a preview |
| crm/admin/TestRecords | Unmark | the row went | says it is no longer marked as test data |
| crm/admin/TestRecords | Retire | "Retired N ... left as they were" | already said |
| crm/admin/UserExport | Make a user field required / optional | the tick changed | says what creating a user now needs |
| crm/admin/users | Act as a user | the CRM reopens as them, with a banner | opens what it made |
| crm/admin/users | Reset link | the link is shown | already said |
| crm/admin/users | Disable / enable | the row changed, nothing said | says they can no longer use the CRM, or can sign in again |
| crm/admin/users | Edit / create a user; hand over a book | the dialog closed | says it is saved or created, or how many records moved |
| crm/admin/WebhookEndpoints | Pause / resume / delete / save a webhook | the list changed | says what is now sent to it |
| crm/ApiAccess | Issue / rotate a key | the key is shown once | already said |
| crm/ApiAccess | Revoke / narrow a key | the list changed | says when it stops or what it may now do |
| crm/Approvals | Approve / reject | "Approved, and the change has been applied" / "Rejected" | already said |
| crm/Attendance | Check in / out | the prompt closed | says the time |
| crm/BulkUpdate | Bulk change a field | "Changed N" | already said |
| crm/BusinessPolicies | Save policy switches | the page reloaded | says how many changed, in force from now, in the audit log |
| crm/Calendar | Sync with Outlook | the diary reloaded | says how many events were read or taken off, and whether simulated |
| crm/Campaigns | New campaign | the dialog closed | says it is created, and nothing sends yet |
| crm/Clients | Show or hide a column; reset | the column appears or goes | shown in place |
| crm/Clients | Export | the file downloaded | says how many, masked or clear, any cap, and that it is audited |
| crm/Copilot | Ask the Copilot | the answer shows | not a change -- a question |
| crm/Dashboards | New dashboard | opens it | opens what it made |
| crm/Dashboards | Change a panel chart; remove or add a panel | the panel changes on the board | shown in place |
| crm/Dashboards | Preview a panel | the preview shows | not a change -- a preview |
| crm/DataTools | Import | the import report | already said |
| crm/DataTools | Restore a lead from the bin | the row went | says it is back with its owner and history |
| crm/Dispositions | Save / add a call outcome | the dialog closed | says when it applies |
| crm/EmailComposer | Send; save as a template | the server note, or "Email logged"; the template note | already said |
| crm/FieldMasking | Save the grid; make a field maskable or not | the grid redrew | says what each role now sees |
| crm/GroupsSetup | Add / remove a member | the member list changes | shown in place |
| crm/GroupsSetup | Create / save / delete a group | the dialog closed | says it is created, updated or deleted |
| crm/Inbox, crm/Cockpit | Mark notifications read | the badge clears | not an action with an outcome to state |
| crm/InCall | Propose / confirm the AI disposition | the review, then "Disposition applied" with what changed | already said (item 9 redesigns this screen) |
| crm/KraSetup | Save / add a metric; retire; save bands | "Saved." / "Added." / "retired" / "Bands saved." | already said |
| crm/KraSetup | Preview a payout | the preview shows | not a change -- a preview |
| crm/KycConsole | Run stall sweep | bare text, nothing said | a button; says how many it checked, stalled and abandoned |
| crm/KycConsole | Take over; force a step complete | the journey reloaded | says it is In Progress again, or that the override is audited |
| crm/leadActions | Call (through the dialler) | "Dialling ..." with whether it was simulated | already said |
| crm/LeadDetail | Add a note; tick a task done | the note or tick appears | shown in place |
| crm/LeadDetail | Add a task | it appeared in the list | says it is on your list, and when it is due |
| crm/LeadDetail | Raise a case | the dialog closed | says the reference, whether it was assigned, and its deadlines |
| crm/LeadDetail | Record a KYC verification outcome | the journey reloaded | says what was recorded, or that the application is complete and who was told |
| crm/LeadDetail | Raise a KYC objection | the journey reloaded | says it is sent back, and who was told |
| crm/LeadDetail | Assist a KYC application | the journey reloaded | says it is In Progress again |
| crm/LeadDetail | Edit the lead | the dialog closed | says it is saved |
| crm/LeadImport | Preview an import | the preview shows | not a change -- a preview |
| crm/LeadLists | Refresh a list | the count changed | says how many it holds now, against before |
| crm/LeadLists | New list | opens it | opens what it made |
| crm/Leads | Show or hide a column | the column appears or goes | shown in place |
| crm/Leads | New lead | opens the lead | opens what it made |
| crm/Libraries | Add an item; create a library | the dialog closed | says whether the item can be sent now or waits for approval |
| crm/Libraries | Withdraw; new version | a message | already said |
| crm/ListDetail | Rename, archive, delete; every bulk action; columns; export | a message with what was done and the counts | already said |
| crm/ListDetail | Preview a bulk message | the preview shows | not a change -- a preview |
| crm/Login, crm/GhostBar, crm/Crm | Sign in; leave acting as; sign out | the CRM opens or closes | not an action with an outcome to state |
| crm/Logs | Retention period; purge | "kept N days" / "Removed N" | already said |
| crm/Messages | Open a conversation / new channel / join | the conversation opens | opens what it made |
| crm/Messages | Remove / add a channel member | the list changes | says who no longer sees / can now read the channel |
| crm/Messages | Leave / archive / reopen a channel | the panel closes | says what changed for whom |
| crm/Messages | Mark read, react, send, withdraw a message | shown in the thread | shown in place |
| crm/Messages | Approve / decline / withdraw a lead transfer | the card's badge changes | says who now owns the lead, or that nothing moved |
| crm/Messages | Ask for a lead | the request card opens in the conversation | opens what it made |
| crm/Messages | Look up a lead | results show | not a change -- a search |
| crm/Nomination | Record a nomination or opt-out | "Recorded ... acknowledgement ..." | already said |
| crm/ObjectManager | Save the field order; add / edit a field | the list redrew | says it is saved or added |
| crm/ObjectSettings | Save an object's settings | the dialog closed | says they apply from the next screen (screen: crm/ObjectManager) |
| crm/PartnerProfile | Withdraw portal access | the badge went, nothing said | says they cannot sign in, and how many sessions ended |
| crm/PartnerProfile | Emergency activation, elevate, portal password | a panel with the code or the one-time password | already said |
| crm/PartnerProfile | Suspend / terminate / reinstate; archive | "Asked to ... waits in Approvals" / "is archived" | already said |
| crm/PartnerProfile | Request elevation | nothing said | says the Admins were notified and nothing changes until one acts |
| crm/PartnerProfile | Restore record | nothing said | says it is out of the archive |
| crm/PartnerProfile | Mark an onboarding step or training module done; add a note | the tick, badge or note appears | shown in place |
| crm/Partners | Export | the file downloaded | says how many, masked or clear, any cap, and that it is audited |
| crm/Partners | Add a prospect | opens it | opens what it made |
| crm/PicklistValues | Save values; add a stray value to the list; merge | the dialog closed | says the list offers these values and records keep theirs |
| crm/ProductPanel | Move a card; ask for a Product RM; start KYC; schedule a review | (items 8.1-8.3) an OK dialog | already said |
| crm/ProductPanel | Message a person on a handover | opens the conversation | opens what it made |
| crm/ProductRmRequest | Send the request | an OK dialog with who, the task and the notifications | already said |
| crm/ProductsSetup | Switch a product on / off; add / save; remove a brochure | the list changed | says what it means for leads and calls |
| crm/RolesSetup | Save / remove / create a role | "saved" / "removed" / "created" | already said |
| crm/TabVisibility | Save the role grid; a per-person exception | the grid redrew | says what each role or person now sees |
| crm/Tasks | Add a task | it appeared in the list | says the lead, the due time, and whose list it is on |
| crm/Tasks | Edit / cancel a task | the dialog closed | says the new due time, or that it is cancelled with the reason |
| crm/Tasks | Tick a task done | struck through | shown in place |
| crm/Telephony | CUBE connection, queues, agents, test | "saved" / "registered" / "removed" / the test result | already said |
| crm/Tickets | Export cases | the file downloaded, nothing said | says how many cases, masked or clear, any cap, and that it is audited |
| crm/Tickets | Reply; add an internal note | the entry appears in the conversation | shown in place |
| crm/Tickets | Escalate / Mark resolved / Save / Check SLAs now | (QA-07) an OK dialog with what happened | already said |
| crm/Tickets | Reopen | the page reloaded | says it is Open again and the reason is kept |
| crm/UsersSetup | Enable / disable several users | said only what failed | says how many changed, beside what failed |
| crm/ValidationRules | Save / delete a rule | the dialog closed | says whether it now refuses saves that break it |
| crm/ValidationRules | Preview a rule | the impact shows | not a change -- a preview |
| portal/PartnerPortal | Sign in; choose a new password | the portal opens | opens what it made |
| portal/PartnerPortal | Raise a support request | the dialog closed | says the reference and where the reply comes |
| portal/PartnerPortal | Complete a training module | the badge changed | says it is marked complete |
| setup/SetupShell | Remember a Setup preference | the section stays as left | not an action with an outcome to state |

Reading them found nine defects outside this item -- among them task and follow-up times saved five and a half hours late, which the new "Task created" message made visible. Ritesh ruled on 16 Oct that each is fixed, in a commit of its own: `OPS-46` to `OPS-54`, in [OUTSTANDING.md](OUTSTANDING.md).
