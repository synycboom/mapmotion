import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import 'maplibre-gl/dist/maplibre-gl.css';

export const metadata = {
  title: 'Mapmotion — animated map videos',
  description: 'Build an animated map video in the browser and export it as MP4 or GIF.',
};

/**
 * `maximumScale` is deliberately left alone — pinch-zoom is an accessibility
 * affordance and blocking it is never worth the tidier layout. `viewportFit`
 * lets the page run under the iPhone notch and home indicator.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#090f1a',
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
          // The preview renders the map at full output size and scales it
          // down with a transform. Transforms don't shrink the scroll area on
          // every engine, so without this iOS Safari rubber-bands sideways.
          overflowX: 'hidden',
          WebkitTextSizeAdjust: '100%',
        }}
      >
        {children}
      </body>
    </html>
  );
}
