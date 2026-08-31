# CUBE QuickCall — telephony API reference

**Source:** the vendor's Swagger portal, `raphsody.in/cubeapidocs/swagger/swagger.html`,
read 31 August 2026. The portal is behind Google SSO; Ritesh authenticated and
the spec was read from the rendered page. Title reported as *CUBE Telephony API*.

**Servers**

| | |
|---|---|
| Production | `https://raphsody.in` |
| UAT | `https://uat-raphsody.in` |

A UAT server exists, which means the integration can be built and exercised
end-to-end without touching production dialer traffic. That is worth using.

---

## 1. The session model, and why it shapes everything else

This is **not** a stateless API. There are three nested lifetimes, and the CRM
has to hold state for two of them.

```
UserID + Password        ──►  Token        (expires: ExpiresIn, sample 3600s)
  AgentId + Password
  + Extension            ──►  AuthId       (lives until AuthLogOff)
  + CampaignId
    every call action    ──►  uses AuthId
```

1. **Token** — tenant-level. `AuthToken` takes `UserID` and `Password`, returns
   `Token` and `ExpiresIn`. Passed on every secure call as the
   `Authorization` header (the value alone, not `Bearer <value>`). Must be
   refreshed before expiry or secure endpoints return 401.
2. **AuthId** — agent-level. `AuthLogin` takes `AgentId`, `Password`,
   `Extension` and `CampaignId`, and returns `AuthId`. Every subsequent session
   action carries it. `AuthLogOff` invalidates it and a new login is required.
3. **Call** — actions within a live session.

### Three consequences for our design

- **The CRM must hold a live `AuthId` per signed-in agent.** If the CRM process
  restarts, every agent's dialer session is orphaned and they must log in again.
  That argues for storing the session server-side and keyed to the CRM user,
  rather than in browser memory.
- **`AuthLogin` requires the agent's own CUBE password.** See §5 — this is the
  single biggest open question in the integration and it is a security decision,
  not a technical one.
- **An agent is in exactly one campaign at a time**, because `CampaignId` is
  fixed at login. Moving campaign means log off and log back in.

---

## 2. Endpoints

All are `POST`. Paths are relative to the server above.

### Authentication

| Path | Request | Returns |
|---|---|---|
| `/QuickCall61AuthToken/AuthToken/` | `UserID`*, `Password`* | `Api`, `Status`, `Token`, `ExpiresIn` |

### Agent session

| Path | Request | Returns |
|---|---|---|
| `/QuickCall61AuthToken/AuthLogin/` | `AgentId`*, `Password`*, `Extension`*, `CampaignId`* | `Api`, `Status`, `AuthId` |
| `/QuickCall61AuthToken/AuthLogOff/` | `AuthId`*, `AgentId`* | `Api`, `Status` |
| `/QuickCall61AuthToken/AuthBreak/` | `AgentId`*, `AuthId`*, `BreakType`*, `BreakDurn`*, `NotifyBreak`, `IsWorkBreak` | `Api`, `Status` |
| `/QuickCall61AuthToken/AuthBreakEnd/` | `AgentId`*, `AuthId`* | `Api`, `Status` |

`BreakType` is a free string in the spec — samples are `Tea`, `Lunch`,
`Personal`. `BreakDurn` is minutes. `NotifyBreak` `1`/`0` notifies the
supervisor; `IsWorkBreak` `1`/`0` distinguishes a work break from a rest break,
which matters for occupancy reporting.

### Call control

| Path | Request | Returns |
|---|---|---|
| `/QuickCall61AuthToken/AuthManualPass/` | `AuthId`*, `PhoneNo`*, `AgentId`*, `Name`, `ClientId` | `Api`, `Status` |
| `/QuickCall61AuthToken/AuthClick2Call/` | `PhoneNo`*, `CampaignID`*, `Name`, `AgentID`, `Priority`, `Duplicate`, `Remark`, `ClientID` | `status`, `callID`, `message` |
| `/QuickCall61AuthToken/AuthHoldCall/` | `AgentId`*, `AuthId`* | `Api`, `Status` |
| `/QuickCall61AuthToken/AuthUnHoldCall/` | `AgentId`*, `AuthId`* | `Api`, `Status` |
| `/QuickCall61AuthToken/AuthDropCall/` | `AgentId`*, `AuthId`* | `Api`, `Status` |
| `/QuickCall61AuthToken/AuthFreeMe/` | `AuthId`*, `AgentId`*, `DispositionCode`*, `CallBackDateTime`, `MustBeTransferedToMe`, `AgentRemarks` | `Api`, `Status` |

