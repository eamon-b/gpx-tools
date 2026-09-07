import type { GpxData, GpxTrack, GpxRoute, GpxWaypoint, GpxPoint } from './types';

/**
 * Parse GPX XML content into structured data.
 *
 * Supports:
 * - <trk> elements (tracks with track segments)
 * - <rte> elements (routes with route points)
 * - <wpt> elements (waypoints)
 *
 * Routes (<rte>) are converted to a track-like structure for compatibility
 * with existing processing functions.
 */
export function parseGpx(xml: string): GpxData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // Check for parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid GPX XML: ' + parseError.textContent);
  }

  // Parse tracks (<trk> elements with <trkseg> containing <trkpt>)
  const tracks: GpxTrack[] = Array.from(doc.querySelectorAll('trk')).map(trk => ({
    name: trk.querySelector('name')?.textContent || '',
    segments: Array.from(trk.querySelectorAll('trkseg')).map(seg => ({
      points: Array.from(seg.querySelectorAll('trkpt')).map(pt => ({
        lat: parseFloat(pt.getAttribute('lat') || '0'),
        lon: parseFloat(pt.getAttribute('lon') || '0'),
        ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
        time: pt.querySelector('time')?.textContent || null
      }))
    }))
  }));

  // Parse routes (<rte> elements with <rtept> children)
  const routes: GpxRoute[] = Array.from(doc.querySelectorAll('rte')).map(rte => ({
    name: rte.querySelector('name')?.textContent || '',
    points: Array.from(rte.querySelectorAll('rtept')).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat') || '0'),
      lon: parseFloat(pt.getAttribute('lon') || '0'),
      ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
      time: pt.querySelector('time')?.textContent || null
    }))
  }));

  // Parse waypoints (<wpt> elements)
  const waypoints: GpxWaypoint[] = Array.from(doc.querySelectorAll('wpt')).map(wpt => {
    // Only set what the file actually carries, so a waypoint without a <type>
    // stays deep-equal to one parsed before these fields existed.
    const optional: Partial<GpxWaypoint> = {};
    const type = wpt.querySelector('type')?.textContent;
    const cmt = wpt.querySelector('cmt')?.textContent;
    const sym = wpt.querySelector('sym')?.textContent;
    const link = wpt.querySelector('link')?.getAttribute('href');
    if (type) optional.type = type;
    if (cmt) optional.cmt = cmt;
    if (sym) optional.sym = sym;
    if (link) optional.link = link;

    return {
      lat: parseFloat(wpt.getAttribute('lat') || '0'),
      lon: parseFloat(wpt.getAttribute('lon') || '0'),
      ele: parseFloat(wpt.querySelector('ele')?.textContent || '0'),
      name: wpt.querySelector('name')?.textContent || '',
      desc: wpt.querySelector('desc')?.textContent || '',
      ...optional
    };
  });

  return { tracks, routes, waypoints };
}

/**
 * Escape XML special characters
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate GPX XML from structured data
 */
export function generateGpx(
  trackName: string,
  points: GpxPoint[],
  waypoints: GpxWaypoint[]
): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Tools"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
`;

  // Add waypoints
  for (const wpt of waypoints) {
    xml += `  <wpt lat="${wpt.lat}" lon="${wpt.lon}">
`;
    if (wpt.ele !== 0) {
      xml += `    <ele>${wpt.ele}</ele>
`;
    }
    if (wpt.name) {
      xml += `    <name>${escapeXml(wpt.name)}</name>
`;
    }
    if (wpt.desc) {
      xml += `    <desc>${escapeXml(wpt.desc)}</desc>
`;
    }
    xml += `  </wpt>
`;
  }

  // Add track
  xml += `  <trk>
    <name>${escapeXml(trackName)}</name>
    <trkseg>
