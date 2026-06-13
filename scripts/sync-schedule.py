#!/usr/bin/env python3
"""
sync-schedule — diff Roo '26's schedule.json against the official Bonnaroo feed
(Tradable Bits, recovered from the Festiverse app — see docs/) and optionally
auto-apply day-of changes through the news/override API.

  Read-only scan (default):   python3 scripts/sync-schedule.py
  Apply time/stage + reappear:ROO_ADMIN_KEY=… python3 scripts/sync-schedule.py --apply
  Also apply cancellations:   ROO_ADMIN_KEY=… python3 scripts/sync-schedule.py --apply --cancels
  Machine output:             python3 scripts/sync-schedule.py --json

Matching is FUZZY (exact-substring containment + token overlap + ratio), so official
spelling variants (Tabacco↔Tobacco, G.Love↔G.L.O.X.E, Catio↔Catlo, "…WITH HOUSE OF YES"
suffixes) match instead of being false-flagged as cancels.

Self-healing: a set we previously CANCELLED that is back in the feed is surfaced as a
REAPPEAR — `--apply` retracts the stale cancel and re-applies the correct stage/time.
This is what stops a stale cancel from silently masking a later move (the bug that hid
Dora Jar's That→Other move behind an old "cancelled" override).

It is conservative on purpose:
  • TIME / STAGE moves and REAPPEARances are safe (artist matched, official value) — auto with --apply.
  • Genuine CANCELS (no fuzzy match anywhere in the feed) are gated behind --cancels.
  • Already-applied overrides are honoured (a set with a live time/stage override isn't re-flagged).
"""
import argparse, datetime, difflib, json, os, re, sys, unicodedata, urllib.request

TB_URL = (
    "https://tradablebits.com/api/v1/idols/events"
    "?api_key=0184f26f-2eee-4691-b981-95d49f563bfd"
    "&performance_uid=c98fc9b1-892c-4264-9400-30bc4dbd14ed"
)  # public client key from the Festiverse APK; re-extract if it rotates (see docs/)
NEWS_URL = "https://roo26.alkem.dev/roo26-api/news"
SCHEDULE = "src/pages/roo26/_data/schedule.json"
UA = "Mozilla/5.0 (sync-schedule; +roo26.alkem.dev)"

# official festival dates → our day ids
FEST = {"2026-06-11": "thu", "2026-06-12": "fri", "2026-06-13": "sat", "2026-06-14": "sun"}
# Tradable Bits venue → our stage id (stages we track; others are Outeroo/Planet Roo)
VEN = {
    "ROO STAGE 1": "what", "ROO STAGE 2": "which", "ROO STAGE 3": "this", "ROO STAGE 4": "that",
    "ROO STAGE 5": "other", "ROO STAGE 6": "where", "ROO STAGE 8": "when",
    "ROO STAGE 9": "groop", "ROO STAGE 10": "silent",
}

# transliterate festival special letters that don't NFKD-decompose (ø/ł/æ…) so the
# official feed's "MOTHERBØRG", "ŁASZEWO", "SUPERJÁM" match our plain-ASCII names
_XLAT = str.maketrans({"ø": "o", "Ø": "o", "ł": "l", "Ł": "l", "đ": "d", "ı": "i",
                       "æ": "ae", "œ": "oe", "ß": "ss", "ð": "d", "þ": "th"})


def _ascii(s):
    s = (s or "").translate(_XLAT)
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


norm = lambda s: re.sub(r"[^a-z0-9]", "", _ascii(s).lower())
slug = lambda s: re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", _ascii(s).lower()))
mins = lambda hm: int((hm or "00:00")[:2]) * 60 + int((hm or "00:00")[3:5])
toks = lambda s: set(t for t in re.findall(r"[a-z0-9]+", _ascii(s).lower()) if len(t) > 2)


def sim(a, b):
    """fuzzy name similarity: substring containment ≈ 0.97, else max(token-jaccard, ratio)."""
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na in nb or nb in na:
        return 0.97
    ta, tb = toks(a), toks(b)
    jac = len(ta & tb) / len(ta | tb) if (ta or tb) else 0.0
    return max(difflib.SequenceMatcher(None, na, nb).ratio(), jac)


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=45))


def festday(date_str, time_str):
    """festival day id with the 8 AM rollover (a 2 AM set belongs to the night before)."""
    if not date_str:
        return None
    h = int((time_str or "12:00")[:2])
    d = datetime.date.fromisoformat(date_str)
    if h < 8:
        d -= datetime.timedelta(days=1)
    return FEST.get(d.isoformat())


def fest_date(day_id, hm):
    """calendar date string our schedule uses for a (festival-day, HH:MM) slot."""
    base = {v: k for k, v in FEST.items()}[day_id]
    d = datetime.date.fromisoformat(base)
    if int(hm[:2]) < 8:  # after-midnight → next calendar day
        d += datetime.timedelta(days=1)
    return d.isoformat()


