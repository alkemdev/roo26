// _app.js — all client logic for the Roo '26 guide (roo26.alkem.dev).
// Bundled by Astro; one script drives all routes (/, /map, /plan, /info).
import SCHED from './_data/schedule.json'
import POIS from './_data/pois.json'
import ARTISTS from './_data/artists.json'

const TZ = SCHED.tz || '-05:00' // Central Daylight Time on the Farm

// ───────────────────────── tiny helpers ─────────────────────────
const $ = (s, p = document) => p.querySelector(s)
const $$ = (s, p = document) => [...p.querySelectorAll(s)]

function el(tag, attrs = {}, ...kids) {
	const n = document.createElement(tag)
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') n.className = v
		else if (k === 'style') n.style.cssText = v
		else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
		else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v)
	}
	for (const k of kids.flat()) {
		if (k == null) continue
		n.append(k.nodeType ? k : document.createTextNode(k))
	}
	return n
}

const slug = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')

const epoch = (iso) => new Date(iso + ':00' + TZ).getTime()

function fmtTime(iso) {
	// iso like "2026-06-11T14:00" — format without timezone math
	let [h, m] = iso.slice(11, 16).split(':').map(Number)
	const ap = h >= 12 ? 'PM' : 'AM'
	h = h % 12 || 12
	return `${h}:${String(m).padStart(2, '0')} ${ap}`
}

function hourLabel(iso) {
	let h = Number(iso.slice(11, 13))
	const ap = h >= 12 ? 'PM' : 'AM'
	h = h % 12 || 12
	return `${h} ${ap}`
}

// "in 35 min" / "in 1h 20m" countdown to a future epoch (ms)
function untilLabel(ms, now = Date.now()) {
	const diff = ms - now
	if (diff <= 0) return 'now'
	const m = Math.round(diff / 60000)
	if (m < 60) return `in ${m} min`
	const h = Math.floor(m / 60)
	const mm = m % 60
	return mm ? `in ${h}h ${mm}m` : `in ${h}h`
}

let toastTimer
function toast(msg) {
	const t = $('#toast')
	t.textContent = msg
	t.hidden = false
	clearTimeout(toastTimer)
	toastTimer = setTimeout(() => (t.hidden = true), 2600)
}

// ───────────────────────── data prep ─────────────────────────
const STAGES = Object.fromEntries(SCHED.stages.map((s) => [s.id, s]))
// The six main stages are Centeroo; everything else — all the Plaza stages
// (When/Silent Disco/Groop/Why/Grove…) and Snake & Jake's — is Outeroo. New
// stages need no edit here: anything not in this set defaults to Outeroo.
const CENTEROO_STAGES = new Set(['what', 'which', 'this', 'that', 'other', 'where'])
const areaOf = (stageId) => (CENTEROO_STAGES.has(stageId) ? 'centeroo' : 'outeroo')
const SETS = SCHED.sets
	.map((x, i) => {
		const stage = STAGES[x.s] || { id: x.s, name: x.s, color: '#888', short: x.s }
		return {
			id: `${x.d}-${x.s}-${slug(x.a)}`,
			// stable index into the SOURCE (declaration) order of schedule.json.
			// Share links (v3) reference this, so APPENDING new sets never shifts
			// anyone's existing links — only reordering existing rows would.
			srcIdx: i,
			artist: x.a,
			day: x.d,
			stage,
			start: x.t,
			end: x.e,
			startMs: x.t ? epoch(x.t) : null,
			endMs: x.e ? epoch(x.e) : null,
			info: ARTISTS[slug(x.a)] || null,
		}
	})
	.sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity))
const SET_BY_ID = Object.fromEntries(SETS.map((s) => [s.id, s]))
// srcIdx → set, for decoding v3 (ID-stable) share links
const SET_BY_SRC = Object.fromEntries(SETS.map((s) => [s.srcIdx, s]))
// the pre-Outeroo time-sorted order, for decoding legacy v2 links (which indexed
// into a Centeroo-only sorted list). Stable as long as Centeroo rows aren't reordered.
const LEGACY_SETS = SETS.filter((s) => areaOf(s.stage.id) === 'centeroo')

const FEST_START = epoch(SCHED.days[0].date + 'T00:00')
const FEST_END = epoch(SCHED.days.at(-1).date + 'T23:59') + 8 * 3600e3

// ───────────────────────── persistent state ─────────────────────────
const store = {
	get(k, d) {
		try {
			const v = localStorage.getItem('roo26:' + k)
			return v == null ? d : JSON.parse(v)
		} catch {
			return d
		}
	},
	set(k, v) {
		try {
			localStorage.setItem('roo26:' + k, JSON.stringify(v))
		} catch {}
	},
	del(k) {
		try {
			localStorage.removeItem('roo26:' + k)
		} catch {}
	},
}

const state = {
	tab: document.documentElement.dataset.tab || 'schedule',
	day: store.get('day', null) || currentFestDay() || SCHED.days[0].id,
	stage: 'all',
	search: '',
	hidePast: store.get('hidepast', false), // declutter sets that already ended
	favs: store.get('favs2', null), // {setId: 2 (going) | 1 (interested)}
	friends: store.get('friends', []), // imported plans: [{name, going:[], interested:[], at}]
	pins: store.get('pins', []), // [{id, emoji, name, lat, lon}] — camps & meetup spots
	placing: null, // pin payload waiting for a map tap: {emoji, name} | null
	pos: null, // latest geolocation fix {lat, lon, acc, at}
	locatePref: store.get('locate', null), // user's last explicit locate on/off choice
}

// migrate v1 single-tier favorites → "going"
if (state.favs == null) {
	state.favs = Object.fromEntries(store.get('favs', []).map((id) => [id, 2]))
	store.set('favs2', state.favs)
	store.del('favs')
}

// migrate the old single "tent" pin into the pins list
{
	const tent = store.get('tent', null)
	if (tent) {
		state.pins.push({
			id: 'pin-' + Date.now(),
			emoji: '⛺',
			name: 'My camp',
			lat: tent.lat,
			lon: tent.lon,
		})
		store.set('pins', state.pins)
		store.del('tent')
	}
}

function currentFestDay() {
	// "festival day" rolls over at 8 AM — a 1 AM (or sunrise) set still belongs
	// to the previous day; the tab only advances mid-morning
	const now = Date.now() - 8 * 3600e3
	for (const d of SCHED.days) {
		if (now >= epoch(d.date + 'T00:00') && now < epoch(d.date + 'T23:59')) return d.id
	}
	return null
}

const saveFavs = () => store.set('favs2', state.favs)
const savePins = () => store.set('pins', state.pins)
const saveFriends = () => store.set('friends', state.friends)

// single-star favorites. Storage keeps the {id: tier} shape from the old
// two-tier system so nobody's saved plan is lost — any tier counts as starred.
const isFav = (id) => !!state.favs[id]
const favTier = (id) => (state.favs[id] ? 2 : 0) // legacy callers

function setFav(set, on) {
	if (on) state.favs[set.id] = 2
	else delete state.favs[set.id]
	saveFavs()
	renderFavCount()
	renderUpNext()
	if (state.tab === 'plan') renderPlan()
	drawRoute()
}

// ───────────────────────── router ─────────────────────────
// served from the domain root at roo26.alkem.dev
const BASE = ''
const TAB_PATH = {
	schedule: '/',
	map: '/map',
	plan: '/plan',
	info: '/info',
}

function setTab(tab, push = true) {
	state.tab = tab
	$$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + tab))
	$$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === tab))
	if (push && location.pathname.replace(/\/$/, '') !== TAB_PATH[tab])
		history.pushState({}, '', TAB_PATH[tab])
	if (tab === 'map') initMap()
	if (tab === 'plan') renderPlan()
	if (tab === 'info') {
		loadWeather()
		renderPet()
		renderQuest()
	}
	window.scrollTo({ top: 0 })
}

window.addEventListener('popstate', () => {
	const p = location.pathname.replace(/\/$/, '')
	const tab = Object.keys(TAB_PATH).find((k) => TAB_PATH[k] === p) || 'schedule'
	setTab(tab, false)
})

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.nav)))

// ───────────────────────── header live pill ─────────────────────────
function renderPill() {
	const pill = $('#livePill')
	const now = Date.now()
	if (now < FEST_START) {
		const d = Math.ceil((FEST_START - now) / 86400e3)
		pill.textContent = `${d} day${d === 1 ? '' : 's'} to go`
		pill.classList.remove('is-live')
	} else if (now < FEST_END) {
		const dayIdx = SCHED.days.findIndex((d) => d.id === currentFestDay())
		pill.textContent = dayIdx >= 0 ? `● LIVE · DAY ${dayIdx + 1}` : '● LIVE'
		pill.classList.add('is-live')
	} else {
		pill.textContent = "that's a wrap 🌈"
		pill.classList.remove('is-live')
	}
}

// ───────────────────────── schedule view ─────────────────────────
function setStatus(s, now = Date.now()) {
	if (!s.startMs) return 'tba'
	if (now >= s.startMs && now < (s.endMs ?? s.startMs + 3600e3)) return 'live'
	if (now >= (s.endMs ?? s.startMs + 3600e3)) return 'past'
	return 'next'
}

function favButton(set) {
	const b = el('button', { class: 'fav-btn', 'aria-label': 'Save to My Roo' })
	const paint = () => {
		b.textContent = isFav(set.id) ? '★' : '☆'
		b.classList.toggle('faved', isFav(set.id))
		b.setAttribute('aria-pressed', String(isFav(set.id)))
	}
	paint()
	b.addEventListener('click', (e) => {
		e.stopPropagation()
		const on = !isFav(set.id)
		setFav(set, on)
		toast(on ? `★ ${set.artist} added to My Roo` : `Removed ${set.artist}`)
		paint()
	})
	return b
}

function setRow(set, showDay = false) {
	const st = setStatus(set)
	const dayLbl = showDay ? SCHED.days.find((d) => d.id === set.day)?.label : null
	const row = el(
		'div',
		{
			class: `set-row is-${st}`,
			style: `--sc:${set.stage.color}`,
			'data-id': set.id,
			role: 'button',
			tabindex: '0',
		},
		el(
			'div',
			{ class: 'set-time' },
			el('span', { class: 'st-s' }, set.start ? fmtTime(set.start) : 'TBA'),
			set.end ? el('span', { class: 'st-e' }, '– ' + fmtTime(set.end)) : null,
		),
		el(
			'div',
			{ class: 'set-main' },
			el('div', { class: 'set-artist' }, set.artist),
			el(
				'div',
				{ class: 'set-meta' },
				dayLbl ? el('span', { class: 'day-tag' }, dayLbl.toUpperCase()) : null,
				el('span', { class: 'stage-tag' }, set.stage.name.toUpperCase()),
				set.info?.g ? el('span', { class: 'genre-tag' }, set.info.g) : null,
				st === 'live' ? el('span', { class: 'live-tag' }, 'LIVE') : null,
			),
		),
		favButton(set),
	)
	row.addEventListener('click', () => openSheet(set))
	row.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') openSheet(set)
	})
	return row
}

function renderDayTabs() {
	const wrap = $('#dayTabs')
	wrap.replaceChildren(
		...SCHED.days.map((d) => {
			const b = el(
				'button',
				{
					class:
						'day-tab' +
						(d.id === state.day ? ' active' : '') +
						(d.id === currentFestDay() ? ' is-today' : ''),
				},
				el('span', { class: 'd-lbl' }, d.label),
				el('span', { class: 'd-date' }, 'Jun ' + Number(d.date.slice(8))),
			)
			b.addEventListener('click', () => {
				state.day = d.id
				store.set('day', d.id)
				renderDayTabs()
				renderSched()
			})
			return b
		}),
	)
}

