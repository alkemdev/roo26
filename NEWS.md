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

## Running it
- **On a schedule:** `/loop 20m research Bonnaroo 2026 for new schedule changes or
  incidents per NEWS.md, cross-reference ≥2 sources, and auto-publish high-confidence
  items to /roo26-api/news` — runs the playbook every 20 min through the festival.
- **Event-driven trigger (optional):** the `roo-push` cron Worker can hash the
  bonnaroo.com schedule images each minute and flag re-publishes as candidates for the
  agent to investigate (cheap official-change signal that beats social/press).

## Keys
- `ADMIN_KEY` (Worker secret) gates publishing.
- `VAPID_PRIVATE` (Worker secret) + `VAPID_PUBLIC`/`VAPID_SUBJECT` (vars) drive Web Push.
- All anonymous; pushes are targeted by starred-set, never by identity.