def feed_events(tb):
    """tracked-stage feed events with festival-day / stage / start / end / name."""
    out = []
    for e in tb:
        st = VEN.get(e.get("venue_name"))
        fd = festday(e.get("start_date", ""), e.get("start_time") or "")
        if st and fd:
            out.append({
                "st": st, "fd": fd, "name": e.get("event_name", ""),
                "start": (e.get("start_time") or "")[:5], "end": (e.get("end_time") or "")[:5],
            })
    return out


def best_match(name, events, day=None, thresh=0.6):
    """best fuzzy feed match for `name` (optionally restricted to festival `day`)."""
    best, br = None, 0.0
    for e in events:
        if day is not None and e["fd"] != day:
            continue
        r = sim(name, e["name"])
        if r > br:
            br, best = r, e
    return (best, br) if br >= thresh else (None, br)


def scan():
    tb = get_json(TB_URL)
    our = json.load(open(SCHEDULE))["sets"]
    try:
        items = get_json(NEWS_URL).get("items", [])
    except Exception:
        items = []

    # what's already overlaid, by setId → {types}; remember cancel news-item ids to retract
    applied, cancel_news = {}, {}
    for it in items:
        c = it.get("change") or {}
        sid = c.get("setId")
        if not sid:
            continue
        applied.setdefault(sid, set()).add(c.get("type"))
        if c.get("type") == "cancel":
            cancel_news[sid] = it.get("id")

    fev = feed_events(tb)
    changes = {"time": [], "stage": [], "cancel": [], "reappear": []}
    for s in our:
        sid = f"{s['d']}-{s['s']}-{slug(s['a'])}"
        ost = s["t"][11:16]
        types = applied.get(sid, set())

        if "cancel" in types:
            # SELF-HEAL: is a previously-cancelled act back in the feed (any day)?
            m, _ = best_match(s["a"], fev, day=None)
            if m:
                changes["reappear"].append({
                    "setId": sid, "artist": s["a"], "day": m["fd"], "stage": m["st"],
                    "wasDay": s["d"], "wasStage": s["s"], "now": m["start"],
                    "start": (f"{fest_date(m['fd'], m['start'])}T{m['start']}" if m["start"] else None),
                    "end": (f"{fest_date(m['fd'], m['end'])}T{m['end']}" if m["end"] else None),
                    "cancelNews": cancel_news.get(sid),
                })
            continue  # cancelled sets are handled via reappear, not time/stage

        m, _ = best_match(s["a"], fev, day=s["d"])
        if not m:
            # absent on our day — only a cancel candidate if truly absent every day
            if not best_match(s["a"], fev, day=None)[0]:
                changes["cancel"].append({"setId": sid, "artist": s["a"], "day": s["d"], "stage": s["s"], "was": ost})
            continue

        if m["start"] and m["start"] != ost and "time" not in types:
            changes["time"].append({
                "setId": sid, "artist": s["a"], "day": s["d"], "stage": s["s"], "was": ost, "now": m["start"],
                "start": f"{fest_date(s['d'], m['start'])}T{m['start']}",
                "end": (f"{fest_date(s['d'], m['end'])}T{m['end']}" if m["end"] else None),
            })
        if m["st"] and m["st"] != s["s"] and "stage" not in types:
            changes["stage"].append({"setId": sid, "artist": s["a"], "day": s["d"], "was": s["s"], "now": m["st"]})
    return tb, changes


def post(body, key):
    req = urllib.request.Request(NEWS_URL, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "x-admin-key": key, "User-Agent": UA})
    return json.load(urllib.request.urlopen(req, timeout=30))


