'use client';

import { useEffect, useState } from 'react';
import { REGION_GROUPS, regionGroup } from '@mapmotion/engine';
import { countryList, loadCountries } from '../lib/countries';

/** One highlight the user has added. */
export interface RegionSetting {
  selection: string[];
  groupId?: string;
  label?: string;
  fillColor: string;
  fillOpacity: number;
  enterAt: number;
}

const SWATCHES = ['#e8590c', '#1971c2', '#2f9e44', '#9c36b5', '#f08c00', '#e03131'];

export function RegionPanel({
  regions,
  onChange,
  disabled,
}: {
  regions: RegionSetting[];
  onChange: (next: RegionSetting[]) => void;
  disabled?: boolean;
}) {
  const [countries, setCountries] = useState<Array<{ code: string; name: string }>>([]);
  const [picking, setPicking] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  // The boundary file is fetched on demand, so the country picker only has
  // names once it lands. Kick it off when this panel first opens.
  useEffect(() => {
    let alive = true;
    void loadCountries().then(() => {
      if (alive) setCountries(countryList());
    });
    return () => {
      alive = false;
    };
  }, []);

  const update = (i: number, patch: Partial<RegionSetting>) =>
    onChange(regions.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const add = (groupId?: string) => {
    const group = regionGroup(groupId);
    onChange([
      ...regions,
      {
        selection: group ? [group.id] : [],
        groupId: group?.id,
        label: group?.label,
        // Cycle the palette so a second highlight is a different colour
        // without the user having to think about it.
        fillColor: SWATCHES[regions.length % SWATCHES.length]!,
        fillOpacity: 0.35,
        enterAt: 0,
      },
    ]);
  };

  const filtered = query
    ? countries.filter((c) => c.name.toLowerCase().includes(query.toLowerCase())).slice(0, 40)
    : countries.slice(0, 40);

  return (
    <div data-testid="region-panel">
      <Label>Highlight a group</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {REGION_GROUPS.map((g) => (
          <button
            key={g.id}
            data-testid={`region-group-${g.id}`}
            onClick={() => add(g.id)}
            title={g.hint}
            disabled={disabled}
            style={pill}
          >
            {g.label}
          </button>
        ))}
        <button
          data-testid="region-add-custom"
          onClick={() => add()}
          title="Pick countries yourself"
          disabled={disabled}
          style={{ ...pill, borderStyle: 'dashed' }}
        >
          + Countries
        </button>
      </div>

      {regions.length === 0 && (
        <p style={{ fontSize: 10, opacity: 0.4, margin: '8px 0 0' }}>
          Fills a whole country or group — for showing membership, borders or
          where something happened. Sits under the place labels so they stay
          readable.
        </p>
      )}

      {regions.map((r, i) => {
        const group = regionGroup(r.groupId);
        const custom = r.selection.filter((c) => !regionGroup(c));
        return (
          <div
            key={i}
            data-testid={`region-item-${i}`}
            style={{
              marginTop: 12,
              padding: 9,
              background: '#101a2c',
              border: '1px solid #24334d',
              borderRadius: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: r.fillColor,
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {group?.label ?? (custom.length ? `${custom.length} countries` : 'Pick countries')}
              </span>
              <button
                data-testid={`region-remove-${i}`}
                onClick={() => onChange(regions.filter((_, j) => j !== i))}
                aria-label="Remove this highlight"
                disabled={disabled}
                style={iconBtn}
              >
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', gap: 4, marginTop: 7 }}>
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  data-testid={`region-${i}-colour-${c.slice(1)}`}
                  onClick={() => update(i, { fillColor: c })}
                  aria-label={`Colour ${c}`}
                  disabled={disabled}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    background: c,
                    border: `2px solid ${r.fillColor === c ? '#e6edf5' : 'transparent'}`,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              ))}
            </div>

            <Slider
              testId={`region-${i}-opacity`}
              label={`Fill · ${Math.round(r.fillOpacity * 100)}%`}
              min={0}
              max={1}
              step={0.05}
              value={r.fillOpacity}
              disabled={disabled}
              onChange={(v) => update(i, { fillOpacity: v })}
            />
            <Slider
              testId={`region-${i}-enter`}
              label={
                r.enterAt === 0
                  ? 'Appears · from the start'
                  : `Appears · ${Math.round(r.enterAt * 100)}% in`
              }
              min={0}
              max={1}
              step={0.05}
              value={r.enterAt}
              disabled={disabled}
              onChange={(v) => update(i, { enterAt: v })}
            />

            <button
              data-testid={`region-${i}-pick`}
              onClick={() => setPicking(picking === i ? null : i)}
              disabled={disabled}
              style={{ ...pill, marginTop: 8, width: '100%' }}
            >
              {picking === i ? 'Done' : group ? 'Add or remove countries' : 'Choose countries'}
            </button>

            {picking === i && (
              <div data-testid={`region-${i}-picker`} style={{ marginTop: 7 }}>
                <input
                  data-testid={`region-${i}-search`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={countries.length ? 'Search countries…' : 'Loading boundaries…'}
                  style={inputStyle}
                />
                <div
                  style={{
                    maxHeight: 170,
                    overflowY: 'auto',
                    marginTop: 5,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 3,
                  }}
                >
                  {filtered.map((c) => {
                    const on = r.selection.includes(c.code);
                    return (
                      <button
                        key={c.code}
                        data-testid={`region-country-${c.code}`}
                        onClick={() =>
                          update(i, {
                            selection: on
                              ? r.selection.filter((x) => x !== c.code)
                              : [...r.selection, c.code],
                          })
                        }
                        style={{
                          ...pill,
                          fontSize: 10,
                          padding: '3px 7px',
                          background: on ? '#e8590c' : '#1c2a42',
                          borderColor: on ? '#e8590c' : '#34496b',
                        }}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 6, letterSpacing: 0.3 }}>
      {children}
    </div>
  );
}

function Slider({
  testId,
  label,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
}: {
  testId: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginTop: 7 }}>
      <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 2 }}>{label}</div>
      <input
        data-testid={testId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  );
}

const pill: React.CSSProperties = {
  background: '#1c2a42',
  color: '#e6edf5',
  border: '1px solid #34496b',
  borderRadius: 999,
  padding: '4px 9px',
  fontSize: 11,
  cursor: 'pointer',
};

const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #2c3d5c',
  color: '#ff8787',
  borderRadius: 4,
  fontSize: 11,
  padding: '1px 6px',
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#111c2e',
  color: '#e6edf5',
  border: '1px solid #34496b',
  borderRadius: 6,
  padding: '6px 9px',
  fontSize: 12,
  boxSizing: 'border-box',
};
