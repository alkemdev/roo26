// roo26-api/push — store/refresh a browser's push subscription + the reminder
// timestamps it wants. The separate roo-push cron Worker reads this KV and
// sends the notifications. Inert until a PUSH_KV namespace is bound; the client
// feature-detects via GET and hides the notification UI when it's absent.
import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

export const prerender = false

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

// stable KV key from the (long, unique) push endpoint URL
async function keyFor(endpoint: string) {
	const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
	return 'push:' + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}

// feature-detect: is the push backend wired up?
export const GET: APIRoute = () => json({ ok: !!(env as any).PUSH_KV })

export const POST: APIRoute = async ({ request }) => {
	const kv = (env as any).PUSH_KV as KVNamespace | undefined
	if (!kv) return json({ ok: false, error: 'push backend not configured' }, 503)
	let body: any
	try {
		body = await request.json()
	} catch {
		return json({ error: 'bad json' }, 400)
	}
	const { action, sub, prefs, reminders, stars, tz } = body || {}
	if (!sub?.endpoint || typeof sub.endpoint !== 'string') return json({ error: 'no subscription' }, 400)
	const key = await keyFor(sub.endpoint)

	if (action === 'unsubscribe') {
		await kv.delete(key)
		return json({ ok: true })
	}

	// subscribe / sync — keep only well-formed future-ish reminders, bounded
	const rem = (Array.isArray(reminders) ? reminders : [])
		.filter((r) => r && typeof r.at === 'number' && typeof r.title === 'string')
		.slice(0, 400)
	const record = {
		sub,
		prefs: { sets: prefs?.sets !== false, lead: Number(prefs?.lead) || 20, weather: prefs?.weather !== false, news: prefs?.news !== false },
		reminders: rem,
		// starred set IDs — lets the news endpoint target schedule-change pushes to
		// exactly the people affected. Bounded.
		stars: (Array.isArray(stars) ? stars : []).filter((x) => typeof x === 'string').slice(0, 600),
		tz: typeof tz === 'string' ? tz : '-05:00',
		updatedAt: Date.now(),
	}
	// auto-expire a couple weeks out so stale subs don't linger past the fest
	await kv.put(key, JSON.stringify(record), { expirationTtl: 14 * 24 * 3600 })

	// Lower the cron's scan gate if this sub has an earlier pending reminder than
	// what's armed. The roo-push cron skips its per-subscriber scan until now ≥
	// ctl:nextDue, so this is how a fresh subscription guarantees it gets seen.
	const now = Date.now()
	let minFuture = Infinity
	for (const r of rem) if (typeof r.at === 'number' && r.at > now && r.at < minFuture) minFuture = r.at
	if (minFuture !== Infinity) {
		const armedRaw = await kv.get('ctl:nextDue')
		const armed = armedRaw == null ? Infinity : Number(armedRaw)
		if (minFuture < armed) await kv.put('ctl:nextDue', String(minFuture))
	}
	return json({ ok: true, count: rem.length })
}
