// Trail viewer module - extracted from inline script to fix Vite HTML proxy issues
// This module handles map, elevation profile, waypoints table, and direction reversal

import type * as Leaflet from 'leaflet';
declare const L: typeof Leaflet;

interface TrackPoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number;
}

interface Waypoint {
  name?: string;
  type?: string;
  lat: number;
  lon: number;
  elevation?: number;
  distance?: number;
  totalDistance?: number;
  ascent?: number;
  descent?: number;
  totalAscent?: number;
  totalDescent?: number;
  description?: string;
  trackIndex?: number;
}

interface RouteVariant {
  name: string;
  type: 'alternate' | 'side-trip';
  distance?: number;
  startDistance?: number;
  endDistance?: number;
  elevation?: { ascent?: number; descent?: number };
  points?: TrackPoint[];
}

interface DirectionConfig {
  default: string;
  reversed: string;
}

interface Trail {
  config: {
    id: string;
    name: string;
    region: string;
    direction?: DirectionConfig;
  };
  track: {
    points: TrackPoint[];
    displayPoints?: TrackPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints?: Waypoint[];
  alternates?: RouteVariant[];
  sideTrips?: RouteVariant[];
}

// Map state
let map: L.Map | null = null;
let hoverMarker: L.Marker | null = null;
let mainRoutePolyline: L.Polyline | null = null;
let trackPoints: TrackPoint[] = [];
let displayPoints: TrackPoint[] = [];
let maxDistance = 0;
let waypointMarkers: Array<{ marker: L.Marker; waypoint: Waypoint; index: number }> = [];
let expandedWaypointIndex: number | null = null;

// Trail direction state management
const trailState = {
  isReversed: false,
  originalTrail: null as Trail | null,
  reversedTrail: null as Trail | null,
  get currentTrail(): Trail | null {
    return this.isReversed ? this.reversedTrail : this.originalTrail;
  }
};

// Waypoint icon configuration
const WAYPOINT_ICONS: Record<string, { icon: string }> = {
  town: { icon: '\u{1F3D8}\u{FE0F}' },
  hut: { icon: '\u{1F6D6}' },
  campsite: { icon: '\u26FA' },
  water: { icon: '\u{1F4A7}' },
  'water-tank': { icon: '\u{1F6B0}' },
  mountain: { icon: '\u26F0\u{FE0F}' },
  'side-trip': { icon: '\u{1F97E}' },
  'caravan-park': { icon: '\u{1F3D5}\u{FE0F}' },
  'trail-head': { icon: '\u{1F697}' },
  food: { icon: '\u{1F374}' },
  'road-crossing': { icon: '\u{1F6E3}\u{FE0F}' },
  waypoint: { icon: '\u{1F4CD}' }
};

// Safe min/max for large arrays (avoids stack overflow with spread operator)
function getMinMax(arr: number[]): { min: number; max: number } {
  if (arr.length === 0) return { min: 0, max: 0 };
  let min = arr[0], max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  return { min, max };
}

// Debounce helper for resize events
function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}

// HTML escape helper for XSS prevention
function escapeHtml(text: unknown): string {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Convert plain-text URLs to clickable links (after HTML escaping)
function autoLinkUrls(text: string): string {
  const escaped = escapeHtml(text);
  // Match URLs, avoiding trailing punctuation that's likely not part of the URL
  return escaped.replace(
    /https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

// Binary search to find nearest point by distance (O(log n) instead of O(n))
function findNearestByDistance(points: TrackPoint[], targetDist: number): number {
  if (points.length === 0) return 0;
  let low = 0, high = points.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].dist < targetDist) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const candidates = [low - 1, low, low + 1].filter(i => i >= 0 && i < points.length);
  return candidates.reduce((best, i) =>
    Math.abs(points[i].dist - targetDist) < Math.abs(points[best].dist - targetDist) ? i : best
  , candidates[0]);
}

function initMap(trail: Trail): void {
  if (typeof L === 'undefined') {
    const mapContainer = document.getElementById('trail-map');
    if (mapContainer) {
      mapContainer.innerHTML = '<p style="padding: 2rem; text-align: center; color: #666;">Map unavailable. Please check your internet connection or try disabling ad blockers.</p>';
    }
    console.error('Leaflet library failed to load');
    return;
  }

  try {
    map = L.map('trail-map', {
      zoomControl: true,
      scrollWheelZoom: true
    });

    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap'
    }).addTo(map);

    maxDistance = trail.track.totalDistance;

    drawMainRoute(trail);
    drawAlternates(trail.alternates || []);
    drawSideTrips(trail.sideTrips || []);
    drawWaypointMarkers(trail.waypoints || []);

    hoverMarker = L.marker([0, 0], {
      icon: L.divIcon({
        className: 'elevation-hover-marker',
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      })
    });

    fitMapToBounds(trail);
  } catch (error) {
    console.error('Failed to initialize map:', error);
    const mapContainer = document.getElementById('trail-map');
    if (mapContainer) {
      mapContainer.innerHTML = '<p style="padding: 2rem; text-align: center; color: #666;">Failed to load map. Please try refreshing the page.</p>';
    }
  }
}

