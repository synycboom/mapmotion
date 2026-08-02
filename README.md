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

## Annotations

Text, images, arrows, lines, boxes and circles pinned to real coordinates —
they move with the map, fade in when you choose, and can fade out again.

One object model, not three features. They differ only in what they draw;
anchoring, timing, entrance, exit and opacity are shared, and building them
separately would mean three subtly different answers to "when does this
disappear".

Placement works by clicking the map, which needed care: the map is built with
`interactive: false`, and that is exactly what makes preview and export
pixel-identical, since nothing but the engine can move it. So a transparent
overlay sits over the preview and unprojects the click itself — the map stays
inert and we still get a coordinate. The overlay divides out the preview's CSS
scale first; without that every placement lands short of the cursor by the
zoom-to-fit factor.

Circles are geodesic. A "circle" drawn by adding a constant to longitude and
latitude is an ellipse twice as wide as it is tall at 60°N, which is where a
lot of people live. Arrowheads are sized in metres relative to the shaft, so
they scale with the map instead of swamping a short arrow, and they only
appear once the shaft is 60% drawn — a head that leads its own line reads as
two separate marks.

## Region highlighting

Fill whole countries or named groups — EU, ASEAN, Schengen, G7, BRICS, MENA,
Nordics, Latin America — with an animated entrance, or pick countries by hand.
Several highlights coexist with their own colours, which is the point: "EU in
blue, candidates in amber".

Geometry is Natural Earth 1:110m via `world-atlas`, converted by
`scripts/build-countries.mjs` into ~190KB of GeoJSON keyed on ISO alpha-3 with
the codes baked in, so the app ships no ISO mapping table. It is fetched on
demand rather than bundled: most projects never highlight anything, and making
every visitor download a fifth of a megabyte of coastlines for a feature they
aren't using is a poor trade.

Two details that matter more than they look. Fills are inserted **beneath the
first symbol layer**, so place names stay readable on top of a highlight — a
fill over every label makes the map unreadable exactly when the viewer wants
to know which countries these are. And overlapping selections are
de-duplicated, because EU and Schengen share 23 members and drawing those
fills twice would render the shared members visibly darker than the rest.

## Editor layout

The editor is a rail of grouped panels — Trip, Style, Camera, Audio, Titles,
Output — with one open at a time, the map taking the remaining room, and a
storyboard strip under it showing the trip as stops and travel legs with their
durations.

It replaced a single scrolling sidebar. That was fine at four sections and a
scroll-hunt at fourteen: Camera and Soundtrack both sat below the fold, and on
a phone every control was underneath the map. The problem also got
monotonically worse with each feature shipped, so the cost of leaving it only
grew. Adding a feature now means adding to a group rather than lengthening a
scroll.

E2E suites reach controls through `e2e/ui.mjs`, which opens panels until the
control appears. A test-only "expand everything" flag would have been less
work and would have left the suites exercising a layout no user ever sees —
and in a restructure the thing most likely to break is precisely whether a
control is still reachable.

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

## Photo import

Drop a folder of trip photos. Each one's EXIF GPS becomes a location, capture
time becomes the order, photos taken in the same place merge into one stop,
and the photograph itself becomes that stop's pin. Files never leave the
browser — only the first 128KB of each is read, which is where EXIF lives.

The EXIF reader is written rather than pulled in, so it can be a pure function
over a `Uint8Array` and therefore unit-testable in Node against files built
byte by byte: big-endian, missing GPS, a 0/0 "no fix" reading, a pointer past
the end of the file, truncation at every length. Those are the cases that
break EXIF parsers and none of them appear in a photo you happen to have.
The fixtures are cross-checked against `piexif` so the parser and the fixture
builder can't agree on a wrong layout.

Clustering is sequential, not purely spatial: a trip that returns to the same
city twice gets two stops, because that is what happened. Stop names come from
the bundled city index via a reverse lookup — "Ayutthaya" rather than "Stop 3".

Photos without GPS, HEIC files and unreadable files are counted and reported
rather than silently dropped, and the three have different messages because
they have different fixes. HEIC especially: it is the iPhone default, browsers
can't read its metadata, and the answer is Settings › Camera › Formats › Most
Compatible.

## Soundtrack and beat snapping

Drop an audio file onto the editor and it is decoded, analysed and beat-tracked
locally — the file never leaves the browser, same as GPX import.

Beat detection is Ellis (2007) dynamic programming over a log-energy onset
envelope: build the envelope, estimate one global tempo from its
autocorrelation under a log-Gaussian prior (which is what stops it settling on
half or double the real tempo), then pick the beat sequence that best trades
landing on onsets against staying on the grid. It coasts through a bar with no
onsets at all, where a peak-picker loses the beat.

It also refuses to answer when there is nothing to answer. Beat trackers always
return *something*; run one on room tone and it hands back a confident tempo
built from frame-boundary noise. A salience gate — mean onset strength at the
chosen beats over the mean overall — rejects that. Click tracks score 15–30, a
pure tone 3.6, broadband noise 3.8; the threshold is 8.

**Cut to the beat** rounds every dwell and travel leg to a whole number of
half-beats, then trims the audio to start on a beat. Quantising *durations*
rather than nudging *boundaries* is what keeps the whole video on the grid — a
boundary-nudger accumulates drift and can reorder two close boundaries. The
result is written into the same per-segment timings Studio mode edits, so it is
visible and undoable rather than a hidden mode.

Timing uses the estimator's sub-frame period, not the median gap between
detected beats: those are snapped to analysis frames (~23ms), so their median
reads 511ms at 120 BPM instead of 500 — under 3% off, but more than half a beat
of drift across a 30-second video.

Exports carry the audio: AAC in MP4, Opus in WebM, via WebCodecs `AudioEncoder`.
GIF has no audio track and a browser without an encoder can't make one; both
cases say so rather than quietly producing a silent file.

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
npm test                                    # 304 engine unit tests
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
xvfb-run -a node apps/web/e2e/audio-test.mjs          # beat detection, snapping, muxed audio
xvfb-run -a node apps/web/e2e/photos-test.mjs         # EXIF import, photos as pins
xvfb-run -a node apps/web/e2e/regions-test.mjs        # country fills, layering, animation
xvfb-run -a node apps/web/e2e/annotate-test.mjs       # placement, shapes, timing
```

Suites bind different ports and can run back to back, but not in parallel —
and give a suite a moment to release its port before starting the next one.
