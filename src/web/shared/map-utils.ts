/**
 * Shared Map Utilities
 *
 * Common Leaflet map initialization and helpers for all tools.
 */

import L from 'leaflet';

// Fix for default marker icons in Vite/webpack builds
// Use CDN URLs to avoid build issues
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export interface MapPoint {
  lat: number;
  lon: number;
}

export interface PolylineOptions {
  weight?: number;
  opacity?: number;
  dashArray?: string;
}

/**
 * Initialize a Leaflet map with OpenStreetMap tiles
 */
export function initializeMap(containerId: string): L.Map {
  const map = L.map(containerId, {
    zoomControl: true,
    scrollWheelZoom: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  return map;
}

/**
 * Fit map bounds to show all provided points
 */
export function fitMapToBounds(map: L.Map, points: MapPoint[]): void {
  if (points.length === 0) return;

  const bounds = L.latLngBounds(points.map(p => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [20, 20] });
}

/**
 * Create a polyline from route points
 */
export function createRoutePolyline(
  points: MapPoint[],
  color: string,
  options: PolylineOptions = {}
): L.Polyline {
  const latLngs = points.map(p => [p.lat, p.lon] as [number, number]);

  return L.polyline(latLngs, {
    color,
    weight: options.weight ?? 3,
    opacity: options.opacity ?? 0.8,
    dashArray: options.dashArray,
  });
}

/**
 * Create a circle marker (for POIs, day markers, etc.)
 */
export function createCircleMarker(
  lat: number,
  lon: number,
  color: string,
  options: {
    radius?: number;
    fillOpacity?: number;
    popup?: string;
  } = {}
): L.CircleMarker {
  const marker = L.circleMarker([lat, lon], {
    radius: options.radius ?? 8,
    fillColor: color,
    color: '#fff',
    weight: 2,
    fillOpacity: options.fillOpacity ?? 0.8,
  });

  if (options.popup) {
    marker.bindPopup(options.popup);
  }

  return marker;
}

/**
 * Create a standard marker with popup
 */
export function createMarker(
  lat: number,
  lon: number,
  popup?: string
): L.Marker {
  const marker = L.marker([lat, lon]);

  if (popup) {
    marker.bindPopup(popup);
  }

  return marker;
}

/**
 * Create a numbered marker for day indicators
 */
export function createNumberedMarker(
  lat: number,
  lon: number,
  number: number,
  color: string = '#3b82f6'
): L.Marker {
  const icon = L.divIcon({
    className: 'numbered-marker',
    html: `<div style="
      background-color: ${color};
      color: white;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: bold;
      border: 2px solid white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    ">${number}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  return L.marker([lat, lon], { icon });
}

/**
 * Clear all layers from a map except the tile layer
 */
export function clearMapLayers(map: L.Map): void {
  map.eachLayer(layer => {
    if (!(layer instanceof L.TileLayer)) {
      map.removeLayer(layer);
    }
  });
}
