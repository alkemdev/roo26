#!/usr/bin/env python3
"""
sync-schedule — diff Roo '26's schedule.json against the official Bonnaroo feed
(Tradable Bits, recovered from the Festiverse app — see docs/) and optionally
auto-apply day-of changes through the news/override API.

  Read-only scan (default):   python3 scripts/sync-schedule.py
  Apply time/stage moves:     ROO_ADMIN_KEY=… python3 scripts/sync-schedule.py --apply
  Also apply cancellations:   ROO_ADMIN_KEY=… python3 scripts/sync-schedule.py --apply --cancels
  Machine output:             python3 scripts/sync-schedule.py --json

It is conservative on purpose:
  • TIME / STAGE changes are safe (artist matched, official new value) — auto-applied with --apply.
  • CANCELS (our set absent from the feed) are gated behind --cancels, because a spelling
    variant would otherwise false-cancel a real act. Verify before applying.
  • Already-applied overrides (live in /news) are skipped, so re-running is idempotent.
"""
import argparse, datetime, json, os, re, sys, urllib.request

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

norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
slug = lambda s: re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", (s or "").lower()))
mins = lambda hm: int((hm or "00:00")[:2]) * 60 + int((hm or "00:00")[3:5])


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


def scan():
    tb = get_json(TB_URL)
    our = json.load(open(SCHEDULE))["sets"]
    try:
        applied = {i["change"].get("setId") for i in get_json(NEWS_URL).get("items", []) if i.get("change")}
    except Exception:
        applied = set()

    # index TB by (festday, normalised artist) → events
    idx = {}
    for e in tb:
        fd = festday(e.get("start_date", ""), e.get("start_time") or "")
        if not fd:
            continue
        idx.setdefault((fd, norm(e.get("event_name"))), []).append(
            {"stage": VEN.get(e.get("venue_name")), "start": e.get("start_time") or "", "end": e.get("end_time") or ""}
        )
    tb_names = {norm(e.get("event_name")) for e in tb}

    changes = {"time": [], "stage": [], "cancel": [], "add": []}
    for s in our:
        sid = f"{s['d']}-{s['s']}-{slug(s['a'])}"
        if sid in applied:
            continue
        ost = s["t"][11:16]
        m = idx.get((s["d"], norm(s["a"])))
        if not m:
            if norm(s["a"]) not in tb_names:  # truly absent anywhere → cancel candidate
                changes["cancel"].append({"setId": sid, "artist": s["a"], "day": s["d"], "stage": s["s"], "was": ost})
            continue
        best = min(m, key=lambda e: abs(mins(e["start"]) - mins(ost)))  # nearest set for multi-slot acts
        if best["start"] and best["start"] != ost:
            changes["time"].append({
                "setId": sid, "artist": s["a"], "day": s["d"], "stage": s["s"], "was": ost, "now": best["start"],
                "start": f"{fest_date(s['d'], best['start'])}T{best['start']}",
                "end": (f"{fest_date(s['d'], best['end'])}T{best['end']}" if best["end"] else None),
            })
        if best["stage"] and best["stage"] != s["s"]:
            changes["stage"].append({"setId": sid, "artist": s["a"], "day": s["d"], "was": s["s"], "now": best["stage"]})
    return tb, changes


def publish(item, key):
    body = json.dumps({"notify": True, "item": item}).encode()
    req = urllib.request.Request(NEWS_URL, data=body, method="POST",
                                 headers={"content-type": "application/json", "x-admin-key": key, "User-Agent": UA})
    return json.load(urllib.request.urlopen(req, timeout=30))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="apply TIME + STAGE changes via the override API")
    ap.add_argument("--cancels", action="store_true", help="also apply CANCEL candidates (verify spelling first!)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    tb, ch = scan()
    if args.json:
        print(json.dumps(ch, indent=2))
    else:
        n = sum(len(v) for v in ch.values())
        print(f"📡 {len(tb)} official events · {n} candidate change(s)\n")
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
