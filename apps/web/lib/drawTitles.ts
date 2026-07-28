import type { TitleState } from '@mapmotion/engine';

/**
 * Draws title cards onto a 2D canvas.
 *
 * Deliberately the ONLY place titles are rendered: the preview layers a
 * transparent canvas over the map and calls this, and the exporter calls it
 * on the compositing canvas. One code path means what you see is what you
 * export — the same principle as the animation engine owning all camera
 * interpolation.
 *
 * Sizes are derived from canvas width so a 9:16 vertical and a 4K landscape
 * both get proportionate type.
 */
export function drawTitles(
  ctx: CanvasRenderingContext2D,
  titles: readonly TitleState[],
  width: number,
  height: number,
): void {
  if (titles.length === 0) return;

  for (const { card, opacity } of titles) {
    if (opacity <= 0) continue;

    const titleSize = Math.round(width * 0.052);
    const subSize = Math.round(width * 0.024);
    const centerY = card.position === 'lower' ? height * 0.78 : height * 0.44;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = wrap(ctx, card.text, width * 0.82, titleSize);
    const lineHeight = titleSize * 1.18;
    const blockHeight =
      lines.length * lineHeight + (card.subtitle ? subSize * 2.2 : 0);
    let y = centerY - blockHeight / 2 + lineHeight / 2;

    // A soft dark scrim keeps text readable over bright basemaps without
    // hiding the map — cheaper and less intrusive than a full overlay.
    const scrimPad = titleSize * 1.1;
    const grad = ctx.createLinearGradient(
      0,
      y - lineHeight / 2 - scrimPad,
      0,
      y - lineHeight / 2 + blockHeight + scrimPad,
    );
    grad.addColorStop(0, 'rgba(6,12,22,0)');
    grad.addColorStop(0.5, `rgba(6,12,22,${0.55 * opacity})`);
    grad.addColorStop(1, 'rgba(6,12,22,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(
      0,
      y - lineHeight / 2 - scrimPad,
      width,
      blockHeight + scrimPad * 2,
    );

    ctx.font = `700 ${titleSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(6,12,22,${0.75 * opacity})`;
    ctx.lineWidth = Math.max(2, titleSize * 0.09);
    ctx.fillStyle = '#ffffff';
    for (const line of lines) {
      ctx.strokeText(line, width / 2, y);
      ctx.fillText(line, width / 2, y);
      y += lineHeight;
    }

    if (card.subtitle) {
      y += subSize * 0.5;
      ctx.font = `500 ${subSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.lineWidth = Math.max(1.5, subSize * 0.09);
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.strokeText(card.subtitle, width / 2, y);
      ctx.fillText(card.subtitle, width / 2, y);
    }

    ctx.restore();
  }
}

/** Greedy word wrap; falls back to the raw string if a single word is huge. */
function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number,
): string[] {
  ctx.save();
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  ctx.restore();
  // Keep cards to three lines; beyond that it stops being a title.
  return lines.length ? lines.slice(0, 3) : [text];
}