`;

  for (const pt of points) {
    xml += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">
`;
    if (pt.ele !== 0) {
      xml += `        <ele>${pt.ele}</ele>
`;
    }
    if (pt.time) {
      xml += `        <time>${pt.time}</time>
`;
    }
    xml += `      </trkpt>
`;
  }

  xml += `    </trkseg>
  </trk>
</gpx>`;

  return xml;
}

export interface GpxMetadata {
  name?: string;
  desc?: string;
  author?: string;
  /** Free-form provenance line, written as a `<keywords>` element. */
  keywords?: string;
  /** Decimal places for coordinates. Six is ~0.1 m, enough for any trail. */
  coordinatePrecision?: number;
  creator?: string;
}

function formatCoord(value: number, precision: number): string {
  return String(Number(value.toFixed(precision)));
}

/**
 * Serialise a whole GpxData document: every track with its segments, every
 * waypoint with the optional fields it carries.
 *
 * `generateGpx` above flattens everything into a single track, which is the
 * right shape for the splitter and optimiser tools but loses the structure of a
 * multi-section trail. Use this when the track boundaries matter.
 */
export function writeGpx(data: GpxData, metadata: GpxMetadata = {}): string {
  const precision = metadata.coordinatePrecision ?? 6;
  const creator = metadata.creator ?? 'GPX Tools';
  const parts: string[] = [];

  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    `<gpx version="1.1" creator="${escapeXml(creator)}"\n` +
      '  xmlns="http://www.topografix.com/GPX/1/1"\n' +
      '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n' +
      '  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">'
  );

  if (metadata.name || metadata.desc || metadata.author || metadata.keywords) {
    parts.push('  <metadata>');
    if (metadata.name) parts.push(`    <name>${escapeXml(metadata.name)}</name>`);
    if (metadata.desc) parts.push(`    <desc>${escapeXml(metadata.desc)}</desc>`);
    if (metadata.author) {
      parts.push(`    <author><name>${escapeXml(metadata.author)}</name></author>`);
    }
    if (metadata.keywords) {
      parts.push(`    <keywords>${escapeXml(metadata.keywords)}</keywords>`);
    }
    parts.push('  </metadata>');
  }

  for (const wpt of data.waypoints) {
    parts.push(
      `  <wpt lat="${formatCoord(wpt.lat, precision)}" lon="${formatCoord(wpt.lon, precision)}">`
    );
    if (wpt.ele !== 0) parts.push(`    <ele>${Math.round(wpt.ele * 10) / 10}</ele>`);
    if (wpt.name) parts.push(`    <name>${escapeXml(wpt.name)}</name>`);
    if (wpt.cmt) parts.push(`    <cmt>${escapeXml(wpt.cmt)}</cmt>`);
    if (wpt.desc) parts.push(`    <desc>${escapeXml(wpt.desc)}</desc>`);
    if (wpt.link) parts.push(`    <link href="${escapeXml(wpt.link)}" />`);
    if (wpt.sym) parts.push(`    <sym>${escapeXml(wpt.sym)}</sym>`);
    if (wpt.type) parts.push(`    <type>${escapeXml(wpt.type)}</type>`);
    parts.push('  </wpt>');
  }

  for (const track of data.tracks) {
    parts.push('  <trk>');
    if (track.name) parts.push(`    <name>${escapeXml(track.name)}</name>`);
    for (const segment of track.segments) {
      parts.push('    <trkseg>');
      for (const pt of segment.points) {
        const open = `      <trkpt lat="${formatCoord(pt.lat, precision)}" lon="${formatCoord(pt.lon, precision)}">`;
        if (pt.ele === 0 && !pt.time) {
          parts.push(`${open}</trkpt>`);
          continue;
        }
        parts.push(open);
        if (pt.ele !== 0) parts.push(`        <ele>${Math.round(pt.ele * 10) / 10}</ele>`);
        if (pt.time) parts.push(`        <time>${pt.time}</time>`);
        parts.push('      </trkpt>');
      }
      parts.push('    </trkseg>');
    }
    parts.push('  </trk>');
  }

  parts.push('</gpx>');
  return parts.join('\n') + '\n';
}
