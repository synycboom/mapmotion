import type { ReactNode } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';

export const metadata = {
  title: 'Mapmotion — render pipeline spike',
  description: 'Phase 0: MapLibre + deterministic engine + WebCodecs export',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#090f1a',
          color: '#e6edf5',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {children}
      </body>
    </html>
  );
}
