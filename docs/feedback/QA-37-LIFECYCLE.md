# QA-37 — what can be renamed, retired, archived or deleted

**Status:** recommended 13 October 2026 and **accepted as written** by Ritesh the
same day, with corrections to notes and activities as linked entries rather
than edits. To build, entity by entity. The page it was decided from:
https://claude.ai/artifact/37zESHabTxjgR8wjiV5pJd

## Principles

1. **Keep what records the business.** Anything that records a client
   interaction, a regulated decision or money is not hard-deleted inside its
   retention period. It is retired or archived.
2. **Delete only what never mattered.** A hard delete is for a draft that never
   reached a client and was never used by anything else.
3. **Correct by adding.** History is append-only: a wrong note or activity is
   corrected by a new entry linked to it, and the original is shown as
   corrected. No edit after saving.
4. **Say what it blocks.** Every lifecycle action is audited, asks for a reason
   when it takes something out of use, and refuses with the reason when
   something still depends on it.

**Rename / edit** changes a draft or a configuration. **Retire** takes it out
of every picker and new use, still readable where it was used, reversible.
**Archive** makes it read-only and out of default lists, restorable. **Delete**
is gone for good, with a confirmation that names it.

## Entity by entity

| Entity | Rename / edit | Retire or archive | Delete | Who |
|---|---|---|---|---|
| Static list | Rename, describe; remove a member (the lead stays) | Archive, restorable | Only if no campaign ever sent to it | Owner, Admin |
| Campaign | Draft only | Archive once sent | Draft never sent | Campaign managers |
| Message template | Edit; an approved one goes back for approval | Retire if any campaign or rule used it | Never used, with a named confirmation and a "Deleted" message | Template managers |
| Library content | A new version, approved before it is offered | Withdraw, then archive | Never — an item sent to a client records what they were told | Content owners; a different approver |
| Partner | Contact details; bank and PAN through approval | Suspend, terminate; archive once settled; withdraw portal access | Never — referrals and commission are attached | Partner RM edits; Admin suspends |
| Task | Title, due date, assignee | Cancel, with a reason | Never | Assignee, creator, their supervisor |
| Notes, activities, case replies | No edit after saving | Correct with a linked entry | Never | Author corrects |
| Case | Fields while open | Resolve, close, reopen | Never | Case handlers |
| Automation rule and flow | Rename, edit; a new version once it has run | Switch off; archive once it has run | Only a draft never switched on | Admin |
| Holiday | Future dates only | — | Future dates only | Admin |
| SLA policy and category | Versioned; applies to new cases | Retire a category | Never — cases point at it | Admin |
| KYC journey | Versioned; applies to new journeys only | Retire a step | Never | Admin, with Compliance |
| Lead and client | Fields, under field security | Recycle bin, restorable | Purge only after the retention period | Admin purges |
| User | Profile, role | Deactivate; hand over the book | Never — the audit trail names them | Admin |

## Retention, the floor under all of it

- Broker books and records: **8 years** under the SEBI (Stock Brokers)
  Regulations, 2026, regulation 16 (raised from five) -- confirmed 14 Oct
  against several published summaries of the regulation, and stated as eight
  years in a broker's own published referral policy.
- Transaction records under the PMLA: **5 years** from the transaction.
- Personal data under the DPDP Act, 2023: erased once its purpose is served,
  unless a law requires it kept (section 8(7)). The DPDP Rules, 2025 use three
  years of inactivity for the classes they name.

Ruled 14 Oct ("keep it as standard practice suggests, configurable"): two
Business policies, changed by an Admin or Superadmin in Setup. Clients are kept
**at least 8 years** after the account closes, and the setting cannot go lower.
Leads that never became clients may be erased after **3 years** without
activity.

## The auditor's cleanup ask

An Admin-only *Retire test records* action that archives records marked as test
data, with a reason, and never deletes them.

## Built so far

- Partner portal access can be withdrawn and re-issued (`OPS-15`).
- Tasks have a *Cancelled* status with a reason (QA-02), used by the
  duplicates script; no screen yet.
- Campaigns already did what the table asks: a draft only is edited, a sent
  one is archived rather than deleted, and only a draft never sent is deleted.
- **Lead purge (14 Oct):** Data tools → Recycle bin lists what has reached its
  retention -- deleted, never an account, untouched for the period -- and an
  Admin erases it with a reason and the word PURGE. The audit keeps the ids,
  the reason and the period, never a name. Clients are not purged.
- **Lists (batch 1, 14 Oct):** the owner or an Admin renames and describes a
  list, and removes a member without touching the lead. *Archive* asks why;
  an archived list leaves Lead Lists for its own view, stays readable,
  previewable and exportable, and nothing changes it -- members, columns, a
  bulk action or a send, a campaign included -- until it is restored.
  Restoring a snapshot whose expiry passed gives it a fresh one. *Delete*
  needs the list's name typed, and is refused, with "archive it instead",
  for a list a campaign went to or a bulk message was sent from.
- **Message templates (batch 1, 14 Oct):** changing the text of an approved
  template -- subject, body, header, buttons -- sends it back for approval,
  which is then a separate act; a rename does not. *Retire* asks why; a
  retired template leaves every picker and nothing new can send it -- a
  campaign, an automation rule, a message from a lead -- and it cannot be
  edited until it is restored. *Delete* is for a template no campaign or
  rule has used, needs its name typed, and answers "Deleted <name>"; one
  that has been used is refused with "retire it instead".
  `test/lifecycle1.test.mjs`.