// stage filter accepts 'all', an area ('centeroo'|'outeroo'), or a stage id
function stageMatches(s) {
	if (state.stage === 'all') return true
	if (state.stage === 'centeroo' || state.stage === 'outeroo') return areaOf(s.stage.id) === state.stage
	return s.stage.id === state.stage
}

function renderStageChips() {
	const wrap = $('#stageChips')
	const mk = (id, name, color, extra = '') => {
		const c = el(
			'button',
			{
				class: 'chip' + extra + (state.stage === id ? ' active' : ''),
				style: color ? `--chip-c:${color}` : '',
			},
			color ? el('span', { class: 'dot' }) : null,
			name,
		)
		c.addEventListener('click', () => {
			state.stage = id
			renderStageChips()
			renderSched()
		})
		return c
	}
	wrap.replaceChildren(
		mk('all', 'Everything', null, ' chip-area'),
		mk('centeroo', 'Centeroo', null, ' chip-area'),
		mk('outeroo', 'Outeroo', null, ' chip-area'),
		...SCHED.stages.map((s) => mk(s.id, s.name, s.color)),
	)
}

function visibleSets() {
	const q = state.search.trim().toLowerCase()
	const now = Date.now()
	return SETS.filter(
		(s) =>
			s.day === state.day &&
			stageMatches(s) &&
			// hide-past only applies when you're not searching (search should find anything)
			(q || !state.hidePast || setStatus(s, now) !== 'past') &&
			(!q || s.artist.toLowerCase().includes(q) || (s.info?.g || '').includes(q)),
	)
}

function renderSched() {
	const list = $('#schedList')
	const sets = visibleSets()
	const q = state.search.trim().toLowerCase()
	// while searching, also surface matches from the other days, after today's
	const otherDays = q
		? SETS.filter(
				(s) =>
					s.day !== state.day &&
					stageMatches(s) &&
					(s.artist.toLowerCase().includes(q) || (s.info?.g || '').includes(q)),
			)
		: []
	if (!sets.length && !otherDays.length) {
		const emptyMsg = state.search
			? `No artists matching “${state.search}”.`
			: state.stage === 'outeroo'
				? 'Outeroo lineup (Plaza stages, Silent Disco, The Grove & late-night parties) is coming to the app soon.'
				: 'Nothing here yet.'
		list.replaceChildren(el('div', { class: 'empty-note' }, emptyMsg))
		return
	}
	const frag = document.createDocumentFragment()
	let lastH = null
	for (const s of sets) {
		const h = s.start ? hourLabel(s.start) : 'TBA'
		if (h !== lastH) {
			frag.append(el('div', { class: 'sched-group-h' }, h))
			lastH = h
		}
		frag.append(setRow(s))
	}
	if (otherDays.length) {
		if (!sets.length)
			frag.append(el('div', { class: 'empty-note slim' }, `Nothing on this day for “${state.search}” —`))
		frag.append(el('div', { class: 'sched-group-h' }, 'OTHER DAYS'))
		for (const s of otherDays) frag.append(setRow(s, true))
	}
	list.replaceChildren(frag)
}

// a horizontal card: tappable body (opens the sheet) + a one-tap ★
function nowCard(s, ncs) {
	const card = el(
		'div',
		{ class: 'now-card', style: `--sc:${s.stage.color}`, role: 'button', tabindex: '0' },
		el('div', { class: 'nc-main' }, el('span', { class: 'nc-a' }, s.artist), ncs),
		favButton(s),
	)
	card.addEventListener('click', () => openSheet(s))
	card.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') openSheet(s)
	})
	return card
}

function renderNowStrip() {
	const now = Date.now()
	const live = SETS.filter((s) => setStatus(s, now) === 'live')
	const strip = $('#nowStrip')
	strip.hidden = live.length === 0
	if (live.length)
		$('#nowCards').replaceChildren(
			...live.map((s) =>
				nowCard(s, el('span', { class: 'nc-s' }, `${s.stage.name} · until ${s.end ? fmtTime(s.end) : '?'}`)),
			),
		)
	renderUpNext(now)
}

// your starred sets starting within the next few hours, with a live countdown
// (and walk time from your location when 📍 is on)
function renderUpNext(now = Date.now()) {
	const strip = $('#upNextStrip')
	const upcoming = SETS.filter((s) => isFav(s.id) && s.startMs && s.startMs > now && s.startMs - now < 3 * 3600e3)
		.sort((a, b) => a.startMs - b.startMs)
		.slice(0, 5)
	strip.hidden = upcoming.length === 0
	if (!upcoming.length) return
	$('#upNextCards').replaceChildren(
		...upcoming.map((s) => {
			const ncs = el(
				'span',
				{ class: 'nc-s' },
				`${s.stage.name} · `,
				el('span', { class: 'nc-when' }, untilLabel(s.startMs, now)),
			)
			if (state.pos && STAGE_POI[s.stage.id]) {
				const w = fmtWalk(haversine(state.pos, STAGE_POI[s.stage.id]))
				if (w) ncs.append(` · ${w}`)
			}
			return nowCard(s, ncs)
		}),
	)
}

// refresh live/past classes in place without rebuilding (keeps scroll)
function refreshStatuses() {
	const now = Date.now()
	$$('#schedList .set-row, #planBody .set-row').forEach((row) => {
		const s = SET_BY_ID[row.dataset.id]
		if (!s) return
		const st = setStatus(s, now)
		row.classList.toggle('is-live', st === 'live')
		row.classList.toggle('is-past', st === 'past')
		const meta = $('.set-meta', row)
		const tag = $('.live-tag', row)
		if (st === 'live' && !tag) meta.append(el('span', { class: 'live-tag' }, 'LIVE'))
		if (st !== 'live' && tag) tag.remove()
	})
	renderNowStrip()
	renderPill()
}

$('#searchBox').addEventListener('input', (e) => {
	state.search = e.target.value
	renderSched()
})

$('#nowJump').addEventListener('click', () => {
	const today = currentFestDay()
	if (today && today !== state.day) {
		state.day = today
		store.set('day', today)
		renderDayTabs()
		renderSched()
	}
	const target =
		$('#schedList .set-row.is-live') ||
		$$('#schedList .set-row').find((r) => !r.classList.contains('is-past'))
	if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
	else toast('No upcoming sets on this day')
})

const hidePastBtn = $('#hidePast')
const paintHidePast = () => {
	hidePastBtn.classList.toggle('active', state.hidePast)
	hidePastBtn.setAttribute('aria-pressed', String(state.hidePast))
}
hidePastBtn.addEventListener('click', () => {
	state.hidePast = !state.hidePast
	store.set('hidepast', state.hidePast)
	paintHidePast()
	renderSched()
})
paintHidePast()

// ───────────────────────── artist detail sheet ─────────────────────────
let sheetSet = null

function openSheet(set) {
	sheetSet = set
	const a = set.info
	const day = SCHED.days.find((d) => d.id === set.day)
	$('#sheetImg').style.backgroundImage = a?.img ? `url(${a.img})` : 'none'
	$('#sheetImg').classList.toggle('no-img', !a?.img)
	$('#sheetArtist').textContent = set.artist
	$('#sheetGenre').textContent = a?.g || ''
	$('#sheetGenre').hidden = !a?.g
	$('#sheetDesc').textContent = a?.d || ''
	$('#sheetBio').textContent = a?.bio && a.bio !== a.d ? a.bio : ''
	$('#sheetBio').hidden = !a?.bio || a.bio === a.d
	const linkChip = (label, href) =>
		el('a', { class: 'link-chip', href, target: '_blank', rel: 'noopener' }, label)
	const chips = []
	if (a?.links?.ig) chips.push(linkChip('📸 Instagram', a.links.ig))
	if (a?.links?.x) chips.push(linkChip('𝕏', a.links.x))
	if (a?.links?.bc) chips.push(linkChip('🎵 Bandcamp', a.links.bc))
	if (a?.links?.web) chips.push(linkChip('🌐 Site', a.links.web))
	for (const n of a?.news || []) chips.push(linkChip('📰 ' + n.t, n.u))
	$('#sheetLinks').replaceChildren(...chips)
	$('#sheetLinks').hidden = !chips.length
	$('#sheetWhen').textContent =
		`${day.full} · ${set.start ? fmtTime(set.start) : 'TBA'}${set.end ? '–' + fmtTime(set.end) : ''}`
	const tag = $('#sheetStage')
	tag.textContent = set.stage.name
	tag.style.color = set.stage.color
	$('#sheetGoing').classList.toggle('faved', isFav(set.id))
	$('#sheetGoing').textContent = isFav(set.id) ? '★ In My Roo' : '☆ Add to My Roo'
	$('#sheetSpotify').href = a?.id
		? `https://open.spotify.com/artist/${a.id}`
		: `https://open.spotify.com/search/${encodeURIComponent(set.artist)}`
	$('#sheetWrap').hidden = false
	document.body.style.overflow = 'hidden'
}

function closeSheet() {
	$('#sheetWrap').hidden = true
	document.body.style.overflow = ''
	sheetSet = null
}

$('#sheetClose').addEventListener('click', closeSheet)
$('#sheetWrap').addEventListener('click', (e) => {
	if (e.target.id === 'sheetWrap') closeSheet()
})
$('#sheetGoing').addEventListener('click', () => {
	if (!sheetSet) return
	const keep = sheetSet
	setFav(keep, !isFav(keep.id))
	openSheet(keep) // refresh sheet button state
	renderSched()
})
$('#sheetMap').addEventListener('click', async () => {
	if (!sheetSet) return
	const poi = POIS.pois.find((p) => p.cat === 'stage' && p.stage === sheetSet.stage.id)
	closeSheet()
	setTab('map')
	await initMap()
	if (map && poi) {
		map.flyTo([poi.lat, poi.lon], 17)
		stageMarkers[poi.stage]?.openPopup()
	}
})

// ───────────────────────── my plan ─────────────────────────
function renderFavCount() {
	const n = Object.keys(state.favs).length
	const b = $('#favCount')
	b.hidden = n === 0
	b.textContent = n
}

const STAGE_POI = Object.fromEntries(
	POIS.pois.filter((p) => p.cat === 'stage' && p.stage).map((p) => [p.stage, p]),
)
const stageDist = (a, b) =>
	STAGE_POI[a] && STAGE_POI[b] && a !== b ? haversine(STAGE_POI[a], STAGE_POI[b]) : 0

