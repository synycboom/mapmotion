'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlaceHit } from '@mapmotion/engine';

const COUNTRY_FLAGS: Record<string, string> = {};
function flag(cc: string): string {
  if (!cc || cc.length !== 2) return '';
  if (!COUNTRY_FLAGS[cc]) {
    COUNTRY_FLAGS[cc] = String.fromCodePoint(
      ...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)),
    );
  }
  return COUNTRY_FLAGS[cc]!;
}

export function PlaceSearch({
  onPick,
  placeholder = 'Add a stop — search for a city…',
}: {
  onPick: (hit: PlaceHit) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // Debounced search. `seq` guards against out-of-order responses so a slow
  // earlier request can't overwrite a newer one's results.
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        const json = (await res.json()) as { results: PlaceHit[] };
        if (mine !== seq.current) return;
        setHits(json.results ?? []);
        setActive(0);
        setOpen(true);
      } catch {
        if (mine === seq.current) setHits([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (hit: PlaceHit) => {
    onPick(hit);
    setQ('');
    setHits([]);
    setOpen(false);
  };

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits.length && setOpen(true)}
        placeholder={placeholder}
        aria-label="Search for a place"
        data-testid="place-search"
        onKeyDown={(e) => {
          if (!open || hits.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const hit = hits[active];
            if (hit) choose(hit);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        style={{
          width: '100%',
          background: '#111c2e',
          color: '#e6edf5',
          border: '1px solid #34496b',
          borderRadius: 6,
          padding: '9px 12px',
          fontSize: 14,
          boxSizing: 'border-box',
        }}
      />
      {loading && (
        <span
          style={{
            position: 'absolute',
            right: 10,
            top: 10,
            fontSize: 11,
            opacity: 0.5,
          }}
        >
          …
        </span>
      )}
      {open && hits.length > 0 && (
        <ul
          data-testid="place-results"
          style={{
            position: 'absolute',
            zIndex: 30,
            top: '100%',
            left: 0,
            right: 0,
            margin: '4px 0 0',
            padding: 0,
            listStyle: 'none',
            background: '#0f1a2b',
            border: '1px solid #34496b',
            borderRadius: 6,
            maxHeight: 260,
            overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          }}
        >
          {hits.map((h, i) => (
            <li key={`${h.name}-${h.country}-${i}`}>
              <button
                onClick={() => choose(h)}
                onMouseEnter={() => setActive(i)}
                style={{
                  display: 'flex',
                  width: '100%',
                  gap: 8,
                  alignItems: 'baseline',
                  background: i === active ? '#1c2a42' : 'transparent',
                  color: '#e6edf5',
                  border: 'none',
                  padding: '8px 12px',
                  fontSize: 13,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span>{flag(h.country)}</span>
                <span style={{ fontWeight: 500 }}>{h.name}</span>
                <span style={{ opacity: 0.5, fontSize: 11 }}>{h.country}</span>
                {h.isCapital && (
                  <span style={{ opacity: 0.45, fontSize: 10 }}>capital</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
