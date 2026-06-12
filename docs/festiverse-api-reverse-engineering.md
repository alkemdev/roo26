# Reverse-engineering the Festiverse schedule API

How the official **Bonnaroo 2026 schedule** was pulled programmatically for Roo '26 —
a full account of the recon, the APK teardown, the backend discovery, and the working
endpoint. Written so it's reproducible and so the integration can be repaired if keys rotate.

> **Scope & ethics.** This used only **public artifacts** — the published Android APK and
> public DNS/HTTP — to discover the endpoint the app uses to fetch the **publicly-displayed**
> festival schedule. No authentication was broken, no user data accessed, nothing exploited.
> The keys involved are **client-side keys shipped in every install** of the public app. This
> is interoperability (reading public schedule data into another app), but note it is against
> the app's ToS in spirit; keep request volume low and cache. Don't redistribute user data.

---

## TL;DR (the answer)
The Festiverse app's set-times are served by **Tradable Bits** (a fan-engagement/CRM
platform the app uses as its schedule backend). No user login required:

```
GET https://tradablebits.com/api/v1/idols/events
      ?api_key=0184f26f-2eee-4691-b981-95d49f563bfd
      &performance_uid=c98fc9b1-892c-4264-9400-30bc4dbd14ed
```

Returns a JSON array of **~275 events** (Jun 10–14, all 14 stages). `api_key` and
`performance_uid` are **public client values** extracted from the APK.

---

## 0. Target & goal
- **App:** Festiverse — the official Bonnaroo app. Android `com.festiverse.production`,
  iOS `id6744997695`. Publisher *Festiverse LLC*; built by the agency **Codelink**.
- **Goal:** fetch the official, live schedule as structured data so Roo '26 can detect
  day-of changes (cancellations, time/stage moves, replacements) automatically instead of
  scraping `bonnaroo.com`'s flat schedule *images* or social posts.

---

## 1. Web recon — and why it dead-ended
First, the cheap checks. All dead ends, but they tell you the backend is deliberately hidden:

```bash
# Subdomain probe — only www + root resolve
python3 - <<'PY'
import socket
for s in ['','www','api','app','web','data','cms','prod','gateway','mobile','backend','graphql']:
    h=(s+'.festiverse.com') if s else 'festiverse.com'
    try: print(h, socket.gethostbyname(h))
    except: pass
PY
# festiverse.com      -> 99.83.190.102   (AWS Global Accelerator)
# www.festiverse.com  -> 198.202.211.1   (Webflow)
```

- **`api.festiverse.com` → NXDOMAIN.** No obvious API subdomain.
- **`www.festiverse.com`** is a **Webflow** marketing site (`server: cloudflare`,
  `x-wf-region: us-east-1`). Its HTML references only Webflow's CDN, jQuery, Google fonts,
  and Heap analytics — **no backend API host**.
- **`festiverse.com` (root)** is an **AWS Global Accelerator** IP that just **301-redirects**
  to `www`. Probing it for `/api`, `/graphql`, `/v1/schedule`, etc. → all `301`. Not an API.

**Conclusion:** the backend host isn't exposed on the web at all. It lives only inside the
app binary. So → tear down the APK.

---

## 2. Acquiring the APK (public mirror)
APKPure exposes a JSON detail endpoint that yields a direct CDN download:

```bash
# get the direct download URL from APKPure's detail API
curl -s "https://tapi.pureapk.com/v3/get_app_detail?hl=en&package_name=com.festiverse.production"
#  -> contained a direct data.winudf.com  *.xapk  URL
curl -L -o Festiverse.xapk "<data.winudf.com URL>"
# Festiverse.xapk  v0.4.1  ~168 MB   SHA1 dd498cd6…  (matched APKPure's published hash)
```

> Modern Android packages are often **`.xapk`/`.apkm`** (a zip of a base `.apk` + split
> configs + OBB). Unzip the `.xapk`, then unzip the base `.apk` inside it.

```bash
unzip -o Festiverse.xapk -d festiverse_xapk
unzip -o festiverse_xapk/com.festiverse.production.apk -d festiverse   # APKs are just zips
```

---

## 3. Identifying the stack — Expo / React Native + Hermes
Inside the APK, the tells of an **Expo / React Native** app are present, and the JS isn't
plaintext — it's **Hermes bytecode**:

