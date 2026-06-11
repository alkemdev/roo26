// astro.config.ts — standalone build of the Roo '26 Bonnaroo guide for
// roo26.alkem.dev. The app component lives in src/pages/roo26/_App.astro and
// is served from the domain root via the wrapper pages in src-roo26/pages/.
import { defineConfig } from 'astro/config'

export default defineConfig({
	site: 'https://roo26.alkem.dev',
	srcDir: './src-roo26',
	trailingSlash: 'never',
	compressHTML: true,
})