- **Tasks (batch 2, 14 Oct):** the assignee, the creator or a supervisor
  (report.team) changes the title, due date or assignee. *Cancel* asks why,
  stops the task's reminders and is audited; a cancelled task stays as it is,
  and there is no delete. The Tasks screen and a lead's Tasks tab offer
  *Change* and *Cancel*.
- **Cases (batch 2, 14 Oct):** priority, assignee and category change while
  the case is open. Resolved or closed, they are refused with "reopen it
  first", and so is escalating; a closed case is not set back to Resolved.
  *Reopen* asks why, clears the resolved and closed times, and puts the
  reason on the case as an internal note and in the audit trail.
- **Corrections (batch 2, 14 Oct):** notes, activities and case replies still
  have no edit. Their author adds a correction -- what it should say, and what
  was wrong -- and the original stays, marked *Corrected*, with the
  correction under it, on a lead, a partner and a case. Corrections are kept
  in their own table, not as new notes or activities, so a corrected call is
  never a second call to a report, KRA, the cockpit or automation. Where a
  reader may not see an activity's notes, the correction is hidden from them
  too. A partner sees the correction to a reply they could see, without the
  reason or the agent's name. Only an agent's own reply is corrected, never a
  client's, a partner's or a system entry, and erasing a lead erases its
  corrections. `test/lifecycle2.test.mjs`.
- **Library content (batch 3, 14 Oct):** the file of an approved or
  withdrawn item is never replaced in place; *New version* adds a row linked
  to it. In a library that requires approval it starts as a draft, the
  current version keeps going out, and approving the new one -- by somebody
  other than its author -- archives the old one; in one that does not, it
  replaces it at once. The older `/admin/content/:id/version` route follows
  the same rule and keeps the item's library and business. *Withdraw* asks
  why and stops it going out; a withdrawn item is archived, or sent for
  approval again. Something on offer is withdrawn before it is archived,
  nothing changes an archived item, and there is no delete.
- **Holidays (batch 3, 14 Oct):** a day is added or removed only if it is
  after today in India; a day that has begun stays, because the SLA clocks
  that ran over it were counted against it. The calendar screen offers
  removal only on future days.
- **Case categories (batch 3, 14 Oct):** *Rename* (names stay unique) and
  *Retire* with a reason, or *Restore*. A retired category leaves every
  picker and is refused for a new case or a change of category; the cases
  that have it keep it. A category a compliance flag opens cases in is not
  retired until the flag is routed elsewhere, and the refusal names the flag.
  `test/lifecycle3.test.mjs`.
- **Automation rules and flows (batch 4, 14 Oct):** when one was first
  switched on is kept by database triggers, so whichever door switched it on,
  it never again passes for a draft. *Delete* is for a draft never switched
  on and needs its name typed; anything else is refused with "archive it
  instead". *Archive* asks why and needs it switched off (a flow also paused,
  with nobody inside); archived, it is read-only -- no edit, no switching on,
  no real run (a dry run still works), and a version rollback is refused --
  until it is restored, switched off. Rules already kept a version per save.
  A flow that has run now changes by new versions: each change to its
  trigger, entry conditions or cards is recorded in `automation_versions`
  with the definition as it stood, renaming or moving cards is not, and every
  run records the version it went through. Flow versions are history to read,
  not to roll back over a live graph. The Rules and Automations screens offer
  Archive or Delete, list what is archived, and show a flow's version.
  `test/lifecycle4.test.mjs`.
- **Partners (batch 5, 15 Oct; Ritesh, 14 Oct):** editing no longer changes a
  partner's state at all -- it used to set any state, ACTIVE included, past
  onboarding. *Suspend*, *Terminate* and *Reinstate* are closure requests
  with a reason, decided in Approvals by somebody else holding
  `partner.suspend`; the move is checked when asked and again when granted.
  Granted, the reason is kept on the partner and its timeline, and suspending
  or terminating withdraws portal access and ends every session (the scope
  always said it did). Terminated is final. *Archive* only a terminated
  partner whose commission is all paid; archived, it leaves the list for its
  own tab and is read-only until restored. No delete.
- **KYC journeys (batch 5, 15 Oct):** a journey was already versioned and
  every journey keeps the version it began with. The KYC journeys screen now
  offers *Retire* on a step and *Add back* on one not in the journey, each
  with a reason, as a new version that reaches only journeys started
  afterwards. "With Compliance" (Ritesh, 14 Oct: not now, but configurable):
  the Business policy "A change to a KYC journey waits for Compliance to
  approve it", off by default, holds a change in Approvals until a user with
  `kyc.journey.approve` (Compliance, Superadmin) other than the asker grants
  it; one change waits at a time.
- **Retire test records (batch 5, 15 Oct):** Setup → Test records, for
  `admin.test_records` (Admin, Superadmin). An Admin marks a record as test
  data by kind and number -- lead, case, list, campaign, library item,
  partner, rule, flow, task or template, in their own business -- and the list
  previews what retiring will do to each, or what stops it. *Retire*, with a
  reason, takes each out of use through its own lifecycle: a lead to the
  recycle bin, a case closed, a list, rule, flow, campaign or library item
  archived, a task cancelled, a template retired, a partner's portal access
  withdrawn and its record archived (its state is left to the closure
  approval). One that cannot go yet -- a flow with a lead inside, a partner
  owed commission -- is left and says why. Nothing is deleted; the mark keeps
  the outcome. `test/lifecycle5.test.mjs`.

Every entity in the table above is now built; QA-37 is closed in the Round 4
ledger.