**Note the casing inconsistency.** `AuthManualPass` uses `AgentId` / `ClientId`;
`AuthClick2Call` uses `AgentID` / `ClientID` / `CampaignID`. The adapter must
not assume one convention. This is exactly the sort of thing that produces a
silent empty field in production, so the adapter maps each endpoint explicitly
rather than sharing one serialiser.

**`AuthClick2Call` is the odd one out** in two ways: it is the only call-control
endpoint that does not take `AuthId`, and the only one returning a `callID`.
It takes `CampaignID` directly instead. It appears to queue a call rather than
place one from a live agent session.

### Routing and conference

| Path | Request | Returns |
|---|---|---|
| `/QuickCall61AuthToken/AuthRedirect/` | `AuthId`*, `AgentId`*, `RedirectTo`* | `Api`, `Status` |
| `/QuickCall61AuthToken/AuthMakeCall/` | `AuthId`*, `PhoneNo`* | `Api`, `Status` |
| `/QuickCall61AuthToken/AuthCompleteConference/` | `AuthId`*, `AgentId`*, `ConfMode`* | `Api`, `Status` |

`RedirectTo` is overloaded — the description says it accepts an **Agent ID, a
Campaign ID, or an Extension number**, with no type discriminator. The adapter
should resolve which of the three it is on our side and record that, or a
transfer to a mistyped agent id silently becomes a transfer to nowhere.

### Monitoring

| Path | Request | Returns |
|---|---|---|
| `/QuickCall61AuthToken/AuthAgentStatus/` | `AuthId`*, `AgentId`* | `Api`, `Status`, `Activity`, `Duration`, `LoginDurn`, `BreakDurn`, `BusyDurn`, `WorkDurn` |

`Activity` sample is `Idle`. Durations are integers; `Duration` is time in the
current activity, the rest are session totals. Almost certainly seconds, but the
spec does not say so — **confirm against UAT before building anything that
displays them.**

### Reporting

| Path | Request | Returns |
|---|---|---|
| `/QuickCall61AuthToken/AuthCallLog/` | `FromDate`*, `FromTime`*, `ToTime`*, `CampaignId`* | `Status`, `Records[]` of `PhoneNo`, `AgentId`, `CallStatus`, `StartTime`, `EndTime`, `Duration` |

See §4 — this endpoint has a limitation that affects how calls attach to leads.

### Legacy PHP endpoints

Two endpoints sit outside the `QuickCall61AuthToken` family, on
`/QuickCallRaphsody/`. They look like an older generation of the API.

| Path | Request | Returns |
|---|---|---|
| `/QuickCallRaphsody/DisposeCall.php` | `Action`*, `CampaignID`*, `AgentID`*, `Disposition`, `SubDisposition`, `ClientID`, `AgentRemarks`, `CallBackDateTime` | `agent_id`, `client_id`, `success`, `error_message` |
| `/QuickCallRaphsody/Uploadlead61.php` | `CampaignId`, `data[]`, `Priority`, `RemoveZero`, `RejectedLog`, `DuplicityCheck`, `EncryptedPhoneNo`, `AutoSaveExtraInfo`, `RemarksSuffix`, `FixedAgent`, `FixedRemarks` | `UploadLead`, `Response.{Records, Inserted, Rejected, AlphaNumeric, DuplicateRows, PhoneNoLength}` |

**`DisposeCall.php` supports `SubDisposition`; the secure `AuthFreeMe` does
not.** If Bonanza's call-outcome taxonomy is two-level — and the CRM's Call
outcomes screen already models it that way — then the secure endpoint cannot
express it and the legacy one can. That is a question for CUBE, recorded in §5.

`Uploadlead61.php` is the **outbound** direction: pushing CRM leads into a
dialer campaign. `FixedAgent` pins the uploaded leads to one agent;
`DuplicityCheck` and `EncryptedPhoneNo` are flags; `data` is the lead array.
The response is a load report, which is genuinely useful — `Rejected`,
`DuplicateRows` and `PhoneNoLength` let us show the user why 40 of 500 leads
did not arrive instead of reporting a silent partial success.

---

## 3. There is no DID field

Worth stating plainly, because the Round 2 feedback (P2-04a) asks for "DID
mapping" and **the CUBE API has no DID concept at all.** Nothing in any request
or response is named DID or anything equivalent.

The nearest thing is **`Extension`**, supplied once per agent at `AuthLogin`.
The identifiers the API actually works in are:

