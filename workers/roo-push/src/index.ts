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
}

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
	let cursor: string | undefined
	do {
		const list = await env.PUSH_KV.list({ prefix: 'push:', cursor })
		for (const k of list.keys) {
			const rec: any = await env.PUSH_KV.get(k.name, 'json')
			if (!rec?.sub) continue
			let changed = false
			let gone = false
			// set reminders that just came due (fire within a 6-min window)
			if (rec.prefs?.sets !== false) {
				for (const r of rec.reminders || []) {
					if (r.sent || r.at > now || r.at < now - 6 * 60e3) continue
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
}

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(dispatch(env))
	},
	// manual trigger for testing: GET /run
	async fetch(req: Request, env: Env) {
		if (new URL(req.url).pathname === '/run') {
			await dispatch(env)
			return new Response('dispatched')
		}
		return new Response('roo-push cron worker')
	},
}
