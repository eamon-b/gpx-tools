import type { GpxData, GpxPoint, GpxTrack, GpxWaypoint } from './types';

/**
 * KML / KMZ reader.
 *
 * Trail authorities frequently publish a KMZ alongside (or instead of) a GPX,
 * and the KMZ is usually the richer file: it keeps the folder structure, the per
 * feature attributes and the elevation that a GPX export throws away. This
 * module turns that into the same `GpxData` shape the rest of the library
 * already speaks, so a KMZ can enter any existing pipeline.
 *
 * Parsing walks the DOM by `localName` rather than by CSS selector, because KML
 * in the wild is inconsistent about namespace prefixes (`<Placemark>` vs
 * `<kml:Placemark>`) and a selector would have to know which one it is looking at.
 *
 * `parseKml` needs a `DOMParser`. Browsers have one; a Node script should assign
 * a jsdom `DOMParser` to `globalThis.DOMParser` before calling in.
 */

/** A single KML coordinate. KML writes these `lon,lat[,ele]`; we keep them named. */
export interface KmlCoord {
  lat: number;
  lon: number;
  ele: number;
}

export type KmlGeometry =
  | { type: 'point'; coordinates: KmlCoord }
  | { type: 'line'; coordinates: KmlCoord[] }
  | { type: 'polygon'; outer: KmlCoord[]; inner: KmlCoord[][] };

export interface KmlPlacemark {
  name: string;
  /** Folder names from the document root down to the placemark's own folder. */
  folder: string[];
  /** The raw `<description>` text, HTML and all. */
  description: string;
  /**
   * Key/value pairs recovered from the placemark. Populated from an ArcGIS-style
   * HTML attribute table in the description and from `<ExtendedData>`, whichever
   * the file provides. Empty when the description is prose.
   */
  fields: Record<string, string>;
  /**
   * Every geometry on the placemark. A `<MultiGeometry>` contributes each of its
   * children, so a caller never has to unwrap one.
   */
  geometries: KmlGeometry[];
}

export interface KmlDocument {
  name: string;
  placemarks: KmlPlacemark[];
  /** Every distinct folder path seen, in document order. Useful for writing a classifier. */
  folders: string[][];
}

/** What a placemark should become in GPX output. */
export interface KmlFeature {
  kind: 'waypoint' | 'track';
  /** Defaults to the placemark name. */
  name?: string;
  /** GPX `<type>`; downstream classifiers prefer this over guessing from the name. */
  type?: string;
  desc?: string;
  cmt?: string;
  sym?: string;
  link?: string;
  /** Tracks are emitted in ascending `order`, then in document order. */
  order?: number;
}

export interface KmlToGpxDataOptions {
  /**
   * Decide what each placemark becomes. Return `null` to drop it. Defaults to
   * points becoming waypoints and lines becoming tracks, with polygons dropped
   * because GPX has nothing to represent one.
   */
  classify?: (placemark: KmlPlacemark) => KmlFeature | null;
}

const TABLE_ROW = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;

/** ArcGIS writes `<Null>` for an empty attribute; treat that as absent. */
const NULL_VALUE = /^<?null>?$/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Recover key/value pairs from an ArcGIS-style HTML attribute table.
 *
 * Esri exports write each attribute as a two-cell `<tr>`, wrapped in an outer
 * table whose first row is a single-cell title. That title row has no second
 * cell so it never matches, and the label cell is trimmed to its last line to
 * shed the indentation those exports wrap it in.
 *
 * Returns an empty object for a prose description, which is the signal a caller
 * needs in order to fall back to the description text itself.
 */
export function parseDescriptionFields(description: string): Record<string, string> {
  if (!description) return {};
  const html = decodeEntities(description);
  const fields: Record<string, string> = {};

  TABLE_ROW.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TABLE_ROW.exec(html)) !== null) {
    const rawKey = stripTags(match[1]);
    // A nested table puts the parent title in the same cell; the label is the last line.
    const key = rawKey.split('\n').pop()!.trim();
    if (!key) continue;
    const value = decodeEntities(stripTags(match[2])).trim();
    if (!value || NULL_VALUE.test(value)) continue;
    fields[key] = value;
  }

  return fields;
}