function renderPlan() {
	renderNameChip()
	const body = $('#planBody')
	const favs = SETS.filter((s) => isFav(s.id))
	const frag = document.createDocumentFragment()
	if (!favs.length) {
		frag.append(
			el(
				'div',
				{ class: 'empty-note' },
				'No sets saved yet. Tap the ☆ next to any set to build your weekend.',
			),
		)
	}
	for (const d of SCHED.days) {
		const daySets = favs.filter((s) => s.day === d.id)
		if (!daySets.length) continue
		frag.append(el('div', { class: 'plan-day-h' }, d.full.toUpperCase()))
		for (let i = 0; i < daySets.length; i++) {
			const s = daySets[i]
			frag.append(setRow(s))
			// friends (from imported plans) who are also going to this exact set
			const fhere = state.friends.filter((f) => f.going.includes(s.id))
			if (fhere.length)
				frag.append(
					el('div', { class: 'friends-at' }, '🤝 ', `${fhere.map((f) => f.name).join(', ')} here too`),
				)
			const next = daySets[i + 1]
			if (next && s.endMs && next.startMs) {
				if (next.startMs < s.endMs) {
					frag.append(
						el(
							'div',
							{ class: 'conflict-note' },
							'⚠️',
							`Overlaps with ${next.artist} — you'll have to choose (or split it)`,
						),
					)
				} else {
					const dist = stageDist(s.stage.id, next.stage.id)
					if (dist > 120) {
						const walkMin = Math.max(1, Math.round(dist / 80))
						const leaveMs = next.startMs - (walkMin + 5) * 60e3
						// format leave time in festival local time (CDT = UTC-5)
						const lvLocal = new Date(leaveMs - 5 * 3600e3)
						const hh = lvLocal.getUTCHours()
						const mm = String(lvLocal.getUTCMinutes()).padStart(2, '0')
						const ap = hh >= 12 ? 'PM' : 'AM'
						const tight = leaveMs < s.endMs
						frag.append(
							el(
								'div',
								{ class: 'walk-note' + (tight ? ' tight' : '') },
								'🚶',
								`${walkMin} min to ${next.stage.name} — leave by ${hh % 12 || 12}:${mm} ${ap}` +
									(tight ? ` (before ${s.artist} ends!)` : ''),
							),
						)
					}
				}
			}
		}
	}
	renderFriends(frag)
	body.replaceChildren(frag)
}

// ── friends' imported plans ──
function renderFriends(frag) {
	if (!state.friends.length) return
	frag.append(el('div', { class: 'plan-day-h friends-h' }, "FRIENDS' PLANS"))
	for (const f of state.friends) {
		const goingSets = f.going.map((id) => SET_BY_ID[id]).filter(Boolean)
		const overlap = goingSets.filter((s) => favTier(s.id) === 2).length
		const card = el('div', { class: 'friend-card' })
		const head = el(
			'button',
			{ class: 'friend-head' },
			el('span', { class: 'friend-name' }, `🤝 ${f.name}`),
			el(
				'span',
				{ class: 'friend-meta' },
				`${goingSets.length} sets${overlap ? ` · ${overlap} with you` : ''} ▾`,
			),
		)
		const listEl = el('div', { class: 'friend-sets' }, '')
		listEl.hidden = true
		head.addEventListener('click', () => {
			listEl.hidden = !listEl.hidden
			if (!listEl.hidden && !listEl.childElementCount) {
				for (const d of SCHED.days) {
					const ds = goingSets.filter((s) => s.day === d.id)
					if (!ds.length) continue
					listEl.append(el('div', { class: 'friend-day' }, d.label.toUpperCase()))
					for (const s of ds)
						listEl.append(
							el(
								'div',
								{ class: 'friend-set' },
								`${s.start ? fmtTime(s.start) : 'TBA'} — ${s.artist} (${s.stage.short})`,
								favTier(s.id) === 2 ? el('span', { class: 'both-tag' }, ' 🤝 you too') : null,
							),
						)
				}
			}
		})
		const rm = el('button', { class: 'friend-rm', 'aria-label': 'Remove' }, '✕')
		rm.addEventListener('click', () => {
			if (!confirm(`Remove ${f.name}'s plan from My Roo?`)) return
			state.friends = state.friends.filter((x) => x !== f)
			saveFriends()
			renderPlan()
			toast(`Removed ${f.name}'s plan`)
		})
		card.append(head, rm, listEl)
		frag.append(card)
	}
}

$('#clearPlan').addEventListener('click', () => {
	if (!Object.keys(state.favs).length) return toast('Nothing to clear')
	if (!confirm('Remove all saved sets from My Roo?')) return
	state.favs = {}
	saveFavs()
	renderFavCount()
	renderPlan()
	renderSched()
	drawRoute()
})

// ── share: text + a link that carries your whole plan ──
// v3 links reference stable srcIdx values, so appending new sets (e.g. Outeroo)
// never shifts anyone's saved plan. Old v2 links indexed a Centeroo-only,
// time-sorted list — still decoded via LEGACY_SETS.
function encodePlan(name) {
	const going = []
	SETS.forEach((s) => {
		if (isFav(s.id)) going.push(s.srcIdx)
	})
	return `3!${encodeURIComponent(name)}!${going.join('.')}`
}

function decodePlan(hash) {
	const parts = hash.split('!')
	const ver = parts[0]
	const ids = (s, table) =>
		s
			? s
					.split('.')
					.map(Number)
					.map((i) => table[i])
					.filter(Boolean)
					.map((set) => set.id)
			: []
	if (ver === '3') {
		return {
			name: decodeURIComponent(parts[1] || '') || 'A friend',
			going: ids(parts[2], SET_BY_SRC),
			interested: [],
		}
	}
	// legacy v2 (and its folded two-tier slot): index into the pre-Outeroo order
	if (ver === '2' && parts.length >= 4) {
		return {
			name: decodeURIComponent(parts[1]) || 'A friend',
			going: [...ids(parts[2], LEGACY_SETS), ...ids(parts[3], LEGACY_SETS)],
			interested: [],
		}
	}
	return null
}

function planText() {
	const favs = SETS.filter((s) => isFav(s.id))
	let txt = "My Bonnaroo '26 plan 🌈\n"
	for (const d of SCHED.days) {
		const daySets = favs.filter((s) => s.day === d.id)
		if (!daySets.length) continue
		txt += `\n${d.full}\n`
		for (const s of daySets)
			txt += `  ${s.start ? fmtTime(s.start) : 'TBA'} — ${s.artist} (${s.stage.name})\n`
	}
	return txt
}

// ── your sharing identity: a name + an icon, used on links, QR & friend cards ──
const NAME_EMOJIS = ['🦄', '🌈', '🍄', '🎸', '🛸', '🔥', '🌻', '🐸', '💀', '🪩', '🦖', '👽', '🌮', '🦋', '⚡', '✌️']
const getMyName = () => store.get('myname', '')
let myIcon = store.get('myicon', '')
let pickIcon = ''
// what friends actually see — icon + name (falls back to just the name)
const myDisplayName = () => (myIcon ? myIcon + ' ' : '') + getMyName()

// give everyone a fun, near-unique handle on first run (still fully editable).
// ~20×20×900 ≈ 360k combos — collisions are unlikely across a campsite.
const FUN_ADJ = ['Cosmic', 'Funky', 'Groovy', 'Disco', 'Electric', 'Velvet', 'Neon', 'Mystic', 'Sunny', 'Wild', 'Dazzling', 'Psychedelic', 'Rowdy', 'Mellow', 'Radiant', 'Glittery', 'Bouncy', 'Sparkly', 'Lunar', 'Sticky']
const FUN_NOUN = ['Otter', 'Mango', 'Penguin', 'Comet', 'Mushroom', 'Unicorn', 'Wombat', 'Sunflower', 'Yeti', 'Narwhal', 'Possum', 'Firefly', 'Kazoo', 'Jellybean', 'Pickle', 'Cactus', 'Noodle', 'Wizard', 'Goblin', 'Llama']
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const funName = () => `${pick(FUN_ADJ)} ${pick(FUN_NOUN)} ${Math.floor(Math.random() * 900) + 100}`
if (!getMyName()) {
	store.set('myname', funName())
	myIcon = pick(NAME_EMOJIS)
	store.set('myicon', myIcon)
}

function renderNameEmojis() {
	$('#nameEmojis').replaceChildren(
		...NAME_EMOJIS.map((e) => {
			const b = el('button', { class: 'pin-emoji' + (e === pickIcon ? ' active' : '') }, e)
			b.addEventListener('click', () => {
				pickIcon = pickIcon === e ? '' : e // tap again to clear
				renderNameEmojis()
			})
			return b
		}),
	)
}
function openNameSheet() {
	pickIcon = myIcon
	renderNameEmojis()
	$('#nameInput').value = getMyName()
	$('#nameSheetWrap').hidden = false
}
$('#nameSave').addEventListener('click', () => {
	const name = $('#nameInput').value.trim().slice(0, 24)
	if (!name) return toast('Enter a name')
	store.set('myname', name)
	myIcon = pickIcon
	store.set('myicon', myIcon)
	$('#nameSheetWrap').hidden = true
	renderNameChip()
})
$('#nameCancel').addEventListener('click', () => ($('#nameSheetWrap').hidden = true))
$('#nameSheetWrap').addEventListener('click', (e) => {
	if (e.target.id === 'nameSheetWrap') $('#nameSheetWrap').hidden = true
})

function renderNameChip() {
	const chip = $('#nameChip')
	if (!chip) return
	chip.replaceChildren(
		getMyName()
			? el('span', {}, 'Sharing as ', el('b', {}, myDisplayName()), ' · ', el('span', { class: 'name-edit' }, '✏️ edit'))
			: el('span', { class: 'name-edit' }, '✏️ Set your name + icon for sharing'),
	)
}
$('#nameChip').addEventListener('click', openNameSheet)

// ── Share my Roo: one hub with a QR + text-a-friend buttons ──
let shareUrl = ''
// text/share helper — opens the native share sheet (text a friend) or copies
async function shareText(text) {
	try {
		if (navigator.share) await navigator.share({ text })
		else {
			await navigator.clipboard.writeText(text)
			toast('Copied to clipboard')
		}
		questFlag('share')
	} catch {}
}

async function openShareHub() {
	if (!Object.keys(state.favs).length) return toast('Star some sets first!')
	if (!getMyName()) return openNameSheet() // set identity first
	shareUrl = `${location.origin}${BASE}/plan#p=${encodePlan(myDisplayName())}`
	try {
		const QR = (await import('qrcode')).default
		await QR.toCanvas($('#qrCanvas'), shareUrl, { width: 720, margin: 2, errorCorrectionLevel: 'M' })
	} catch {
		// QR is a bonus; the share buttons still work without it
	}
	$('#qrName').textContent = `${myDisplayName()}'s Roo '26`
	$('#qrWrap').hidden = false
	document.body.style.overflow = 'hidden'
}
$('#sharePlan').addEventListener('click', openShareHub)
// short message — easy to text
$('#shareLink').addEventListener('click', () => shareText(`Here's my ROO26 🌈 ${shareUrl}`))
// full set-by-set schedule + link
$('#shareFull').addEventListener('click', () => shareText(planText() + '\nOpen it: ' + shareUrl))
$('#qrClose').addEventListener('click', () => {
	$('#qrWrap').hidden = true
	document.body.style.overflow = ''
})

// ───────────────────────── Spotify warm-up playlist ─────────────────────────
// Turns your starred artists into a playlist of their top tracks, in your
// Spotify account. Browser-only OAuth (PKCE) — no server secret. To enable:
// paste your Spotify app's Client ID below (it's a public value) and register
// the redirect URI shown in SPOTIFY_REDIRECT in the Spotify developer dashboard.
const SPOTIFY_CLIENT_ID = '' // ← paste Client ID here to switch the feature on
const SPOTIFY_REDIRECT = `${location.origin}${BASE}/plan`
const SPOTIFY_SCOPES = 'playlist-modify-private playlist-modify-public'

const b64url = (buf) =>
	btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
const randStr = (n = 64) => b64url(crypto.getRandomValues(new Uint8Array(n)))

async function spotifyAuth() {
	const verifier = randStr()
	const challenge = b64url(await sha256(verifier))
	store.set('spotify_pkce', verifier)
	store.set('spotify_pending', true)
	const p = new URLSearchParams({
		client_id: SPOTIFY_CLIENT_ID,
		response_type: 'code',
		redirect_uri: SPOTIFY_REDIRECT,
		code_challenge_method: 'S256',
		code_challenge: challenge,
		scope: SPOTIFY_SCOPES,
	})
	location.href = `https://accounts.spotify.com/authorize?${p}`
}

