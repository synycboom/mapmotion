/**
 * Title cards (intro/outro text over the map).
 *
 * Only the *timing* lives here — pure, testable, and shared by the preview
 * and the exporter so both agree on what is on screen at time t. The actual
 * drawing is a canvas concern and lives in the app.
 */

export interface TitleCard {
  id: string;
  text: string;
  subtitle?: string;
  startMs: number;
  endMs: number;
  /** Fade in/out duration, ms. Clamped so it can never exceed half the card. */
  fadeMs?: number;
  position?: 'center' | 'lower';
}

export interface TitleState {
  card: TitleCard;
  /** 0..1 */
  opacity: number;
}

/** Which cards are visible at tMs, and how faded in they are. */
export function titlesAt(cards: readonly TitleCard[], tMs: number): TitleState[] {
  const out: TitleState[] = [];
  for (const card of cards) {
    const opacity = titleOpacity(card, tMs);
    if (opacity > 0) out.push({ card, opacity });
  }
  return out;
}

export function titleOpacity(card: TitleCard, tMs: number): number {
  const duration = card.endMs - card.startMs;
  if (duration <= 0) return 0;
  if (tMs < card.startMs || tMs > card.endMs) return 0;

  // A long fade on a short card would never reach full opacity; cap it at
  // half the card so every card is fully readable at its midpoint.
  const fade = Math.min(card.fadeMs ?? 500, duration / 2);
  if (fade <= 0) return 1;

  const sinceStart = tMs - card.startMs;
  const untilEnd = card.endMs - tMs;
  const raw = Math.min(sinceStart / fade, untilEnd / fade, 1);
  return Math.max(0, Math.min(1, raw));
}

/**
 * Default intro/outro pair for a trip. The intro sits over the opening dwell;
 * the outro lands at the end so the video finishes on the trip name rather
 * than a bare map.
 */
export function buildTitleCards(opts: {
  title?: string | null;
  subtitle?: string | null;
  durationMs: number;
  outro?: boolean;
}): TitleCard[] {
  const cards: TitleCard[] = [];
  const title = opts.title?.trim();
  if (!title) return cards;

  const introEnd = Math.min(3200, Math.max(1200, opts.durationMs * 0.28));
  cards.push({
    id: 'intro',
    text: title,
    subtitle: opts.subtitle?.trim() || undefined,
    startMs: 0,
    endMs: introEnd,
    fadeMs: 500,
    position: 'center',
  });

  if (opts.outro && opts.durationMs > 4000) {
    cards.push({
      id: 'outro',
      text: title,
      startMs: Math.max(introEnd + 200, opts.durationMs - 2600),
      endMs: opts.durationMs,
      fadeMs: 600,
      position: 'center',
    });
  }
  return cards;
}
