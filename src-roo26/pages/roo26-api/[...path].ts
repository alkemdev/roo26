// roo26-api — crew location sharing, as a Cloudflare Workers on-demand route.
// (Ported from the old Pages Function; Pages `functions/` don't run on Workers.)
// Needs a KV namespace bound as ROO_KV in wrangler.jsonc. Until it's bound,
// /health reports ok:false and the app hides all crew UI.
//
// Model: a crew is a 6-char code (capability — anyone with the code is in).
// Members POST their location every ~25s; entries expire after 5 minutes, so
// closing the app removes you from the map shortly after. No accounts, no
// history, nothing persisted beyond the TTL.
import type { APIRoute } from 'astro'
// Astro v6 + @astrojs/cloudflare: bindings come from the workerd runtime module,
// not Astro.locals.runtime.env (removed in v6).
import { env } from 'cloudflare:workers'

export const prerender = false

const CODE_RE = /^[A-Z0-9]{6}$/
const NAME_RE = /^[\w .'-]{1,24}$/

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	})

const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })

async function sha256(s: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// coarse device class from UA (server-side; no client work)
function deviceOf(ua: string): string {
	if (!ua) return 'unknown'
	if (/iphone|ipod/i.test(ua)) return 'ios-phone'
	if (/ipad/i.test(ua)) return 'ios-tablet'
	if (/android.*mobile/i.test(ua)) return 'android-phone'
	if (/android/i.test(ua)) return 'android-tablet'
	if (/macintosh|mac os x/i.test(ua)) return 'mac'
	if (/windows/i.test(ua)) return 'windows'
	if (/linux/i.test(ua)) return 'linux'
	return 'other'
}

// ───────────────────────── Web Push (RFC 8291 + 8292) ─────────────────────────
// Same hand-rolled crypto as the roo-push cron Worker, so news/alert pushes can
// fire instantly from the publish endpoint. Needs VAPID_PUBLIC (var) + the secret
// VAPID_PRIVATE bound on this Worker.
const b2bytes = (s: string) => {
	s = s.replace(/-/g, '+').replace(/_/g, '/')
	s += '='.repeat((4 - (s.length % 4)) % 4)
	const bin = atob(s)
	const a = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
	return a
}
const bytes2b = (bytes: Uint8Array) => {
	let bin = ''
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const u8 = (s: string) => new TextEncoder().encode(s)
const cat = (...arrs: Uint8Array[]) => {
	const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
	let o = 0
	for (const a of arrs) { out.set(a, o); o += a.length }
	return out
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8))
}
async function vapidHeader(endpoint: string, e: any) {
	const aud = new URL(endpoint).origin
	const header = bytes2b(u8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
	const payload = bytes2b(u8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: e.VAPID_SUBJECT || 'mailto:roo26@alkem.dev' })))
	const signingInput = `${header}.${payload}`
	const pub = b2bytes(e.VAPID_PUBLIC)
	const jwk = { kty: 'EC', crv: 'P-256', x: bytes2b(pub.slice(1, 33)), y: bytes2b(pub.slice(33, 65)), d: e.VAPID_PRIVATE, ext: true }
	const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
	const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, u8(signingInput)))
	return `vapid t=${signingInput}.${bytes2b(sig)}, k=${e.VAPID_PUBLIC}`
}
async function sendPush(sub: any, payload: object, e: any): Promise<'gone' | boolean> {
	try {
		const ua = b2bytes(sub.keys.p256dh)
		const auth = b2bytes(sub.keys.auth)
		const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
		const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey))
		const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
		const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256))
		const ikm = await hkdf(auth, shared, cat(u8('WebPush: info\0'), ua, asPub), 32)
		const salt = crypto.getRandomValues(new Uint8Array(16))
		const cek = await hkdf(salt, ikm, u8('Content-Encoding: aes128gcm\0'), 16)
		const nonce = await hkdf(salt, ikm, u8('Content-Encoding: nonce\0'), 12)
		const plaintext = cat(u8(JSON.stringify(payload)), new Uint8Array([2]))
		const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
		const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext))
		const body = cat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([65]), asPub, ct)
		const res = await fetch(sub.endpoint, {
			method: 'POST',
			headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', authorization: await vapidHeader(sub.endpoint, e) },
			body,
		})
		if (res.status === 404 || res.status === 410) return 'gone'
		return res.ok
	} catch {
		return false
	}
}

// fan a news/alert push out to subscribers. Targeted to people who starred the
// affected set when the item carries a schedule change; otherwise broadcast.
async function pushNews(env: any, item: any): Promise<number> {
	const kv = env.PUSH_KV as KVNamespace | undefined
	if (!kv || !env.VAPID_PRIVATE) return 0
	const targetSet: string | null = item.change?.setId || null
	const payload = {
		title: item.severity === 'urgent' ? `🚨 ${item.title}` : `📣 ${item.title}`,
		body: item.summary || '',
		url: '/info',
		tag: 'news-' + item.id,
	}
	let sent = 0
	let cursor: string | undefined
	do {
		const list = await kv.list({ prefix: 'push:', cursor })
		const jobs = list.keys.map(async (k) => {
			const rec: any = await kv.get(k.name, 'json')
			if (!rec?.sub) return
			if (rec.prefs?.news === false) return
			if (targetSet) {
				const starred = (rec.stars || []).includes(targetSet) || (rec.reminders || []).some((r: any) => r.tag === 'set-' + targetSet)
				if (!starred) return
			}
			const r = await sendPush(rec.sub, payload, env)
			if (r === 'gone') await kv.delete(k.name)
			else if (r) sent++
		})
		await Promise.allSettled(jobs)
		cursor = list.list_complete ? undefined : list.cursor
	} while (cursor)
	return sent
}

