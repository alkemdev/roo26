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
