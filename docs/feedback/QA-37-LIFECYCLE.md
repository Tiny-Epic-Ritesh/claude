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
