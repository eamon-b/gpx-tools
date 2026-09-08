import { describe, it, expect } from 'vitest';
import { parseKml, parseKmlCoordinates, parseDescriptionFields, kmlToGpxData } from './kml-parser';

const SIMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Test Trail</name>
  <Folder>
    <name>Huts</name>
    <Placemark>
      <name>Goat Pass Hut</name>
      <Point><coordinates>171.5,-42.9,1050</coordinates></Point>
    </Placemark>
  </Folder>
  <Folder>
    <name>Track</name>
    <Placemark>
      <name>Section One</name>
      <LineString><coordinates>171.0,-42.0,100 171.1,-42.1,150</coordinates></LineString>
    </Placemark>
  </Folder>
</Document>
</kml>`;

describe('parseKmlCoordinates', () => {
  it('reads lon,lat,ele tuples into named coordinates', () => {
    const coords = parseKmlCoordinates('171.5,-42.9,1050 171.6,-42.8,900');

    expect(coords).toEqual([
      { lat: -42.9, lon: 171.5, ele: 1050 },
      { lat: -42.8, lon: 171.6, ele: 900 },
    ]);
  });

  it('defaults elevation to 0 when the tuple omits it', () => {
    expect(parseKmlCoordinates('171.5,-42.9')).toEqual([{ lat: -42.9, lon: 171.5, ele: 0 }]);
  });

  it('skips malformed tuples rather than emitting NaN coordinates', () => {
    expect(parseKmlCoordinates('171.5,-42.9,10 bogus 171.6')).toEqual([
      { lat: -42.9, lon: 171.5, ele: 10 },
    ]);
  });

  it('handles newline-separated coordinates', () => {
    expect(parseKmlCoordinates('\n  171.5,-42.9\n  171.6,-42.8\n')).toHaveLength(2);
  });
});

describe('parseDescriptionFields', () => {
  // The shape Esri/ArcGIS exports produce, entity-encoded as it appears in KML.
  const ARCGIS_DESCRIPTION = `&lt;html&gt;&lt;body&gt;