| Identifier | Scope | Set where |
|---|---|---|
| `UserID` | The whole tenant | Our credentials, once |
| `AgentId` | One agent | Per agent, permanent |
| `Extension` | One agent's handset | Supplied at each login |
| `CampaignId` | A calling campaign | Chosen at each login |
| `AuthId` | One agent session | Returned by login |
| `ClientId` | Our lead reference | Passed by us, per call |

So the P2-04a field is `Extension`, and it belongs on the **user** record, not
the campaign. Whether it is fixed per user or entered at login is a business
question — see §5.

There is also **no endpoint that lists campaigns**, so `CampaignId` values
cannot be discovered programmatically. They have to be configured on our side
from whatever CUBE is set up with. Samples in the spec look like `CubeTest`
and `CubeSales_Out`.

---

## 4. The reconciliation gap

**`AuthManualPass` and `AuthClick2Call` both accept our `ClientId`. `AuthCallLog`
does not return it.**

The call log returns `PhoneNo`, `AgentId`, `CallStatus`, `StartTime`, `EndTime`
and `Duration` — and no client reference, and no call id. So when we pull the
day's calls to attach them to the timeline, the only join key available is
**phone number plus a time window**.

That is ambiguous in exactly the case Indian broking hits constantly: **family
accounts sharing one mobile number.** Two leads with the same mobile produce
call records we cannot confidently assign to either.

Three ways to handle it, in the order I would try them:

1. **Ask CUBE whether `AuthCallLog` can return `ClientId` or a call id.** The
   field is accepted on the way in, so it exists in their data model. This is
   the correct fix and costs us nothing but an email.
2. **Use `AuthClick2Call` where possible**, which returns a `callID` at the
   point of dialling. That gives an authoritative key for calls we originate,
   though not for inbound or manually dialled ones.
3. **Match on phone plus window, and mark it.** Where a number resolves to more
   than one lead, attach the call to the one the agent had open and record the
   match as inferred rather than certain. An inferred match presented as a fact
   is worse than one presented as inferred.

I would build (3) as the fallback regardless, since (1) and (2) never cover
inbound calls.

---

## 5. What the documentation does not answer

Five questions for Ritesh or for CUBE. The first is the one that matters.

| # | Question | Ask |
|---|---|---|
| 1 | **`AuthLogin` needs each agent's CUBE password. How is the CRM supposed to get it?** Storing every agent's dialer password in the CRM is a credential store we do not currently have and would rather not build. Options: the agent types it once at start of shift and we hold the `AuthId` only, never the password; we store it encrypted per user; or CUBE provides a service-account login that does not need it. | CUBE + Compliance |
| 2 | Is `Extension` **fixed per agent**, or does it change by seat or shift? Fixed means a user field; variable means a prompt at login. | Ritesh |
| 3 | What are the real **`CampaignId`** values, and is a campaign per team, per product or per user? No endpoint lists them, so they must be configured by hand. | Ritesh / CUBE |
| 4 | Does the **`AuthFreeMe` `DispositionCode`** accept our existing outcome codes, and is there a way to send a **sub-disposition** through the secure endpoint as the legacy PHP one allows? | CUBE |
| 5 | Are the **duration fields seconds**, and is `CallBackDateTime` in IST? The two sample formats differ between endpoints — `2024-05-21 18:13:33` on `AuthFreeMe` versus `28-02-2023 07:08:00 pm` on `DisposeCall.php`. Sending the wrong one silently books a callback at the wrong time. | CUBE / verify on UAT |

Question 5 is answerable by us against the UAT server once we have credentials,
and should be verified rather than assumed. The differing date formats between
two endpoints of the same product are a strong hint that at least one of them
will surprise us.

---

## 6. How this maps onto our side

The adapter follows the existing `vendors.js` pattern: live when credentials are
present in `server/.env`, simulated when they are not, so the screens and tests
run without a dialer.

| CUBE concept | Our home |
|---|---|
| `UserID` / `Password` | `server/.env`, never in the database |
| `AgentId`, `Extension` | Fields on the user record |
| `CampaignId` | Configured list; selected at agent login |
| `AuthId` | Server-side session, keyed to the CRM user |
| `DispositionCode` | Existing **Call outcomes** setup screen |
| `AuthCallLog` records | Interaction timeline — never a separate call log |

That last row is non-negotiable #1 from the original brief: one shared
interaction timeline. A call is an interaction, and it goes where every other
interaction goes.
