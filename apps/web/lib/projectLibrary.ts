'use client';

import type { LegMode, LngLat, TripStop } from '@mapmotion/engine';
import type { PinAppearance } from '@mapmotion/engine';
import type { FormatId, MapAppearance } from './urlState';

/**
 * Saved projects, stored locally.
 *
 * URL state already makes a map shareable, but it can't carry an imported
 * GPX track (thousands of points) and it isn't a list you can browse. This
 * gives both, with no backend and no account — and it's the shape a server
 * sync would later mirror, so nothing here is throwaway.
 *
 * Every read is defensive: localStorage is user-editable, shared across
 * tabs, and can be full or blocked entirely (private mode, embedded
 * webviews). A corrupt entry must never take down the editor.
 */

const KEY = 'mapmotion.projects.v1';
const MAX_PROJECTS = 50;

export interface SavedProject {
  id: string;
  name: string;
  updatedAt: number;
  stops: TripStop[];
  legModes: LegMode[];
  /** Imported track geometry per leg — the part a URL can't hold. */
  trackGeometries: (LngLat[] | null)[];
  /** Studio-mode timing overrides; null entries mean "derive it". */
  legDurations?: (number | null)[];
  stopDwells?: (number | null)[];
  appearance?: MapAppearance;
  pin?: PinAppearance;
  format: FormatId;
  styleId: string;
  speed: number;
  title: string;
  subtitle: string;
  outro: boolean;
}

export type NewProject = Omit<SavedProject, 'id' | 'updatedAt'>;

function available(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__mm_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null; // private mode, disabled storage, sandboxed iframe
  }
}

export function listProjects(): SavedProject[] {
  const store = available();
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveProject(
  project: NewProject,
  existingId?: string,
  now = Date.now(),
): SavedProject | null {
  const store = available();
  if (!store) return null;

  const all = listProjects();
  const id = existingId ?? makeId(now);
  const record: SavedProject = { ...project, id, updatedAt: now };

  const next = [record, ...all.filter((p) => p.id !== id)].slice(0, MAX_PROJECTS);

  try {
    store.setItem(KEY, JSON.stringify(next));
    return record;
  } catch {
    // Almost certainly the ~5MB quota, hit by big imported tracks. Drop the
    // oldest entries and retry rather than failing the user's save.
    for (let keep = next.length - 1; keep >= 1; keep--) {
      try {
        store.setItem(KEY, JSON.stringify(next.slice(0, keep)));
        return record;
      } catch {
        /* keep shrinking */
      }
    }
    return null;
  }
}

export function deleteProject(id: string): void {
  const store = available();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(listProjects().filter((p) => p.id !== id)));
  } catch {
    /* nothing useful to do */
  }
}

export function getProject(id: string): SavedProject | null {
  return listProjects().find((p) => p.id === id) ?? null;
}

function makeId(now: number): string {
  // Time-prefixed so ids sort chronologically; the suffix only needs to
  // separate saves made within the same millisecond.
  return `p${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Reject anything that would break the editor if loaded. */
function isValid(p: unknown): p is SavedProject {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false;
  if (typeof o.updatedAt !== 'number') return false;
  if (!Array.isArray(o.stops) || o.stops.length < 2) return false;
  return o.stops.every((s) => {
    if (!s || typeof s !== 'object') return false;
    const st = s as Record<string, unknown>;
    return (
      typeof st.name === 'string' &&
      Array.isArray(st.coordinate) &&
      st.coordinate.length === 2 &&
      st.coordinate.every((n) => typeof n === 'number' && Number.isFinite(n))
    );
  });
}
