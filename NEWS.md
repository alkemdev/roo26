# Roo '26 — Live News & Autonomous Research Workflow

A festival news/alerts system with an AI-agent research loop that detects events,
cross-references multiple sources, and **auto-publishes high-confidence items** to
the app (banner + Guide news strip + modal + targeted Web Push).

## Surfaces (live)
- **Top banner** — most-recent undismissed item, severity-colored; tap → modal.
- **Guide news strip** — horizontally scrollable feed of all items.
- **Modal** — full description + source links grouped Official / Press / Social / Sources.
- **Schedule overlay** — an item with a `change` overlays onto the schedule with a
  ⚡ badge (time/stage/cancel/note/add) and re-syncs reminders. Never rewrites `schedule.json`.
- **Web Push** — fires on publish: targeted to people who **starred the affected set**
  when the item carries a `change`, else broadcast (respecting each sub's `news` pref).

## Publish API
`POST https://roo26.alkem.dev/roo26-api/news`  — header `x-admin-key: <ADMIN_KEY>` (a Worker secret).

```jsonc
{
  "notify": true,                 // false = add silently (no push); default true
  "item": {
    "severity": "info|alert|urgent",
    "title": "short headline",
    "summary": "one line for the banner/strip",
    "body": "full description (\\n for paragraphs)",
    "confidence": 0.0,            // 0–1, see rubric
    "sources": "attribution line shown in the modal",
    "tags": ["power-outage","skrillex"],
    "links": [
      { "label": "...", "url": "https://...", "kind": "official|press|social|source|other" }
    ],
    "change": {                   // OPTIONAL — only for real schedule changes
      "type": "time|stage|cancel|note|add",
      "setId": "fri-what-the-strokes",   // canonical ${day}-${stage}-${slug(artist)}
      "artist": "The Strokes", "day": "fri", "stage": "what",
      "start": "2026-06-12T23:30", "end": "2026-06-13T01:00",
      "note": "pushed 30 min by weather hold"
    }
  }
}
```
- Retract: `POST` with `{ "action":"delete", "id":"<id>", "key":"<ADMIN_KEY>" }`.
- Read feed: `GET /roo26-api/news` (public).

## Writing guidelines (how an alert should read)
Strike a balance: **short and scannable, but genuinely informative.** People read these
on a phone, in a crowd, often in a hurry.

- **Summary** (banner/strip): ≤ ~120 chars. Lead with the *what* + the *impact*. No hype,
  no filler. e.g. _"Storms move in ~6 PM Sat — What/Which stages may pause; check back."_
- **Body**: use **bullet points**, one fact each. The modal renders lines that start with
  `• `, `- `, or `* ` as a bullet list (`▸`). Keep to **≤ 6 bullets**, short sentences.
  Recommended order:
  1. **When** — date + time (festival-local CDT), and whether it's resolved/ongoing.
  2. **Where** — stage(s)/area affected.
  3. **What's affected** — concretely.
  4. **Impact on sets** — who's delayed/moved/cancelled and the new time if known.
  5. **Cause / status** — only if known; say "unconfirmed" when it is.
  6. **Caveat** — note single-sourced/provisional info honestly.
- **Lead bullet = the single most important thing** someone needs to know.
- **Always cite sources.** Add as many real `links` as make sense, grouped by `kind`
  (`official` > `press` > `social` > `source`), plus a one-line `sources` attribution and
  an honest `confidence`. Prefer official Bonnaroo + reputable press; mark rumors as such.
- **Verify links resolve** (no 404s) before publishing — drop or replace dead URLs.
- **Severity:** `info` = FYI, no schedule impact · `alert` = affects plans (delays/moves)
  · `urgent` = safety/weather/evacuation (red banner, push immediately if credible).
- If a set actually moved/cancelled, attach a `change` **and** state the new time in a bullet.
- Tone: factual and calm. Frame for festival-goers (name the stage, the artist, the time).

**Example body:**
```
• When: Thu Jun 11, ~8:30 PM CDT — power restored shortly after.
• Where: Localized to The Farm (not a regional outage).
• Affected: What Stage screens & lights, the Bonnaroo sign, Ferris wheel, some food vendors & restrooms.
• Sets: Four Tet & Skrillex delayed ~30 min; resumed with Four Tet. No cancellations.
• Cause: Unconfirmed (an attendee floated a blown transformer; no official word).
• Note: Still single-sourced — treat specifics as provisional.
```

## Autonomous research playbook (run by an AI agent, e.g. via `/loop`)
On each cycle:
1. **Detect.** Scan for new events since last run:
   - Official: `bonnaroo.com/schedule` (set times are **images** — note when an image
     URL hash changes = a re-publish) and `bonnaroo.com` for banners/alerts.
   - Real-time: **@Bonnaroo on X** + Instagram, filtered for `delay|cancel|moved|
     rescheduled|weather|hold|evacuat|power`.
   - Press/local: Billboard, Consequence, Stereogum, WKRN/WSMV/Tennessean, MTSU Sidelines.
   - Structured: Clashfinder `bonnaroo2k26` (often captcha-walled — best-effort).
2. **Cross-reference.** For each candidate, gather **≥2 independent sources**. Compare
   against current `schedule.json` on `{day, stage, artist}`.
3. **Score confidence:**
   - **≥0.85** — official Bonnaroo source OR ≥2 independent reputable outlets agree → **auto-publish** (`notify:true`).
   - **0.6–0.85** — single credible source / minor detail → publish as `info`/`alert`
     with `notify:false` (shows in feed, no push) and lower `confidence`.
   - **<0.6** — rumor/social only → **do not publish**; hold for human review.
4. **De-dupe.** Skip if an item with the same event already exists (`GET /news` first).
5. **Publish.** POST with honest `confidence`, a clear `sources` line, and as many
   real `links` as make sense so people can read the originals. Attach a `change` only
   when a set time/stage actually moved or was cancelled.
6. **Escalate.** Anything safety-related (weather hold, evacuation, injury) → `severity:
   "urgent"` and publish immediately if it clears 0.6 from an official source.

### Confidence rubric (quick)
| Evidence | Confidence | Action |
|---|---|---|
| Official Bonnaroo post/site | 0.95 | auto-publish + push |
| ≥2 reputable outlets agree | 0.85–0.9 | auto-publish + push |
| 1 reputable local/press outlet | 0.6–0.8 | publish, no push |
| Social/fan chatter only | <0.6 | hold |

## ▶ Start the watcher (copy-paste)
Open a **new Claude Code thread on the `alkemdev/roo26` repo** (keep your dev thread
separate). Paste the `ADMIN_KEY` in where shown, then paste this one line:

```
/loop 15m You are the autonomous live news + schedule editor for the Roo '26 Bonnaroo app (roo26.alkem.dev). Read NEWS.md in this repo for the full playbook, writing style, and confidence rubric, and follow it exactly. Run fully autonomously every cycle — publish without asking. 1) DE-DUPE: GET https://roo26.alkem.dev/roo26-api/news and skim schedule.json so you know current state + what's posted. 2) RESEARCH: spawn several parallel agents to find anything NEW since last cycle across bonnaroo.com (schedule images, banners, alerts), @Bonnaroo on X & Instagram, Clashfinder bonnaroo2k26, and press/local (Billboard, Consequence, Stereogum, Brooklyn Vegan, WKRN, WSMV, Tennessean, MTSU Sidelines) — set time changes, stage moves, cancellations/drop-outs, additions, weather holds/evacuations, safety incidents. 3) CROSS-REFERENCE + SCORE: gather >=2 independent sources per candidate, compare to schedule.json on {day,stage,artist}, score confidence per NEWS.md. 4) APPLY + NOTIFY via POST https://roo26.alkem.dev/roo26-api/news (header x-admin-key: <PASTE_ADMIN_KEY>): for a real set time/stage/cancellation/addition change include a structured `change` (type time|stage|cancel|add, setId `${day}-${stage}-${slug(artist)}`, new start/end in CDT e.g. 2026-06-13T23:30, note) so it live-updates the set (⚡ badge) + re-syncs reminders + pushes people who starred it; for an incident post a news item (severity info|alert|urgent). Write per NEWS.md: tight summary (<=120 chars, lead with impact), <=6 short bullets (When/Where/Affected/Sets/Cause/Caveat), honest confidence + sources line, and as many real, link-checked source links as make sense grouped official/press/social/source — verify every URL resolves (no 404s). notify:true ONLY at high confidence (official or >=2 agreeing outlets); medium -> notify:false (feed only); low/rumor -> don't publish, just note it. Safety items from an official source -> severity urgent, publish immediately. 5) NEVER touch git or schedule.json — publish only via the API (it goes live on prod automatically). Print a concise report: found / published (with confidence + push count) / "no changes".
```

- Adjust the interval (`15m`) — tighter (`10m`) in the evenings when sets run, looser
  overnight. Omit it (`/loop Run the Roo…`) to let the model self-pace.
- ⚠️ A `/loop` lives in one cloud session, which is **ephemeral** — it won't survive the
  whole festival untended; re-paste to restart. For hands-off multi-day, use a **Routine** ↓

## ⏱️ Run it durably as a Routine (recommended for multi-day)
**Routines** run on Anthropic's cloud on a schedule (even with your laptop/app closed),
spinning up a **fresh isolated session each run** — so there's no long-lived container to
get reclaimed. Caveat: **minimum cadence is 1 hour** (sub-hourly is rejected), so pair an
hourly Routine with a `/loop` (15 min) during peak evening hours and/or the always-on
`roo-push` cron detector.

Setup — at **claude.ai/code/routines → New routine**:
1. **Name:** `Roo '26 news watch`
2. **Repository:** `alkemdev/roo26`
3. **Environment:** one with web/network access; add an env var **`ADMIN_KEY`** =
   the publish key (keeps the secret out of the prompt).
4. **Trigger:** Schedule → Hourly (or `/schedule update` for a custom cron, min 1h).
5. **Prompt:** paste the per-run task below.
6. **Create → Run now** to test.

```
You are the autonomous live news + schedule editor for the Roo '26 Bonnaroo app (roo26.alkem.dev). Read NEWS.md in this repo for the full playbook, writing style, and confidence rubric, and follow it exactly — run fully autonomously and publish without asking. 1) DE-DUPE: GET https://roo26.alkem.dev/roo26-api/news and skim schedule.json for current state + what's posted. 2) RESEARCH: spawn several parallel agents for anything NEW since the last run across bonnaroo.com (schedule images, banners, alerts), @Bonnaroo on X & Instagram, Clashfinder bonnaroo2k26, and press/local (Billboard, Consequence, Stereogum, Brooklyn Vegan, WKRN, WSMV, Tennessean, MTSU Sidelines) — set time changes, stage moves, cancellations/drop-outs, additions, weather holds/evacuations, safety incidents. 3) CROSS-REFERENCE + SCORE: >=2 independent sources per candidate, compare to schedule.json on {day,stage,artist}, score confidence per NEWS.md. 4) APPLY + NOTIFY via POST https://roo26.alkem.dev/roo26-api/news with header "x-admin-key: $ADMIN_KEY" (read from the ADMIN_KEY env var): for a real set time/stage/cancellation/addition change include a structured `change` (type time|stage|cancel|add, setId `${day}-${stage}-${slug(artist)}`, new start/end in CDT e.g. 2026-06-13T23:30, note) so it live-updates the set + re-syncs reminders + pushes people who starred it; for an incident post a news item (severity info|alert|urgent). Write per NEWS.md: tight summary (<=120 chars), <=6 short bullets (When/Where/Affected/Sets/Cause/Caveat), honest confidence + sources, real link-checked source links grouped official/press/social/source (no 404s). notify:true ONLY at high confidence (official or >=2 agreeing outlets); medium -> notify:false; low/rumor -> don't publish. Safety from an official source -> severity urgent, publish now. 5) NEVER push to git or edit schedule.json — publish only via the API. End with a concise report: found / published (confidence + push count) / "no changes".
```
- **Stop it** anytime: send `stop` / "stop the loop" in that thread, or just close it.
- It's **stateless** — if the cloud session gets reclaimed, start a fresh thread and
  paste the same line; it re-reads the live feed to avoid duplicates.

## What each cycle actually does
1. `GET /roo26-api/news` → sees what's already posted (won't repost the same event).
2. Spawns **research sub-agents** that web-search + fetch across the sources above.
3. **Cross-references** candidates (≥2 independent sources) and scores confidence.
4. Publishes via `POST /roo26-api/news` — which, server-side:
   - appends the item (banner + Guide strip + modal go live within ~5 min / on refresh),
   - overlays any `change` onto the schedule (new time + ⚡ badge + reminder re-sync),
   - fires **Web Push** — targeted to people who starred the affected set, else broadcast.
5. Prints a short report; waits for the next interval.

**Guardrails:** it only talks to the API (never commits to git, so it can't break the
build or the repo), it de-dupes every cycle, and it gates pushes on confidence. Cost note:
each cycle runs web-search agents — at 20-min intervals that's a few dozen runs a day, so
run it during active hours and stop it when you don't need it.

## Running it
- **On a schedule:** the `/loop` above (recommended; rich multi-source agent research).
- **Event-driven trigger (optional):** the `roo-push` cron Worker can hash the
  bonnaroo.com schedule images each minute and flag re-publishes as candidates for the
  agent to investigate (cheap always-on official-change signal that beats social/press).

## Keys
- `ADMIN_KEY` (Worker secret) gates publishing.
- `VAPID_PRIVATE` (Worker secret) + `VAPID_PUBLIC`/`VAPID_SUBJECT` (vars) drive Web Push.
- All anonymous; pushes are targeted by starred-set, never by identity.
