'use client';

import { useEffect, useState } from 'react';
import {
  deleteProject,
  listProjects,
  type SavedProject,
} from '../lib/projectLibrary';

export function ProjectLibrary({
  onLoad,
  onSave,
  currentName,
  reloadKey,
}: {
  onLoad: (p: SavedProject) => void;
  onSave: (name: string) => void;
  currentName: string;
  /** Bump to refresh the list after an external save. */
  reloadKey: number;
}) {
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setProjects(listProjects());
  }, [reloadKey]);

  const refresh = () => setProjects(listProjects());

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          data-testid="save-project"
          onClick={() => {
            onSave(currentName || 'Untitled trip');
            refresh();
          }}
          style={{ ...btn, flex: 1, fontSize: 12 }}
        >
          Save project
        </button>
        <button
          data-testid="toggle-library"
          onClick={() => {
            refresh();
            setOpen((v) => !v);
          }}
          style={{ ...btn, fontSize: 12 }}
        >
          {open ? 'Hide' : `Library (${projects.length})`}
        </button>
      </div>

      {open && (
        <ul
          data-testid="project-list"
          style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}
        >
          {projects.length === 0 && (
            <li data-testid="project-empty" style={{ fontSize: 11, opacity: 0.5, padding: '4px 2px' }}>
              Nothing saved yet.
            </li>
          )}
          {projects.map((p) => (
            <li
              key={p.id}
              data-testid="project-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 8px',
                marginBottom: 3,
                background: '#111c2e',
                border: '1px solid #24334d',
                borderRadius: 5,
                fontSize: 12,
              }}
            >
              <button
                onClick={() => onLoad(p)}
                style={{
                  flex: 1,
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  color: '#e6edf5',
                  cursor: 'pointer',
                  padding: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={`${p.stops.length} stops · ${new Date(p.updatedAt).toLocaleString()}`}
              >
                {p.name}
                <span style={{ opacity: 0.45, fontSize: 10 }}> · {p.stops.length} stops</span>
              </button>
              <button
                aria-label={`Delete ${p.name}`}
                onClick={() => {
                  deleteProject(p.id);
                  refresh();
                }}
                style={{
                  background: 'transparent',
                  border: '1px solid #2c3d5c',
                  color: '#ff8787',
                  borderRadius: 4,
                  width: 20,
                  height: 20,
                  fontSize: 10,
                  cursor: 'pointer',
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: '#1c2a42',
  color: '#e6edf5',
  border: '1px solid #34496b',
  borderRadius: 6,
  padding: '7px 12px',
  cursor: 'pointer',
};