async function spotifyTokenReq(params) {
	const r = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, ...params }),
	})
	if (!r.ok) throw new Error('spotify token')
	return r.json()
}

// return a valid access token (refreshing if needed), or null if not signed in
async function spotifyToken() {
	const t = store.get('spotify', null)
	if (!t) return null
	if (Date.now() < t.exp - 60e3) return t.access
	if (!t.refresh) return null
	try {
		const j = await spotifyTokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh })
		const next = { access: j.access_token, refresh: j.refresh_token || t.refresh, exp: Date.now() + j.expires_in * 1000 }
		store.set('spotify', next)
		return next.access
	} catch {
		store.del('spotify')
		return null
	}
}

const spApi = (access) => (path, opts = {}) =>
	fetch(`https://api.spotify.com/v1${path}`, {
		...opts,
		headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', ...(opts.headers || {}) },
	})

async function buildSpotifyPlaylist() {
	if (!SPOTIFY_CLIENT_ID) return
	const fav = SETS.filter((s) => isFav(s.id))
	if (!fav.length) return toast('Star some sets first!')
	const access = await spotifyToken()
	if (!access) return spotifyAuth() // sign in, then resume on redirect
	toast('Building your Spotify playlist…')
	try {
		const api = spApi(access)
		const ids = [...new Set(fav.map((s) => s.info?.id).filter(Boolean))] // unique artist IDs
		const uris = []
		for (const id of ids) {
			const r = await api(`/artists/${id}/top-tracks?market=US`)
			if (!r.ok) continue
			const j = await r.json()
			for (const t of (j.tracks || []).slice(0, 3)) uris.push(t.uri)
		}
		if (!uris.length) return toast('Couldn’t find tracks for your artists')
		const me = await (await api('/me')).json()
		const pl = await (
			await api(`/users/${me.id}/playlists`, {
				method: 'POST',
				body: JSON.stringify({
					name: "My Roo '26 🌈",
					description: `Warm-up for Bonnaroo 2026 — ${ids.length} artists from my plan @ roo26.alkem.dev`,
					public: false,
				}),
			})
		).json()
		for (let i = 0; i < uris.length; i += 100)
			await api(`/playlists/${pl.id}/tracks`, { method: 'POST', body: JSON.stringify({ uris: uris.slice(i, i + 100) }) })
		toast(`🎵 Playlist ready — ${uris.length} tracks!`)
		window.open(pl.external_urls.spotify, '_blank')
		questFlag('share')
	} catch {
		toast('Spotify hiccup — try again')
	}
}

// after the OAuth redirect we land back on /plan?code=… — finish + resume
async function spotifyOnLoad() {
	const code = new URLSearchParams(location.search).get('code')
	if (!code || !store.get('spotify_pending', false)) return
	store.del('spotify_pending')
	history.replaceState({}, '', location.pathname)
	try {
		const j = await spotifyTokenReq({
			grant_type: 'authorization_code',
			code,
			redirect_uri: SPOTIFY_REDIRECT,
			code_verifier: store.get('spotify_pkce', ''),
		})
		store.set('spotify', { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + j.expires_in * 1000 })
		store.del('spotify_pkce')
		setTab('plan')
		buildSpotifyPlaylist()
	} catch {
		toast('Spotify sign-in failed')
	}
}

if ($('#spotifyPlan')) {
	$('#spotifyPlan').hidden = !SPOTIFY_CLIENT_ID
	$('#spotifyPlan').addEventListener('click', buildSpotifyPlaylist)
}
spotifyOnLoad()

// importing a friend's plan from a shared link
let pendingImport = null
function checkImport() {
	const m = location.hash.match(/^#p=(.+)$/)
	if (!m) return
	const plan = decodePlan(decodeURI(m[1]))
	history.replaceState({}, '', location.pathname)
	if (!plan || (!plan.going.length && !plan.interested.length)) return
	pendingImport = plan
	renderImportPreview(plan)
}

// rich preview of an incoming shared plan — set list by day, overlaps flagged
function renderImportPreview(plan) {
	const goingSets = plan.going
		.map((id) => SET_BY_ID[id])
		.filter(Boolean)
		.sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity))
	const overlap = goingSets.filter((s) => isFav(s.id)).length
	const existing = state.friends.some((f) => f.name === plan.name)
	$('#importTitle').textContent = `${plan.name} shared their Roo '26`
	$('#importSub').textContent =
		`${goingSets.length} set${goingSets.length === 1 ? '' : 's'}` +
		(overlap ? ` · ${overlap} you're also seeing 🤝` : '') +
		(existing ? ' · updates the copy you saved' : '')
	$('#importSave').textContent = existing ? `Update ${plan.name}'s plan` : 'Save to My Roo'
	const frag = document.createDocumentFragment()
	for (const d of SCHED.days) {
		const ds = goingSets.filter((s) => s.day === d.id)
		if (!ds.length) continue
		frag.append(el('div', { class: 'import-day' }, d.full.toUpperCase()))
		for (const s of ds) {
			const both = isFav(s.id)
			frag.append(
				el(
					'div',
					{ class: 'import-row' + (both ? ' both' : '') },
					el('span', {}, `${both ? '🤝 ' : ''}${s.artist}`),
					el('span', { class: 'ir-t' }, `${s.start ? fmtTime(s.start) : 'TBA'} · ${s.stage.short}`),
				),
			)
		}
	}
	$('#importList').replaceChildren(frag)
	$('#importWrap').hidden = false
	document.body.style.overflow = 'hidden'
}

function closeImport() {
	$('#importWrap').hidden = true
	document.body.style.overflow = ''
	pendingImport = null
}
$('#importSave').addEventListener('click', () => {
	const plan = pendingImport
	if (!plan) return closeImport()
	state.friends = state.friends.filter((f) => f.name !== plan.name)
	state.friends.push({ ...plan, at: Date.now() })
	saveFriends()
	closeImport()
	setTab('plan')
	toast(`Saved ${plan.name}'s plan`)
})
$('#importCancel').addEventListener('click', closeImport)
$('#importWrap').addEventListener('click', (e) => {
	if (e.target.id === 'importWrap') closeImport()
})

// ── calendar export (.ics) — native reminders that work offline ──
$('#icsPlan').addEventListener('click', () => {
	const favs = SETS.filter((s) => favTier(s.id) > 0 && s.startMs)
	if (!favs.length) return toast('Star some sets first!')
	const utc = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '')
	let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//roo26.alkem.dev//roo26//EN\r\n'
	for (const s of favs) {
		ics +=
			'BEGIN:VEVENT\r\n' +
			`UID:${s.id}@roo26.alkem.dev\r\n` +
			`DTSTAMP:${utc(Date.now())}\r\n` +
			`DTSTART:${utc(s.startMs)}\r\n` +
			`DTEND:${utc(s.endMs || s.startMs + 3600e3)}\r\n` +
			`SUMMARY:${s.artist.replace(/[,;\\]/g, ' ')} @ ${s.stage.name}\r\n` +
			`LOCATION:${s.stage.name}, Bonnaroo, Manchester TN\r\n` +
			'BEGIN:VALARM\r\nTRIGGER:-PT20M\r\nACTION:DISPLAY\r\nDESCRIPTION:Set starting soon\r\nEND:VALARM\r\n' +
			'END:VEVENT\r\n'
	}
	ics += 'END:VCALENDAR\r\n'
	const a = el('a', {
		href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })),
		download: 'my-roo26.ics',
	})
	document.body.append(a)
	a.click()
	a.remove()
	toast('Calendar file downloaded — open it to add reminders')
})

// ───────────────────────── map ─────────────────────────
const POI_CATS = {
	stage: { label: 'Stages', emoji: '🎪', color: '#ff4f7b', on: true },
	water: { label: 'Water', emoji: '💧', color: '#46b3ff', on: true },
	medical: { label: 'Medical', emoji: '⛑️', color: '#ff5252', on: true },
	entrance: { label: 'Entrances', emoji: '🚪', color: '#ffb02e', on: true },
	food: { label: 'Food & shops', emoji: '🍕', color: '#3ddc97', on: false },
	utility: { label: 'Restrooms & misc', emoji: '🚻', color: '#8fa3ad', on: false },
	camping: { label: 'Camping', emoji: '⛺', color: '#b08bff', on: true },
	landmark: { label: 'Landmarks', emoji: '🎡', color: '#ff8bd2', on: true },
}

let L = null // leaflet module, loaded lazily on first map view
let map = null
const catLayers = {}
const stageMarkers = {}
let pinLayer = null
let userMarker = null
let userCircle = null
let watchId = null
let retryTimer = null

async function loadLeaflet() {
	if (L) return L
	const [mod] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')])
	L = mod.default
	return L
}

async function initMap() {
	if (map) {
		setTimeout(() => map.invalidateSize(), 60)
		return
	}
	try {
		await loadLeaflet()
	} catch {
		toast('Map failed to load — check your connection')
		return
	}

	const sat = L.tileLayer(
		'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
		{ maxZoom: 19, attribution: 'Imagery © Esri' },
	)

	map = L.map('map', {
		center: POIS.center,
		zoom: 16,
		// conservative limits so nobody accidentally zooms/pans off into the
		// ocean and "breaks" the map: locked to the Farm, sensible zoom range.
		minZoom: 14,
		maxZoom: 19,
		layers: [sat],
		zoomControl: false,
		maxBounds: L.latLngBounds(POIS.farmBounds).pad(0.15),
		maxBoundsViscosity: 0.85,
		attributionControl: true,
	})

	// build category layers + markers
	for (const cat of Object.keys(POI_CATS)) catLayers[cat] = L.layerGroup()
	for (const p of POIS.pois) {
		const cat = POI_CATS[p.cat] || POI_CATS.landmark
		const isStage = p.cat === 'stage'
		const stageColor = p.stage && STAGES[p.stage] ? STAGES[p.stage].color : cat.color
		const size = isStage ? 34 : 26
		const m = L.marker([p.lat, p.lon], {
			icon: L.divIcon({
				className: '',
				html: `<div class="poi-pin ${isStage ? 'poi-stage' : ''}" style="--pc:${stageColor}">${p.emoji || cat.emoji}</div>`,
				iconSize: [size, size],
				iconAnchor: [size / 2, size / 2],
			}),
		})
		const majorLabel = isStage || /^Plaza \d/.test(p.name) // key wayfinding anchors
		m.bindTooltip(p.name, {
			permanent: true,
			direction: 'bottom',
			offset: [0, size / 2 + 1],
			className: 'poi-lbl' + (majorLabel ? '' : ' lbl-minor'),
		})
		m.bindPopup(() => poiPopup(p))
		m.addTo(catLayers[p.cat] ? catLayers[p.cat] : catLayers.landmark)
		if (isStage) stageMarkers[p.stage] = m
	}
	for (const [cat, def] of Object.entries(POI_CATS)) if (def.on) catLayers[cat].addTo(map)

	pinLayer = L.layerGroup().addTo(map)
	routeLayer = L.layerGroup().addTo(map)
	drawPins()
	drawRoute()
	if (crewAvailable && crew) startCrew()

	const syncZoomClass = () => $('#map').classList.toggle('map-zoomed-out', map.getZoom() < 17)
	map.on('zoomend', syncZoomClass)
	syncZoomClass()

	map.on('click', (e) => {
		if (state.placing) placePin(e.latlng.lat, e.latlng.lng)
	})

	renderPoiChips()
	probeCrew()
	setTimeout(() => map.invalidateSize(), 60)

	// auto-locate: resume if the user had it on, or if permission is already granted
	if (state.locatePref === true) startLocate(true)
	else if (state.locatePref !== false && navigator.permissions?.query) {
		navigator.permissions
			.query({ name: 'geolocation' })
			.then((p) => {
				if (p.state === 'granted') startLocate(true)
			})
			.catch(() => {})
	}
}

