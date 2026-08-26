# Feedback Round 1 — status by item ID

Source: `Bonanza-AI-CRM-Feedback-Round-1.md`, Ritesh, 26 Aug 2026.
Status values: **Done** · **Partial** · **In build** · **Blocked** · **Not started**

## Decisions taken (22 Aug, before development)

| Ref | Decision |
|---|---|
| Sequencing | **Real defects first, then the unbuilt modules.** Four P0s are modules that were never built, not regressions. |
| Q-16 | **Admin + Super Admin only.** Marketing Manager keeps masked PII — that role segments and sends; it never needs to read a PAN. Setup screen still ships so you can widen it later, and every unmask is audited. |
| Q-06 / Q-13 | **Build fully, simulate until credentials land.** Composer, templates and attachments all work; sends go through the existing adapter and log an Activity. Live by setting credentials, no code change. |
| Q-14 | **One assistant, context-aware.** Extend the existing Copilot rather than add a second. One place where residency and permission scoping are enforced. |
| Q-27 | **Confirmed** — `/ai-crm/dkyc` and `/ai-crm/portal`. |
| Q-GEN | **Yes, a design system exists** — tokens in `client/src/styles.css`. All UI items extend those tokens rather than adding one-off CSS. |

## The framing correction

Thirteen tabs render a deliberate "In build" placeholder, not a broken page:
pipeline, clients, calendar, products, ccm, team, revenue, kra, incentives,
campaigns, content, lists, dashboards.

**BUG-20, BUG-25, BUG-26 and ENH-24 are therefore net-new modules**, not fixes,
and are the largest items in the document. They are sequenced after the genuine
defects by agreement.

A real defect sits underneath them: unknown `/api/*` routes returned **200 with
HTML** because the SPA fallback caught them. An unbuilt endpoint must 404.

## Status

| ID | Area | Pri | Status | Note |
|---|---|---|---|---|
| BUG-01 | Login field alignment | P2 | **Done** — root cause was the input selector, see below | |
| BUG-02 | Dark theme, login email | P1 | **Done** — same root cause | with BUG-18 |
| ENH-03 | Scrolling ticker | P2 | Not started | |
| ENH-04 | Ticker role control | P2 | Not started | needs Q-04 |
| ENH-05 | Summary-card drill-through | P1 | Not started | needs Q-05 |
| ENH-05a | Drill-through per role | P1 | Not started | |
| ENH-06 | Email composer | P1 | Not started | simulate until SMTP set |
| BUG-07 | Copilot breaks layout | P0 | Not started | |
| ENH-08 | Role→tab matrix | P1 | Blocked | matrix sent, awaiting mark-up |
| ENH-09 | Market items link out | P2 | Not started | |
| ENH-10 | Rename to Products | P2 | Not started | needs Q-10 |
| ENH-10a | Replace status dots | P1 | Not started | |
| ENH-10b | Directive actions | P1 | Not started | stage model sent |
| ENH-10c | Richer View popup | P1 | Not started | |
| ENH-10d | Start Engaging actions | P1 | Not started | |
| ENH-11 | Group NBA + Start Call | P2 | Not started | |
| ENH-12 | Warm card meaning | P1 | Not started | needs Q-12 |
| BUG-13 | Quick Actions dead | P0 | Not started | |
| ENH-14 | Contextual AI help | P1 | Not started | one assistant |
| ENH-15 | Advanced Search UX | P1 | Not started | |
| ENH-16 | Unmask + config | P1 | Not started | Admin/Superadmin only |
| ENH-17 | Tabs above summary | P1 | Not started | |
| BUG-18 | Dark theme audit | P1 | **Done** — same root cause, verified across the lead edit form | |
| ENH-19 | Input styling | P2 | **Done** — all 45 untyped inputs now inherit the design system | |
| BUG-20 | Pipeline | P0 | Not started | **module, not a fix** |
| BUG-21 | Log Activity opens | P0 | Not started | |
| ENH-21a | Highlight connected | P1 | Not started | |
| ENH-21b | Log Activity UX | P1 | Not started | |
| ENH-21c | Dispositions in Setup | P1 | Not started | 22 values sent |
| ENH-22 | Setup in main nav | P2 | Not started | |
| ENH-23 | Launcher animation | P2 | Not started | |
| ENH-23a | Launcher icon size | P2 | Not started | |
| ENH-23b | Launcher by role | P1 | Not started | |
| ENH-24 | Dashboard | P1 | Not started | **module** · needs Q-24 |
| ENH-24a | Date range | P1 | Not started | |
| ENH-24b | Placement | P1 | Not started | |
| BUG-25 | Lead Lists | P0 | Not started | **module** · needs Q-25 |
| BUG-26 | Clients | P0 | Not started | **module** · needs Q-26 |
| BUG-27 | Portal/DKYC URLs | P0 | **Done** — both resolve to /ai-crm/… | confirmed |
| ENH-28 | Partner Portal usable | P1 | Not started | |
| ENH-28a | Commission trend | P1 | Not started | |
| ENH-28b | Client drill-down | P1 | Not started | |
| ENH-28c | Training detail | P1 | Not started | |
| — | API 404 not HTML | P1 | **Done** | unknown /api routes now 404 with JSON |
