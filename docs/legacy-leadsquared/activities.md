# Activity Types — Complete Inventory (54 custom activities)
Source: Settings > Leads > Activities and Scores > Custom Activities & Scores
Columns: Display Name | Code (ActivityEvent) | Score | Delete Activity | Show in Activity List

NOTE: These codes are TENANT-ASSIGNED. Any API integration must resolve them at runtime.

| Activity Type | Code | Score | Deletable | In List |
|---|---|---|---|---|
| Lead Shared through Agent Popup | 29 | 0 | | Yes |
| Opportunity Shared through Agent Popup | 36 | 0 | | Yes |
| Lead updated | 150 | 0 | | |
| Support Ticket Activity | 200 | 10 | | Yes |
| Phone Call Conversation Activity | 201 | 0 | Yes | Yes |
| WhatsApp Message | 203 | 0 | Yes | Yes |
| Facebook Lead Ads Submissions | 204 | 0 | | Yes |
| SMS Sent | 205 | 0 | | Yes |
| SMS Received | 206 | 0 | | Yes |
| Post Sales Data Update Activity | 207 | 0 | | Yes |
| Email Received | 208 | 1 | | |
| Email Sent | 209 | 0 | Yes | Yes |
| Not Connected | 210 | 0 | | Yes |
| Lead Recapture | 211 | 0 | Yes | Yes |
| Recheck Trading Automation | 212 | 0 | | Yes |
| Google AdWords Capture | 213 | 0 | | Yes |
| Postsales Lead Capture | 214 | 0 | Yes | Yes |
| Welcome Phone Call Activity | 215 | 0 | | Yes |
| App Login/Logout Activity | 217 | 0 | | |
| Trading Activity | 218 | 10 | | Yes |
| Margin Available Activity | 221 | 0 | | Yes |
| B2B Lead Form Disposition | 222 | 0 | | Yes |
| Kaleyra send SMS | 223 | 0 | | Yes |
| Trading Software Mapped | 224 | 0 | | Yes |
| Subscription Activity | 225 | 0 | Yes | Yes |
| Profiling/Trading/Reactivation Form old | 226 | 1 | | Yes |
| Product Usage Activity | 227 | 0 | Yes | Yes |
| Ready To Trade | 228 | 0 | Yes | Yes |
| Call Log Activity | 229 | 0 | | |
| OutBound | 230 | 0 | | Yes |
| Follow Up Type | 231 | 0 | | Yes |
| Call & Trade Activity | 232 | 10 | Yes | Yes |
| IVR Flow Activity | 233 | 0 | | Yes |
| Opportunity Added | 234 | 10 | Yes | Yes |
| OPPORTUNITY CLOSED | 235 | 0 | | Yes |
| Converse Chat | 236 | 0 | | Yes |
| Offer | 237 | 0 | | Yes |
| Zoom Meeting | 238 | 0 | | Yes |
| Zoom Meeting Started | 239 | 0 | | Yes |
| Zoom Webinar | 240 | 0 | Yes | Yes |
| Create Support Ticket | 241 | 0 | | Yes |
| Profiling/Trading/Reactivation Form V4 | 242 | 0 | Yes | Yes |
| Modification Activity | 243 | 0 | Yes | Yes |
| Payment Payin | 244 | 0 | Yes | Yes |
| Payment Payout | 245 | 0 | Yes | Yes |
| Opportunity Recapture | 246 | 0 | Yes | Yes |
| Call Backup | 247 | 0 | Yes | Yes |
| Zipteams Notes | 248 | 2 | Yes | Yes |
| Zipteams Meeting | 249 | 2 | Yes | Yes |
| Opt In Date | 250 | 0 | | Yes |
| test | 251 | 0 | | Yes |
| KYC Subscription | 252 | 0 | Yes | Yes |
| Entity sharing - Lead | 253 | 0 | | Yes |
| Document Generation | 21600 | 0 | Yes | Yes |

## Activity taxonomy — categories for the new CRM

**Communication events (system-generated)**: Email Sent/Received, SMS Sent/Received,
WhatsApp Message, Kaleyra send SMS, Converse Chat, Phone Call Conversation,
Call Log, Call Backup, Not Connected, OutBound, IVR Flow

**Meeting/webinar**: Zoom Meeting, Zoom Meeting Started, Zoom Webinar,
Zipteams Meeting, Zipteams Notes

**Lead lifecycle**: Lead Recapture, Lead updated, Postsales Lead Capture,
Entity sharing - Lead, Lead Shared through Agent Popup, Opt In Date

**Opportunity lifecycle**: Opportunity Added, OPPORTUNITY CLOSED,
Opportunity Recapture, Opportunity Shared through Agent Popup

**Business/domain events (broking-specific)**: Trading Activity,
Call & Trade Activity, Ready To Trade, Margin Available, Recheck Trading Automation,
Trading Software Mapped, Product Usage, Subscription Activity, KYC Subscription,
Payment Payin, Payment Payout, App Login/Logout

**Forms/data capture**: Profiling/Trading/Reactivation Form V4 (+ "old" version),
B2B Lead Form Disposition, Facebook Lead Ads Submissions, Google AdWords Capture,
Post Sales Data Update, Modification Activity, Document Generation

**Service**: Support Ticket Activity, Create Support Ticket

**Scoring**: Only 8 activities carry a non-zero score — Support Ticket (10),
Trading Activity (10), Call & Trade (10), Opportunity Added (10),
Email Received (1), Profiling Form old (1), Zipteams Notes (2), Zipteams Meeting (2).
Everything else scores 0 → the scoring model is barely used / not meaningfully tuned.

## Design signals for the new CRM
1. **Versioned activity types are a smell**: "Profiling/Trading/Reactivation Form old"
   (226) and "V4" (242) coexist. LSQ can't version an activity schema, so a new type
   was created. New CRM needs schema versioning on event types.
2. **"test" activity type (251) live in production.**
3. **Score model is vestigial** — 46 of 54 types score zero. Either commit to
   event-based scoring properly in the new CRM or drop it for an explicit model.
4. **Two parallel opportunity-event mechanisms**: activities named "Opportunity
   Added/Closed/Recapture" duplicate what the Opportunity object itself tracks.
5. **Vendor-named types** (Kaleyra, Zipteams, Zoom, Facebook, AdWords) hard-wire
   vendors into the data model. New CRM should model the *event* (e.g. "Meeting
   Held", channel=Zoom) not the vendor.
6. The `Document Generation` code 21600 sits far outside the 200-253 band —
   a platform-reserved range, worth noting for any migration mapping table.
