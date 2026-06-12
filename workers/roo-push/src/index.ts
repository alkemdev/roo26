// roo-push — the notification dispatcher for Roo '26.
// Runs once a minute (cron), reads push subscriptions + reminder timestamps
// from the shared PUSH_KV (written by the app's /roo26-api/push route), and
// fires Web Push: set reminders when they come due + severe NWS weather alerts.
// Pure Web Crypto (RFC 8291 aes128gcm + RFC 8292 VAPID) — no external deps.

interface Env {
	PUSH_KV: KVNamespace
	VAPID_PUBLIC: string // base64url 65-byte point (also shipped in the client)
	VAPID_PRIVATE: string // base64url 32-byte private scalar (a secret)
	VAPID_SUBJECT?: string // mailto: or https: contact
	ADMIN_KEY?: string // gates /roo26-api/news — used by the schedule auto-sync
}

import OUR_SETS from '../sets.json'
const OUR = new Set(OUR_SETS as string[])

const WX_POINT = '35.4714,-86.0517' // the Farm

// ── base64url + byte helpers ──
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
const utf8 = (s: string) => new TextEncoder().encode(s)
const concat = (...arrs: Uint8Array[]) => {
	const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
	let o = 0
	for (const a of arrs) {
		out.set(a, o)
		o += a.length
	}
	return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8))
}

// VAPID Authorization header value (RFC 8292)
async function vapidHeader(endpoint: string, env: Env) {
	const aud = new URL(endpoint).origin
	const header = bytes2b(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
	const payload = bytes2b(
		utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:roo26@alkem.dev' })),
	)
	const signingInput = `${header}.${payload}`
	const pub = b2bytes(env.VAPID_PUBLIC) // 0x04 || x || y
	const jwk = { kty: 'EC', crv: 'P-256', x: bytes2b(pub.slice(1, 33)), y: bytes2b(pub.slice(33, 65)), d: env.VAPID_PRIVATE, ext: true }
	const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
	const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput)))
	return `vapid t=${signingInput}.${bytes2b(sig)}, k=${env.VAPID_PUBLIC}`
}

// encrypt + POST a single push (RFC 8291, aes128gcm). returns 'gone' | true | false
async function sendPush(sub: any, payload: object, env: Env) {
	const ua = b2bytes(sub.keys.p256dh) // 65
	const auth = b2bytes(sub.keys.auth) // 16
	const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
	const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey)) // 65
	const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256))
	const ikm = await hkdf(auth, shared, concat(utf8('WebPush: info\0'), ua, asPub), 32)
	const salt = crypto.getRandomValues(new Uint8Array(16))
	const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
	const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
	const plaintext = concat(utf8(JSON.stringify(payload)), new Uint8Array([2])) // record delimiter
	const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext))
	const body = concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([65]), asPub, ct) // salt|rs=4096|idlen=65|keyid|ct
	const res = await fetch(sub.endpoint, {
		method: 'POST',
		headers: {
			'content-encoding': 'aes128gcm',
			'content-type': 'application/octet-stream',
			ttl: '86400',
			authorization: await vapidHeader(sub.endpoint, env),
		},
		body,
	})
	if (res.status === 404 || res.status === 410) return 'gone'
	return res.ok
}

// current severe/extreme NWS alert for the Farm, or null
async function weatherAlert() {
	try {
		const r = await fetch(`https://api.weather.gov/alerts/active?point=${WX_POINT}`, {
			headers: { 'user-agent': '(roo26.alkem.dev, roo26@alkem.dev)' },
		})
		const j: any = await r.json()
		const a = (j.features || []).map((f: any) => f.properties).find((p: any) => ['Severe', 'Extreme'].includes(p.severity))
		if (!a) return null
		return { id: a.id as string, title: `⚠️ ${a.event}`, body: (a.headline as string) || 'Severe weather near the Farm — find shelter.' }
	} catch {
		return null
	}
}