// popups show description + what's on now / coming up at stages, and a
// "Guide me" button that points the compass at this place.
function poiPopup(p) {
	const emoji = p.emoji || POI_CATS[p.cat]?.emoji || '📍'
	const wrap = el('div', {}, el('b', {}, p.name))
	if (p.desc) wrap.append(el('div', { class: 'pop-desc' }, p.desc))
	if (p.cat === 'stage' && p.stage) {
		const now = Date.now()
		const stageSets = SETS.filter((s) => s.stage.id === p.stage)
		const live = stageSets.find((s) => setStatus(s, now) === 'live')
		const upcoming = stageSets.filter((s) => s.startMs && s.startMs > now).slice(0, live ? 2 : 3)
		if (live)
			wrap.append(el('div', { class: 'pop-now' }, `▶ NOW: ${live.artist} · until ${fmtTime(live.end)}`))
		if (upcoming.length) {
			const ev = el('div', { class: 'pop-events' }, el('div', { class: 'pop-ev-h' }, live ? 'Next up' : 'Coming up'))
			for (const s of upcoming)
				ev.append(
					el(
						'div',
						{ class: 'pop-ev' },
						el('span', { class: 'pe-a' }, s.artist),
						el('span', { class: 'pe-t' }, `${fmtTime(s.start)} · ${untilLabel(s.startMs, now)}`),
					),
				)
			wrap.append(ev)
		}
		if (!live && !upcoming.length) wrap.append(el('div', { class: 'pop-next' }, 'no more sets here — 🌈'))
	}
	const guide = el('button', { class: 'pop-btn pop-guide' }, '🧭 Guide me')
	guide.addEventListener('click', () => {
		map?.closePopup()
		openCompass({ name: p.name, emoji, lat: p.lat, lon: p.lon })
	})
	wrap.append(el('div', { class: 'pop-actions' }, guide))
	return wrap
}

let radarOn = false
let routeOn = true

function renderPoiChips() {
	const wrap = $('#poiChips')
	const radarChip = el(
		'button',
		{ class: 'chip' + (radarOn ? ' active' : ''), style: '--chip-c:#7fd4ff' },
		'🌧️ Radar',
	)
	radarChip.addEventListener('click', () => {
		radarOn = !radarOn
		radarOn ? showRadar() : hideRadar()
		renderPoiChips()
	})
	const routeChip = el(
		'button',
		{ class: 'chip' + (routeOn ? ' active' : ''), style: '--chip-c:#ffe66d' },
		'➤ My route',
	)
	routeChip.addEventListener('click', () => {
		routeOn = !routeOn
		drawRoute()
		renderPoiChips()
	})
	const tracksChip = el(
		'button',
		{ class: 'chip' + (tracksOn ? ' active' : ''), style: '--chip-c:#7ff0e0' },
		'🐾 Tracks',
	)
	tracksChip.addEventListener('click', () => {
		tracksOn = !tracksOn
		drawTracks()
		renderPoiChips()
	})
	const extraChips = []
	if (crewAvailable) {
		const c = el(
			'button',
			{ class: 'chip' + (crew ? ' active' : ''), style: '--chip-c:#3ddc97' },
			crew ? `👥 ${crew.code}` : '👥 Crew',
		)
		c.addEventListener('click', crewTap)
		extraChips.push(c)
	}
	wrap.replaceChildren(
		...extraChips,
		radarChip,
		routeChip,
		tracksChip,
		...Object.entries(POI_CATS).map(([id, def]) => {
			const c = el(
				'button',
				{ class: 'chip' + (def.on ? ' active' : ''), style: `--chip-c:${def.color}` },
				def.emoji + ' ' + def.label,
			)
			c.addEventListener('click', () => {
				def.on = !def.on
				if (map) (def.on ? catLayers[id].addTo(map) : catLayers[id].remove())
				renderPoiChips()
			})
			return c
		}),
	)
}

// — crew location sharing (only appears if the roo26-api backend is bound) —
let crewAvailable = false
let crew = store.get('crew', null) // {code, name}
let crewLayer = null
let crewTimer = null
let crewProbed = false

// probe the backend the first time the map opens (not on every page load)
function probeCrew() {
	if (crewProbed) return
	crewProbed = true
	fetch('/roo26-api/health')
		.then((r) => r.json())
		.then((h) => {
			crewAvailable = !!h.ok
			if (crewAvailable) renderPoiChips()
			if (crewAvailable && crew) startCrew()
		})
		.catch(() => {})
}

async function crewTap() {
	if (crew) {
		if (confirm(`Crew ${crew.code} — share this code with friends.\n\nLeave the crew?`)) {
			stopCrew()
			crew = null
			store.set('crew', null)
			renderPoiChips()
		}
		return
	}
	const join = prompt("Join a crew: enter its 6-letter code.\nOr leave empty to create a new crew.")
	if (join === null) return
	let code = join.trim().toUpperCase()
	if (code && !/^[A-Z0-9]{6}$/.test(code)) return toast('Codes are 6 letters/numbers')
	if (!code) {
		try {
			code = (await (await fetch('/roo26-api/crew', { method: 'POST' })).json()).code
		} catch {
			return toast('Could not create a crew — no signal?')
		}
	}
	const name = (prompt('Your name (shown to your crew):', store.get('myname', '')) || '').trim()
	if (!name) return
	store.set('myname', name)
	crew = { code, name }
	store.set('crew', crew)
	toast(`👥 In crew ${code} — share the code!`)
	renderPoiChips()
	startCrew()
}

function startCrew() {
	stopCrew()
	if (!map) return
	crewLayer = L.layerGroup().addTo(map)
	const tick = async () => {
		if (!crew) return
		try {
			const opts = state.pos
				? {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ name: crew.name, lat: state.pos.lat, lon: state.pos.lon, emoji: '🧑' }),
					}
				: {}
			const res = await (await fetch(`/roo26-api/crew/${crew.code}`, opts)).json()
			crewLayer.clearLayers()
			for (const mb of res.members || []) {
				if (mb.name === crew.name) continue
				const stale = Date.now() - mb.at > 90e3
				L.marker([mb.lat, mb.lon], {
					icon: L.divIcon({
						className: '',
						html: `<div class="crew-dot${stale ? ' stale' : ''}">${mb.emoji || '🧑'}</div>`,
						iconSize: [28, 28],
						iconAnchor: [14, 14],
					}),
				})
					.bindTooltip(mb.name, { permanent: true, direction: 'bottom', offset: [0, 14], className: 'poi-lbl' })
					.addTo(crewLayer)
			}
		} catch {}
	}
	tick()
	crewTimer = setInterval(tick, 25e3)
}

function stopCrew() {
	clearInterval(crewTimer)
	crewTimer = null
	if (crewLayer) {
		crewLayer.remove()
		crewLayer = null
	}
}

// — live precipitation radar (RainViewer free tiles) —
let radarLayer = null
let radarTimer = null

async function showRadar() {
	if (!map) return
	try {
		const meta = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json()
		const frames = meta?.radar?.past
		if (!frames?.length) throw new Error('no frames')
		const path = frames.at(-1).path
		if (radarLayer) radarLayer.remove()
		radarLayer = L.tileLayer(`${meta.host}${path}/256/{z}/{x}/{y}/2/1_1.png`, {
			opacity: 0.62,
			maxZoom: 19,
		}).addTo(map)
		clearInterval(radarTimer)
		radarTimer = setInterval(() => radarOn && showRadar(), 5 * 60e3)
	} catch {
		toast('Radar unavailable right now')
		radarOn = false
		renderPoiChips()
	}
}

function hideRadar() {
	clearInterval(radarTimer)
	radarTimer = null
	if (radarLayer) {
		radarLayer.remove()
		radarLayer = null
	}
}

// — your trail: everywhere you've been, from the trip log —
let tracksOn = false
let tracksLayer = null

function drawTracks() {
	if (!map) return
	if (tracksLayer) {
		tracksLayer.remove()
		tracksLayer = null
	}
	if (!tracksOn) return
	if (track.length < 2) return toast('No trail yet — wander with 📍 on')
	const step = Math.max(1, Math.ceil(track.length / 1500))
	// break the trail where there are big time gaps (app closed, overnight)
	const segs = []
	let seg = []
	for (let i = 0; i < track.length; i += step) {
		const p = track[i]
		if (seg.length && p[0] - seg.at(-1)[0] > 1800) {
			if (seg.length > 1) segs.push(seg)
			seg = []
		}
		seg.push(p)
	}
	if (seg.length > 1) segs.push(seg)
	tracksLayer = L.layerGroup().addTo(map)
	for (const s of segs)
		L.polyline(
			s.map((p) => [p[1], p[2]]),
			{ color: '#7ff0e0', weight: 2.5, opacity: 0.7 },
		).addTo(tracksLayer)
}

// — today's route: arrows through your ★ going sets, in time order —
let routeLayer = null

function bearing(a, b) {
	const φ1 = (a.lat * Math.PI) / 180
	const φ2 = (b.lat * Math.PI) / 180
	const Δλ = ((b.lon - a.lon) * Math.PI) / 180
	const y = Math.sin(Δλ) * Math.cos(φ2)
	const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// accumulate a continuous rotation so a CSS-transitioned arrow takes the SHORT
// way across the 0°/360° seam (e.g. 359°→2° nudges +3°, not −357°)
function shortRotate(prev, target) {
	const delta = (((target - prev) % 360) + 540) % 360 - 180
	return prev + delta
}

function drawRoute() {
	if (!map || !routeLayer) return
	routeLayer.clearLayers()
	if (!routeOn) return
	const today = currentFestDay() || state.day
	const going = SETS.filter(
		(s) => s.day === today && favTier(s.id) === 2 && s.startMs && STAGE_POI[s.stage.id],
	)
	// collapse consecutive sets at the same stage into single waypoints
	const pts = []
	for (const s of going) {
		const poi = STAGE_POI[s.stage.id]
		if (!pts.length || pts.at(-1).stage !== s.stage.id)
			pts.push({ stage: s.stage.id, lat: poi.lat, lon: poi.lon, t: s.start })
	}
	if (pts.length < 2) return
	L.polyline(
		pts.map((p) => [p.lat, p.lon]),
		{ color: '#ffe66d', weight: 3, opacity: 0.85, dashArray: '7 9' },
	).addTo(routeLayer)
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i]
		const b = pts[i + 1]
		const mid = [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2]
		L.marker(mid, {
			interactive: false,
			icon: L.divIcon({
				className: '',
				html: `<div class="route-arrow" style="transform:rotate(${bearing(a, b) - 90}deg)">➤</div>`,
				iconSize: [22, 22],
				iconAnchor: [11, 11],
			}),
		}).addTo(routeLayer)
		L.marker([b.lat, b.lon], {
			interactive: false,
			icon: L.divIcon({
				className: '',
				html: `<div class="route-step">${i + 2}<span>${fmtTime(b.t)}</span></div>`,
				iconSize: [0, 0],
				iconAnchor: [-16, 10],
			}),
		}).addTo(routeLayer)
	}
}

// — custom pins: mark your camp, friends' camps, meetup spots —
const PIN_EMOJIS = ['⛺', '🏕️', '🚐', '🍻', '🔥', '⭐', '🪩', '🦄', '🍄', '💀', '🎈', '🚩']
let pinEmoji = '⛺'

function openPinSheet() {
	$('#pinName').value = ''
	pinEmoji = '⛺'
	renderPinEmojis()
	$('#pinSheetWrap').hidden = false
}