function children(el: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
    if (child.localName === localName) out.push(child);
  }
  return out;
}

function childText(el: Element, localName: string): string {
  for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
    if (child.localName === localName) return (child.textContent || '').trim();
  }
  return '';
}

/** Parse a KML `<coordinates>` blob. Tuples are `lon,lat[,ele]`, whitespace separated. */
export function parseKmlCoordinates(text: string): KmlCoord[] {
  const coords: KmlCoord[] = [];
  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue;
    const parts = token.split(',');
    if (parts.length < 2) continue;
    const lon = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = parts.length > 2 ? parseFloat(parts[2]) : 0;
    coords.push({ lat, lon, ele: Number.isFinite(ele) ? ele : 0 });
  }
  return coords;
}

function readRing(boundary: Element): KmlCoord[] {
  const ring = children(boundary, 'LinearRing')[0] ?? boundary;
  return parseKmlCoordinates(childText(ring, 'coordinates'));
}

function readGeometries(el: Element, out: KmlGeometry[]): void {
  for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
    switch (child.localName) {
      case 'Point': {
        const coords = parseKmlCoordinates(childText(child, 'coordinates'));
        if (coords.length > 0) out.push({ type: 'point', coordinates: coords[0] });
        break;
      }
      case 'LineString': {
        const coords = parseKmlCoordinates(childText(child, 'coordinates'));
        if (coords.length > 0) out.push({ type: 'line', coordinates: coords });
        break;
      }
      case 'LinearRing': {
        // A LinearRing directly on a Placemark is a closed line, not a polygon
        // boundary; the boundary case is handled under Polygon below.
        const coords = parseKmlCoordinates(childText(child, 'coordinates'));
        if (coords.length > 0) out.push({ type: 'line', coordinates: coords });
        break;
      }
      case 'Polygon': {
        const outerEl = children(child, 'outerBoundaryIs')[0];
        const outer = outerEl ? readRing(outerEl) : [];
        const inner = children(child, 'innerBoundaryIs')
          .map(readRing)
          .filter(ring => ring.length > 0);
        if (outer.length > 0) out.push({ type: 'polygon', outer, inner });
        break;
      }
      case 'MultiGeometry':
        readGeometries(child, out);
        break;
      default:
        break;
    }
  }
}

function readExtendedData(placemark: Element): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const ext of children(placemark, 'ExtendedData')) {
    for (const data of children(ext, 'Data')) {
      const key = data.getAttribute('name');
      if (key) fields[key] = childText(data, 'value');
    }
    for (const schema of children(ext, 'SchemaData')) {
      for (const simple of children(schema, 'SimpleData')) {
        const key = simple.getAttribute('name');
        if (key) fields[key] = (simple.textContent || '').trim();
      }
    }
  }
  return fields;
}

function readPlacemark(el: Element, folder: string[]): KmlPlacemark {
  const description = childText(el, 'description');
  const geometries: KmlGeometry[] = [];
  readGeometries(el, geometries);
  return {
    name: childText(el, 'name'),
    folder,
    description,
    // ExtendedData is structured data and wins over anything scraped from HTML.
    fields: { ...parseDescriptionFields(description), ...readExtendedData(el) },
    geometries,
  };
}

/**
 * Parse KML XML into placemarks carrying their folder path and attributes.
 *
 * Requires a `DOMParser` (see the module note about Node).
 */
