# roo-push — notification dispatcher

A tiny Cloudflare Worker that runs **every minute** (cron) and sends Web Push
for Roo '26: **set reminders** (a buzz N minutes before each starred set) and
**severe NWS weather alerts**. Reads subscriptions from a KV namespace that the
app's `/roo26-api/push` route writes to. Pure Web Crypto (RFC 8291 + VAPID) —
no dependencies.

## How it fits together

```
app (PWA)  ──POST /roo26-api/push──►  PUSH_KV  ◄──reads──  roo-push (cron, 1/min)
  🔔 settings: on/off, lead time,      (subs +              └─ sends Web Push:
     weather alerts                     reminders)             set reminders + weather
```

The VAPID **public** key is already shipped (client + `wrangler.jsonc` var). The
**private** key is a secret you set. Both were generated together — keep them paired.

## One-time setup

```sh
# 1. Create the shared KV namespace (copy the id it prints)
npx wrangler kv namespace create roo26-push

# 2. Bind it to the APP worker: in /wrangler.jsonc uncomment the kv_namespaces
#    block and paste the id for PUSH_KV, then push to main (Workers Builds deploys).

# 3. Bind the SAME id in this worker: workers/roo-push/wrangler.jsonc → kv_namespaces[].id

# 4. Set the VAPID private key as a secret on this worker
cd workers/roo-push
npx wrangler secret put VAPID_PRIVATE      # paste the base64url private key

# 5. Deploy this worker (registers the every-minute cron)
npx wrangler deploy
```

That's it. Once PUSH_KV is bound to the app, the **🔔** button appears in the
header; users opt in, and the cron starts delivering.

## Notes
- **iOS** only delivers Web Push to an **installed** PWA (Add to Home Screen,
  iOS 16.4+). Android/desktop work in-browser.
- Test the dispatcher without waiting for the cron: `GET https://roo-push.<you>.workers.dev/run`.
- Subscriptions auto-expire from KV ~2 weeks out; dead subscriptions (404/410)
  are pruned on send.
- If you ever rotate VAPID keys, update the public key in **both** the client
  (`VAPID_PUBLIC` in `src/pages/roo26/_app.js`) and this worker's `wrangler.jsonc`,
  and re-`secret put` the private key. Existing subscriptions must re-subscribe.
