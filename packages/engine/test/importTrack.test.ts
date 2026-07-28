import { describe, expect, it } from 'vitest';
import { importTrack, TrackImportError } from '../src/importTrack';

const GPX_TRACK = `<?xml version="1.0"?>
<gpx version="1.1" creator="Garmin">
  <trk>
    <name>Morning Ride</name>
    <trkseg>
      <trkpt lat="13.7563" lon="100.5018"><ele>12.5</ele></trkpt>
      <trkpt lat="13.7600" lon="100.5100"><ele>14.0</ele></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="13.7700" lon="100.5200"><ele>18.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

// Namespaced, single-segment, no elevation — a common Strava export shape.
const GPX_NAMESPACED = `<?xml version="1.0"?>
<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1">
  <gpx:trk><gpx:trkseg>
    <gpx:trkpt lat="1.0" lon="2.0"/>
    <gpx:trkpt lat="1.1" lon="2.1"/>
  </gpx:trkseg></gpx:trk>
</gpx:gpx>`;

const GPX_ROUTE_AND_WPT = `<?xml version="1.0"?>
<gpx version="1.1">
  <wpt lat="48.8584" lon="2.2945"><name>Eiffel Tower</name></wpt>
  <wpt lat="48.8606" lon="2.3376"><name>Louvre</name></wpt>
  <rte>
    <name>City Walk</name>
    <rtept lat="48.8584" lon="2.2945"/>
    <rtept lat="48.8606" lon="2.3376"/>
  </rte>
</gpx>`;

const KML_LINE = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Folder>
      <Placemark>
        <name>Coast Road</name>
        <LineString>
          <coordinates>
            -122.4194,37.7749,0 -122.4000,37.8000,15 -122.3800,37.8200,30
          </coordinates>
        </LineString>
      </Placemark>
      <Placemark>
        <name>Lookout</name>
        <Point><coordinates>-122.3900,37.8100,0</coordinates></Point>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

describe('GPX import', () => {
  it('reads a track, joining multiple segments', () => {
    const r = importTrack(GPX_TRACK);
    expect(r.format).toBe('gpx');
    expect(r.name).toBe('Morning Ride');
    expect(r.track).toEqual([
      [100.5018, 13.7563],
      [100.51, 13.76],
      [100.52, 13.77],
    ]);
    expect(r.elevations).toEqual([12.5, 14, 18]);
  });

  it('handles namespace prefixes and missing elevation', () => {
    const r = importTrack(GPX_NAMESPACED);
    expect(r.track).toEqual([
      [2, 1],
      [2.1, 1.1],
    ]);
    expect(r.elevations.every((e) => Number.isNaN(e))).toBe(true);
  });

  it('falls back to <rte> when there is no track, and reads waypoints', () => {
    const r = importTrack(GPX_ROUTE_AND_WPT);
    expect(r.track).toHaveLength(2);
    expect(r.waypoints.map((w) => w.name)).toEqual(['Eiffel Tower', 'Louvre']);
    expect(r.waypoints[0]!.coordinate[0]).toBeCloseTo(2.2945, 4);
  });

  it('skips malformed points rather than throwing', () => {
    const r = importTrack(`<gpx><trk><trkseg>
      <trkpt lat="10" lon="20"/>
      <trkpt lat="abc" lon="20"/>
      <trkpt lat="999" lon="20"/>
      <trkpt lon="30"/>
      <trkpt lat="11" lon="21"/>
    </trkseg></trk></gpx>`);
    expect(r.track).toEqual([
      [20, 10],
      [21, 11],
    ]);
  });
});

describe('KML import', () => {
  it('reads a LineString nested in Document/Folder plus Point waypoints', () => {
    const r = importTrack(KML_LINE);
    expect(r.format).toBe('kml');
    expect(r.name).toBe('Coast Road');
    expect(r.track).toHaveLength(3);
    expect(r.track[0]).toEqual([-122.4194, 37.7749]);
    expect(r.elevations).toEqual([0, 15, 30]);
    expect(r.waypoints).toHaveLength(1);
    expect(r.waypoints[0]!.name).toBe('Lookout');
  });

  it('accepts coordinates without altitude', () => {
    const r = importTrack(
      `<kml><Placemark><LineString><coordinates>1,2 3,4</coordinates></LineString></Placemark></kml>`,
    );
    expect(r.track).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe('import errors', () => {
  it('rejects empty input', () => {
    expect(() => importTrack('   ')).toThrow(TrackImportError);
  });

  it('rejects non-GPX/KML XML', () => {
    expect(() => importTrack('<html><body>hi</body></html>')).toThrow(
      /Not a GPX or KML/,
    );
  });

  it('rejects a GPX with no usable geometry', () => {
    expect(() => importTrack('<gpx><metadata/></gpx>')).toThrow(
      /No track, route or waypoints/,
    );
  });

  it('rejects a KML with no geometry', () => {
    expect(() => importTrack('<kml><Document/></kml>')).toThrow(
      /No LineString or Point/,
    );
  });

  it('does not hang on deeply nested KML', () => {
    let xml = '<Placemark><name>deep</name><Point><coordinates>1,2</coordinates></Point></Placemark>';
    for (let i = 0; i < 40; i++) xml = `<Folder>${xml}</Folder>`;
    expect(() => importTrack(`<kml>${xml}</kml>`)).not.toThrow();
  });
});
