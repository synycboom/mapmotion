'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * The editor's frame.
 *
 * The old layout was one column with fourteen stacked sections. That was fine
 * at four and became a scroll-hunt at fourteen — Camera and Soundtrack both
 * sat below the fold, and on a phone every control was underneath the map.
 * Worse, it got monotonically worse with each feature, so the cost of leaving
 * it only grew.
 *
 * This replaces it with a rail of grouped panels: one thing open at a time,
 * the map gets the remaining room, and adding a feature means adding to a
 * group rather than lengthening a scroll.
 */

export interface PanelDef {
  id: string;
  label: string;
  /** Single glyph for the rail. Text, not an icon font — no extra payload. */
  glyph: string;
  hint: string;
  /** Shown on the rail when the panel holds something worth noticing. */
  badge?: string | number | null;
  content: ReactNode;
}

export function EditorShell({
  panels,
  header,
  stage,
  storyboard,
  narrow,
  activeId,
  onActivate,
}: {
  panels: PanelDef[];
  header: ReactNode;
  stage: ReactNode;
  storyboard?: ReactNode;
  narrow: boolean;
  activeId: string | null;
  onActivate: (id: string | null) => void;
}) {
  const active = panels.find((p) => p.id === activeId) ?? null;

  // Escape closes the panel — on a phone it covers the map, so there has to
  // be a way out that isn't hunting for the same tab again.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onActivate(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onActivate]);

  const rail = (
    <nav
      data-testid="panel-rail"
      aria-label="Editor sections"
      style={{
        display: 'flex',
        flexDirection: narrow ? 'row' : 'column',
        gap: 4,
        padding: narrow ? '6px 8px' : '8px 6px',
        background: '#0d1524',
        borderRight: narrow ? undefined : '1px solid #1c2a42',
        borderTop: narrow ? '1px solid #1c2a42' : undefined,
        flexShrink: 0,
        overflowX: narrow ? 'auto' : undefined,
        // On a phone the rail is the primary navigation, so it is pinned to
        // the viewport rather than the document. `sticky` looked right and
        // wasn't: the nearest scrolling ancestor is the body, so it only
        // sticks while its parent is in view — which is exactly when you
        // don't need it.
        position: narrow ? 'fixed' : undefined,
        left: narrow ? 0 : undefined,
        right: narrow ? 0 : undefined,
        bottom: narrow ? 0 : undefined,
        zIndex: narrow ? 20 : undefined,
        boxShadow: narrow ? '0 -6px 16px rgba(0,0,0,0.45)' : undefined,
      }}
    >
      {panels.map((p) => {
        const on = p.id === activeId;
        return (
          <button
            key={p.id}
            data-testid={`tab-${p.id}`}
            data-on={on ? '1' : '0'}
            aria-pressed={on}
            title={p.hint}
            onClick={() => onActivate(on ? null : p.id)}
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              width: narrow ? 62 : 56,
              padding: '7px 2px',
              background: on ? '#1c2a42' : 'transparent',
              border: `1px solid ${on ? '#34496b' : 'transparent'}`,
              borderRadius: 8,
              color: on ? '#e6edf5' : '#7d90ae',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{p.glyph}</span>
            <span style={{ fontSize: 9, letterSpacing: 0.2 }}>{p.label}</span>
            {p.badge ? (
              <span
                data-testid={`tab-badge-${p.id}`}
                style={{
                  position: 'absolute',
                  top: 3,
                  right: 6,
                  minWidth: 14,
                  height: 14,
                  padding: '0 3px',
                  borderRadius: 7,
                  background: '#e8590c',
                  color: '#fff',
                  fontSize: 9,
                  lineHeight: '14px',
                  fontWeight: 600,
                }}
              >
                {p.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );

  const panel = active ? (
    <div
      data-testid="panel"
      data-panel={active.id}
      style={{
        width: narrow ? '100%' : 320,
        flexShrink: 0,
        // Without this the horizontal padding is added to a 100% width and
        // the panel's own close button ends up off the right edge.
        boxSizing: 'border-box',
        padding: narrow ? '10px 12px 4px' : '12px 14px',
        overflowY: 'auto',
        // Bounded so the panel scrolls internally rather than pushing the map
        // off screen — the failure mode of the layout this replaces.
        maxHeight: narrow ? '48vh' : 'calc(100vh - 58px)',
        background: '#0b1220',
        borderRight: narrow ? undefined : '1px solid #1c2a42',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 4,
          fontSize: 12,
          opacity: 0.75,
        }}
      >
        <span>{active.label}</span>
        <button
          data-testid="panel-close"
          onClick={() => onActivate(null)}
          aria-label={`Close ${active.label}`}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid #2c3d5c',
            color: '#9fb0c8',
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1,
            padding: '3px 7px',
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>
      {active.content}
    </div>
  ) : null;

  if (narrow) {
    return (
      <main
        data-testid="editor-shell"
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100dvh',
          // Room for the fixed rail, plus the iPhone home indicator.
          paddingBottom: 'calc(58px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #1c2a42' }}>{header}</div>
        <section data-testid="preview-pane" style={{ padding: 12, minWidth: 0 }}>
          {stage}
        </section>
        {storyboard}
        <div data-testid="controls" style={{ flex: 1, minHeight: 0 }}>
          {panel}
        </div>
        {rail}
      </main>
    );
  }

  return (
    <main
      data-testid="editor-shell"
      style={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '9px 14px',
          borderBottom: '1px solid #1c2a42',
          flexShrink: 0,
        }}
      >
        {header}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {rail}
        <div data-testid="controls" style={{ display: 'flex', minWidth: 0 }}>
          {panel}
        </div>
        <section
          data-testid="preview-pane"
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: 14,
            overflow: 'auto',
          }}
        >
          {stage}
          {storyboard}
        </section>
      </div>
    </main>
  );
}