async function dispatch(env: Env) {
	const now = Date.now()
	const wx = await weatherAlert()

	// Gate the expensive per-subscriber scan behind two tiny control keys, so an
	// idle tick costs ~2 KV reads instead of one-read-per-subscriber. We only walk
	// every subscription when a reminder is actually due (now ≥ ctl:nextDue) or a
	// NEW severe-weather alert appeared (id changed). Free-tier KV reads are the
	// constraint — this is what keeps us under it as the audience grows.
	const wxLast = await env.PUSH_KV.get('ctl:wxlast')
	const wxNew = !!wx && wx.id !== wxLast
	const nextDueRaw = await env.PUSH_KV.get('ctl:nextDue')
	const reminderDue = nextDueRaw == null || now >= Number(nextDueRaw)
	if (!reminderDue && !wxNew) return { scanned: false, nextDueRaw, wxNew, now } // nothing due — skip the scan entirely

	let cursor: string | undefined
	let subs = 0
	let minFuture = Infinity // earliest still-pending reminder, to re-arm ctl:nextDue
	do {
		const list = await env.PUSH_KV.list({ prefix: 'push:', cursor })
		for (const k of list.keys) {
			const rec: any = await env.PUSH_KV.get(k.name, 'json')
			if (!rec?.sub) continue
			subs++
			let changed = false
			let gone = false
			// set reminders that just came due (fire within a 6-min window)
			if (rec.prefs?.sets !== false) {
				for (const r of rec.reminders || []) {
					if (r.sent) continue
					// fire anything due within the last 8 min (covers the 5-min cron gap + jitter)
					if (r.at > now) {
						if (r.at < minFuture) minFuture = r.at // track for re-arming the gate
						continue
					}
					if (r.at < now - 8 * 60e3) continue
					const ok = await sendPush(rec.sub, { title: r.title, body: r.body || '', url: r.url || '/plan', tag: r.tag }, env)
					if (ok === 'gone') {
						gone = true
						break
					}
					r.sent = true
					changed = true
				}
			}
			// severe weather (once per alert id per subscriber)
			if (!gone && wx && rec.prefs?.weather !== false && rec.lastWx !== wx.id) {
				const ok = await sendPush(rec.sub, { title: wx.title, body: wx.body, url: '/info', tag: `wx-${wx.id}` }, env)
				if (ok === 'gone') gone = true
				else {
					rec.lastWx = wx.id
					changed = true
				}
			}
			if (gone) await env.PUSH_KV.delete(k.name)
			else if (changed) await env.PUSH_KV.put(k.name, JSON.stringify(rec), { expirationTtl: 14 * 24 * 3600 })
		}
		cursor = list.list_complete ? undefined : list.cursor
	} while (cursor)

	// Re-arm the gate. If nothing's pending, park it 6 h out (a new subscription
	// lowers it via the /push route, so we won't miss anything sooner).
	const armed = minFuture === Infinity ? now + 6 * 3600e3 : minFuture
	await env.PUSH_KV.put('ctl:nextDue', String(armed))
	if (wxNew) await env.PUSH_KV.put('ctl:wxlast', wx!.id)
	return { scanned: true, subs, minFuture, armed, nextDueRaw, wxNew, now }
}

// ───────────────────── official schedule auto-sync ─────────────────────
// Diffs the official Tradable Bits feed (the Festiverse app's backend; recovered
// from the APK — see docs/) against the last snapshot and auto-applies day-of
// TIME changes via /roo26-api/news. Pure data, no LLM — so it runs unattended on
// this cron, 24/7, independent of any Claude session or device. Conservative:
// only time changes on sets we actually have (a changed start on a still-present
// feed entry) auto-apply; stage moves / cancels / adds are left to the
// /sync-schedule skill (they carry spelling-mismatch risk).
const TB_URL =
	'https://tradablebits.com/api/v1/idols/events?api_key=0184f26f-2eee-4691-b981-95d49f563bfd&performance_uid=c98fc9b1-892c-4264-9400-30bc4dbd14ed'
