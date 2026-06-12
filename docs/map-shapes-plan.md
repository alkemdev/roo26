# Map shapes — entrances & exits as areas (plan)

Today every POI on the map is a single point (`pois.json` → one lat/lon, one pin).
Entrances/exits are really **areas and gates** — a single dot under-sells "the Arch
is this whole wide approach." This is the plan to render them as **shapes** (polygons
for areas, lines for gates/paths) without breaking the existing point system.

**Status: not built yet** — this is the design + the recording workflow. The recorder
(`/survey`) is already live so you can start collecting the geometry today.

## 1. How you record them (already shipped)

Open **`https://roo26.alkem.dev/survey`** on your phone, on-site:

1. Set **Category = Entrance** (or whatever the shape is).
2. Tap **"▶ Trace a shape (walk the boundary)."** Name it (e.g. "Main Arch entrance").
3. **Walk the perimeter.** It drops a vertex automatically every ~4 m and shows a live
   dashed outline + vertex count + meters walked. Pause a beat at each corner so the
   fix settles.
4. Tap **"■ Finish shape"** when you've closed the loop (≥3 vertices → polygon; 2 →
   a line, good for a gate or a one-way exit path).
5. Repeat for each entrance/exit. For point POIs, use **"📍 Drop point"** (with 6-sample
   averaging on for ±-meters accuracy).
6. Tap **"Copy GeoJSON"** (or **Download .json**) and send it to me. Everything is stored
   in `localStorage` so you won't lose it if the page reloads.

Output is standard GeoJSON: points become `Point`, traced loops become `Polygon`,
2-point traces become `LineString`. Each carries `{name, cat, note, acc}` properties.

## 2. Data model

Add a sibling to `pois.json`: **`src/pages/roo26/_data/areas.json`** — shapes stay
separate from point POIs so the existing point pipeline is untouched.

```jsonc
{
  "areas": [
    {
      "name": "The Arch (NE entrance)",
      "cat": "entrance",          // reuses POI cats → same filter group (grp)
      "kind": "polygon",          // "polygon" (area) | "line" (gate/path)
      "coords": [[35.470, -86.048], [35.471, -86.047], ...],  // [lat, lon], outer ring
      "emoji": "🚪",
      "desc": "Main pedestrian entrance off Hwy 41.",
      "anchor": [35.4705, -86.0475] // optional: routing/label point; else use centroid
    }
  ]
}
```

- `cat` flows through the same `poiGrp()` mapping, so shapes obey the **same filter
  chips** as points (entrances area + entrance pins toggle together).
- `kind: "line"` renders as a weighted (optionally dashed/arrowed) polyline — good for
  a one-way exit or a gate you pass through, where a filled blob would be wrong.
- `anchor` is the single point used for "Guide me" routing and for placing the label;
  if omitted we compute the polygon centroid.

## 3. Rendering (`_app.js`, in `initMap`)

After the point-marker loop, add a shapes loop:

```js
for (const a of (AREAS.areas || [])) {
  const grp = poiGrp(a)                         // same grouping as points
  const def = POI_CATS[grp] || POI_CATS.landmark
  const shape = a.kind === 'line'
    ? L.polyline(a.coords, { color: def.color, weight: 4, opacity: 0.85 })
    : L.polygon(a.coords, { color: def.color, weight: 2, fillColor: def.color, fillOpacity: 0.14 })
  shape.bindPopup(() => poiPopup(a))            // reuse the same popup as points
  const anchor = a.anchor || polyCentroid(a.coords)
  L.marker(anchor, { icon: labelIcon(a.emoji || def.emoji, a.name) }).addTo(catLayers[grp])
  shape.addTo(catLayers[grp])
}
```

- Reuse the **existing `catLayers[grp]`** so shapes honor the chip on/off + default
  state for free (entrances are an off-by-default chip today).
- Reuse **`poiPopup()`** — `poiPopup` already takes a `{name, emoji, desc, cat}`-shaped
  object, so a shape clicks through to the same sheet a pin does. (It branches on
  `p.cat === 'stage'` for set listings; non-stage shapes just show name/desc/Guide me —
  no change needed there.)
- `poiGrp()` already falls back to `cat`, so no new wiring beyond loading `areas.json`.

Needs two small helpers: `polyCentroid(coords)` (average of ring, fine for convex-ish
festival shapes) and `labelIcon()` (a `divIcon` reusing `.poi-pin`/`.poi-lbl` styles).

## 4. Routing / "Guide me"

`drawRoute()` and the compass already aim at a single lat/lon. Point them at the shape's
`anchor`/centroid — zero special-casing. (Stretch: aim at the **nearest point on the
polygon edge** so "go to the entrance" routes to the closest gate, not the middle.)

## 5. Rollout

1. You record shapes via `/survey`, send me the GeoJSON.
2. I convert GeoJSON → `areas.json` (a 10-line script: `Polygon`→`kind:"polygon"` with
   `[lat,lon]` rings, `LineString`→`kind:"line"`). Keep the existing 8 entrance **points**
   or retire them per-entrance as each gets a shape (a shape can carry its own `anchor`
   pin, so we don't lose the labeled dot).
3. Render behind the existing Entrances chip; verify on `npx wrangler dev`.
4. Same pattern later unlocks **plaza outlines**, the **Centeroo footprint**, and
   **water-line / shade areas** if we want them — all just more `areas.json` rows.

## Open questions for you

- **Which shapes first?** Just the official entrances/exits, or also plaza outlines and
  the Centeroo boundary while you're walking it?
- **Entrance pins:** keep the labeled dot alongside the area, or go shape-only?
- **Lines vs. polygons for exits:** is an exit a gate you cross (line) or a fenced area
  (polygon)? You can do either per-feature in the recorder.
