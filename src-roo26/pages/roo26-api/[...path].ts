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
		const given = new URL(request.url).searchParams.get('key')
		if (!key || given !== key) return json({ error: 'unauthorized' }, 401)
		const db = (env as any).DB as D1Database | undefined
		if (!db) return json({ error: 'D1 not bound yet — provision roo26-analytics' }, 503)
		const url = new URL(request.url)
		const wantJson = url.searchParams.get('format') === 'json'
		try {
			const q = (sql: string) => db.prepare(sql).all().then((r) => r.results || [])
			const [totals, byEvent, byDay, topArtists, topSearch, geoRows, devices, social, snaps] = await Promise.all([
				q(`SELECT count(*) n, count(DISTINCT client_id) users, count(DISTINCT session_id) sessions FROM events`),
				q(`SELECT event, count(*) n FROM events GROUP BY event ORDER BY n DESC LIMIT 40`),
				q(`SELECT strftime('%Y-%m-%d %H:00', recv_ts/1000, 'unixepoch') hour, count(*) n FROM events GROUP BY hour ORDER BY hour DESC LIMIT 72`),
				q(`SELECT json_extract(props,'$.artist') artist, count(*) n FROM events WHERE event='fav' AND json_extract(props,'$.on')=1 GROUP BY artist ORDER BY n DESC LIMIT 30`),
				q(`SELECT json_extract(props,'$.q') q, max(json_extract(props,'$.hits')) hits, count(*) n FROM events WHERE event='search' GROUP BY q ORDER BY n DESC LIMIT 30`),
				q(`SELECT country, region, city, colo, count(DISTINCT client_id) users, count(*) n FROM events GROUP BY country, region, city ORDER BY n DESC LIMIT 30`),
				q(`SELECT device, count(DISTINCT client_id) users, count(*) n FROM events GROUP BY device ORDER BY n DESC`),
				q(`SELECT json_extract(props,'$.from') from_name, count(*) n FROM events WHERE event='import_save' GROUP BY from_name ORDER BY n DESC LIMIT 30`),
				q(`SELECT name, icon, fav_count, pins, friends, datetime(ts/1000,'unixepoch') updated FROM snapshots ORDER BY fav_count DESC LIMIT 50`),
			])
			const data = { totals: totals[0] || {}, byEvent, byDay, topArtists, topSearch, geo: geoRows, devices, social, snapshots: snaps }
			if (wantJson) return json(data)
			return html(statsPage(data))
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
		if (request.method === 'GET') {
			const doc = (pkv && (await pkv.get('news:current', 'json'))) || { v: 1, items: [] }
			return new Response(JSON.stringify(doc), {
				headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
			})
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

// ───────────────────────── stats dashboard (server-rendered) ─────────────────────────
const esc = (s: any) =>
	String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

function bars(rows: any[], label: string, valKey = 'n'): string {
	if (!rows?.length) return '<p class="muted">no data yet</p>'
	const max = Math.max(...rows.map((r) => Number(r[valKey]) || 0), 1)
	return rows
		.map((r) => {
			const v = Number(r[valKey]) || 0
			const name = esc(r[label] ?? '—')
			return `<div class="row"><span class="lbl">${name}</span><span class="track"><span class="fill" style="width:${(v / max) * 100}%"></span></span><span class="val">${v.toLocaleString()}</span></div>`
		})
		.join('')
}

function table(rows: any[], cols: [string, string][]): string {
	if (!rows?.length) return '<p class="muted">no data yet</p>'
	const head = cols.map(([, h]) => `<th>${esc(h)}</th>`).join('')
	const body = rows
		.map((r) => '<tr>' + cols.map(([k]) => `<td>${esc(r[k])}</td>`).join('') + '</tr>')
		.join('')
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function statsPage(d: any): string {
	const t = d.totals || {}
	const card = (n: any, l: string) => `<div class="card"><b>${(Number(n) || 0).toLocaleString()}</b><span>${l}</span></div>`
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Roo '26 · Analytics</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#120d1d;color:#ece7fb;padding:1.2rem;max-width:1000px;margin:0 auto}
h1{font-size:1.4rem;margin:.2rem 0 1rem}h2{font-size:1rem;margin:1.6rem 0 .6rem;color:#c9b8ff}
.muted{color:#8a7fb0}.cards{display:flex;flex-wrap:wrap;gap:.7rem}
.card{flex:1;min-width:120px;background:#1d1630;border:1px solid #2e2547;border-radius:12px;padding:.8rem 1rem}
.card b{display:block;font-size:1.7rem}.card span{color:#9a8fc0;font-size:.82rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.4rem}@media(max-width:680px){.grid{grid-template-columns:1fr}}
.row{display:flex;align-items:center;gap:.5rem;margin:.18rem 0}
.lbl{flex:0 0 38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.84rem}
.track{flex:1;background:#241c3b;border-radius:99px;height:.7rem;overflow:hidden}
.fill{display:block;height:100%;background:linear-gradient(90deg,#7c5cff,#3ddc97)}
.val{flex:0 0 auto;font-variant-numeric:tabular-nums;color:#b9aee0;font-size:.82rem}
table{width:100%;border-collapse:collapse;font-size:.84rem}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #241c3b}
th{color:#9a8fc0;font-weight:600}small{color:#8a7fb0}
</style></head><body>
<h1>🌈 Roo '26 — Analytics</h1>
<div class="cards">${card(t.n, 'events')}${card(t.users, 'unique devices')}${card(t.sessions, 'sessions')}</div>
<div class="grid">
<div><h2>Events by type</h2>${bars(d.byEvent, 'event')}</div>
<div><h2>Most-favorited artists</h2>${bars(d.topArtists, 'artist')}</div>
<div><h2>Searches</h2>${table(d.topSearch, [['q', 'query'], ['hits', 'results'], ['n', 'count']])}</div>
<div><h2>Plans imported from</h2>${bars(d.social, 'from_name')}</div>
<div><h2>Geography</h2>${table(d.geo, [['city', 'city'], ['region', 'region'], ['country', 'cc'], ['colo', 'colo'], ['users', 'users']])}</div>
<div><h2>Devices</h2>${bars(d.devices, 'device', 'users')}</div>
</div>
<h2>Activity by hour (most recent first)</h2>${bars(d.byDay, 'hour')}
<h2>Per-person plans (top by stars)</h2>${table(d.snapshots, [['name', 'name'], ['icon', '·'], ['fav_count', '★ sets'], ['pins', 'pins'], ['friends', 'friends'], ['updated', 'updated']])}
<p style="margin-top:2rem"><small>Anonymous + festival-time (CDT). Add <code>&amp;format=json</code> for raw JSON. Analytics Engine has the live 90-day stream; this view is the durable D1 log.</small></p>
</body></html>`
}