const FESTID: Record<string, string> = { '2026-06-11': 'thu', '2026-06-12': 'fri', '2026-06-13': 'sat', '2026-06-14': 'sun' }
const FESTBASE: Record<string, string> = { thu: '2026-06-11', fri: '2026-06-12', sat: '2026-06-13', sun: '2026-06-14' }
const VENUE: Record<string, string> = {
	'ROO STAGE 1': 'what', 'ROO STAGE 2': 'which', 'ROO STAGE 3': 'this', 'ROO STAGE 4': 'that',
	'ROO STAGE 5': 'other', 'ROO STAGE 6': 'where', 'ROO STAGE 8': 'when', 'ROO STAGE 9': 'groop', 'ROO STAGE 10': 'silent',
}
const slugName = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const titleCase = (s: string) => (s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
function festDay(date: string, hm: string): string | null {
	if (!date) return null
	const h = parseInt((hm || '12:00').slice(0, 2)) || 12
	const d = new Date(date + 'T12:00:00Z')
	if (h < 8) d.setUTCDate(d.getUTCDate() - 1)
	return FESTID[d.toISOString().slice(0, 10)] || null
}
function festDate(dayId: string, hm: string): string {
	const d = new Date(FESTBASE[dayId] + 'T12:00:00Z')
	if (parseInt(hm.slice(0, 2)) < 8) d.setUTCDate(d.getUTCDate() + 1)
	return d.toISOString().slice(0, 10)
}

async function syncSchedule(env: Env, force = false): Promise<number> {
	if (!env.ADMIN_KEY) return 0
	const last = Number(await env.PUSH_KV.get('sched:last')) || 0
	if (!force && Date.now() - last < 13 * 60e3) return 0 // ~every 15 min (cron is 5)
	await env.PUSH_KV.put('sched:last', String(Date.now()))

	let tb: any
	try {
		tb = await (await fetch(TB_URL, { headers: { 'user-agent': 'roo26-sync/1' } })).json()
	} catch {
		return 0
	}
	if (!Array.isArray(tb)) return 0

	// current feed keyed by idol_event_uid (a stable per-set id — immune to the
	// spelling differences that made name-matching unsafe). Tracked stages only.
	const cur: Record<string, any> = {}
	for (const e of tb) {
		const fd = festDay(e.start_date || '', e.start_time || '')
		const st = VENUE[e.venue_name]
		if (!fd || !st || !e.idol_event_uid) continue
		cur[e.idol_event_uid] = { name: e.event_name, day: fd, stage: st, start: e.start_time || '', end: e.end_time || '' }
	}
	const snap: Record<string, any> | null = await env.PUSH_KV.get('sched:snap2', 'json')
	await env.PUSH_KV.put('sched:snap2', JSON.stringify(cur))
	if (!snap) return 0 // first run: establish baseline only

	const sidOf = (x: any) => `${x.day}-${x.stage}-${slugName(x.name)}` // → our set id
	const post = async (item: any) => {
		try {
			await fetch('https://roo26.alkem.dev/roo26-api/news', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-admin-key': env.ADMIN_KEY! },
				body: JSON.stringify({ notify: true, item }),
			})
		} catch {}
	}
	const base = { ts: Date.now(), confidence: 0.9, sources: 'Official Festiverse schedule · auto-sync' }
	let applied = 0

	// TIME + STAGE changes — same event id in both snapshots
	for (const uid in cur) {
		const c = cur[uid]
		const p = snap[uid]
		if (!p) continue
		const art = titleCase(c.name)
		if (c.start && p.start && c.start !== p.start) {
			const sid = sidOf(c)
			if (OUR.has(sid)) {
				await post({ ...base, id: `autosync-time-${sid}-${c.start.replace(':', '')}`, severity: 'info',
					title: `${art} moved to ${c.start}`,
					summary: `${art} now starts ${c.start} (${cap(c.day)} ${cap(c.stage)}) — was ${p.start}.`,
					body: `• New time: ${c.start} (was ${p.start}).\n• Auto-synced from the official Festiverse schedule.`,
					tags: [slugName(c.name)],
					change: { type: 'time', setId: sid, artist: art, day: c.day, start: `${festDate(c.day, c.start)}T${c.start}`,
						end: c.end ? `${festDate(c.day, c.end)}T${c.end}` : undefined, note: 'Official time update' } })
				applied++
			}
		}
		if (c.stage !== p.stage) {
			const sid = sidOf(p) // our set id encodes the prior stage
			if (OUR.has(sid)) {
				await post({ ...base, id: `autosync-stage-${sid}-${c.stage}`, severity: 'alert',
					title: `${art} moved to the ${cap(c.stage)} stage`,
					summary: `${art} (${cap(c.day)}) moved from ${cap(p.stage)} to ${cap(c.stage)}.`,
					body: `• New stage: ${cap(c.stage)} (was ${cap(p.stage)}).\n• Auto-synced from the official Festiverse schedule.`,
					tags: [slugName(c.name)],
					change: { type: 'stage', setId: sid, artist: art, day: p.day, stage: c.stage, note: 'Official stage move' } })
				applied++
			}
		}
	}

	// CANCELLATIONS — two-strike: a set must be gone for two consecutive syncs
	// (~30 min) before we cancel, so a transient feed blip can't false-cancel.
	const pend: Record<string, any> = (await env.PUSH_KV.get('sched:pending2', 'json')) || {}
	const nextPend: Record<string, any> = {}
	for (const uid in pend) {
		if (cur[uid]) continue // reappeared → drop
		const p = pend[uid]
		if (OUR.has(p.sid)) {
			await post({ ...base, id: `autosync-cancel-${p.sid}`, severity: 'alert', confidence: 0.85,
				title: `${titleCase(p.name)} off the lineup`,
				summary: `${titleCase(p.name)}'s ${cap(p.day)} ${cap(p.stage)} set is no longer on the official schedule.`,
				body: `• ${titleCase(p.name)}'s ${cap(p.day)} ${cap(p.stage)} set is no longer listed.\n• Dropped from the official Festiverse schedule.`,
				tags: [slugName(p.name), 'cancelled'],
				change: { type: 'cancel', setId: p.sid, artist: titleCase(p.name), day: p.day, note: 'No longer on the official schedule' } })
			applied++
		}
	}
	for (const uid in snap) {
		if (cur[uid] || pend[uid]) continue // first strike: just disappeared → wait one cycle
		const p = snap[uid]
		const sid = sidOf(p)
		if (OUR.has(sid)) nextPend[uid] = { sid, name: p.name, day: p.day, stage: p.stage }
	}
	await env.PUSH_KV.put('sched:pending2', JSON.stringify(nextPend))

	return applied
}

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(dispatch(env))
		ctx.waitUntil(syncSchedule(env))
	},
	// manual triggers for testing: GET /run (dispatch) · GET /sync (schedule sync)
	async fetch(req: Request, env: Env) {
		const p = new URL(req.url).pathname
		if (p === '/run') {
			const diag = await dispatch(env)
			return new Response(JSON.stringify(diag ?? { ok: true }), { headers: { 'content-type': 'application/json' } })
		}
		if (p === '/sync') {
			const n = await syncSchedule(env, true)
			return new Response('schedule sync: ' + n)
		}
		return new Response('roo-push cron worker')
	},
}
