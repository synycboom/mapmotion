'use client';

/**
 * Product analytics.
 *
 * The question this exists to answer is a single number: of the people who
 * open the editor, how many reach a finished export? Unlimited free exports
 * only beat a competitor's monthly cap if people actually get that far, and
 * until that number exists every other prioritisation is a guess.
 *
 * ## Why this is ~120 lines instead of `posthog.init()`
 *
 * This app keeps the entire project in the URL — `?s=Paris,2.3522,48.8566~…`.
 * Any analytics SDK that captures `$current_url`, and they all do by default,
 * therefore ships the user's itinerary and coordinates to a third party as a
 * side effect of measuring a page view. Turning that off is a configuration
 * flag, which means it is one careless upgrade away from turning back on.
 *
 * Posting to PostHog's documented capture endpoint ourselves makes the
 * privacy property structural: the only things that can leave this file are
 * the event name and the properties a caller passed in. There is no code path
 * that reads the DOM, the URL, or anything the user typed. Feature flags and
 * session replay are given up; neither is needed to count a funnel.
 *
 * ## Rules
 *
 * 1. **Inert without a key.** No `NEXT_PUBLIC_POSTHOG_KEY`, no network. Local
 *    dev, CI and every e2e suite run with analytics off.
 * 2. **No user content, ever.** Counts and enum values only.
 * 3. **Respect Do Not Track.**
 * 4. **Never break the app.** Every call is fire-and-forget inside a try.
 */

/** The funnel, in order, plus the things that explain drop-off. */
export type AnalyticsEvent =
  | 'editor_opened'
  | 'project_edited'
  | 'template_applied'
  | 'place_searched'
  | 'track_imported'
  | 'preview_played'
  | 'camera_changed'
  | 'style_changed'
  | 'project_saved'
  | 'link_copied'
  | 'export_started'
  | 'export_completed'
  | 'export_failed'
  | 'audio_added'
  | 'beat_snapped'
  | 'photos_imported'
  | 'region_added';

export type EventProps = Record<string, string | number | boolean | null | undefined>;

const ID_KEY = 'mapmotion.anon_id';

let sessionId = '';
let distinctId = '';
/** Events already sent this load, for the once-per-session ones. */
const fired = new Set<string>();

function key(): string | undefined {
  return process.env.NEXT_PUBLIC_POSTHOG_KEY || undefined;
}

function host(): string {
  return (process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com').replace(/\/$/, '');
}

function enabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (!key()) return false;
  // '1' in Chrome/Firefox, 'yes' in older Safari; window.doNotTrack on IE.
  const dnt =
    (navigator as unknown as { doNotTrack?: string }).doNotTrack ??
    (window as unknown as { doNotTrack?: string }).doNotTrack;
  return dnt !== '1' && dnt !== 'yes';
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Older Safari, and any non-secure context.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * A stable anonymous id, so returning visitors aren't counted as new ones.
 * It identifies a browser, not a person, and is never joined to anything.
 * If storage is unavailable (private mode, embedded webview) we fall back to
 * a per-load id rather than failing — an inflated new-visitor count is a much
 * smaller problem than a broken editor.
 */
function anonId(): string {
  try {
    const existing = localStorage.getItem(ID_KEY);
    if (existing) return existing;
    const fresh = randomId();
    localStorage.setItem(ID_KEY, fresh);
    return fresh;
  } catch {
    return randomId();
  }
}

export function initAnalytics(): void {
  if (!enabled() || sessionId) return;
  sessionId = randomId();
  distinctId = anonId();
}

/**
 * Record an event. Safe to call anywhere, including during SSR.
 *
 * Sent immediately rather than batched: a session produces a handful of
 * events, and a queue that needs flushing is a queue that loses the last
 * event — which here is `export_completed`, the one the whole thing is for.
 * `keepalive` lets the request outlive the page.
 */
export function track(event: AnalyticsEvent, props?: EventProps): void {
  try {
    if (!enabled()) return;
    if (!sessionId) initAnalytics();

    const payload = {
      api_key: key(),
      event,
      // TOP-LEVEL, not inside properties. PostHog drops events with a
      // missing or empty distinct_id and still answers 200 OK — so getting
      // this wrong produces no error, no failed request, and no data. It
      // shipped that way once; the mock ingest server now rejects it.
      distinct_id: distinctId,
      properties: {
        ...props,
        $session_id: sessionId,
        // Deliberately NOT $current_url: this app's URL is the user's
        // itinerary. `$pathname` is always '/' and carries nothing.
        $pathname: '/',
        app_version: process.env.NEXT_PUBLIC_COMMIT_SHA ?? 'dev',
      },
      timestamp: new Date().toISOString(),
    };

    void fetch(`${host()}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      // No cookies, no credentials — there is nothing to authenticate.
      credentials: 'omit',
      mode: 'cors',
    }).catch(() => {
      /* blocked, offline, ad-blocked — all fine */
    });
  } catch {
    /* analytics must never throw into the app */
  }
}

/** Record an event at most once per page load. */
export function trackOnce(event: AnalyticsEvent, props?: EventProps): void {
  if (fired.has(event)) return;
  fired.add(event);
  track(event, props);
}

/** Exposed for tests: is instrumentation live in this build? */
export function analyticsEnabled(): boolean {
  return enabled();
}