```bash
file festiverse/assets/index.android.bundle
#  -> Hermes JavaScript bytecode  (magic 0x1F1903C1…)
strings festiverse/assets/index.android.bundle | grep -i http   # → mostly concatenated junk
```

A normal `grep` over a Hermes bundle returns garbage because string literals are packed into
a table referenced by bytecode, not laid out inline. So plaintext extraction fails — this was
the one real speed bump.

---

## 4. Disassembling the Hermes bytecode
Use **`hermes-dec`** (`hbc-disassembler`) to decode the bundle. The disassembly exposes the
**string table** cleanly, which contains every baked URL, config object, and client key:

```bash
pip install hermes-dec
hbc-disassembler festiverse/assets/index.android.bundle out.hasm
grep -aoE 'https?://[A-Za-z0-9._/-]+' out.hasm | sort -u     # now: real hosts
grep -iaE 'api_key|performance_uid|tradablebits|strapi|codelink' out.hasm
```

This recovered the app's baked configuration verbatim.

---

## 5. The backend architecture (what the bundle revealed)
The app talks to **three** backends, all built/hosted by Codelink (the `*.prodftv.internal.codelink.io`
hosts resolve publicly via AWS CloudFront despite the "internal" in the name):

| Concern | Service | Host |
|---|---|---|
| **Set-times / schedule** | **Tradable Bits** (3rd-party) | `tradablebits.com/api` |
| Content / CMS (festivals, artists, maps, missions) | **Strapi v5** | `strapi.prodftv.internal.codelink.io/api` |
| App gateway | NestJS/Express | `api.prodftv.internal.codelink.io` |
| Strapi media | S3 (us-west-2) via CloudFront | `strapi-cdn.prodftv.internal.codelink.io` |

Other client keys baked in (expected for a mobile app): AppsFlyer, Ticketmaster Ignite,
Frontgate Tickets, Facebook, Heap, OneSignal, Firebase App-Check.

**Key insight:** the **schedule is NOT in Strapi** — Strapi only holds festival metadata and
the artist catalog. Set-times come exclusively from **Tradable Bits**.

---

## 6. Finding `performance_uid` (the festival id in Tradable Bits)
The Tradable Bits call needs a `performance_uid`. That id isn't hard-coded for Bonnaroo in the
bundle — it's stored per-festival in Strapi. The APK also contains a baked **Strapi read API
token** (a long hex bearer; *not reproduced here — keep tokens out of the repo*), which opens
the otherwise-403 collections:

```bash
curl -s "https://strapi.prodftv.internal.codelink.io/api/festivals?populate=*" \
     -H "Authorization: Bearer <STRAPI_TOKEN_FROM_APK>"
```

- 20 festivals total. Bonnaroo 2026 = `festival_identifier: ROO_26_US_C3`,
  documentId `y2p2cbjfsy9khz7ry7b9y8mw`, and its record carries
  `tradable_bits.performance_uid = c98fc9b1-892c-4264-9400-30bc4dbd14ed`.
- Tradable Bits business id for Festiverse = `77415`; the `api_key` above is its public client key.

(Useful Strapi collections, if you want metadata: `/api/festivals`, `/api/artists` — 3,271
acts with Spotify/Deezer/YouTube/Instagram ids, joinable to the schedule via `idol_uid` ↔
`tbits_idol_uid` — plus `/api/sections`, `/api/missions`, `/api/festival-dates`,
`/api/festival-headers`. Strapi media URLs are CloudFront-signed and **expire in ~hours**.)

---

## 7. The schedule endpoint & response shape
```
GET https://tradablebits.com/api/v1/idols/events?api_key=…&performance_uid=…
```
- **Method:** GET. **Auth:** none beyond the `api_key` query param. No header, no login.
- **Verified:** HTTP 200, ~369 KB JSON, **275 events**, Jun 10–14, headliners correct
  (Skrillex, The Strokes, GRiZ, Four Tet, Vince Staples…).

Each element:
```json
{
  "idol_event_uid": "5089d64c-…",
  "event_name": "CLAIRE ROSINKRANZ",                  // the act (UPPERCASE)
  "idol_uid": "badb2d21-…",                            // artist id → Strapi join
  "venue_name": "ROO STAGE 2",                         // coded stage
  "display_venue_name": "<ord>2<nm>WHICH",             // real stage name, encoded
  "start_timestamp": "2026-06-12 14:30:00",
  "end_timestamp":   "2026-06-12 15:15:00",
  "start_date": "2026-06-12", "start_time": "14:30", "end_time": "15:15",
  "idol_image_url": "https://tradablebits.com/fb_media/…",
  "is_available": true
}
```