export const ALL: APIRoute = async ({ request, params }) => {
	const kv = (env as any).ROO_KV as KVNamespace | undefined
	const path = params.path || ''

	if (path === 'health') return json({ ok: !!kv })

	// ───────────────────────── telemetry ─────────────────────────
	// POST /roo26-api/t — batch of anonymous events from the client SDK.
	// Writes to Analytics Engine (fast aggregates, live now) + D1 (durable log,
	// when bound) + R2 (raw archive, when bound). Degrades gracefully: any sink
	// that isn't bound is simply skipped, so this never 500s a beacon.
	if (path === 't') {
		if (request.method !== 'POST') return json({ ok: false }, 405)
		const ae = (env as any).ROO26_AE as AnalyticsEngineDataset | undefined
		const db = (env as any).DB as D1Database | undefined
		const archive = (env as any).ARCHIVE as R2Bucket | undefined

		let payload: any
		try {
			payload = await request.json()
		} catch {
			return json({ ok: false, error: 'bad json' }, 400)
		}
		const events: any[] = Array.isArray(payload?.events) ? payload.events : []
		if (!events.length || events.length > 100) return json({ ok: false, error: 'bad batch' }, 400)

		const cf: any = (request as any).cf || {}
		const ua = request.headers.get('user-agent') || ''
		const ip = request.headers.get('cf-connecting-ip') || ''
		const ipHash = ip ? (await sha256(ip + '|roo26-telemetry-salt')).slice(0, 16) : ''
		const recvTs = Date.now()
		const geo = {
			country: cf.country || null,
			region: cf.region || null,
			city: cf.city || null,
			colo: cf.colo || null,
			asn: cf.asn != null ? String(cf.asn) : null,
			tz: cf.timezone || null,
		}
		const device = deviceOf(ua)

		// 1) Analytics Engine — one data point per event (live immediately)
		if (ae) {
			for (const e of events) {
				if (typeof e?.event !== 'string') continue
				const p = e.props || {}
				try {
					ae.writeDataPoint({
						indexes: [String(e.event).slice(0, 32)], // sampling key
						blobs: [
							String(e.event).slice(0, 64),
							String(e.route || '').slice(0, 64),
							String(e.client_id || '').slice(0, 48),
							String(e.session_id || '').slice(0, 48),
							geo.country || '',
							geo.region || '',
							geo.city || '',
							geo.colo || '',
							device,
							String(e.app_ver || '').slice(0, 32),
							String(p.artist || p.id || p.from || p.q || '').slice(0, 96),
							JSON.stringify(p).slice(0, 1024),
						],
						doubles: [1, Number(p.value ?? p.count ?? 0) || 0, Number(e.ts || 0) || 0],
					})
				} catch {}
			}
		}

		// 2) D1 — durable, richly-queryable event log + plan snapshots
		if (db) {
			try {
				const stmts: D1PreparedStatement[] = []
				const insert = db.prepare(
					`INSERT INTO events (recv_ts, client_ts, client_id, session_id, event, props, route, app_ver,
						country, region, city, colo, asn, tz, device, ua, ip_hash)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				)
				const snap = db.prepare(
					`INSERT INTO snapshots (client_id, ts, name, icon, favs, fav_count, pins, friends, settings)
					 VALUES (?,?,?,?,?,?,?,?,?)
					 ON CONFLICT(client_id) DO UPDATE SET
						ts=excluded.ts, name=excluded.name, icon=excluded.icon, favs=excluded.favs,
						fav_count=excluded.fav_count, pins=excluded.pins, friends=excluded.friends, settings=excluded.settings`,
				)
				for (const e of events) {
					if (typeof e?.event !== 'string') continue
					const p = e.props || {}
					stmts.push(
						insert.bind(
							recvTs,
							Number(e.ts) || null,
							String(e.client_id || '').slice(0, 48),
							String(e.session_id || '').slice(0, 48),
							String(e.event).slice(0, 48),
							JSON.stringify(p).slice(0, 4096),
							String(e.route || '').slice(0, 64),
							String(e.app_ver || '').slice(0, 32),
							geo.country,
							geo.region,
							geo.city,
							geo.colo,
							geo.asn,
							geo.tz,
							device,
							ua.slice(0, 256),
							ipHash,
						),
					)
					if (e.event === 'snapshot') {
						stmts.push(
							snap.bind(
								String(e.client_id || '').slice(0, 48),
								recvTs,
								(p.name || '').slice(0, 48),
								(p.icon || '').slice(0, 16),
								JSON.stringify(p.favs || []).slice(0, 8192),
								Number(p.fav_count) || 0,
								Number(p.pins) || 0,
								Number(p.friends) || 0,
								JSON.stringify({ notif: p.notif, locate: p.locate }).slice(0, 1024),
							),
						)
					}
				}
				if (stmts.length) await db.batch(stmts)
			} catch {}
		}

		// 3) R2 — immutable raw archive (one NDJSON object per batch, never lost)
		if (archive) {
			try {
				const day = new Date(recvTs).toISOString().slice(0, 10)
				const ndjson = events
					.map((e) => JSON.stringify({ ...e, recv_ts: recvTs, geo, device, ip_hash: ipHash }))
					.join('\n')
				await archive.put(`raw/${day}/${recvTs}-${crypto.randomUUID()}.ndjson`, ndjson, {
					httpMetadata: { contentType: 'application/x-ndjson' },
				})
			} catch {}
		}

		return json({ ok: true, n: events.length })
	}

	// GET /roo26-api/stats?key=… — owner dashboard (D1-backed). Gated by STATS_KEY.
	if (path === 'stats' && request.method === 'GET') {
		const key = (env as any).STATS_KEY as string | undefined
		const url = new URL(request.url)
		const given = url.searchParams.get('key')
		if (!key || given !== key) return json({ error: 'unauthorized' }, 401)
		const db = (env as any).DB as D1Database | undefined
		if (!db) return json({ error: 'D1 not bound yet — provision roo26-analytics' }, 503)
		try {
			if (url.searchParams.get('format') === 'json') {
				const data = url.searchParams.get('mode') === 'live' ? await liveData(db) : await fullData(db)
				return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
			}
			return html(dashboardPage())
		} catch (err: any) {
			return json({ error: 'query failed', detail: String(err?.message || err) }, 500)
		}
	}

	// ───────────────────────── news & alerts ─────────────────────────
	// GET  /roo26-api/news  → public feed (cached briefly). The client renders the
	//   Guide news strip + top banner + modal, and overlays any schedule `change`.
	// POST /roo26-api/news  → publish/retract (gated by ADMIN_KEY). On publish it
	//   appends the item and fires a Web Push (targeted to people who starred the
	//   affected set if the item carries a schedule change, else broadcast).
	if (path === 'news') {
		const pkv = (env as any).PUSH_KV as KVNamespace | undefined
		const newsCacheKey = new Request(new URL('/roo26-api/news', request.url).toString())
		if (request.method === 'GET') {
			// edge-cache the feed so the every-5-min client poll doesn't read KV each
			// time (KV reads scale with audience). Cache is purged on publish below.
			const cache = (caches as any).default
			const hit = await cache.match(newsCacheKey)
			if (hit) return hit
			const doc = (pkv && (await pkv.get('news:current', 'json'))) || { v: 1, items: [] }
			const res = new Response(JSON.stringify(doc), {
				headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
			})
			await cache.put(newsCacheKey, res.clone())
			return res
		}
		if (request.method === 'POST') {
			const adminKey = (env as any).ADMIN_KEY as string | undefined
			let body: any
			try { body = await request.json() } catch { return json({ error: 'bad json' }, 400) }
			const given = request.headers.get('x-admin-key') || body?.key
			if (!adminKey || given !== adminKey) return json({ error: 'unauthorized' }, 401)
			if (!pkv) return json({ error: 'PUSH_KV not bound' }, 503)

			const doc: any = (await pkv.get('news:current', 'json')) || { v: 1, items: [] }

			if (body.action === 'delete') {
				doc.items = (doc.items || []).filter((x: any) => x.id !== body.id)
				doc.updatedAt = Date.now()
				await pkv.put('news:current', JSON.stringify(doc))
				await (caches as any).default.delete(newsCacheKey)
				return json({ ok: true, removed: body.id })
			}

			const it = body.item || body
			const clamp = (s: any, n: number) => String(s ?? '').slice(0, n)
			const sev = ['info', 'alert', 'urgent'].includes(it.severity) ? it.severity : 'info'
			if (!it.title) return json({ error: 'title required' }, 400)
			const links = (Array.isArray(it.links) ? it.links : [])
				.filter((l: any) => l && typeof l.url === 'string' && /^https?:\/\//.test(l.url))
				.slice(0, 14)
				.map((l: any) => ({ label: clamp(l.label || l.url, 80), url: clamp(l.url, 500), kind: ['official', 'press', 'social', 'source', 'other'].includes(l.kind) ? l.kind : 'source' }))
			let change: any = undefined
			if (it.change && ['time', 'stage', 'cancel', 'note', 'add'].includes(it.change.type)) {
				const c = it.change
				change = {
					setId: clamp(c.setId, 80) || undefined,
					type: c.type,
					artist: c.artist ? clamp(c.artist, 80) : undefined,
					day: c.day ? clamp(c.day, 8) : undefined,
					stage: c.stage ? clamp(c.stage, 24) : undefined,
					start: c.start ? clamp(c.start, 16) : undefined,
					end: c.end ? clamp(c.end, 16) : undefined,
					note: c.note ? clamp(c.note, 200) : undefined,
				}
			}
			const item = {
				id: clamp(it.id, 40) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
				ts: Number(it.ts) || Date.now(),
				createdAt: Date.now(),
				severity: sev,
				title: clamp(it.title, 120),
				summary: clamp(it.summary || it.title, 200),
				body: clamp(it.body, 4000),
				links,
				tags: (Array.isArray(it.tags) ? it.tags : []).slice(0, 8).map((t: any) => clamp(t, 24)),
				change,
				confidence: typeof it.confidence === 'number' ? Math.max(0, Math.min(1, it.confidence)) : undefined,
				sources: it.sources ? clamp(it.sources, 200) : undefined,
			}
			doc.items = [item, ...(doc.items || []).filter((x: any) => x.id !== item.id)].slice(0, 60)
			doc.updatedAt = Date.now()
			await pkv.put('news:current', JSON.stringify(doc))
			await (caches as any).default.delete(newsCacheKey)

			let pushed = 0
			if (body.notify !== false && sev !== 'silent') pushed = await pushNews(env, item)
			return json({ ok: true, id: item.id, pushed })
		}
		return json({ error: 'method' }, 405)
	}

	if (!kv) return json({ error: 'crew backend not configured' }, 503)

	if (path === 'crew' && request.method === 'POST') {
		const code = [...crypto.getRandomValues(new Uint8Array(6))]
			.map((b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31])
			.join('')
		return json({ code })
	}

	const m = path.match(/^crew\/([A-Z0-9]{6})$/)
	if (!m) return json({ error: 'not found' }, 404)
	const code = m[1]
	if (!CODE_RE.test(code)) return json({ error: 'bad code' }, 400)

	if (request.method === 'POST') {
		let body: any
		try {
			body = await request.json()
		} catch {
			return json({ error: 'bad json' }, 400)
		}
		const { name, lat, lon, emoji } = body || {}
		if (!NAME_RE.test(name || '')) return json({ error: 'bad name' }, 400)
		if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180)
			return json({ error: 'bad coords' }, 400)
		await kv.put(
			`crew:${code}:${name}`,
			JSON.stringify({ name, lat, lon, emoji: String(emoji || '🙂').slice(0, 8), at: Date.now() }),
			{ expirationTtl: 300 },
		)
		// fall through to return the current roster
	}

	const list = await kv.list({ prefix: `crew:${code}:` })
	const members = (await Promise.all(list.keys.map((k) => kv.get(k.name, 'json')))).filter(Boolean)
	return json({ members })
}

// ───────────────────────── live analytics dashboard ─────────────────────────
// Fast-changing slice (KPIs, recent event stream, recent users, 60-min spark).
async function liveData(db: D1Database) {
	const q = (sql: string) => db.prepare(sql).all().then((r) => r.results || [])
	const now = Date.now()
	const since5 = now - 5 * 60000
	const since1 = now - 60000
	const sinceHr = now - 60 * 60000
	const [totals, active, perMin, recent, users, spark] = await Promise.all([
		q(`SELECT count(*) n, count(DISTINCT client_id) users, count(DISTINCT session_id) sessions FROM events`),
		q(`SELECT count(DISTINCT client_id) n FROM events WHERE recv_ts > ${since5}`),
		q(`SELECT count(*) n FROM events WHERE recv_ts > ${since1}`),
		q(`SELECT recv_ts, event, client_id, route, country, city, device, props FROM events ORDER BY id DESC LIMIT 60`),
		q(`SELECT client_id, max(recv_ts) last, count(*) events, max(device) device, max(country) country, max(city) city FROM events GROUP BY client_id ORDER BY last DESC LIMIT 30`),
		q(`SELECT (recv_ts/60000) m, count(*) n FROM events WHERE recv_ts > ${sinceHr} GROUP BY m ORDER BY m`),
	])
	const t: any = totals[0] || {}
	return {
		now,
		kpis: { events: t.n || 0, users: t.users || 0, sessions: t.sessions || 0, active5m: (active[0] as any)?.n || 0, perMin: (perMin[0] as any)?.n || 0 },
		recent,
		users,
		spark,
	}
}

// Everything: live slice + the historical aggregates.
async function fullData(db: D1Database) {
	const q = (sql: string) => db.prepare(sql).all().then((r) => r.results || [])
	const live = await liveData(db)
	const [byEvent, byHour, topArtists, topSearch, geo, devices, social, snaps] = await Promise.all([
		q(`SELECT event, count(*) n FROM events GROUP BY event ORDER BY n DESC LIMIT 40`),
		q(`SELECT strftime('%m-%d %H:00', recv_ts/1000, 'unixepoch', '-5 hours') hour, count(*) n FROM events GROUP BY hour ORDER BY hour DESC LIMIT 48`),
		q(`SELECT json_extract(props,'$.artist') artist, count(*) n FROM events WHERE event='fav' AND json_extract(props,'$.on')=1 GROUP BY artist ORDER BY n DESC LIMIT 30`),
		q(`SELECT json_extract(props,'$.q') q, max(json_extract(props,'$.hits')) hits, count(*) n FROM events WHERE event='search' GROUP BY q ORDER BY n DESC LIMIT 30`),
		q(`SELECT country, region, city, colo, count(DISTINCT client_id) users, count(*) n FROM events GROUP BY country, region, city ORDER BY n DESC LIMIT 30`),
		q(`SELECT device, count(DISTINCT client_id) users, count(*) n FROM events GROUP BY device ORDER BY n DESC`),
		q(`SELECT json_extract(props,'$.from') from_name, count(*) n FROM events WHERE event='import_save' GROUP BY from_name ORDER BY n DESC LIMIT 30`),
		q(`SELECT name, icon, fav_count, pins, friends, datetime(ts/1000,'unixepoch') updated FROM snapshots ORDER BY fav_count DESC LIMIT 50`),
	])
	return { ...live, byEvent, byHour, topArtists, topSearch, geo, devices, social, snapshots: snaps }
}

// Client-rendered live dashboard. Reads ?key= from the URL and polls the JSON
// endpoint (live every 5s, full every 45s). No external deps; DOM-built so there
// are no escaping concerns.
function dashboardPage(): string {
	return DASH_HTML
}
const DASH_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Roo '26 · Live Analytics</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
html,body{margin:0}
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#ece7fb;background:#0b0716;min-height:100vh;overflow-x:hidden}
.bg{position:fixed;inset:0;z-index:-1;overflow:hidden}
.blob{position:absolute;border-radius:50%;filter:blur(72px);opacity:.45;animation:float 19s ease-in-out infinite}
.b1{width:430px;height:430px;background:#7c5cff;top:-130px;left:-90px}
.b2{width:380px;height:380px;background:#3ddc97;bottom:-150px;right:-70px;animation-delay:-6s}
.b3{width:300px;height:300px;background:#f472b6;top:42%;left:56%;animation-delay:-12s}
@keyframes float{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(46px,-32px) scale(1.12)}66%{transform:translate(-32px,22px) scale(.94)}}
.wrap{max-width:1180px;margin:0 auto;padding:1.1rem}
header{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin:.3rem 0 .1rem}
h1{font-size:1.65rem;margin:0;font-weight:800;background:linear-gradient(90deg,#ff8fb1,#ffd166,#3ddc97,#7c5cff,#ff8fb1);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:hue 8s linear infinite}
@keyframes hue{to{background-position:300% 0}}
.live{display:flex;align-items:center;gap:.4rem;font-size:.8rem;color:#7ff0e0;margin-left:auto;font-weight:700;letter-spacing:.04em}
.dot{width:.6rem;height:.6rem;border-radius:50%;background:#3ddc97;box-shadow:0 0 12px #3ddc97;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.65)}}
.sub{color:#9a8fc0;font-size:.82rem;margin:.15rem 0 1rem}
.toolbar{display:flex;gap:.6rem;align-items:center;font-size:.76rem;color:#8a7fb0;margin-bottom:1rem}
.toolbar button{background:rgba(124,92,255,.18);color:#d9caff;border:1px solid #4a3a7a;border-radius:99px;padding:.3rem .85rem;font-size:.76rem;cursor:pointer;font-weight:600}
.toolbar button:hover{background:rgba(124,92,255,.34)}
.panel{background:rgba(28,20,48,.5);backdrop-filter:blur(11px);-webkit-backdrop-filter:blur(11px);border:1px solid rgba(124,92,255,.18);border-radius:18px;padding:1rem 1.05rem;margin-bottom:1.1rem;box-shadow:0 10px 34px rgba(0,0,0,.28)}
h2{font-size:.95rem;margin:0 0 .75rem;color:#e7defc;font-weight:700}
.muted{color:#8a7fb0;font-size:.82rem}
.vibe{font-size:1.02rem;line-height:1.65;color:#f5f1ff;font-weight:500}
.vmeter{height:.5rem;border-radius:99px;background:#241c3b;overflow:hidden;margin-top:.8rem}
.vfill{height:100%;border-radius:99px;background:linear-gradient(90deg,#3ddc97,#ffd166,#ff6b6b);transition:width .7s ease;width:0}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:.8rem;margin-bottom:1.1rem}
@media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{position:relative;background:rgba(28,20,48,.6);border:1px solid rgba(124,92,255,.2);border-radius:16px;padding:.85rem 1rem;overflow:hidden;transition:transform .2s}
.kpi:hover{transform:translateY(-3px)}
.kpi::after{content:'';position:absolute;inset:0;background:radial-gradient(140px 70px at 82% -12%,rgba(124,92,255,.4),transparent);pointer-events:none}
.kn{font-size:1.95rem;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.05}
.kl{color:#9a8fc0;font-size:.74rem;margin-top:.15rem}
.kpi.hot .kn{background:linear-gradient(90deg,#7ff0e0,#3ddc97);-webkit-background-clip:text;background-clip:text;color:transparent}
.kpi.hot{border-color:rgba(61,220,151,.4)}
.cols{display:grid;grid-template-columns:1.25fr .75fr;gap:1.1rem}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.1rem}@media(max-width:680px){.grid{grid-template-columns:1fr}}
.feed{max-height:460px;overflow-y:auto;margin:-.15rem;display:flex;flex-direction:column;gap:.12rem}
.feed::-webkit-scrollbar{width:6px}.feed::-webkit-scrollbar-thumb{background:#34294f;border-radius:9px}
.ev{display:flex;align-items:center;gap:.6rem;padding:.4rem .45rem;border-radius:10px;border-left:3px solid var(--ec,#8a7fb0);background:rgba(255,255,255,.015)}
.ev.new{animation:slidein .55s ease}
@keyframes slidein{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
.eav{flex:0 0 1.85rem;height:1.85rem;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border-radius:9px;font-size:1.02rem}
.emid{flex:1;min-width:0}
.etop{display:flex;gap:.5rem;align-items:baseline}
.et{font-weight:700;font-size:.82rem;color:var(--ec,#d9caff);text-transform:capitalize}
.edet{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cdbff0;font-size:.82rem}
.emeta{color:#7a6fa0;font-size:.7rem}
.frow{display:flex;align-items:center;gap:.55rem;margin:.3rem 0}
.rank{flex:0 0 1.6rem;text-align:center;font-size:1rem}
.fname{flex:0 0 34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.84rem}
.track{flex:1;background:#241c3b;border-radius:99px;height:.62rem;overflow:hidden}
.fill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#7c5cff,#3ddc97);transition:width .5s ease}
.val{flex:0 0 auto;font-variant-numeric:tabular-nums;color:#b9aee0;font-size:.8rem}
.uchip{display:flex;align-items:center;gap:.6rem;padding:.45rem;border-radius:12px;background:rgba(255,255,255,.04);margin-bottom:.45rem}
.uav{width:2.1rem;height:2.1rem;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2b2150,#3a2d6b);font-size:1.05rem;flex-shrink:0}
.un{font-size:.83rem;font-weight:600}.us{font-size:.72rem;color:#8a7fb0}
.donut-wrap{display:flex;align-items:center;gap:1.1rem;flex-wrap:wrap}
.legend{font-size:.8rem;display:flex;flex-direction:column;gap:.3rem}
.lg{display:flex;align-items:center;gap:.45rem}.sw{width:.7rem;height:.7rem;border-radius:3px;display:inline-block}
.hbars{display:flex;align-items:flex-end;gap:2px;height:98px}
.hbars i{flex:1;background:linear-gradient(180deg,#7c5cff,#3ddc97);border-radius:3px 3px 0 0;min-height:2px;transition:height .4s}
.hbars i.peak{background:linear-gradient(180deg,#ffd166,#ff6b6b)}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th,td{text-align:left;padding:.32rem .45rem;border-bottom:1px solid #1f1838;white-space:nowrap}
th{color:#9a8fc0;font-weight:600}
small{color:#7a6fa0}
</style></head><body>
<div class="bg"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div></div>
<div class="wrap">
<header><h1>🌈 Roo '26 Live</h1><span class="live"><span class="dot"></span><span id="liveTxt">connecting…</span></span></header>
<div class="sub">your festival, as it happens — anonymous, real-time, festival-time CDT</div>
<div class="toolbar"><button id="pauseBtn">⏸ Pause</button><span id="updated"></span></div>
<div class="panel"><div class="vibe" id="vibe">tuning in to the Farm…</div><div class="vmeter"><div class="vfill" id="vfill"></div></div></div>
<div class="kpis">
<div class="kpi"><div class="kn" id="k_events" data-v="0">0</div><div class="kl">⚡ total events</div></div>
<div class="kpi"><div class="kn" id="k_users" data-v="0">0</div><div class="kl">👤 unique devices</div></div>
<div class="kpi"><div class="kn" id="k_sessions" data-v="0">0</div><div class="kl">🪟 sessions</div></div>
<div class="kpi hot"><div class="kn" id="k_active" data-v="0">0</div><div class="kl">🟢 active now (5m)</div></div>
<div class="kpi hot"><div class="kn" id="k_min" data-v="0">0</div><div class="kl">🔥 events / last min</div></div>
</div>
<div class="panel"><h2>📈 Activity — last 60 minutes</h2><div id="chart"></div></div>
<div class="cols">
<div class="panel"><h2>⚡ Live event stream</h2><div class="feed" id="feed"></div></div>
<div class="panel"><h2>👋 Who's here</h2><div id="users"></div></div>
</div>
<div class="grid">
<div class="panel"><h2>🏆 Crowd favorites</h2><div id="artists"></div></div>
<div class="panel"><h2>📱 Devices</h2><div id="devices"></div></div>
<div class="panel"><h2>🔍 What people are searching</h2><div style="overflow-x:auto"><table id="searches"></table></div></div>
<div class="panel"><h2>🤝 Plan-sharing graph</h2><div id="social"></div></div>
</div>
<div class="panel"><h2>🌎 Where the crowd is</h2><div id="geo"></div></div>
<div class="panel"><h2>🕐 Activity by hour (CDT)</h2><div class="hbars" id="hours"></div></div>
<div class="panel"><h2>🗂️ Everyone's plans (top by stars)</h2><div style="overflow-x:auto"><table id="snaps"></table></div></div>
<p><small>Anonymous · festival-time CDT · live D1 stream. Add &amp;format=json or &amp;format=json&amp;mode=live for raw data.</small></p>
</div>
<script>
var KEY=new URLSearchParams(location.search).get('key');
var BASE='/roo26-api/stats?key='+encodeURIComponent(KEY||'');
var S={},seen={},paused=false,gotFull=false;
var ICON={fav:'⭐',search:'🔍',route_view:'🧭',session_start:'🟢',session_end:'⚫',share:'📤',share_open:'📤',import_view:'👀',import_save:'🤝',ics_export:'📅',pin_add:'📍',tracks_toggle:'🐾',geo:'📍',notif_set:'🔔',wx_alert_view:'⚠️',quest:'🏆',news_open:'📣',vital:'⚡',perf:'⏱️',error:'💥',net:'📡',visibility:'👁️',filter:'🎛️',snapshot:'📸',pwa_install:'📲'};
var COLOR={fav:'#ffd166',search:'#7ff0e0',route_view:'#a78bfa',session_start:'#3ddc97',session_end:'#6b7280',share:'#60a5fa',share_open:'#60a5fa',import_view:'#f472b6',import_save:'#f472b6',ics_export:'#fbbf24',pin_add:'#34d399',tracks_toggle:'#22d3ee',geo:'#22d3ee',notif_set:'#f59e0b',wx_alert_view:'#fb923c',quest:'#fde047',news_open:'#c084fc',vital:'#94a3b8',perf:'#94a3b8',error:'#ef4444',net:'#38bdf8',visibility:'#a3a3a3',filter:'#a78bfa',snapshot:'#818cf8',pwa_install:'#4ade80'};
function el(tag,cls,txt){var n=document.createElement(tag);if(cls)n.className=cls;if(txt!=null)n.textContent=txt;return n;}
function num(n){return (Number(n)||0).toLocaleString();}
function ago(ms){var s=Math.round((Date.now()-ms)/1000);if(s<5)return 'now';if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m';var h=Math.floor(m/60);if(h<24)return h+'h';return Math.floor(h/24)+'d';}
function pj(s){try{return JSON.parse(s)||{};}catch(e){return {};}}
function flag(cc){if(!cc||cc.length!==2)return '🌐';return String.fromCodePoint(cc.toUpperCase().charCodeAt(0)+127397,cc.toUpperCase().charCodeAt(1)+127397);}
function devEmoji(d){if(!d)return '❓';if(d.indexOf('ios')===0)return '🍎';if(d.indexOf('android')===0)return '🤖';if(d==='mac')return '💻';if(d==='windows')return '🪟';if(d==='linux')return '🐧';return '🖥️';}
function detail(ev){var p=pj(ev.props);if(ev.event==='fav')return (p.on===false?'unstarred ':'starred ')+(p.artist||p.id||'');if(ev.event==='search')return '"'+(p.q||'')+'"'+(p.hits!=null?' ('+p.hits+' hits)':'');if(ev.event==='route_view')return p.tab||ev.route;if(ev.event==='import_save'||ev.event==='import_view')return 'from '+(p.from||'?');if(ev.event==='news_open')return p.id||'';if(ev.event==='filter')return (p.kind||'')+': '+p.value;if(ev.event==='quest')return p.id||'';if(ev.event==='vital')return (p.name||'')+' '+(p.value||'');if(ev.event==='notif_set')return p.on?'on':'off';if(ev.event==='geo')return 'on the move';return ev.route||'';}
function countUp(node,to){var from=Number(node.getAttribute('data-v'))||0;to=Number(to)||0;node.setAttribute('data-v',to);if(from===to){node.textContent=to.toLocaleString();return;}var start=performance.now(),dur=650;function step(t){var p=Math.min(1,(t-start)/dur),e=1-Math.pow(1-p,3);node.textContent=Math.round(from+(to-from)*e).toLocaleString();if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);}
function setK(id,v){var n=document.getElementById(id);if(n)countUp(n,v);}
function bars(id,rows,lk,vk){vk=vk||'n';var box=document.getElementById(id);box.replaceChildren();if(!rows||!rows.length){box.append(el('p','muted','no data yet'));return;}var max=1;rows.forEach(function(r){max=Math.max(max,Number(r[vk])||0);});rows.forEach(function(r){var v=Number(r[vk])||0,row=el('div','row');row.append(el('span','lbl',(r[lk]==null||r[lk]==='')?'—':String(r[lk])));var tr=el('span','track'),f=el('span','fill');f.style.width=(v/max*100)+'%';tr.append(f);row.append(tr);row.append(el('span','val',num(v)));box.append(row);});}
function tbl(id,rows,cols){var t=document.getElementById(id);t.replaceChildren();if(!rows||!rows.length){var c=el('caption','muted','no data yet');t.append(c);return;}var thead=el('thead'),htr=el('tr');cols.forEach(function(c){htr.append(el('th',null,c[1]));});thead.append(htr);t.append(thead);var tb=el('tbody');rows.forEach(function(r){var tr=el('tr');cols.forEach(function(c){var v=r[c[0]];if(c[2]==='ago'&&v)v=ago(Number(v))+' ago';tr.append(el('td',null,v==null?'—':String(v)));});tb.append(tr);});t.append(tb);}
function favBars(box,rows){box.replaceChildren();rows=rows||[];if(!rows.length){box.append(el('p','muted','no stars yet — be the first ⭐'));return;}var max=1;rows.forEach(function(r){max=Math.max(max,Number(r.n)||0);});rows.slice(0,12).forEach(function(r,i){var medal=i===0?'🥇':i===1?'🥈':i===2?'🥉':String(i+1);var row=el('div','frow');row.append(el('span','rank',medal));row.append(el('span','fname',r.artist||'—'));var tr=el('span','track'),f=el('span','fill');f.style.width=((Number(r.n)||0)/max*100)+'%';tr.append(f);row.append(tr);row.append(el('span','val',num(r.n)));box.append(row);});}
function geoList(box,rows){box.replaceChildren();rows=rows||[];if(!rows.length){box.append(el('p','muted','no data yet'));return;}var max=1;rows.forEach(function(r){max=Math.max(max,Number(r.n)||0);});rows.slice(0,14).forEach(function(r){var row=el('div','frow');row.append(el('span','rank',flag(r.country)));row.append(el('span','fname',[r.city,r.region].filter(Boolean).join(', ')||r.country||'?'));var tr=el('span','track'),f=el('span','fill');f.style.width=((Number(r.n)||0)/max*100)+'%';tr.append(f);row.append(tr);row.append(el('span','val',(r.users||0)+' 👤'));box.append(row);});}
function userChips(box,rows){box.replaceChildren();rows=rows||[];if(!rows.length){box.append(el('p','muted','nobody yet — invite the crew!'));return;}rows.forEach(function(u){var c=el('div','uchip');c.append(el('span','uav',devEmoji(u.device)));var info=el('div');info.append(el('div','un',flag(u.country)+' '+(u.city||u.country||'somewhere')));info.append(el('div','us',(u.events||0)+' events · '+ago(Number(u.last))+' ago'));c.append(info);box.append(c);});}
function donut(box,rows){rows=rows||[];var total=0;rows.forEach(function(r){total+=Number(r.users)||0;});if(!total){box.replaceChildren(el('p','muted','no data yet'));return;}var COL=['#7c5cff','#3ddc97','#f472b6','#fbbf24','#22d3ee','#fb923c','#a3a3a3'];var C=2*Math.PI*52,off=0,segs='',legend='';rows.forEach(function(r,i){var frac=(Number(r.users)||0)/total,len=frac*C,col=COL[i%COL.length];segs+='<circle cx="70" cy="70" r="52" fill="none" stroke="'+col+'" stroke-width="20" stroke-dasharray="'+len.toFixed(2)+' '+(C-len).toFixed(2)+'" stroke-dashoffset="'+(-off).toFixed(2)+'" transform="rotate(-90 70 70)"/>';off+=len;legend+='<div class="lg"><span class="sw" style="background:'+col+'"></span>'+devEmoji(r.device)+' '+r.device+' <b>'+Math.round(frac*100)+'%</b></div>';});box.innerHTML='<div class="donut-wrap"><svg width="140" height="140" viewBox="0 0 140 140">'+segs+'<text x="70" y="66" text-anchor="middle" fill="#ece7fb" font-size="22" font-weight="800">'+total+'</text><text x="70" y="84" text-anchor="middle" fill="#9a8fc0" font-size="10">devices</text></svg><div class="legend">'+legend+'</div></div>';}
function areaChart(box,rows){rows=rows||[];var n=rows.length,w=320,h=72;if(n<2){box.innerHTML='<div class="muted" style="padding:1rem 0">waiting for activity…</div>';return;}var max=1;rows.forEach(function(r){max=Math.max(max,Number(r.n)||0);});var pts=[];for(var i=0;i<n;i++){var x=i/(n-1)*w,y=h-4-((Number(rows[i].n)||0)/max)*(h-12);pts.push([x,y]);}var line='M'+pts[0][0].toFixed(1)+','+pts[0][1].toFixed(1);for(var i=1;i<n;i++)line+=' L'+pts[i][0].toFixed(1)+','+pts[i][1].toFixed(1);var area=line+' L'+w+','+h+' L0,'+h+' Z';var svg='<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" style="width:100%;height:74px;display:block"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c5cff" stop-opacity=".55"/><stop offset="1" stop-color="#7c5cff" stop-opacity="0"/></linearGradient></defs><path d="'+area+'" fill="url(#ag)"/><path d="'+line+'" fill="none" stroke="#9b7bff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="'+pts[n-1][0].toFixed(1)+'" cy="'+pts[n-1][1].toFixed(1)+'" r="3.2" fill="#3ddc97"/></svg>';box.innerHTML=svg;}
function hourly(rows){var hb=document.getElementById('hours');hb.replaceChildren();rows=(rows||[]).slice().reverse();var max=1;rows.forEach(function(x){max=Math.max(max,Number(x.n)||0);});rows.forEach(function(x){var v=Number(x.n)||0,b=el('i');if(v===max&&v>0)b.className='peak';b.style.height=(v/max*100)+'%';b.title=x.hour+' · '+v+' events';hb.append(b);});}
function pushFeed(rows){var feed=document.getElementById('feed');rows=rows||[];for(var j=rows.length-1;j>=0;j--){var ev=rows[j],key=ev.recv_ts+'|'+ev.client_id+'|'+ev.event;if(seen[key])continue;seen[key]=1;var r=el('div','ev new');r.style.setProperty('--ec',COLOR[ev.event]||'#8a7fb0');r.append(el('span','eav',ICON[ev.event]||'•'));var mid=el('div','emid'),top=el('div','etop');top.append(el('span','et',ev.event.replace(/_/g,' ')));top.append(el('span','edet',detail(ev)));mid.append(top);mid.append(el('div','emeta',devEmoji(ev.device)+' '+flag(ev.country)+' '+(ev.city||'')+' · '+ago(ev.recv_ts)));r.append(mid);feed.prepend(r);}while(feed.childNodes.length>70)feed.removeChild(feed.lastChild);}
function commentary(){var k=S.kpis||{},parts=[];var pm=k.perMin||0;var vibe=pm>=20?'🔥 The Farm is absolutely buzzing':pm>=8?'🎶 Nice steady flow on the app':pm>=1?'🌤️ Ticking along':'🌙 Pretty mellow right now';parts.push(vibe+' — '+pm+' event'+(pm===1?'':'s')+' in the last minute.');if(k.active5m)parts.push('👥 '+k.active5m+' device'+(k.active5m===1?'':'s')+' active in the last 5 min.');if(S.topArtists&&S.topArtists[0]&&S.topArtists[0].artist)parts.push('⭐ '+S.topArtists[0].artist+' is the crowd favorite.');if(S.devices&&S.devices[0])parts.push('📱 Most folks are on '+S.devices[0].device+'.');if(S.geo&&S.geo.length){var cities=S.geo.slice(0,3).map(function(g){return g.city;}).filter(Boolean);if(cities.length)parts.push('🌎 Tuning in from '+cities.join(', ')+(S.geo.length>3?' & more':'')+'.');}return parts.join('  ');}
function render(full){var k=S.kpis||{};setK('k_events',k.events);setK('k_users',k.users);setK('k_sessions',k.sessions);setK('k_active',k.active5m);setK('k_min',k.perMin);document.getElementById('vfill').style.width=Math.min(100,(k.perMin||0)*3)+'%';document.getElementById('vibe').textContent=commentary();areaChart(document.getElementById('chart'),S.spark);pushFeed(S.recent);userChips(document.getElementById('users'),S.users);document.getElementById('updated').textContent='updated '+new Date(S.now||Date.now()).toLocaleTimeString();document.getElementById('liveTxt').textContent='LIVE';if(full){favBars(document.getElementById('artists'),S.topArtists);donut(document.getElementById('devices'),S.devices);tbl('searches',S.topSearch,[['q','query'],['hits','results'],['n','count']]);bars('social',S.social,'from_name');geoList(document.getElementById('geo'),S.geo);hourly(S.byHour);tbl('snaps',S.snapshots,[['name','name'],['icon','·'],['fav_count','★ sets'],['pins','pins'],['friends','friends'],['updated','updated']]);}}
async function tick(full){if(paused)return;try{var r=await fetch(BASE+'&format=json'+(full?'':'&mode=live'),{cache:'no-store'});if(r.status===401){document.getElementById('liveTxt').textContent='bad key 🔒';return;}var d=await r.json();for(var key in d)S[key]=d[key];render(full||!gotFull);if(full)gotFull=true;}catch(e){document.getElementById('liveTxt').textContent='reconnecting…';}}
document.getElementById('pauseBtn').onclick=function(){paused=!paused;this.textContent=paused?'▶ Resume':'⏸ Pause';document.querySelector('.dot').style.animationPlayState=paused?'paused':'running';if(!paused)tick(true);};
tick(true);
setInterval(function(){tick(false);},5000);
setInterval(function(){tick(true);},45000);
</script></body></html>`
