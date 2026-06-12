// roo26-sw.js — tiny offline helper for roo26.alkem.dev.
// Cell service on the Farm is rough: network-first for pages (so updates land
// when there IS signal), cache-fallback when there isn't. Built assets and the
// official festival maps are cached so the app + maps work with zero signal.
const BASE = ''
const CACHE = 'roo26-v7'
const PRECACHE = [
	'/',
	'/map',
	'/plan',
	'/info',
	'/roo26-map-centeroo.webp',
	'/roo26-map-outeroo.webp',
	'/roo26-icon-192.png',
	'/roo26-icon-512.png',
	'/roo26-root.webmanifest',
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

// ───────────────────────── push notifications ─────────────────────────
// payload: { title, body, url, tag }
self.addEventListener('push', (e) => {
	let d = {}
	try {
		d = e.data ? e.data.json() : {}
	} catch {
		d = { title: "Roo '26", body: e.data ? e.data.text() : '' }
	}
	e.waitUntil(
		self.registration.showNotification(d.title || "Roo '26", {
			body: d.body || '',
			tag: d.tag || undefined, // same tag replaces, avoids dupes
			renotify: !!d.tag,
			icon: '/roo26-icon-192.png',
			badge: '/roo26-icon-192.png',
			data: { url: d.url || '/' },
			vibrate: [60, 40, 60],
		}),
	)
})

self.addEventListener('notificationclick', (e) => {
	e.notification.close()
	const url = (e.notification.data && e.notification.data.url) || '/'
	e.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
			for (const c of cls) {
				if ('focus' in c) {
					c.navigate(url).catch(() => {})
					return c.focus()
				}
			}
			return self.clients.openWindow(url)
		}),
	)
})
