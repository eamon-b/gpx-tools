/**
 * POI Enrichment Module
 *
 * Provides utilities for enriching GPX routes with Points of Interest (POIs)
 * from OpenStreetMap via the Overpass API.
 */

import { apiClient, getBoundsFromPoints, splitBounds, type POI, type POIRequest } from './api-client.js';
import { haversineDistance } from './distance.js';

export type POIType = 'water' | 'camping' | 'resupply' | 'transport' | 'emergency';

export interface EnrichmentOptions {
  types: POIType[];
  bufferKm?: number;
  maxDistanceFromRoute?: number; // in km
}

export interface EnrichedPOI extends POI {
  distanceFromRoute: number;
  nearestPointIndex: number;
  category: POIType;
}

export interface EnrichmentResult {
  pois: EnrichedPOI[];
  byType: Record<POIType, EnrichedPOI[]>;
  stats: {
    totalFound: number;
    byType: Record<POIType, number>;
    queryChunks: number;
    queryTimeMs: number;
  };
}

/**
 * Find the minimum distance from a POI to any point on the route
 * Returns distance in km
 */
function findMinDistanceToRoute(
  poi: POI,
  routePoints: { lat: number; lon: number }[]
): { distance: number; nearestPointIndex: number } {
  let minDistance = Infinity;
  let nearestIndex = 0;

  for (let i = 0; i < routePoints.length; i++) {
    // haversineDistance returns meters, convert to km
    const dist = haversineDistance(
      poi.lat,
      poi.lon,
      routePoints[i].lat,
      routePoints[i].lon
    ) / 1000;
    if (dist < minDistance) {
      minDistance = dist;
      nearestIndex = i;
    }
  }

  return { distance: minDistance, nearestPointIndex: nearestIndex };
}

/**
 * Categorize a POI based on its OSM tags
 */
function categorizePOI(poi: POI): POIType | null {
  const tags = poi.tags;

  // Water sources
  if (
    tags.amenity === 'drinking_water' ||
    tags.natural === 'spring' ||
    tags.man_made === 'water_tap' ||
    (tags.natural === 'water' && tags.name)
  ) {
    return 'water';
  }

  // Camping
  if (
    tags.tourism === 'camp_site' ||
    tags.tourism === 'alpine_hut' ||
    tags.tourism === 'wilderness_hut' ||
    tags.amenity === 'shelter'
  ) {
    return 'camping';
  }

  // Resupply
  if (
    tags.shop === 'supermarket' ||
    tags.shop === 'convenience' ||
    tags.shop === 'general' ||
    tags.amenity === 'cafe' ||
    tags.amenity === 'restaurant'
  ) {
    return 'resupply';
  }

  // Transport
  if (
    tags.highway === 'bus_stop' ||
    tags.railway === 'station' ||
    tags.railway === 'halt'
  ) {
    return 'transport';
  }

  // Emergency
  if (
    tags.amenity === 'hospital' ||
    tags.amenity === 'pharmacy' ||
    tags.amenity === 'police'
  ) {
    return 'emergency';
  }

  return null;
}

/**
 * Get a human-readable name for a POI
 */
