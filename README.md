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

Import the repo in Vercel and set **Root Directory** to `apps/web` (keep "Include files outside root directory" enabled so the workspace packages resolve). No env vars needed yet.

## Determinism rules

1. No `Date.now()` / `Math.random()` in the engine — time enters as `tMs`.
2. The engine never reads from the map; it only writes FrameState to it (`jumpTo`, never `easeTo`).
3. Easing/interpolation are pure functions, unit-tested against golden values.
