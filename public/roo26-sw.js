// roo26-sw.js — tiny offline helper for cade.io/roo26.
// Cell service on the Farm is rough: network-first for pages (so updates land
// when there IS signal), cache-fallback when there isn't. Built assets and the
// official festival maps are cached so the app + maps work with zero signal.
// serves both cade.io/roo26 and the standalone roo26.alkem.dev
const BASE = self.location.hostname.startsWith('roo26.') ? '' : '/roo26'
const CACHE = 'roo26-v4'
const PRECACHE = [
	BASE + '/',
	BASE + '/map/',
	BASE + '/plan/',
	BASE + '/trip/',
	BASE + '/info/',
	'/roo26-map-centeroo.webp',
	'/roo26-map-outeroo.webp',
	'/roo26-icon-192.png',
	'/roo26-icon-512.png',
	'/roo26.webmanifest',
]

self.addEventListener('install', (e) => {
	e.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(PRECACHE))
			.then(() => self.skipWaiting()),
	)
})

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('roo26')).map((k) => caches.delete(k))),
			)
			.then(() => self.clients.claim()),
	)
})

self.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url)
	if (e.request.method !== 'GET' || url.origin !== location.origin) return

	const path = url.pathname
	// app pages: network-first, fall back to cache when offline
	const isPage = path.replace(/\/$/, '').startsWith(BASE) && !path.includes('.')
	// hashed build assets + roo26 static files: cache-first (immutable-ish)
	const isAsset = path.startsWith('/_astro/') || /^\/roo26[-.].+\.(webp|png|webmanifest)$/.test(path)

	if (isPage) {
		e.respondWith(
			fetch(e.request)
				.then((res) => {
					const copy = res.clone()
					caches.open(CACHE).then((c) => c.put(e.request, copy))
					return res
				})
				.catch(() =>
					caches
						.match(e.request, { ignoreSearch: true })
						.then((m) => m || caches.match(BASE + '/')),
				),
		)
	} else if (isAsset) {
		e.respondWith(
			caches.match(e.request).then(
				(m) =>
					m ||
					fetch(e.request).then((res) => {
						const copy = res.clone()
						caches.open(CACHE).then((c) => c.put(e.request, copy))
						return res
					}),
			),
		)
	}
	// map tiles & weather API: live network only
})