export function parseKml(xml: string): KmlDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  const parseError = doc.getElementsByTagName('parsererror')[0];
  if (parseError) {
    throw new Error('Invalid KML XML: ' + parseError.textContent);
  }

  const root = doc.documentElement;
  if (!root || (root.localName !== 'kml' && root.localName !== 'Document')) {
    throw new Error(`Not a KML document: root element is <${root ? root.localName : 'empty'}>`);
  }

  const placemarks: KmlPlacemark[] = [];
  const folders: string[][] = [];
  const seenFolders = new Set<string>();
  let documentName = '';

  const visit = (el: Element, path: string[]): void => {
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      if (child.localName === 'Placemark') {
        placemarks.push(readPlacemark(child, path));
        continue;
      }
      if (child.localName === 'Folder' || child.localName === 'Document') {
        const name = childText(child, 'name');
        // A <Document> wrapping the file is structure, not a folder level, and
        // its name is the document's name.
        if (child.localName === 'Document') {
          if (!documentName) documentName = name;
          visit(child, path);
          continue;
        }
        const nextPath = name ? [...path, name] : path;
        const key = nextPath.join(' ');
        if (name && !seenFolders.has(key)) {
          seenFolders.add(key);
          folders.push(nextPath);
        }
        visit(child, nextPath);
        continue;
      }
      if (child.localName === 'name' && !documentName && el.localName === 'kml') {
        documentName = (child.textContent || '').trim();
      }
    }
  };

  visit(root, []);

  return { name: documentName, placemarks, folders };
}

/**
 * Read a KMZ archive (a zip whose `doc.kml` holds the document).
 *
 * jszip is already a dependency for the tools' ZIP exports, so this costs
 * nothing extra. Any `.kml` entry is accepted, preferring `doc.kml`.
 */
export async function parseKmz(archive: ArrayBuffer | Uint8Array | Blob): Promise<KmlDocument> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(archive as ArrayBuffer);

  const names = Object.keys(zip.files).filter(name => name.toLowerCase().endsWith('.kml'));
  if (names.length === 0) {
    throw new Error('KMZ archive contains no .kml file');
  }
  const entry = names.find(name => name.toLowerCase().endsWith('doc.kml')) ?? names[0];

  return parseKml(await zip.files[entry].async('string'));
}

function defaultClassify(placemark: KmlPlacemark): KmlFeature | null {
  const kind = placemark.geometries[0]?.type;
  if (kind === 'point') return { kind: 'waypoint' };
  if (kind === 'line') return { kind: 'track' };
  return null;
}

/**
 * Convert a parsed KML document into `GpxData`.
 *
 * Each placemark becomes either a waypoint or a track, as decided by `classify`.
 * A placemark carrying several line geometries becomes one track with one
 * `<trkseg>` per line, which is how a `<MultiGeometry>` should survive the trip.
 */
export function kmlToGpxData(doc: KmlDocument, options: KmlToGpxDataOptions = {}): GpxData {
  const classify = options.classify ?? defaultClassify;

  const waypoints: GpxWaypoint[] = [];
  const ordered: Array<{ order: number; index: number; track: GpxTrack }> = [];

  doc.placemarks.forEach((placemark, index) => {
    const feature = classify(placemark);
    if (!feature) return;
    const name = feature.name ?? placemark.name;

    if (feature.kind === 'waypoint') {
      for (const geometry of placemark.geometries) {
        if (geometry.type !== 'point') continue;
        waypoints.push({
          lat: geometry.coordinates.lat,
          lon: geometry.coordinates.lon,
          ele: geometry.coordinates.ele,
          name,
          desc: feature.desc ?? '',
          ...(feature.type ? { type: feature.type } : {}),
          ...(feature.cmt ? { cmt: feature.cmt } : {}),
          ...(feature.sym ? { sym: feature.sym } : {}),
          ...(feature.link ? { link: feature.link } : {}),
        });
      }
      return;
    }

    const segments = placemark.geometries
      .filter(
        (geometry): geometry is Extract<KmlGeometry, { type: 'line' }> => geometry.type === 'line'
      )
      .map(geometry => ({
        points: geometry.coordinates.map<GpxPoint>(c => ({
          lat: c.lat,
          lon: c.lon,
          ele: c.ele,
          time: null,
        })),
      }));
    if (segments.length === 0) return;

    ordered.push({
      order: feature.order ?? index,
      index,
      track: { name, segments },
    });
  });

  ordered.sort((a, b) => a.order - b.order || a.index - b.index);

  return { tracks: ordered.map(entry => entry.track), routes: [], waypoints };
}
