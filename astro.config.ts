// astro.config.ts — Roo '26 Bonnaroo guide for roo26.alkem.dev, deployed to
// Cloudflare Workers (Static Assets + on-demand routes via @astrojs/cloudflare).
// The app component lives in src/pages/roo26/_App.astro and is served from the
// domain root via the wrapper pages in src-roo26/pages/.
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'

export default defineConfig({
	site: 'https://roo26.alkem.dev',
	srcDir: './src-roo26',
	// Workers Static Assets serves /map directly and redirects /map/ → /map
	// (html_handling: auto-trailing-slash), so the canonical form has no slash.
	trailingSlash: 'never',
	compressHTML: true,
	// This app uses neither Astro Sessions nor astro:assets image optimization.
	// Left at defaults, @astrojs/cloudflare injects a SESSION KV binding and a
	// Cloudflare IMAGES binding into the deploy config — and `wrangler deploy`
	// then fails because those resources don't exist. Opt out of both so the
	// Worker deploys with no external bindings required.
	session: { driver: 'memory' },
	adapter: cloudflare({ imageService: 'passthrough' }),
})