function renderPinEmojis() {
	$('#pinEmojis').replaceChildren(
		...PIN_EMOJIS.map((e) => {
			const b = el('button', { class: 'pin-emoji' + (e === pinEmoji ? ' active' : '') }, e)
			b.addEventListener('click', () => {
				pinEmoji = e
				renderPinEmojis()
			})
			return b
		}),
	)
}

$('#fabPin').addEventListener('click', () => {
	if (!map) return toast('Wait for the map to load first')
	openPinSheet()
})
$('#pinSheetWrap').addEventListener('click', (e) => {
	if (e.target.id === 'pinSheetWrap') $('#pinSheetWrap').hidden = true
})
$('#pinCancel').addEventListener('click', () => ($('#pinSheetWrap').hidden = true))
$('#pinPlace').addEventListener('click', () => {
	state.placing = { emoji: pinEmoji, name: $('#pinName').value.trim() || 'My camp' }
	$('#pinSheetWrap').hidden = true
	$('#tentBanner').textContent = `Tap the map to place ${state.placing.emoji} ${state.placing.name}`
	$('#tentBanner').hidden = false
})
$('#pinHere').addEventListener('click', () => {
	if (!state.pos) return toast('Turn on 📍 location first')
	state.placing = { emoji: pinEmoji, name: $('#pinName').value.trim() || 'My camp' }
	$('#pinSheetWrap').hidden = true
	placePin(state.pos.lat, state.pos.lon)
})

function placePin(lat, lon) {
	const pin = {
		id: 'pin-' + Date.now(),
		emoji: state.placing.emoji,
		name: state.placing.name,
		lat,
		lon,
	}
	state.pins.push(pin)
	savePins()
	state.placing = null
	$('#tentBanner').hidden = true
	drawPins()
	toast(`${pin.emoji} ${pin.name} saved`)
	renderNearest()
}

function drawPins() {
	if (!map || !pinLayer) return
	pinLayer.clearLayers()
	for (const pin of state.pins) {
		// pins are locked by default — panning/zooming was nudging them around.
		// Moving requires an explicit "Move" from the pin's popup.
		const m = L.marker([pin.lat, pin.lon], {
			draggable: false,
			icon: L.divIcon({
				className: '',
				html: `<div class="camp-pin">${pin.emoji}</div>`,
				iconSize: [34, 34],
				iconAnchor: [17, 28],
			}),
		}).addTo(pinLayer)
		m.bindTooltip(pin.name, {
			permanent: true,
			direction: 'bottom',
			offset: [0, 8],
			className: 'poi-lbl',
		})
		m.bindPopup(() => {
			const move = el('button', { class: 'pop-btn' }, 'Move')
			move.addEventListener('click', () => {
				m.closePopup()
				m.dragging.enable()
				toast(`Drag ${pin.name} to its new spot — it locks when you drop it`)
			})
			const rename = el('button', { class: 'pop-btn' }, 'Rename')
			rename.addEventListener('click', () => {
				const name = prompt('Pin name:', pin.name)
				if (name?.trim()) {
					pin.name = name.trim()
					savePins()
					drawPins()
					renderNearest()
				}
			})
			const rm = el('button', { class: 'pop-btn pop-btn-danger' }, 'Remove')
			rm.addEventListener('click', () => {
				state.pins = state.pins.filter((p) => p.id !== pin.id)
				savePins()
				drawPins()
				toast(`${pin.emoji} ${pin.name} removed`)
				renderNearest()
			})
			const guide = el('button', { class: 'pop-btn pop-guide' }, '🧭 Guide me')
			guide.addEventListener('click', () => {
				m.closePopup()
				openCompass({ name: pin.name, emoji: pin.emoji, lat: pin.lat, lon: pin.lon })
			})
			return el(
				'div',
				{},
				el('b', {}, `${pin.emoji} ${pin.name}`),
				el('div', { class: 'pop-actions' }, guide),
				el('div', { class: 'pop-actions' }, move, ' ', rename, ' ', rm),
			)
		})
		m.on('dragend', () => {
			const ll = m.getLatLng()
			pin.lat = ll.lat
			pin.lon = ll.lng
			savePins()
			renderNearest()
			m.dragging.disable()
			toast(`${pin.emoji} ${pin.name} locked in`)
		})
	}
}

// — geolocation: sticky, self-healing —
function haversine(a, b) {
	const R = 6371000
	const dLat = ((b.lat - a.lat) * Math.PI) / 180
	const dLon = ((b.lon - a.lon) * Math.PI) / 180
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
	return 2 * R * Math.asin(Math.sqrt(s))
}

const fmtDist = (m) =>
	m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1609.34).toFixed(1)} mi`
const fmtWalk = (m) => {
	const min = Math.max(1, Math.round(m / 80)) // ~3 mph festival shuffle
	return min > 90 ? '' : `~${min} min walk`
}

function startLocate(auto = false) {
	if (!('geolocation' in navigator)) return toast('No location support on this device')
	if (watchId != null) return
	clearTimeout(retryTimer)
	$('#fabLocate').classList.add('on')
	if (!auto) {
		store.set('locate', true)
		state.locatePref = true
		// a real tap is our chance to ask iOS for compass-heading permission,
		// so the on-map "you" arrow can show which way you're facing
		requestOrientationPerm().then(startOrientation)
	} else {
		startOrientation()
	}
	let hadFix = !!state.pos
	watchId = navigator.geolocation.watchPosition(
		(p) => {
			const first = !hadFix
			hadFix = true
			state.pos = {
				lat: p.coords.latitude,
				lon: p.coords.longitude,
				acc: p.coords.accuracy,
				at: Date.now(),
			}
			drawUser()
			renderNearest()
			checkQuests()
			logTrack()
			if (first) {
				const far = haversine(state.pos, { lat: POIS.center[0], lon: POIS.center[1] })
				if (far < 30000) map?.flyTo([state.pos.lat, state.pos.lon], Math.max(map.getZoom(), 16))
				else toast(`You're ${fmtDist(far)} from the Farm — map stays put`)
			}
		},
		(err) => {
			if (err.code === 1) {
				// permission denied — a retry loop would just nag
				stopLocate(true)
				toast('Location permission denied — enable it in browser settings')
				return
			}
			// signal lost / timeout: keep the last fix, mark it stale, quietly retry
			if (watchId != null) navigator.geolocation.clearWatch(watchId)
			watchId = null
			userMarker?.getElement()?.querySelector('.user-dot')?.classList.add('stale')
			retryTimer = setTimeout(() => startLocate(true), 8000)
		},
		{ enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
	)
}

function stopLocate(silent = false) {
	clearTimeout(retryTimer)
	if (watchId != null) navigator.geolocation.clearWatch(watchId)
	watchId = null
	state.pos = null
	$('#fabLocate').classList.remove('on')
	if (!silent) {
		store.set('locate', false)
		state.locatePref = false
	}
	if (userMarker) {
		userMarker.remove()
		userMarker = null
	}
	if (userCircle) {
		userCircle.remove()
		userCircle = null
	}
	renderNearest()
}

$('#fabLocate').addEventListener('click', () => (watchId == null ? startLocate() : stopLocate()))

// if the tab was backgrounded (screen off in a pocket), re-arm the watch
document.addEventListener('visibilitychange', () => {
	if (!document.hidden) {
		refreshStatuses()
		if (map && state.locatePref === true && watchId == null) startLocate(true)
	}
})

function drawUser() {
	if (!map || !state.pos) return
	const ll = [state.pos.lat, state.pos.lon]
	if (!userMarker) {
		userHeadCont = 0 // fresh element starts at 0deg; keep the accumulator in sync
		userMarker = L.marker(ll, {
			icon: L.divIcon({
				className: '',
				html: '<div class="user-dot"><div class="user-head"></div></div>',
				iconSize: [18, 18],
				iconAnchor: [9, 9],
			}),
			zIndexOffset: 1000,
		}).addTo(map)
		userCircle = L.circle(ll, {
			radius: state.pos.acc,
			color: '#46b3ff',
			weight: 1,
			fillOpacity: 0.12,
		}).addTo(map)
	} else {
		userMarker.setLatLng(ll)
		userCircle.setLatLng(ll).setRadius(state.pos.acc)
	}
	userMarker.getElement()?.querySelector('.user-dot')?.classList.remove('stale')
	paintUserHeading()
}

// rotate the little arrow on the "you" dot to the way you're facing
let userHeadCont = 0
function paintUserHeading() {
	const head = userMarker?.getElement()?.querySelector('.user-head')
	if (!head) return
	if (deviceHeading == null) {
		head.style.opacity = '0'
		return
	}
	head.style.opacity = '1'
	userHeadCont = shortRotate(userHeadCont, deviceHeading)
	head.style.transform = `rotate(${userHeadCont}deg)`
}

function renderNearest() {
	const hint = $('#nearestHint')
	const list = $('#nearestList')
	if (!state.pos) {
		hint.hidden = false
		list.replaceChildren()
		return
	}
	hint.hidden = true
	const targets = [
		...state.pins.map((p) => ({ name: p.name, emoji: p.emoji, lat: p.lat, lon: p.lon })),
		...POIS.pois.filter((p) => ['stage', 'water', 'medical'].includes(p.cat)),
	]
	const rows = targets
		.map((t) => ({ ...t, dist: haversine(state.pos, t) }))
		.sort((a, b) => a.dist - b.dist)
		.slice(0, 9)
	list.replaceChildren(
		...rows.map((r) => {
			const row = el(
				'div',
				{ class: 'near-row', role: 'button', tabindex: '0' },
				el('span', { class: 'near-ico' }, r.emoji || POI_CATS[r.cat]?.emoji || '📍'),
				el('span', { class: 'near-name' }, r.name),
				el('span', { class: 'near-dist' }, fmtDist(r.dist)),
				el('span', { class: 'near-walk' }, fmtWalk(r.dist)),
			)
			const go = () => focusPlace(r)
			row.addEventListener('click', go)
			row.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') go()
			})
			return row
		}),
	)
}

// fly to a place and drop a brief arrow + line from you to it, so tapping a
// row in the nearest list actually shows you where it is on the map
let focusLayer = null
let focusTimer = null
function focusPlace(t) {
	if (!map) return
	map.flyTo([t.lat, t.lon], Math.max(map.getZoom(), 17))
	if (focusLayer) focusLayer.remove()
	clearTimeout(focusTimer)
	focusLayer = L.layerGroup().addTo(map)
	L.marker([t.lat, t.lon], {
		interactive: false,
		zIndexOffset: 1600,
		icon: L.divIcon({
			className: '',
			html: `<div class="focus-ping">${t.emoji || POI_CATS[t.cat]?.emoji || '📍'}</div>`,
			iconSize: [38, 38],
			iconAnchor: [19, 34],
		}),
	}).addTo(focusLayer)
	if (state.pos)
		L.polyline(
			[
				[state.pos.lat, state.pos.lon],
				[t.lat, t.lon],
			],
			{ color: '#fff', weight: 2.5, opacity: 0.75, dashArray: '5 8' },
		).addTo(focusLayer)
	focusTimer = setTimeout(() => {
		if (focusLayer) {
			focusLayer.remove()
			focusLayer = null
		}
	}, 7000)
}

// — device heading: one shared listener drives both the on-map "you" arrow and
//   the full-screen guide compass. iOS needs a permission gesture first. —
let deviceHeading = null
let orientStarted = false
function startOrientation() {
	if (orientStarted) return
	orientStarted = true
	const onOrient = (e) => {
		const v = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null)
		if (v == null) return
		deviceHeading = v
		paintUserHeading()
		if (!$('#compassWrap').hidden) paintCompass()
	}
	window.addEventListener('deviceorientationabsolute', onOrient)
	window.addEventListener('deviceorientation', onOrient)
}
async function requestOrientationPerm() {
	try {
		if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission)
			await DeviceOrientationEvent.requestPermission()
	} catch {}
}