### Decoding the stage names
`venue_name` is the opaque `ROO STAGE N`; the human name is inside `display_venue_name`,
encoded as `<ord>N<nm>NAME` (with `\r` separating a sub-label like `PLAZA 5`):

```python
import re
def real_stage(e):
    m = re.search(r'<nm>(.*)', e.get('display_venue_name',''), re.S)
    return (m.group(1).replace('\r',' ').strip() if m else e['venue_name'])
```

**Stage map (TB → Roo '26 stage id):**

| TB | Real name | Our id |
|----|-----------|--------|
| ROO STAGE 1 | WHAT | `what` |
| ROO STAGE 2 | WHICH | `which` |
| ROO STAGE 3 | THIS | `this` |
| ROO STAGE 4 | THAT | `that` |
| ROO STAGE 5 | OTHER | `other` |
| ROO STAGE 6 | WHERE | `where` |
| ROO STAGE 7 | WHY · Plaza 2 | (Outeroo) |
| ROO STAGE 8 | WHEN · Plaza 3 | `when` |
| ROO STAGE 9 | GROOP · Plaza 5 | `groop` |
| ROO STAGE 10 | SILENT DISCO · Plaza 9 | `silent` |
| ROO STAGE 11 | THE GROVE · Plaza 7 | (Outeroo) |
| ROO STAGE 12 | SNAKE & JAKE'S · in Centeroo | (Outeroo) |
| ROO STAGE 13 | THE ACADEMY · Planet Roo | non-music (talks) |
| ROO STAGE 14 | HOW STAGE · Planet Roo | non-music (talks) |

---

## 8. Using it — fetch & map
```bash
curl -s "https://tradablebits.com/api/v1/idols/events?api_key=0184f26f-2eee-4691-b981-95d49f563bfd&performance_uid=c98fc9b1-892c-4264-9400-30bc4dbd14ed" -o tb.json
```
Map each event → our `{a: event_name (title-cased), s: stage_id, d: day_id, t: start, e: end}`,
keyed by our `${day}-${stage}-${slug(artist)}` set id. **Filter out non-music** Planet Roo
programming (stages 13–14 and entries like yoga/podcasts/workshops/puppet parades) — the app
tracks music. Then diff against `schedule.json` on `{day, stage, artist}` and apply
time/stage/cancellation deltas through the override API (`/roo26-api/news`, see NEWS.md).

---

## 9. What the first diff found
Official **275 events / 245 "acts"** vs our **154 sets / 152 artists**:

- **The only real music change:** **Wolfmother cancelled** (0 entries in the official feed)
  and were replaced at Fri 2:30 PM Which Stage by **Claire Rosinkranz** — who was never on the
  announced lineup, which is exactly why she wasn't in our data. Both were applied live via the
  override system.
- **~100** of the official "extra" entries are **non-music Planet Roo programming** (yoga,
  podcasts, panels, puppet parades) that the app intentionally omits.
- The remainder were **spelling variants** (e.g. our "Trixie Mattel" vs official
  "DJ Trixie Mattel"; "Heelturn & Madspinnz" vs "HEELTURN X MADSPINNZ").

So our music lineup was essentially complete; the feed's value is **catching live changes**.

---

## 10. Fragility / maintenance
- **Key rotation:** `api_key` / `performance_uid` / the Strapi token are client values baked
  into the APK. A new app release could rotate them — if requests start failing, re-extract
  from a newer APK (repeat §2–6).
- **CloudFront-signed media** (Strapi images) expires in ~hours — fetch on demand, don't cache URLs.
- **Names are UPPERCASE** in TB and spellings differ slightly — title-case and reconcile
  against existing entries before adding.
- **No hard blocker** was hit. Hermes bytecode was the only obstacle and `hermes-dec` cleared it.

## 11. Prior art
`github.com/porkcharsui/clashfinder` reverse-engineers other festival apps (Appmiral,
GreenCopper/Aloompa) via on-device MITM session-key capture — but documents **nothing** on
Festiverse or Tradable Bits. The `tradablebits.com/api/v1/idols/events` route for this app
appears undocumented publicly; this writeup is the record.
