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

export const ALL: APIRoute = async ({ request, params }) => {
	const kv = (env as any).ROO_KV as KVNamespace | undefined
	const path = params.path || ''

	if (path === 'health') return json({ ok: !!kv })
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