// — guide compass: point at any saved pin OR any place you tapped, 2 AM-proof —
let compassTarget = 0
let compassFocus = null // an arbitrary tapped place: {name, emoji, lat, lon} | null
let compassArrowCont = 0 // continuous accumulated rotation (no 0/360 wrap spin)

// what the compass can point at: the focused place (if any) first, then pins
function compassTargets() {
	const pins = state.pins.map((p) => ({ name: p.name, emoji: p.emoji, lat: p.lat, lon: p.lon }))
	return compassFocus ? [compassFocus, ...pins] : pins
}

// focus is a {name,emoji,lat,lon} place to guide to; omitted (e.g. the 🧭 FAB)
// = pure take-me-home mode through your pins.
async function openCompass(focus = null) {
	compassFocus = focus && typeof focus.lat === 'number' && typeof focus.lon === 'number' ? focus : null
	const targets = compassTargets()
	if (!targets.length) {
		toast('Tap a place on the map (or drop a ⛺ pin) to guide there')
		return
	}
	compassTarget = 0
	$('#compassWrap').hidden = false
	document.body.style.overflow = 'hidden'
	if (watchId == null) startLocate(true)
	await requestOrientationPerm()
	startOrientation()
	paintCompass()
	if (compassTimer) clearInterval(compassTimer)
	compassTimer = setInterval(paintCompass, 1000)
}

let compassTimer = null

function paintCompass() {
	const targets = compassTargets()
	const t = targets[compassTarget % targets.length]
	if (!t) return closeCompass()
	const heading = deviceHeading
	$('#compassName').textContent = `${t.emoji || '📍'} ${t.name}`
	const cycle = $('#compassCycle')
	cycle.hidden = targets.length < 2
	cycle.textContent = `${(compassTarget % targets.length) + 1}/${targets.length} · tap to switch ▾`
	if (!state.pos) {
		$('#compassDist').textContent = 'finding you…'
		$('#compassArrow').style.transform = ''
		compassArrowCont = 0 // keep accumulator in sync with the reset element
		return
	}
	const dist = haversine(state.pos, t)
	$('#compassDist').textContent = `${fmtDist(dist)} · ${fmtWalk(dist) || 'far'}`
	const brg = bearing(state.pos, t)
	const rot = heading == null ? brg : brg - heading
	compassArrowCont = shortRotate(compassArrowCont, rot)
	$('#compassArrow').style.transform = `rotate(${compassArrowCont}deg)`
	$('#compassHint').textContent =
		heading == null ? 'arrow points relative to north — hold phone flat' : 'follow the arrow'
	const age = Math.round((Date.now() - state.pos.at) / 1000)
	$('#compassAge').textContent = age > 20 ? `last fix ${age}s ago` : ''
}

function cycleCompass() {
	const n = compassTargets().length
	if (n > 1) {
		compassTarget = (compassTarget + 1) % n
		paintCompass()
	}
}

function closeCompass() {
	$('#compassWrap').hidden = true
	document.body.style.overflow = ''
	clearInterval(compassTimer)
	compassTimer = null
	// leave the orientation listener running — it also drives the on-map arrow
}

$('#fabHome').addEventListener('click', () => openCompass())
$('#compassClose').addEventListener('click', closeCompass)
$('#compassName').addEventListener('click', cycleCompass)
$('#compassCycle').addEventListener('click', cycleCompass)

// — official map viewer (pinch-zoom over the official festival map images) —
const OMAPS = {
	centeroo: {
		src: '/roo26-map-centeroo.webp',
		w: 3200,
		h: 2005,
		note: 'Heads up: the official Centeroo map is printed SOUTH-UP — north is down.',
	},
	outeroo: {
		src: '/roo26-map-outeroo.webp',
		w: 3200,
		h: 2038,
		note: 'Campgrounds, Plazas 1–9, tolls and day parking.',
	},
}
let omap = null
let omapOverlay = null

async function openOmap(which = 'centeroo') {
	questFlag('omap')
	$('#omapWrap').hidden = false
	document.body.style.overflow = 'hidden'
	try {
		await loadLeaflet()
	} catch {
		toast('Could not load the viewer')
		return
	}
	const def = OMAPS[which]
	const bounds = [
		[0, 0],
		[def.h, def.w],
	]
	if (!omap) {
		omap = L.map('omapMap', {
			crs: L.CRS.Simple,
			minZoom: -3,
			maxZoom: 2,
			zoomControl: false,
			attributionControl: false,
		})
	}
	if (omapOverlay) omapOverlay.remove()
	omapOverlay = L.imageOverlay(def.src, bounds).addTo(omap)
	omap.setMaxBounds(L.latLngBounds(bounds).pad(0.2))
	omap.fitBounds(bounds)
	$('#omapNote').textContent = def.note
	$$('#omapTabs button').forEach((b) => b.classList.toggle('active', b.dataset.omap === which))
	setTimeout(() => omap.invalidateSize(), 60)
}

$('#fabOmap').addEventListener('click', () => openOmap('centeroo'))
$('#omapClose').addEventListener('click', () => {
	$('#omapWrap').hidden = true
	document.body.style.overflow = ''
})
$$('#omapTabs button').forEach((b) => b.addEventListener('click', () => openOmap(b.dataset.omap)))

// ───────────────────────── weather + alerts ─────────────────────────
const WX_POINT = `${POIS.center[0].toFixed(4)},${POIS.center[1].toFixed(4)}`
// full NWS forecast for the Farm — each weather card links here (new tab)
const WX_REPORT_URL = `https://forecast.weather.gov/MapClick.php?lat=${POIS.center[0]}&lon=${POIS.center[1]}`
let weatherLoaded = false

async function loadWeather() {
	if (weatherLoaded) return
	const box = $('#weatherDays')
	try {
		const cached = JSON.parse(sessionStorage.getItem('roo26:wx') || 'null')
		if (cached && Date.now() - cached.at < 30 * 60e3) {
			weatherLoaded = true
			return renderWeather(cached.periods, 'NWS live')
		}
		const pt = await (await fetch(`https://api.weather.gov/points/${WX_POINT}`)).json()
		const fc = await (await fetch(pt.properties.forecast)).json()
		const periods = fc.properties.periods.slice(0, 8).map((p) => ({
			name: p.name,
			temp: p.temperature + '°' + p.temperatureUnit,
			short: p.shortForecast,
			rain: p.probabilityOfPrecipitation?.value ?? null,
		}))
		sessionStorage.setItem('roo26:wx', JSON.stringify({ at: Date.now(), periods }))
		weatherLoaded = true // only latch success, so a failed first load retries when you revisit
		renderWeather(periods, 'NWS live')
	} catch {
		if (window.ROO_WX_FALLBACK) renderWeather(window.ROO_WX_FALLBACK, 'cached forecast')
		else box.textContent = 'Forecast unavailable offline — check the NWS app.'
	}
}

function renderWeather(periods, src) {
	$('#weatherSrc').textContent = src
	$('#weatherDays').replaceChildren(
		...periods.map((p) =>
			el(
				'a',
				{ class: 'wx-day', href: WX_REPORT_URL, target: '_blank', rel: 'noopener', title: 'Open the full NWS forecast' },
				el('div', { class: 'wx-n' }, p.name, el('span', { class: 'wx-ext' }, ' ↗')),
				el('div', { class: 'wx-t' }, p.temp),
				el('div', { class: 'wx-d' }, p.short),
				// always render the rain row (blank when dry) so every card is the same size
				el('div', { class: 'wx-r' }, p.rain != null && p.rain > 0 ? `💧 ${p.rain}% rain` : ''),
			),
		),
	)
}

// active NWS alerts (storms!) — banner above everything, dismissible per-alert
async function loadAlerts() {
	try {
		const res = await (await fetch(`https://api.weather.gov/alerts/active?point=${WX_POINT}`)).json()
		const dismissed = new Set(JSON.parse(sessionStorage.getItem('roo26:wxdismiss') || '[]'))
		const alerts = (res.features || [])
			.map((f) => f.properties)
			.filter((p) => ['Severe', 'Extreme', 'Moderate'].includes(p.severity) && !dismissed.has(p.id))
		const bar = $('#wxAlert')
		if (!alerts.length) {
			bar.hidden = true
			return
		}
		const a = alerts[0]
		$('#wxAlertText').textContent = `⚠️ ${a.event}${a.headline ? ' — ' + a.headline : ''}`
		bar.hidden = false
		$('#wxAlertClose').onclick = () => {
			dismissed.add(a.id)
			sessionStorage.setItem('roo26:wxdismiss', JSON.stringify([...dismissed]))
			bar.hidden = true
			loadAlerts()
		}
	} catch {}
}

// ───────────────────────── trip tracking ─────────────────────────
// Every fix (while 📍 is on) feeds a local-only trip log: raw points for the
// map trail + per-day/per-hour distance aggregates that survive point thinning.
let track = store.get('track', [])
let trackAgg = store.get('trackagg', {})
let lastLog = track.length
	? { t: track.at(-1)[0] * 1000, lat: track.at(-1)[1], lon: track.at(-1)[2] }
	: null