&lt;table&gt;
&lt;tr style="font-weight:bold"&gt;&lt;td&gt;East Ahuriri Hut&lt;/td&gt;&lt;/tr&gt;
&lt;tr&gt;&lt;td&gt;
&lt;table&gt;
&lt;tr&gt;&lt;td&gt;Region&lt;/td&gt;&lt;td&gt;Canterbury&lt;/td&gt;&lt;/tr&gt;
&lt;tr bgcolor="#D4E4F3"&gt;&lt;td&gt;Facilities&lt;/td&gt;&lt;td&gt;6 Bunks&lt;/td&gt;&lt;/tr&gt;
&lt;tr&gt;&lt;td&gt;Bookable&lt;/td&gt;&lt;td&gt;&amp;lt;Null&amp;gt;&lt;/td&gt;&lt;/tr&gt;
&lt;/table&gt;
&lt;/td&gt;&lt;/tr&gt;
&lt;/table&gt;
&lt;/body&gt;&lt;/html&gt;`;

  it('recovers attribute rows from an ArcGIS description table', () => {
    const fields = parseDescriptionFields(ARCGIS_DESCRIPTION);

    expect(fields.Region).toBe('Canterbury');
    expect(fields.Facilities).toBe('6 Bunks');
  });

  it('drops <Null> placeholders instead of storing them as values', () => {
    expect(parseDescriptionFields(ARCGIS_DESCRIPTION)).not.toHaveProperty('Bookable');
  });

  it('returns nothing for a prose description', () => {
    expect(parseDescriptionFields('A nice hut by the river.')).toEqual({});
  });

  it('returns nothing for an empty description', () => {
    expect(parseDescriptionFields('')).toEqual({});
  });
});

describe('parseKml', () => {
  it('records the document name and each placemark folder path', () => {
    const doc = parseKml(SIMPLE_KML);

    expect(doc.name).toBe('Test Trail');
    expect(doc.placemarks).toHaveLength(2);
    expect(doc.placemarks[0].folder).toEqual(['Huts']);
    expect(doc.placemarks[1].folder).toEqual(['Track']);
    expect(doc.folders).toEqual([['Huts'], ['Track']]);
  });

  it('reads point and line geometry', () => {
    const doc = parseKml(SIMPLE_KML);

    expect(doc.placemarks[0].geometries).toEqual([
      { type: 'point', coordinates: { lat: -42.9, lon: 171.5, ele: 1050 } },
    ]);
    expect(doc.placemarks[1].geometries[0].type).toBe('line');
  });

  it('flattens a MultiGeometry so callers never unwrap one', () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>Two parts</name>
  <MultiGeometry>
    <LineString><coordinates>1,1 2,2</coordinates></LineString>
    <LineString><coordinates>3,3 4,4</coordinates></LineString>
  </MultiGeometry>
</Placemark></Document></kml>`;

    const doc = parseKml(kml);

    expect(doc.placemarks[0].geometries).toHaveLength(2);
    expect(doc.placemarks[0].geometries.every(g => g.type === 'line')).toBe(true);
  });

  it('reads polygons with their inner rings', () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>Zone</name>
  <Polygon>
    <outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs>
    <innerBoundaryIs><LinearRing><coordinates>0.2,0.2 0.4,0.2 0.4,0.4 0.2,0.2</coordinates></LinearRing></innerBoundaryIs>
  </Polygon>
</Placemark></Document></kml>`;

    const geometry = parseKml(kml).placemarks[0].geometries[0];

    expect(geometry.type).toBe('polygon');
    if (geometry.type !== 'polygon') throw new Error('expected a polygon');
    expect(geometry.outer).toHaveLength(4);
    expect(geometry.inner).toHaveLength(1);
  });

  it('handles namespace-prefixed elements', () => {
    const kml = `<?xml version="1.0"?>
<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Document>
  <kml:name>Prefixed</kml:name>
  <kml:Folder><kml:name>Points</kml:name>
    <kml:Placemark>
      <kml:name>A</kml:name>
      <kml:Point><kml:coordinates>1,2</kml:coordinates></kml:Point>
    </kml:Placemark>
  </kml:Folder>
</kml:Document></kml:kml>`;

    const doc = parseKml(kml);

    expect(doc.name).toBe('Prefixed');
    expect(doc.placemarks[0].name).toBe('A');
    expect(doc.placemarks[0].folder).toEqual(['Points']);
  });

  it('reads ExtendedData in preference to a description table', () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>A</name>
  <ExtendedData>
    <Data name="Region"><value>Otago</value></Data>
    <SchemaData><SimpleData name="Bunks">12</SimpleData></SchemaData>
  </ExtendedData>
  <Point><coordinates>1,2</coordinates></Point>
</Placemark></Document></kml>`;

    expect(parseKml(kml).placemarks[0].fields).toEqual({
      Region: 'Otago',
      Bunks: '12',
    });
  });

  it('tracks nested folder paths', () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Folder><name>Outer</name>
    <Folder><name>Inner</name>
      <Placemark><name>Deep</name><Point><coordinates>1,2</coordinates></Point></Placemark>
    </Folder>
  </Folder>
</Document></kml>`;

    expect(parseKml(kml).placemarks[0].folder).toEqual(['Outer', 'Inner']);
  });

  it('rejects a document that is not KML', () => {
    expect(() => parseKml('<?xml version="1.0"?><gpx><trk /></gpx>')).toThrow(/Not a KML document/);
  });
});

describe('kmlToGpxData', () => {
  it('turns points into waypoints and lines into tracks by default', () => {
    const data = kmlToGpxData(parseKml(SIMPLE_KML));

    expect(data.waypoints).toHaveLength(1);
    expect(data.waypoints[0].name).toBe('Goat Pass Hut');
    expect(data.waypoints[0].ele).toBe(1050);
    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].segments[0].points).toHaveLength(2);
  });

  it('applies the classifier, dropping placemarks it rejects', () => {
    const data = kmlToGpxData(parseKml(SIMPLE_KML), {
      classify: placemark =>
        placemark.folder[0] === 'Huts' ? { kind: 'waypoint', type: 'hut' } : null,
    });

    expect(data.tracks).toHaveLength(0);
    expect(data.waypoints).toHaveLength(1);
    expect(data.waypoints[0].type).toBe('hut');
  });

  it('orders tracks by the classifier order, not document order', () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Second</name><LineString><coordinates>1,1 2,2</coordinates></LineString></Placemark>
  <Placemark><name>First</name><LineString><coordinates>3,3 4,4</coordinates></LineString></Placemark>
</Document></kml>`;

    const data = kmlToGpxData(parseKml(kml), {
      classify: placemark => ({
        kind: 'track',
        order: placemark.name === 'First' ? 0 : 1,
      }),
    });

    expect(data.tracks.map(t => t.name)).toEqual(['First', 'Second']);
  });

  it('gives a multi-line placemark one segment per line', () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>Split</name>
  <MultiGeometry>
    <LineString><coordinates>1,1 2,2</coordinates></LineString>
    <LineString><coordinates>3,3 4,4</coordinates></LineString>
  </MultiGeometry>
</Placemark></Document></kml>`;

    const data = kmlToGpxData(parseKml(kml));

    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].segments).toHaveLength(2);
  });

  it('carries the optional waypoint fields the classifier supplies', () => {
    const data = kmlToGpxData(parseKml(SIMPLE_KML), {
      classify: placemark =>
        placemark.geometries[0].type === 'point'
          ? {
              kind: 'waypoint',
              type: 'hut',
              desc: '6 bunks',
              link: 'https://doc.govt.nz/x',
            }
          : null,
    });

    expect(data.waypoints[0]).toMatchObject({
      type: 'hut',
      desc: '6 bunks',
      link: 'https://doc.govt.nz/x',
    });
  });
});