function drawMainRoute(trail: Trail): void {
  displayPoints = trail.track.displayPoints || trail.track.points;
  if (!displayPoints || displayPoints.length === 0) return;

  const latLngs = displayPoints.map(p => [p.lat, p.lon] as [number, number]);

  mainRoutePolyline = L.polyline(latLngs, {
    color: '#2196F3',
    weight: 3,
    opacity: 0.9
  }).addTo(map!);

  trackPoints = trail.track.points;

  mainRoutePolyline.on('mousemove', handleMapHover);
  mainRoutePolyline.on('mouseout', hideElevationHover);
}

function drawAlternates(alternates: RouteVariant[]): void {
  alternates.forEach(alt => {
    if (!alt.points || alt.points.length === 0) return;

    const latLngs = alt.points.map(p => [p.lat, p.lon] as [number, number]);
    L.polyline(latLngs, {
      color: '#ff9800',
      weight: 3,
      opacity: 0.8
    }).addTo(map!).bindPopup(`<strong>${escapeHtml(alt.name)}</strong><br>${escapeHtml(alt.distance)} km`);
  });
}

function drawSideTrips(sideTrips: RouteVariant[]): void {
  sideTrips.forEach(trip => {
    if (!trip.points || trip.points.length === 0) return;

    const latLngs = trip.points.map(p => [p.lat, p.lon] as [number, number]);
    L.polyline(latLngs, {
      color: '#9c27b0',
      weight: 3,
      opacity: 0.8
    }).addTo(map!).bindPopup(`<strong>${escapeHtml(trip.name)}</strong><br>${escapeHtml(trip.distance)} km`);
  });
}

function createWaypointIcon(type?: string): L.DivIcon {
  const config = WAYPOINT_ICONS[type || 'waypoint'] || WAYPOINT_ICONS.waypoint;
  return L.divIcon({
    className: `waypoint-marker ${type || 'waypoint'}`,
    html: config.icon,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12]
  });
}

function drawWaypointMarkers(waypoints: Waypoint[]): void {
  waypointMarkers = [];
  if (!waypoints || waypoints.length === 0) return;

  waypoints.forEach((wp, index) => {
    const marker = L.marker([wp.lat, wp.lon], {
      icon: createWaypointIcon(wp.type)
    }).addTo(map!).bindPopup(`
      <strong>${escapeHtml(wp.name || 'Waypoint')}</strong><br>
      ${escapeHtml(wp.type || 'waypoint')}<br>
      ${(wp.totalDistance || 0).toFixed(1)} km along trail
      ${wp.elevation ? `<br>${Math.round(wp.elevation)}m elevation` : ''}
      <br><a href="#" class="popup-show-in-table" data-waypoint-index="${index}">Show in table</a>
    `);

    waypointMarkers.push({ marker, waypoint: wp, index });
  });
}

function fitMapToBounds(trail: Trail): void {
  const bounds = L.latLngBounds([]);

  const pts = trail.track.displayPoints || trail.track.points;
  pts.forEach(p => bounds.extend([p.lat, p.lon]));

  (trail.alternates || []).forEach(alt => {
    (alt.points || []).forEach(p => bounds.extend([p.lat, p.lon]));
  });

  (trail.sideTrips || []).forEach(trip => {
    (trip.points || []).forEach(p => bounds.extend([p.lat, p.lon]));
  });

  map!.fitBounds(bounds, { padding: [20, 20] });
}

function handleMapHover(e: L.LeafletMouseEvent): void {
  if (!displayPoints.length) return;

  const latlng = e.latlng;
  let nearestPoint: TrackPoint | null = null;
  let minDist = Infinity;

  for (const p of displayPoints) {
    const dist = Math.sqrt(
      Math.pow(p.lat - latlng.lat, 2) +
      Math.pow(p.lon - latlng.lng, 2)
    );
    if (dist < minDist) {
      minDist = dist;
      nearestPoint = p;
    }
  }

  if (nearestPoint) {
    showElevationHover(nearestPoint.dist, nearestPoint.ele);
  }
}