def publish(item, key, notify=True):
    return post({"notify": notify, "item": item}, key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="apply TIME + STAGE moves and REAPPEARs via the override API")
    ap.add_argument("--cancels", action="store_true", help="also apply genuine CANCEL candidates (verify spelling first!)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    tb, ch = scan()
    if args.json:
        print(json.dumps(ch, indent=2))
    else:
        n = sum(len(v) for v in ch.values())
        print(f"📡 {len(tb)} official events · {n} candidate change(s)\n")
        for c in ch["reappear"]:
            print(f"  ♻️  REAPPEAR {c['artist']}: back as {c['day'].title()} {c['stage'].title()} {c['now']} (retract stale cancel)")
        for c in ch["time"]:
            print(f"  ⏰ TIME   {c['artist']} ({c['day']} {c['stage']}): {c['was']} → {c['now']}")
        for c in ch["stage"]:
            print(f"  🎪 STAGE  {c['artist']} ({c['day']}): {c['was']} → {c['now']}")
        for c in ch["cancel"]:
            print(f"  ❌ CANCEL {c['artist']} ({c['day']} {c['stage']} {c['was']}) — absent from feed (verify spelling)")
        if not n:
            print("  ✅ in sync — no changes")

    if not args.apply:
        return
    key = os.environ.get("ROO_ADMIN_KEY")
    if not key:
        sys.exit("⚠️  set ROO_ADMIN_KEY to apply")

    now = int(datetime.datetime.now().timestamp() * 1000)

    # REAPPEAR: retract the stale cancel, then re-apply the correct stage + time
    for c in ch["reappear"]:
        if c.get("cancelNews"):
            post({"action": "delete", "id": c["cancelNews"]}, key)
        if c["stage"] != c["wasStage"]:
            publish({"id": f"sync-reappear-stage-{c['setId']}", "ts": now, "severity": "alert",
                     "title": f"{c['artist']} is on — {c['stage'].title()} stage",
                     "summary": f"{c['artist']} is back on the official schedule ({c['day'].title()} {c['stage'].title()}).",
                     "body": f"• Listed again on the official Festiverse schedule.\n• Stage: {c['stage'].title()}.",
                     "confidence": 0.9, "sources": "Official Festiverse schedule", "tags": [slug(c["artist"])],
                     "change": {"type": "stage", "setId": c["setId"], "artist": c["artist"], "day": c["day"],
                                "stage": c["stage"], "note": "Back on the official schedule"}}, key, notify=False)
        publish({"id": f"sync-reappear-time-{c['setId']}", "ts": now, "severity": "alert",
                 "title": f"{c['artist']} is on — {c['day'].title()} {c['now']}",
                 "summary": f"Good news: {c['artist']} isn't cancelled — playing {c['day'].title()} {c['now']} ({c['stage'].title()}).",
                 "body": f"• {c['artist']} is back on the official Festiverse schedule.\n• {c['day'].title()} {c['now']}, {c['stage'].title()} stage.",
                 "confidence": 0.9, "sources": "Official Festiverse schedule", "tags": [slug(c["artist"])],
                 "change": {"type": "time", "setId": c["setId"], "artist": c["artist"], "day": c["day"],
                            "start": c["start"], "end": c["end"], "note": "Back on the official schedule"}}, key)
        print(f"  ✓ healed REAPPEAR {c['artist']} → {c['day']} {c['stage']} {c['now']}")

    for c in ch["time"]:
        publish({"id": f"sync-time-{c['setId']}", "ts": now, "severity": "info",
                 "title": f"{c['artist']} moved to {c['now']}",
                 "summary": f"{c['artist']} now starts {c['now']} ({c['day'].title()} {c['stage'].title()}) — was {c['was']}.",
                 "body": f"• New time: {c['now']} (was {c['was']}).\n• Per the official Festiverse schedule.",
                 "confidence": 0.9, "sources": "Official Festiverse schedule", "tags": [slug(c["artist"])],
                 "change": {"type": "time", "setId": c["setId"], "artist": c["artist"], "day": c["day"],
                            "start": c["start"], "end": c["end"], "note": "Official time update"}}, key)
        print(f"  ✓ applied TIME {c['artist']} → {c['now']}")
    for c in ch["stage"]:
        publish({"id": f"sync-stage-{c['setId']}", "ts": now, "severity": "alert",
                 "title": f"{c['artist']} moved to the {c['now'].title()} stage",
                 "summary": f"{c['artist']} ({c['day'].title()}) moved from {c['was'].title()} to {c['now'].title()}.",
                 "body": f"• New stage: {c['now'].title()} (was {c['was'].title()}).\n• Per the official Festiverse schedule.",
                 "confidence": 0.9, "sources": "Official Festiverse schedule", "tags": [slug(c["artist"])],
                 "change": {"type": "stage", "setId": c["setId"], "artist": c["artist"], "day": c["day"],
                            "stage": c["now"], "note": "Official stage move"}}, key)
        print(f"  ✓ applied STAGE {c['artist']} → {c['now']}")
    if args.cancels:
        for c in ch["cancel"]:
            publish({"id": f"sync-cancel-{c['setId']}", "ts": now, "severity": "alert",
                     "title": f"{c['artist']} off the lineup",
                     "summary": f"{c['artist']}’s {c['day'].title()} {c['stage'].title()} set is no longer on the official schedule.",
                     "body": f"• {c['artist']}’s {c['day'].title()} {c['was']} set is no longer listed.\n• Dropped from the official Festiverse schedule.",
                     "confidence": 0.85, "sources": "Official Festiverse schedule", "tags": [slug(c["artist"]), "cancelled"],
                     "change": {"type": "cancel", "setId": c["setId"], "artist": c["artist"], "day": c["day"],
                                "note": "No longer on the official schedule"}}, key)
            print(f"  ✓ applied CANCEL {c['artist']}")
    elif ch["cancel"]:
        print(f"  ⓘ {len(ch['cancel'])} cancel candidate(s) NOT applied — re-run with --cancels after verifying spelling")


if __name__ == "__main__":
    main()