const localDate = (ms) => new Date(ms - 5 * 3600e3) // festival clock (CDT)
const locTime = (ms) => {
	const d = localDate(ms)
	const h = d.getUTCHours()
	return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

function logTrack() {
	if (!state.pos) return
	const { lat, lon } = state.pos
	const now = Date.now()
	if (lastLog) {
		const d = haversine(lastLog, { lat, lon })
		const dt = now - lastLog.t
		if (dt < 20e3 && d < 15) return // too soon and barely moved
		if (d >= 8 && d < 400) {
			// credit walking distance; ignore GPS teleports
			const local = localDate(now)
			const key = local.toISOString().slice(0, 10)
			const agg = (trackAgg[key] ??= { dist: 0, hours: {}, first: now, last: now })
			agg.dist += d
			const h = local.getUTCHours()
			agg.hours[h] = (agg.hours[h] || 0) + d
			agg.last = now
		} else if (d < 8) {
			lastLog.t = now // standing still: don't spam points
			return
		}
	}
	lastLog = { t: now, lat, lon }
	track.push([Math.round(now / 1000), +lat.toFixed(5), +lon.toFixed(5)])
	// keep storage bounded: thin old points, keep recent ones dense
	if (track.length > 15000) track = track.filter((_, i) => i % 2 === 0 || i > track.length - 2000)
	// persist at most every ~20s — serializing the whole array on every fix
	// janks low-end phones over a long day (we still keep it all in memory)
	if (now - lastTrackSave > 20e3) {
		lastTrackSave = now
		store.set('track', track)
		store.set('trackagg', trackAgg)
	}
}
let lastTrackSave = 0
// flush the trail to storage when the app is backgrounded/closed so nothing's lost
addEventListener('visibilitychange', () => {
	if (document.hidden && track.length) {
		store.set('track', track)
		store.set('trackagg', trackAgg)
	}
})

function renderTrip() {
	const body = $('#tripBody')
	const days = Object.entries(trackAgg).sort()
	if (!days.length) {
		body.replaceChildren(
			el(
				'div',
				{ class: 'empty-note' },
				'No trip data yet — turn on 📍 on the map and go wander. Your trail is logged only on this phone, never uploaded.',
			),
		)
		return
	}
	const total = days.reduce((a, [, v]) => a + v.dist, 0)
	const activeHours = days.reduce(
		(a, [, v]) => a + Object.values(v.hours).filter((m) => m > 150).length,
		0,
	)
	const stat = (n, l) => el('div', { class: 'trip-stat' }, el('b', {}, n), el('span', {}, l))
	const frag = document.createDocumentFragment()
	frag.append(
		el(
			'div',
			{ class: 'trip-stats' },
			stat((total / 1609.34).toFixed(1) + ' mi', 'walked'),
			stat(Math.round(total / 0.762).toLocaleString(), 'est. steps'),
			stat(activeHours + ' h', 'on the move'),
			stat(track.length.toLocaleString(), 'GPS points'),
		),
	)
	for (const [key, v] of days) {
		const dayName = SCHED.days.find((d) => d.date === key)?.full || key
		frag.append(el('div', { class: 'plan-day-h' }, dayName.toUpperCase()))
		frag.append(
			el(
				'div',
				{ class: 'trip-day-meta' },
				`${(v.dist / 1609.34).toFixed(1)} mi · ~${Math.round(v.dist / 0.762).toLocaleString()} steps · out ${locTime(v.first)} → ${locTime(v.last)}`,
			),
		)
		const max = Math.max(...Object.values(v.hours), 1)
		const bars = el('div', { class: 'trip-bars' })
		for (let h = 0; h < 24; h++) {
			const m = v.hours[h] || 0
			bars.append(
				el('div', {
					class: 'trip-bar' + (m === max && m > 0 ? ' peak' : ''),
					title: `${h % 12 || 12}${h >= 12 ? 'PM' : 'AM'} — ${Math.round(m)} m`,
					style: `height:${m ? Math.max(7, (m / max) * 100) : 4}%`,
				}),
			)
		}
		frag.append(
			bars,
			el(
				'div',
				{ class: 'trip-axis' },
				el('span', {}, '12a'),
				el('span', {}, '6a'),
				el('span', {}, '12p'),
				el('span', {}, '6p'),
				el('span', {}, '11p'),
			),
		)
	}
	frag.append(
		el(
			'div',
			{ class: 'trip-foot' },
			'Toggle 🐾 Tracks on the map to see your trail. Data lives only in this browser. ',
			el(
				'button',
				{
					class: 'tool-btn tool-danger',
					onclick: () => {
						if (!confirm('Delete all trip data?')) return
						track = []
						trackAgg = {}
						lastLog = null
						store.set('track', track)
						store.set('trackagg', trackAgg)
						renderTrip()
					},
				},
				'Clear trip data',
			),
		),
	)
	body.replaceChildren(frag)
}

// ───────────────────────── Lil Roo: your festival pet ─────────────────────────
const PET_NAMES = ['Bonnie', 'Roozy', 'Sprocket', 'Mango', 'Disco', 'Pebble', 'Waffle', 'Comet']
let pet = store.get('pet', null)
if (!pet) {
	const seed = Math.random().toString(36).slice(2, 10)
	pet = { seed, name: PET_NAMES[Math.floor(Math.random() * PET_NAMES.length)], water: Date.now() }
	store.set('pet', pet)
}
const savePet = () => store.set('pet', pet)
let petSvg = null

function petMood() {
	const h = (Date.now() - pet.water) / 3600e3
	const liveGoing = SETS.some((s) => favTier(s.id) === 2 && setStatus(s) === 'live')
	if (liveGoing && h < 1.5) return 'party'
	if (h < 1.5) return 'happy'
	if (h < 3) return 'thirsty'
	return 'parched'
}

const MOOD_TEXT = {
	party: 'is raging with you 🎉',
	happy: 'is vibing',
	thirsty: 'is getting thirsty… (so are you)',
	parched: 'is PARCHED. Water, now — both of you!',
}

async function renderPet() {
	const card = $('#petCard')
	if (!card) return
	if (!petSvg) {
		try {
			const [{ createAvatar }, { bigEars }] = await Promise.all([
				import('@dicebear/core'),
				import('@dicebear/collection'),
			])
			petSvg = createAvatar(bigEars, { seed: pet.seed, backgroundColor: [] }).toString()
		} catch {
			petSvg = '<div style="font-size:3rem">🦘</div>'
		}
	}
	const mood = petMood()
	const badges = QUESTS.filter((q) => questDone(q.id)).map((q) => q.e)
	const allDone = badges.length === QUESTS.length
	card.replaceChildren(
		el(
			'div',
			{ class: `pet-box pet-${mood}` },
			Object.assign(el('div', { class: 'pet-svg' }), { innerHTML: petSvg }),
			el(
				'div',
				{ class: 'pet-info' },
				el('button', { class: 'pet-name', onclick: renamePet }, (allDone ? '👑 ' : '') + pet.name),
				el('div', { class: 'pet-mood' }, `${MOOD_TEXT[mood]}`),
				badges.length ? el('div', { class: 'pet-badges' }, badges.join(' ')) : null,
			),
			el('button', { class: 'pet-water', onclick: waterPet }, '💧'),
		),
	)
}

function renamePet() {
	const name = prompt('Name your Roo buddy:', pet.name)
	if (name?.trim()) {
		pet.name = name.trim().slice(0, 20)
		savePet()
		renderPet()
	}
}

function waterPet() {
	pet.water = Date.now()
	savePet()
	renderPet()
	toast(`${pet.name} is hydrated — now drink some water yourself 💧`)
}

// ───────────────────────── Roo Quest: scavenger-hunt tutorial ─────────────────────────
const ARCH = POIS.pois.find((p) => p.name.startsWith('The Arch'))
const FOUNTAIN = POIS.pois.find((p) => p.name === 'Bonnaroo Fountain')

const QUESTS = [
	{ id: 'star3', e: '⭐', t: 'Save 3 sets to your plan', auto: () => Object.keys(state.favs).length >= 3 },
	{ id: 'camp', e: '⛺', t: 'Pin your camp on the map', auto: () => state.pins.length > 0 },
	{ id: 'share', e: '📤', t: 'Share your plan with a friend' },
	{ id: 'omap', e: '📜', t: 'Peek at the official map' },
	{ id: 'fountain', e: '⛲', t: 'Touch the mushroom Fountain', geo: () => FOUNTAIN, r: 75 },
	{ id: 'water', e: '💧', t: 'Refill at a water station', cat: 'water', r: 65 },
	{ id: 'arch', e: '🌈', t: 'High-five someone under the Arch', geo: () => ARCH, r: 75 },
	{ id: 'stages', e: '🎪', t: 'Visit all 6 stages', stages: true },
	{ id: 'sunrise', e: '🌅', t: 'Survive a sunrise set (4–6 AM)', sunrise: true },
]

let quest = store.get('quest', { done: {}, stages: {} })
const saveQuest = () => store.set('quest', quest)
const questDone = (id) => !!quest.done[id]

function questFlag(id) {
	if (questDone(id)) return
	quest.done[id] = Date.now()
	saveQuest()
	const q = QUESTS.find((x) => x.id === id)
	toast(`${q.e} Quest complete: ${q.t}`)
	renderQuest()
	renderPet()
}

function checkQuests() {
	for (const q of QUESTS) {
		if (questDone(q.id)) continue
		if (q.auto && q.auto()) questFlag(q.id)
		if (!state.pos) continue
		if (q.geo) {
			const p = q.geo()
			if (p && haversine(state.pos, p) < q.r) questFlag(q.id)
		}
		if (q.cat) {
			if (POIS.pois.some((p) => p.cat === q.cat && haversine(state.pos, p) < q.r)) questFlag(q.id)
		}
		if (q.stages) {
			for (const [sid, p] of Object.entries(STAGE_POI))
				if (!quest.stages[sid] && haversine(state.pos, p) < 130) {
					quest.stages[sid] = Date.now()
					saveQuest()
					renderQuest()
				}
			if (Object.keys(quest.stages).length >= Object.keys(STAGE_POI).length) questFlag(q.id)
		}
		if (q.sunrise) {
			// 4:00–6:30 AM festival time, near The Other or Where
			const local = new Date(Date.now() - 5 * 3600e3)
			const hr = local.getUTCHours() + local.getUTCMinutes() / 60
			const near = ['other', 'where'].some(
				(sid) => STAGE_POI[sid] && haversine(state.pos, STAGE_POI[sid]) < 260,
			)
			if (hr >= 4 && hr <= 6.5 && near) questFlag(q.id)
		}
	}
}

function renderQuest() {
	const card = $('#questCard')
	if (!card) return
	const done = QUESTS.filter((q) => questDone(q.id)).length
	const rows = QUESTS.map((q) => {
		let hint = ''
		if (!questDone(q.id) && state.pos) {
			const target = q.geo ? q.geo() : q.cat ? POIS.pois.find((p) => p.cat === q.cat) : null
			if (target) hint = fmtDist(haversine(state.pos, target)) + ' away'
			if (q.stages) hint = `${Object.keys(quest.stages).length}/${Object.keys(STAGE_POI).length} stages`
		} else if (q.stages && !questDone(q.id)) {
			hint = `${Object.keys(quest.stages).length}/${Object.keys(STAGE_POI).length} stages`
		}
		return el(
			'div',
			{ class: 'quest-row' + (questDone(q.id) ? ' done' : '') },
			el('span', { class: 'q-check' }, questDone(q.id) ? '✅' : q.e),
			el('span', { class: 'q-label' }, q.t),
			hint ? el('span', { class: 'q-hint' }, hint) : null,
		)
	})
	card.replaceChildren(
		el(
			'div',
			{ class: 'quest-box' },
			el(
				'div',
				{ class: 'quest-head' },
				el('span', {}, '🏆 Roo Quest'),
				el('span', { class: 'quest-count' }, `${done}/${QUESTS.length}`),
			),
			el('div', { class: 'quest-bar' }, el('div', { class: 'quest-fill', style: `width:${(done / QUESTS.length) * 100}%` })),
			...rows,
			done === QUESTS.length
				? el('div', { class: 'quest-won' }, `👑 ${pet.name} is festival royalty. You ARE Bonnaroo.`)
				: el('div', { class: 'quest-tip' }, 'Location quests check automatically while 📍 is on.'),
		),
	)
}

// ───────────────────────── help & install ─────────────────────────
let deferredInstall = null
window.addEventListener('beforeinstallprompt', (e) => {
	e.preventDefault()
	deferredInstall = e
	$('#installBtn').hidden = false
})

$('#installBtn').addEventListener('click', async () => {
	if (!deferredInstall) return
	deferredInstall.prompt()
	await deferredInstall.userChoice
	deferredInstall = null
	$('#installBtn').hidden = true
})

function closeHelp() {
	$('#helpWrap').hidden = true
	document.body.style.overflow = ''
}
$('#helpBtn').addEventListener('click', () => {
	const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone
	$('#iosInstall').hidden = !ios || !!deferredInstall
	$('#helpWrap').hidden = false
	document.body.style.overflow = 'hidden'
})
$('#helpClose').addEventListener('click', closeHelp)
$('#helpWrap').addEventListener('click', (e) => {
	if (e.target.id === 'helpWrap') closeHelp()
})

// ───────────────────────── boot ─────────────────────────
renderDayTabs()
renderStageChips()
renderPoiChips()
renderSched()
renderNowStrip()
renderPill()
renderFavCount()
setTab(state.tab, false)
loadAlerts()
checkImport()
window.addEventListener('hashchange', checkImport)

setInterval(() => {
	refreshStatuses()
	checkQuests()
	if (state.tab === 'info') renderPet()
}, 30e3)
setInterval(loadAlerts, 10 * 60e3)

if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('/roo26-sw.js').catch(() => {})
}
