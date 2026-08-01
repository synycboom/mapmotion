# Mapmotion

Animated map video maker for content creators — browser-based, MapLibre-rendered, exported via WebCodecs. Phase 0 spike: deterministic engine → MapLibre → in-browser video export.

## Structure

- `packages/engine` — pure-TS deterministic animation engine (`sceneAt()`, van Wijk camera flights, easing, great-circle routes, Quick-mode compiler). No DOM imports; runs in Node.
- `apps/web` — Next.js 15 editor + WebCodecs exporter (H.264 → VP9 → VP8 fallback, mp4/webm muxing).

## Develop

```bash
npm install
npm test          # engine unit tests (vitest)
npm run dev       # editor at localhost:3000
npm run build
npm run e2e       # headless export proof (needs Playwright chromium + ffprobe)
```

## Deploy (Vercel)

Import the repo in Vercel and set **Root Directory** to `apps/web` (keep
"Include files outside root directory" enabled so the workspace packages
resolve). No env vars are required — see `apps/web/.env.example` for the
optional ones.

## Analytics

Off unless `NEXT_PUBLIC_POSTHOG_KEY` is set: with no key the app makes no
analytics requests at all, which is what local development, CI and every e2e
suite run with.

Events are posted directly to PostHog's capture endpoint rather than through
their SDK, for one specific reason. This app keeps the whole project in the
URL (`?s=Paris,2.3522,48.8566~…`), so any SDK that captures `$current_url` —
and they all do by default — would ship the user's itinerary and coordinates
as a side effect of counting a page view. Turning that off is a config flag,
and a config flag is one careless upgrade away from flipping back. Posting
ourselves makes it structural: the only things that can leave `analytics.ts`
are an event name and the properties a caller passed in.

What is sent: counts and enum values (`stops: 3`, `format: '9x16'`,
`template: 'road-trip'`, `realtime_factor: 0.41`). What is never sent: place
names, titles, coordinates, search queries, or the URL. Do Not Track is
honoured, and the anonymous id identifies a browser, not a person.

The funnel is `editor_opened` → `project_edited` → `preview_played` →
`export_started` → `export_completed`.

## Determinism rules

1. No `Date.now()` / `Math.random()` in the engine — time enters as `tMs`.
2. The engine never reads from the map; it only writes FrameState to it (`jumpTo`, never `easeTo`).
3. Easing/interpolation are pure functions, unit-tested against golden values.

## Camera

Framing defaults to **Auto**: each stop's zoom comes from the distance to its
nearest neighbour, so a Paris–Lyon hop frames at ~z7.7 while Bangkok–Tokyo
frames at ~z4.7. A fixed zoom is right for one of those and absurd for the
other, which is why it isn't the default. Named presets (Street … World) pin
every stop, and any single stop can be overridden from the stop list without
giving up automatic framing everywhere else.

The **travel arc** is van Wijk's rho, exposed directly: it controls how far the
camera pulls back on the way between two stops. **Rotation** is either fixed or
follows the route, in which case the map turns during each dwell so you are
always travelling up the screen — turning mid-flight reads as the map spinning.
**Orbit** adds a rotation across each stop's dwell, which is what tilt and 3D
terrain are for.

## Quick mode and Studio mode

**Quick mode** hides time entirely: pick places, pick a look, export. **Studio
mode** shows the same project on a timeline where every stop dwell and travel
leg can be retimed individually. They are not different data models — Studio
edits the `legDurations`/`stopDwells` the compiler already reads, so switching
modes never rebuilds or loses work, and any segment can be reverted to its
automatic duration.

## Quick mode

Search for cities, build a trip, export a video — no account needed. Project
state lives in the URL, so any map is a shareable link:

```
/?s=Bangkok,100.5018,13.7563~Tokyo,139.6917,35.6895&f=9x16&style=paper&spd=1.4
```

| param | meaning |
|---|---|
| `s` | stops, `name,lng,lat` joined by `~` |
| `f` | format: `16x9`, `9x16`, `1x1` |
| `style` | `liberty`, `bright`, `positron`, `paper`, `minimal` |
| `l` | leg modes, one char per leg: `x`=direct `f`=flight `d`=car `m`=moto `r`=train `s`=ferry `b`=bike `w`=walk `t`=imported |
| `spd` | speed multiplier (0.5–2.5) |
| `res` | output resolution scale 0.25–1 (draft exports) |
| `lb` | label visibility bits: places, countries, roads, water, pois (e.g. `10110`) |
| `zm` | framing preset: `auto`, `street`, `district`, `city`, `region`, `country`, `continent`, `world` |
| `sz` | per-stop zoom overrides, `_`-joined, `-` for automatic (e.g. `-_12.5_-`) |
| `arc` | travel arc — van Wijk rho, 0.8 (direct) to 3 (sweeping) |
| `bm` | `travel` to turn the map so you always travel upward |
| `brg` | camera heading in degrees (an offset when `bm=travel`) |
| `orb` | degrees the camera orbits each stop during its dwell |
| `ez` | movement easing: `c` smooth, `s` gentle, `o` snap out, `i` ramp up, `l` constant |
| `prj` | `globe` for spherical projection |
| `ter` | `1` to enable 3D terrain |
| `pit` | camera tilt in degrees (0–85) |
| `styleUrl` | load an arbitrary MapLibre style (dev) |
| `autotest` | run an export automatically (CI) |

Place search hits `/api/geocode`, which answers from a bundled index of ~6,500
notable cities (instant, offline, no rate limit) and only falls back to an
upstream geocoder when local results are thin.

Each leg between two stops is either a **flight** (great-circle arc, computed
locally) or a **drive** (real road geometry via `/api/route`, which proxies
OSRM). `/api/route` never fails the caller: if the router is down,
rate-limited, or the points aren't road-connected, it returns
`{ geometry: null, reason }` and the leg falls back to an arc. Set `ROUTER_URL`
to point at a different OSRM-compatible instance.

## Tests

```bash
npm test                                    # 159 engine unit tests
node apps/web/e2e/export-test.mjs           # headless export proof
xvfb-run -a node apps/web/e2e/headful-style-test.mjs   # remote vector style + export
xvfb-run -a node apps/web/e2e/quickmode-test.mjs       # full Quick mode UI flow
xvfb-run -a node apps/web/e2e/routes-test.mjs          # driving routes + failure fallback
xvfb-run -a node apps/web/e2e/import-test.mjs          # GPX/KML import
xvfb-run -a node apps/web/e2e/titles-templates-test.mjs # templates + title cards
xvfb-run -a node apps/web/e2e/library-test.mjs         # saved projects + corrupt storage
xvfb-run -a node apps/web/e2e/studio-test.mjs          # Studio timeline + retiming
xvfb-run -a node apps/web/e2e/vehicles-test.mjs        # travel modes + moving vehicles
xvfb-run -a node apps/web/e2e/appearance-test.mjs      # label toggles, projection, tilt, terrain
xvfb-run -a node apps/web/e2e/pins-test.mjs            # marker styles
xvfb-run -a node apps/web/e2e/gif-test.mjs             # GIF export
xvfb-run -a node apps/web/e2e/camera-test.mjs          # framing, arc, rotation, orbit, tilt
xvfb-run -a node apps/web/e2e/mobile-test.mjs          # phone/tablet layout
xvfb-run -a node apps/web/e2e/analytics-test.mjs      # funnel events + no-leak proof
```

Suites bind different ports and can run back to back, but not in parallel —
and give a suite a moment to release its port before starting the next one.