function showElevationHover(distance: number, elevation: number): void {
  const canvas = document.getElementById('elevation-canvas') as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const width = rect.width - padding.left - padding.right;

  const xPos = padding.left + (distance / maxDistance) * width;

  const hoverLine = document.querySelector('.elevation-profile .hover-line') as HTMLElement;
  const tooltip = document.querySelector('.elevation-profile .hover-tooltip') as HTMLElement;

  if (hoverLine) {
    hoverLine.style.left = `${xPos}px`;
    hoverLine.style.display = 'block';
  }

  if (tooltip) {
    tooltip.style.left = `${xPos + 10}px`;
    tooltip.textContent = `${distance.toFixed(1)} km, ${Math.round(elevation)}m`;
    tooltip.style.display = 'block';
  }
}

function hideElevationHover(): void {
  const hoverLine = document.querySelector('.elevation-profile .hover-line') as HTMLElement;
  const tooltip = document.querySelector('.elevation-profile .hover-tooltip') as HTMLElement;
  if (hoverLine) hoverLine.style.display = 'none';
  if (tooltip) tooltip.style.display = 'none';
}

function handleTableRowClick(waypointIndex: number): void {
  const markerInfo = waypointMarkers[waypointIndex];
  if (!markerInfo) return;

  document.getElementById('trail-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const targetZoom = Math.max(map!.getZoom(), 13);
  map!.setView([markerInfo.waypoint.lat, markerInfo.waypoint.lon], targetZoom);

  markerInfo.marker.openPopup();

  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (row) {
    row.classList.add('highlight-selected');
    setTimeout(() => row.classList.remove('highlight-selected'), 2000);
  }
}

function scrollToTableRow(waypointIndex: number): void {
  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (!row) return;

  row.scrollIntoView({ behavior: 'smooth', block: 'center' });

  row.classList.add('highlight-selected');
  setTimeout(() => row.classList.remove('highlight-selected'), 2000);

  // Expand the row (collapse any other expanded row first, per accordion behavior)
  if (expandedWaypointIndex !== null && expandedWaypointIndex !== waypointIndex) {
    collapseWaypointDetail(expandedWaypointIndex);
  }
  if (expandedWaypointIndex !== waypointIndex) {
    const trail = trailState.currentTrail;
    const wp = trail?.waypoints?.[waypointIndex];
    if (wp) {
      expandWaypointDetail(waypointIndex, wp);
      expandedWaypointIndex = waypointIndex;
    }
  }
}

function toggleWaypointExpansion(waypointIndex: number): void {
  if (expandedWaypointIndex === waypointIndex) {
    collapseWaypointDetail(waypointIndex);
    expandedWaypointIndex = null;
  } else {
    if (expandedWaypointIndex !== null) {
      collapseWaypointDetail(expandedWaypointIndex);
    }
    const trail = trailState.currentTrail;
    const wp = trail?.waypoints?.[waypointIndex];
    if (wp) {
      expandWaypointDetail(waypointIndex, wp);
      expandedWaypointIndex = waypointIndex;
    }
  }
}

function expandWaypointDetail(waypointIndex: number, wp: Waypoint): void {
  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (!row) return;

  // Add expanded styling to the row
  row.classList.add('waypoint-expanded');
  row.setAttribute('aria-expanded', 'true');
  const chevron = row.querySelector('.expand-chevron');
  if (chevron) chevron.classList.add('expanded');

  // Determine colspan dynamically
  const headerCells = document.querySelectorAll('.waypoints-table thead th');
  const colspan = headerCells.length || 9;

  // Build detail panel HTML
  const hasDesc = !!wp.description;
  const descHtml = hasDesc
    ? `<div class="waypoint-detail-description">${autoLinkUrls(wp.description!)}</div>`
    : '';
  const coordsHtml = `<span class="waypoint-detail-coords">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)} · <a href="https://www.google.com/maps?q=${wp.lat},${wp.lon}" target="_blank" rel="noopener noreferrer">Google Maps</a></span>`;

  const detailHtml = `
    <tr class="waypoint-detail-row" id="waypoint-detail-${waypointIndex}">
      <td colspan="${colspan}">
        <div class="waypoint-detail-panel${hasDesc ? '' : ' no-description'}">
          ${descHtml}
          <div class="waypoint-detail-actions">
            <a href="#" class="waypoint-show-on-map" data-waypoint-index="${waypointIndex}">Show on map</a>
            ${coordsHtml}
          </div>
        </div>
      </td>
    </tr>
  `;

  row.insertAdjacentHTML('afterend', detailHtml);
}

function collapseWaypointDetail(waypointIndex: number): void {
  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (row) {
    row.classList.remove('waypoint-expanded');
    row.setAttribute('aria-expanded', 'false');
    const chevron = row.querySelector('.expand-chevron');
    if (chevron) chevron.classList.remove('expanded');
  }
  const detailRow = document.getElementById(`waypoint-detail-${waypointIndex}`);
  if (detailRow) {
    detailRow.remove();
  }
}

function setupElevationHover(): void {
  const canvas = document.getElementById('elevation-canvas') as HTMLCanvasElement;
  const profileDiv = document.querySelector('.elevation-profile') as HTMLElement;

  const hoverLine = document.createElement('div');
  hoverLine.className = 'hover-line';
  profileDiv.appendChild(hoverLine);

  const tooltip = document.createElement('div');
  tooltip.className = 'hover-tooltip';
  profileDiv.appendChild(tooltip);

  canvas.addEventListener('mousemove', (e) => {
    if (!trackPoints.length || !map) return;

    const rect = canvas.getBoundingClientRect();
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const width = rect.width - padding.left - padding.right;

    const x = e.clientX - rect.left - padding.left;
    if (x < 0 || x > width) {
      hideElevationHover();
      if (map.hasLayer(hoverMarker!)) map.removeLayer(hoverMarker!);
      return;
    }

    const distance = (x / width) * maxDistance;

    const nearestIndex = findNearestByDistance(trackPoints, distance);
    const nearestPoint = trackPoints[nearestIndex];

    if (nearestPoint) {
      hoverMarker!.setLatLng([nearestPoint.lat, nearestPoint.lon]);
      if (!map.hasLayer(hoverMarker!)) {
        hoverMarker!.addTo(map);
      }
      showElevationHover(nearestPoint.dist, nearestPoint.ele);
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (map && map.hasLayer(hoverMarker!)) {
      map.removeLayer(hoverMarker!);
    }
    hideElevationHover();
  });
}

async function loadTrailData(trailId: string): Promise<Trail | null> {
  try {
    const response = await fetch(`/data/generated/${trailId}.json`);
    if (!response.ok) throw new Error('Trail data not found');
    return await response.json();
  } catch (error) {
    console.error('Failed to load trail data:', error);
    return null;
  }
}

function updateStats(trail: Trail): void {
  document.getElementById('distance')!.textContent = trail.track.totalDistance.toFixed(1);
  document.getElementById('ascent')!.textContent = Math.round(trail.track.totalAscent).toString();
  document.getElementById('descent')!.textContent = Math.round(trail.track.totalDescent).toString();
  document.getElementById('points')!.textContent = trail.track.points.length.toLocaleString();
}

function drawElevationProfile(points: TrackPoint[]): void {
  const canvas = document.getElementById('elevation-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  if (points.length === 0) return;

  const elevations = points.map(p => p.ele);
  const distances = points.map(p => p.dist);
  const { min: minEle, max: maxEle } = getMinMax(elevations);
  const { max: maxDist } = getMinMax(distances);

  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const width = rect.width - padding.left - padding.right;
  const height = rect.height - padding.top - padding.bottom;

  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + width, y);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.strokeStyle = '#2196F3';
  ctx.lineWidth = 2;

  points.forEach((point, i) => {
    const x = padding.left + (point.dist / maxDist) * width;
    const y = padding.top + height - ((point.ele - minEle) / (maxEle - minEle)) * height;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  ctx.lineTo(padding.left + width, padding.top + height);
  ctx.lineTo(padding.left, padding.top + height);
  ctx.closePath();
  ctx.fillStyle = 'rgba(33, 150, 243, 0.1)';
  ctx.fill();

  ctx.fillStyle = '#666';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(maxEle)}m`, padding.left - 5, padding.top + 10);
  ctx.fillText(`${Math.round(minEle)}m`, padding.left - 5, padding.top + height);

  ctx.textAlign = 'center';
  ctx.fillText('0 km', padding.left, padding.top + height + 20);
  ctx.fillText(`${maxDist.toFixed(0)} km`, padding.left + width, padding.top + height + 20);
}

function renderWaypoints(waypoints: Waypoint[] | undefined, alternates: RouteVariant[] | undefined, sideTrips: RouteVariant[] | undefined): void {
  const container = document.getElementById('waypoints-container')!;

  if (!waypoints || waypoints.length === 0) {
    container.innerHTML = '<p>No waypoints defined</p>';
    return;
  }

  const resupplyKeywords = ['grocer', 'market', 'foodland', 'iga', 'wool', 'coles', 'general', 'servo'];

  function isResupply(wp: Waypoint): boolean {
    const text = ((wp.name || '') + ' ' + (wp.description || '')).toLowerCase();
    return resupplyKeywords.some(kw => text.includes(kw));
  }

  function getRowClass(wp: Waypoint): string {
    if (wp.type === 'town') return 'highlight-town';
    if (isResupply(wp)) return 'highlight-resupply';
    return '';
  }

  function getTypeClass(type?: string): string {
    const typeMap: Record<string, string> = {
      'town': 'type-town',
      'hut': 'type-hut',
      'campsite': 'type-campsite',
      'water': 'type-water',
      'water-tank': 'type-water-tank',
      'mountain': 'type-mountain',
      'side-trip': 'type-side-trip',
      'caravan-park': 'type-caravan-park',
      'trail-head': 'type-trail-head',
      'food': 'type-food',
      'road-crossing': 'type-road-crossing'
    };
    return typeMap[type || ''] || '';
  }

  interface TableRow {
    rowType: 'waypoint' | 'variant-start' | 'variant-end';
    distance: number;
    data: Waypoint | RouteVariant;
    waypointIndex?: number;
  }

  const allVariants = [...(alternates || []), ...(sideTrips || [])];
  const tableRows: TableRow[] = [];

  waypoints.forEach((wp, waypointIndex) => {
    tableRows.push({
      rowType: 'waypoint',
      distance: wp.totalDistance ?? 0,
      data: wp,
      waypointIndex
    });
  });

  for (const variant of allVariants) {
    if (variant.startDistance != null) {
      tableRows.push({
        rowType: 'variant-start',
        distance: variant.startDistance,
        data: variant
      });
    }
    if (variant.type === 'alternate' && variant.endDistance != null) {
      tableRows.push({
        rowType: 'variant-end',
        distance: variant.endDistance,
        data: variant
      });
    }
  }

  tableRows.sort((a, b) => a.distance - b.distance);

  function renderWaypointRow(wp: Waypoint, waypointIndex: number): string {
    const descIndicator = wp.description
      ? ' <span class="has-description-indicator" title="Has additional info"></span>'
      : '';
    return `
      <tr class="${getRowClass(wp)}"
          id="waypoint-row-${waypointIndex}"
          data-waypoint-index="${waypointIndex}"
          tabindex="0"
          role="button"
          aria-expanded="false"
          aria-controls="waypoint-detail-${waypointIndex}">
        <td><span class="expand-chevron">&#9654;</span> ${wp.name || 'Unnamed'}${descIndicator}</td>
        <td><span class="waypoint-type ${getTypeClass(wp.type)}">${wp.type || 'waypoint'}</span></td>
        <td class="numeric">${wp.elevation ?? '-'}</td>
        <td class="numeric">${wp.distance?.toFixed(1) ?? '-'}</td>
        <td class="numeric">${wp.totalDistance?.toFixed(1) ?? '-'}</td>
        <td class="numeric">${wp.ascent ?? '-'}</td>
        <td class="numeric">${wp.descent ?? '-'}</td>
        <td class="numeric">${wp.totalAscent ?? '-'}</td>
        <td class="numeric">${wp.totalDescent ?? '-'}</td>
      </tr>
    `;
  }

  function renderVariantRow(variant: RouteVariant, isStart: boolean): string {
    const typeClass = variant.type === 'alternate' ? 'type-alternate' : 'type-side-trip';
    const typeLabel = variant.type === 'alternate' ? 'Alternate' : 'Side Trip';
    const actionLabel = isStart
      ? (variant.type === 'alternate' ? 'branches' : 'starts')
      : 'rejoins';
    const distance = isStart ? variant.startDistance : variant.endDistance;

    return `
      <tr class="variant-row ${typeClass}">
        <td colspan="2">
          <span class="variant-marker ${typeClass}">
            <span class="variant-icon">${isStart ? '\u2197' : '\u2198'}</span>
            <strong>${variant.name}</strong>
            <span class="variant-action">${actionLabel} here</span>
          </span>
        </td>
        <td colspan="3" class="variant-stats-cell">
          <span class="variant-inline-stats">
            ${variant.distance} km \u00B7 +${variant.elevation?.ascent || 0}m / -${variant.elevation?.descent || 0}m
          </span>
        </td>
        <td class="numeric">${distance?.toFixed(1) ?? '-'}</td>
        <td colspan="3">
          <span class="variant-type-badge ${typeClass}">${typeLabel}</span>
        </td>
      </tr>
    `;
  }

  const tableHtml = `
    <table class="waypoints-table">
      <thead>
        <tr>
          <th>Location</th>
          <th>Type</th>
          <th>Elev (m)</th>
          <th>Dist (km)</th>
          <th>Total (km)</th>
          <th>Gain (m)</th>
          <th>Loss (m)</th>
          <th>Total Gain</th>
          <th>Total Loss</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows.map(row => {
          if (row.rowType === 'waypoint') {
            return renderWaypointRow(row.data as Waypoint, row.waypointIndex!);
          } else if (row.rowType === 'variant-start') {
            return renderVariantRow(row.data as RouteVariant, true);
          } else {
            return renderVariantRow(row.data as RouteVariant, false);
          }
        }).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = tableHtml;
}

function exportDatasheet(trail: Trail): void {
  const { config, track, waypoints, alternates, sideTrips } = trail;

  const lines: string[] = [];

  lines.push(`# ${config.name} - Trail Datasheet`);
  lines.push(`# Region: ${config.region}`);
  lines.push(`# Total Distance: ${track.totalDistance.toFixed(1)} km`);
  lines.push(`# Total Ascent: ${Math.round(track.totalAscent)} m`);
  lines.push(`# Total Descent: ${Math.round(track.totalDescent)} m`);
  lines.push(`# Generated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  lines.push('Location,Type,Elevation (m),Distance (km),Total (km),Gain (m),Loss (m),Total Gain (m),Total Loss (m),Notes');

  for (const wp of waypoints || []) {
    const row = [
      `"${(wp.name || 'Unnamed').replace(/"/g, '""')}"`,
      wp.type || 'waypoint',
      wp.elevation ?? '',
      wp.distance?.toFixed(1) ?? '',
      wp.totalDistance?.toFixed(1) ?? '',
      wp.ascent ?? '',
      wp.descent ?? '',
      wp.totalAscent ?? '',
      wp.totalDescent ?? '',
      `"${(wp.description || '').replace(/"/g, '""')}"`
    ];
    lines.push(row.join(','));
  }

  if (alternates && alternates.length > 0) {
    lines.push('');
    lines.push('# Alternate Routes');
    lines.push('Name,Type,Distance (km),Ascent (m),Descent (m),Start Distance (km),End Distance (km)');
    for (const alt of alternates) {
      const row = [
        `"${(alt.name || 'Unnamed').replace(/"/g, '""')}"`,
        alt.type || 'alternate',
        alt.distance ?? '',
        alt.elevation?.ascent ?? '',
        alt.elevation?.descent ?? '',
        alt.startDistance?.toFixed(1) ?? '',
        alt.endDistance?.toFixed(1) ?? ''
      ];
      lines.push(row.join(','));
    }
  }

  if (sideTrips && sideTrips.length > 0) {
    lines.push('');
    lines.push('# Side Trips');
    lines.push('Name,Type,Distance (km),Ascent (m),Descent (m),Start Distance (km)');
    for (const trip of sideTrips) {
      const row = [
        `"${(trip.name || 'Unnamed').replace(/"/g, '""')}"`,
        trip.type || 'side-trip',
        trip.distance ?? '',
        trip.elevation?.ascent ?? '',
        trip.elevation?.descent ?? '',
        trip.startDistance?.toFixed(1) ?? ''
      ];
      lines.push(row.join(','));
    }
  }

  const csvContent = lines.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${config.id || 'trail'}-datasheet.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function escapeXml(text: unknown): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function exportGpx(trail: Trail): void {
  const { config, track, waypoints } = trail;

  const gpxLines: string[] = [];
  gpxLines.push('<?xml version="1.0" encoding="UTF-8"?>');
  gpxLines.push('<gpx version="1.1" creator="GPX Tools" xmlns="http://www.topografix.com/GPX/1/1">');
  gpxLines.push(`  <metadata>`);
  gpxLines.push(`    <name>${escapeXml(config.name)}</name>`);
  gpxLines.push(`    <desc>${escapeXml(config.region)} - ${track.totalDistance.toFixed(1)} km</desc>`);
  gpxLines.push(`  </metadata>`);

  for (const wp of waypoints || []) {
    gpxLines.push(`  <wpt lat="${wp.lat}" lon="${wp.lon}">`);
    if (wp.elevation != null) gpxLines.push(`    <ele>${wp.elevation}</ele>`);
    gpxLines.push(`    <name>${escapeXml(wp.name || 'Waypoint')}</name>`);
    if (wp.type) gpxLines.push(`    <type>${escapeXml(wp.type)}</type>`);
    if (wp.description) gpxLines.push(`    <desc>${escapeXml(wp.description)}</desc>`);
    gpxLines.push(`  </wpt>`);
  }

  gpxLines.push(`  <trk>`);
  gpxLines.push(`    <name>${escapeXml(config.name)}</name>`);
  gpxLines.push(`    <trkseg>`);
  for (const pt of track.points || []) {
    gpxLines.push(`      <trkpt lat="${pt.lat}" lon="${pt.lon}">`);
    if (pt.ele != null) gpxLines.push(`        <ele>${pt.ele}</ele>`);
    gpxLines.push(`      </trkpt>`);
  }
  gpxLines.push(`    </trkseg>`);
  gpxLines.push(`  </trk>`);

  gpxLines.push('</gpx>');

  const gpxContent = gpxLines.join('\n');
  const blob = new Blob([gpxContent], { type: 'application/gpx+xml;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${config.id || 'trail'}.gpx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// === Direction Reversal Functions ===

function reverseTrackPoints(points: TrackPoint[], totalDistance: number): TrackPoint[] {
  // Use totalDistance - originalDist to avoid floating-point drift from recalculation
  return [...points].reverse().map(p => ({
    ...p,
    dist: totalDistance - p.dist
  }));
}

function reverseDisplayPoints(displayPts: TrackPoint[], totalDistance: number): TrackPoint[] {
  // Use totalDistance - originalDist to avoid floating-point drift from recalculation
  return [...displayPts].reverse().map(p => ({
    ...p,
    dist: totalDistance - p.dist
  }));
}

function reverseWaypoints(waypoints: Waypoint[], totalDistance: number, trackLength: number): Waypoint[] {
  const reversed = [...waypoints].reverse();

  const withNewTotals = reversed.map(wp => ({
    ...wp,
    newTotalDistance: totalDistance - (wp.totalDistance || 0)
  }));

  let runningAscent = 0;
  let runningDescent = 0;

  return withNewTotals.map((wp, i, arr) => {
    const segmentAscent = wp.descent || 0;
    const segmentDescent = wp.ascent || 0;
    runningAscent += segmentAscent;
    runningDescent += segmentDescent;

    const segmentDist = i === 0 ? 0 : wp.newTotalDistance - arr[i - 1].newTotalDistance;

    return {
      ...wp,
      distance: Math.abs(segmentDist),
      totalDistance: wp.newTotalDistance,
      ascent: segmentAscent,
      descent: segmentDescent,
      totalAscent: runningAscent,
      totalDescent: runningDescent,
      trackIndex: trackLength - 1 - (wp.trackIndex || 0)
    };
  });
}

function reverseAlternates(alternates: RouteVariant[], totalDistance: number): RouteVariant[] {
  return alternates.map(alt => ({
    ...alt,
    startDistance: totalDistance - (alt.endDistance || 0),
    endDistance: totalDistance - (alt.startDistance || 0),
    points: alt.points ? [...alt.points].reverse() : []
  }));
}

function transformSideTrips(sideTrips: RouteVariant[], totalDistance: number): RouteVariant[] {
  return sideTrips.map(trip => ({
    ...trip,
    startDistance: totalDistance - (trip.startDistance || 0)
  }));
}

function createReversedTrail(trail: Trail): Trail {
  const totalDistance = trail.track.totalDistance;
  const trackLength = trail.track.points.length;

  const reversedTrackPts = reverseTrackPoints(trail.track.points, totalDistance);
  const reversedDisplayPts = trail.track.displayPoints
    ? reverseDisplayPoints(trail.track.displayPoints, totalDistance)
    : reversedTrackPts;

  return {
    ...trail,
    track: {
      ...trail.track,
      points: reversedTrackPts,
      displayPoints: reversedDisplayPts,
      totalAscent: trail.track.totalDescent,
      totalDescent: trail.track.totalAscent
    },
    waypoints: reverseWaypoints(trail.waypoints || [], totalDistance, trackLength),
    alternates: reverseAlternates(trail.alternates || [], totalDistance),
    sideTrips: transformSideTrips(trail.sideTrips || [], totalDistance)
  };
}

function getReversedTrail(): Trail {
  if (!trailState.reversedTrail) {
    trailState.reversedTrail = createReversedTrail(trailState.originalTrail!);
  }
  return trailState.reversedTrail;
}

function refreshDisplay(trail: Trail): void {
  expandedWaypointIndex = null;
  trackPoints = trail.track.points;
  displayPoints = trail.track.displayPoints || trail.track.points;
  maxDistance = trail.track.totalDistance;

  updateStats(trail);
  drawElevationProfile(trail.track.points);
  renderWaypoints(trail.waypoints, trail.alternates, trail.sideTrips);

  // Update waypoint markers
  waypointMarkers.forEach(({ marker }) => {
    if (map && map.hasLayer(marker)) {
      map.removeLayer(marker);
    }
  });
  drawWaypointMarkers(trail.waypoints || []);

  // Update main route polyline
  if (map && mainRoutePolyline) {
    const latLngs = displayPoints.map(p => [p.lat, p.lon] as [number, number]);
    mainRoutePolyline.setLatLngs(latLngs);
  }
}

function getDirectionLabel(isReversed: boolean): string {
  const config = trailState.originalTrail?.config.direction;
  if (config) {
    return isReversed ? config.reversed : config.default;
  }
  return isReversed ? 'End → Start' : 'Start → End';
}

function saveDirectionPreference(trailId: string, isReversed: boolean): void {
  try {
    const prefs = JSON.parse(localStorage.getItem('trailDirectionPrefs') || '{}');
    prefs[trailId] = isReversed;
    localStorage.setItem('trailDirectionPrefs', JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable
  }
}

function loadDirectionPreference(trailId: string): boolean {
  try {
    const prefs = JSON.parse(localStorage.getItem('trailDirectionPrefs') || '{}');
    return prefs[trailId] === true;
  } catch {
    return false;
  }
}

function updateDirectionUI(isReversed: boolean): void {
  const btn = document.getElementById('reverse-direction-btn');
  const label = document.getElementById('direction-label');

  if (btn) btn.setAttribute('aria-pressed', isReversed ? 'true' : 'false');
  if (label) label.textContent = getDirectionLabel(isReversed);
}

function toggleDirection(): void {
  const loading = document.getElementById('direction-loading');
  const originalTrail = trailState.originalTrail;
  if (!originalTrail) return;

  // Show loading indicator if we need to compute reversed trail
  if (!trailState.reversedTrail && !trailState.isReversed && loading) {
    loading.hidden = false;
  }

  // Use requestAnimationFrame to ensure loading indicator renders before heavy computation
  requestAnimationFrame(() => {
    trailState.isReversed = !trailState.isReversed;

    const trail = trailState.isReversed ? getReversedTrail() : originalTrail;

    refreshDisplay(trail);
    updateDirectionUI(trailState.isReversed);
    saveDirectionPreference(originalTrail.config.id, trailState.isReversed);

    if (loading) loading.hidden = true;
  });
}

export async function initTrailViewer(trailId: string): Promise<void> {
  const trail = await loadTrailData(trailId);
  if (!trail) {
    const panel = document.querySelector('.panel');
    if (panel) panel.innerHTML = '<p>Failed to load trail data.</p>';
    return;
  }

  trailState.originalTrail = trail;

  // Load saved direction preference
  const savedReversed = loadDirectionPreference(trailId);
  if (savedReversed) {
    trailState.isReversed = true;
    const reversedTrail = getReversedTrail();
    updateStats(reversedTrail);
    initMap(reversedTrail);
    drawElevationProfile(reversedTrail.track.points);
    setupElevationHover();
    renderWaypoints(reversedTrail.waypoints, reversedTrail.alternates, reversedTrail.sideTrips);
  } else {
    updateStats(trail);
    initMap(trail);
    drawElevationProfile(trail.track.points);
    setupElevationHover();
    renderWaypoints(trail.waypoints, trail.alternates, trail.sideTrips);
  }

  // Set initial direction label from config
  updateDirectionUI(trailState.isReversed);

  document.querySelector('.waypoints-table tbody')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Handle "Show on map" link clicks in detail panels
    if (target.classList.contains('waypoint-show-on-map')) {
      e.preventDefault();
      handleTableRowClick(parseInt(target.dataset.waypointIndex!, 10));
      return;
    }

    // Handle waypoint row clicks for expand/collapse
    const row = target.closest('tr[data-waypoint-index]');
    if (row) {
      toggleWaypointExpansion(parseInt((row as HTMLElement).dataset.waypointIndex!, 10));
    }
  });

  // Keyboard accessibility for waypoint rows
  document.querySelector('.waypoints-table tbody')?.addEventListener('keydown', (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
      const row = (e.target as HTMLElement).closest('tr[data-waypoint-index]');
      if (row) {
        e.preventDefault();
        toggleWaypointExpansion(parseInt((row as HTMLElement).dataset.waypointIndex!, 10));
      }
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('popup-show-in-table')) {
      e.preventDefault();
      scrollToTableRow(parseInt(target.dataset.waypointIndex!, 10));
    }
  });

  document.getElementById('reverse-direction-btn')?.addEventListener('click', toggleDirection);

  const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
  const exportGpxBtn = document.getElementById('export-gpx-btn') as HTMLButtonElement;
  if (exportCsvBtn) {
    exportCsvBtn.disabled = false;
    exportCsvBtn.addEventListener('click', () => {
      if (trailState.currentTrail) exportDatasheet(trailState.currentTrail);
    });
  }
  if (exportGpxBtn) {
    exportGpxBtn.disabled = false;
    exportGpxBtn.addEventListener('click', () => {
      if (trailState.currentTrail) exportGpx(trailState.currentTrail);
    });
  }

  window.addEventListener('resize', debounce(() => {
    if (trailState.currentTrail) {
      drawElevationProfile(trailState.currentTrail.track.points);
    }
    if (map) map.invalidateSize();
  }, 150));
}