export function getPOIName(poi: POI): string {
  const tags = poi.tags;

  if (tags.name) {
    return tags.name;
  }

  // Generate a name from tags
  const type = tags.amenity || tags.tourism || tags.shop || tags.natural || tags.man_made || tags.highway || tags.railway;
  if (type) {
    return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  return 'Unknown POI';
}

/**
 * Get a description for a POI based on its tags
 */
export function getPOIDescription(poi: POI): string {
  const tags = poi.tags;
  const parts: string[] = [];

  if (tags.description) {
    parts.push(tags.description);
  }

  if (tags.opening_hours) {
    parts.push(`Hours: ${tags.opening_hours}`);
  }

  if (tags.phone) {
    parts.push(`Phone: ${tags.phone}`);
  }

  if (tags.website) {
    parts.push(`Web: ${tags.website}`);
  }

  if (tags.capacity) {
    parts.push(`Capacity: ${tags.capacity}`);
  }

  if (tags.fee) {
    parts.push(tags.fee === 'yes' ? 'Fee required' : 'Free');
  }

  return parts.join(' | ') || 'No additional information';
}

/**
 * Enrich a route with POIs from OpenStreetMap
 */
export async function enrichRoute(
  routePoints: { lat: number; lon: number }[],
  options: EnrichmentOptions,
  onProgress?: (message: string) => void
): Promise<EnrichmentResult> {
  const startTime = Date.now();
  const bufferKm = options.bufferKm ?? 5;
  const maxDistance = options.maxDistanceFromRoute ?? 2;

  onProgress?.('Calculating route bounds...');
  const bounds = getBoundsFromPoints(routePoints, bufferKm);
  const chunks = splitBounds(bounds);

  onProgress?.(`Fetching POIs (${chunks.length} chunks)...`);

  // Fetch POIs from all chunks
  const allPOIs: POI[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`Fetching chunk ${i + 1}/${chunks.length}...`);
    const request: POIRequest = {
      bounds: chunks[i],
      types: options.types,
    };
    const chunkPOIs = await apiClient.fetchPOIs(request);
    allPOIs.push(...chunkPOIs);
  }

  onProgress?.(`Processing ${allPOIs.length} POIs...`);

  // Deduplicate POIs by ID
  const uniquePOIs = new Map<number, POI>();
  for (const poi of allPOIs) {
    if (!uniquePOIs.has(poi.id)) {
      uniquePOIs.set(poi.id, poi);
    }
  }

  // Enrich and filter POIs
  const enrichedPOIs: EnrichedPOI[] = [];
  const byType: Record<POIType, EnrichedPOI[]> = {
    water: [],
    camping: [],
    resupply: [],
    transport: [],
    emergency: [],
  };

  for (const poi of uniquePOIs.values()) {
    const { distance, nearestPointIndex } = findMinDistanceToRoute(poi, routePoints);

    // Filter by max distance from route
    if (distance > maxDistance) {
      continue;
    }

    const category = categorizePOI(poi);
    if (!category || !options.types.includes(category)) {
      continue;
    }

    const enrichedPOI: EnrichedPOI = {
      ...poi,
      distanceFromRoute: distance,
      nearestPointIndex,
      category,
    };

    enrichedPOIs.push(enrichedPOI);
    byType[category].push(enrichedPOI);
  }

  // Sort by position along route
  enrichedPOIs.sort((a, b) => a.nearestPointIndex - b.nearestPointIndex);
  for (const type of options.types) {
    byType[type].sort((a, b) => a.nearestPointIndex - b.nearestPointIndex);
  }

  const stats = {
    totalFound: enrichedPOIs.length,
    byType: {} as Record<POIType, number>,
    queryChunks: chunks.length,
    queryTimeMs: Date.now() - startTime,
  };

  for (const type of options.types) {
    stats.byType[type] = byType[type].length;
  }

  onProgress?.(`Found ${enrichedPOIs.length} POIs along route`);

  return {
    pois: enrichedPOIs,
    byType,
    stats,
  };
}

/**
 * Format POIs as CSV for export
 */
export function exportPOIsToCSV(pois: EnrichedPOI[]): string {
  const headers = ['Name', 'Category', 'Latitude', 'Longitude', 'Distance from Route (km)', 'Description'];
  const rows = pois.map(poi => [
    getPOIName(poi),
    poi.category,
    poi.lat.toFixed(6),
    poi.lon.toFixed(6),
    poi.distanceFromRoute.toFixed(2),
    getPOIDescription(poi).replace(/,/g, ';'),
  ]);

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

/**
 * Format POIs as GPX waypoints for export
 */
export function exportPOIsToGPX(pois: EnrichedPOI[], routeName?: string): string {
  const waypoints = pois.map(poi => {
    const name = getPOIName(poi).replace(/[<>&'"]/g, '');
    const desc = getPOIDescription(poi).replace(/[<>&'"]/g, '');
    const sym = getCategorySymbol(poi.category);

    return `  <wpt lat="${poi.lat}" lon="${poi.lon}">
    <name>${name}</name>
    <desc>${desc}</desc>
    <sym>${sym}</sym>
    <type>${poi.category}</type>
  </wpt>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Tools POI Enrichment"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${routeName ? `${routeName} POIs` : 'Route POIs'}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
${waypoints}
</gpx>`;
}

/**
 * Get GPX symbol for a POI category
 */
function getCategorySymbol(category: POIType): string {
  const symbols: Record<POIType, string> = {
    water: 'Drinking Water',
    camping: 'Campground',
    resupply: 'Shopping Center',
    transport: 'Ground Transportation',
    emergency: 'Medical Facility',
  };
  return symbols[category] || 'Flag, Blue';
}
