import { parseGpx } from '../../lib/gpx-parser.js';
import { enrichRoute, exportPOIsToCSV, exportPOIsToGPX, getPOIName, getPOIDescription, type POIType, type EnrichedPOI } from '../../lib/poi-enrichment.js';
import { saveAs } from 'file-saver';
import L from 'leaflet';
import { initializeMap, fitMapToBounds, createRoutePolyline, createCircleMarker, type MapPoint } from '../shared/map-utils.js';

// DOM Elements
const gpxUploadArea = document.getElementById('gpx-upload-area')!;
const gpxFileInput = document.getElementById('gpx-file-input') as HTMLInputElement;
const gpxFileInfo = document.getElementById('gpx-file-info')!;
const enrichBtn = document.getElementById('enrich-btn') as HTMLButtonElement;
const progressArea = document.getElementById('progress-area')!;
const progressFill = document.getElementById('progress-fill')!;
const progressText = document.getElementById('progress-text')!;
const results = document.getElementById('results')!;
const stats = document.getElementById('stats')!;
const poiList = document.getElementById('poi-list')!;
const downloadCsvBtn = document.getElementById('download-csv')!;
const downloadGpxBtn = document.getElementById('download-gpx')!;

// POI type checkboxes
const poiWaterCheckbox = document.getElementById('poi-water') as HTMLInputElement;
const poiCampingCheckbox = document.getElementById('poi-camping') as HTMLInputElement;
const poiResupplyCheckbox = document.getElementById('poi-resupply') as HTMLInputElement;
const poiTransportCheckbox = document.getElementById('poi-transport') as HTMLInputElement;
const poiEmergencyCheckbox = document.getElementById('poi-emergency') as HTMLInputElement;

// Options
const bufferKmInput = document.getElementById('buffer-km') as HTMLInputElement;
const maxDistanceInput = document.getElementById('max-distance') as HTMLInputElement;

// State
let gpxFile: File | null = null;
let enrichedPOIs: EnrichedPOI[] = [];
let routeName = 'route';
let routePoints: MapPoint[] = [];
let map: L.Map | null = null;
let poiMarkers: Map<string, L.CircleMarker[]> = new Map();

// Utility functions
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Upload handling
function setupUploadArea(
  area: HTMLElement,
  input: HTMLInputElement,
  fileInfo: HTMLElement,
  onFile: (file: File | null) => void
): void {
  area.addEventListener('click', () => {
    if (!area.classList.contains('has-file')) {
      input.click();
    }
  });

  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('dragover');
  });

  area.addEventListener('dragleave', () => {
    area.classList.remove('dragover');
  });

  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      onFile(files[0]);
    }
  });

  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) {
      onFile(input.files[0]);
    }
  });

  const clearBtn = fileInfo.querySelector('.clear-btn');
  clearBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    input.value = '';
    area.classList.remove('has-file');
    area.querySelector('.upload-content')!.removeAttribute('hidden');
    fileInfo.setAttribute('hidden', '');
    onFile(null);
  });
}

function showFileInfo(area: HTMLElement, fileInfo: HTMLElement, file: File): void {
  area.classList.add('has-file');
  area.querySelector('.upload-content')!.setAttribute('hidden', '');
  fileInfo.removeAttribute('hidden');
  fileInfo.querySelector('.file-name')!.textContent = file.name;
  fileInfo.querySelector('.file-size')!.textContent = formatFileSize(file.size);
}

// Setup upload area
setupUploadArea(gpxUploadArea, gpxFileInput, gpxFileInfo, (file) => {
  gpxFile = file;
  if (file) {
    showFileInfo(gpxUploadArea, gpxFileInfo, file);
    enrichBtn.disabled = false;
    results.setAttribute('hidden', '');
    progressArea.setAttribute('hidden', '');
    routeName = file.name.replace('.gpx', '');
  } else {
    enrichBtn.disabled = true;
    results.setAttribute('hidden', '');
  }
});

// Get selected POI types
function getSelectedTypes(): POIType[] {
  const types: POIType[] = [];
  if (poiWaterCheckbox.checked) types.push('water');
  if (poiCampingCheckbox.checked) types.push('camping');
  if (poiResupplyCheckbox.checked) types.push('resupply');
  if (poiTransportCheckbox.checked) types.push('transport');
  if (poiEmergencyCheckbox.checked) types.push('emergency');
  return types;
}

// Process GPX
enrichBtn.addEventListener('click', async () => {
  if (!gpxFile) return;

  const types = getSelectedTypes();
  if (types.length === 0) {
    alert('Please select at least one POI type');
    return;
  }

  enrichBtn.disabled = true;
  progressArea.removeAttribute('hidden');
  results.setAttribute('hidden', '');
  progressFill.style.width = '0%';

  try {
    const content = await gpxFile.text();
    const gpxData = parseGpx(content);

    // Get all track points
    routePoints = [];
    for (const track of gpxData.tracks) {
      for (const segment of track.segments) {
        routePoints.push(...segment.points.map(p => ({ lat: p.lat, lon: p.lon })));
      }
    }

    // Also check routes if no tracks
    if (routePoints.length === 0) {
      for (const route of gpxData.routes) {
        routePoints.push(...route.points.map(p => ({ lat: p.lat, lon: p.lon })));
      }
    }

    if (routePoints.length === 0) {
      throw new Error('No track or route points found in GPX file');
    }

    const points = routePoints;

    const bufferKm = parseFloat(bufferKmInput.value) || 5;
    const maxDistanceFromRoute = parseFloat(maxDistanceInput.value) || 2;

    const result = await enrichRoute(points, {
      types,
      bufferKm,
      maxDistanceFromRoute,
    }, (message) => {
      progressText.textContent = message;
      // Simulate progress based on message
      if (message.includes('chunk')) {
        const match = message.match(/(\d+)\/(\d+)/);
        if (match) {
          const current = parseInt(match[1]);
          const total = parseInt(match[2]);
          progressFill.style.width = `${(current / total) * 100}%`;
        }
      }
    });

    enrichedPOIs = result.pois;

    // Show results
    progressArea.setAttribute('hidden', '');
    results.removeAttribute('hidden');

    stats.innerHTML = `
      <p><strong>Total POIs found:</strong> ${result.stats.totalFound}</p>
      <p><strong>Query time:</strong> ${(result.stats.queryTimeMs / 1000).toFixed(1)}s</p>
      <p><strong>By type:</strong></p>
      <ul>
        ${types.map(t => `<li>${t}: ${result.stats.byType[t] || 0}</li>`).join('')}
      </ul>
    `;

    renderPOIList(enrichedPOIs);
    renderMap(routePoints, enrichedPOIs);
    setupTabFilters();

  } catch (error) {
    alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    progressArea.setAttribute('hidden', '');
  } finally {
    enrichBtn.disabled = false;
  }
});

// Render POI list
function renderPOIList(pois: EnrichedPOI[]): void {
  if (pois.length === 0) {
    poiList.innerHTML = '<p class="no-results">No POIs found</p>';
    return;
  }

  poiList.innerHTML = pois.map(poi => `
    <div class="poi-item" data-category="${poi.category}">
      <div class="poi-header">
        <span class="poi-icon">${getCategoryIcon(poi.category)}</span>
        <span class="poi-name">${getPOIName(poi)}</span>
        <span class="poi-distance">${(poi.distanceFromRoute * 1000).toFixed(0)}m from route</span>
      </div>
      <div class="poi-details">
        <p class="poi-description">${getPOIDescription(poi)}</p>
        <p class="poi-coords">
          <a href="https://www.openstreetmap.org/?mlat=${poi.lat}&mlon=${poi.lon}#map=17/${poi.lat}/${poi.lon}" target="_blank">
            ${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}
          </a>
        </p>
      </div>
    </div>
  `).join('');
}

function getCategoryIcon(category: POIType): string {
  const icons: Record<POIType, string> = {
    water: '💧',
    camping: '⛺',
    resupply: '🛒',
    transport: '🚌',
    emergency: '🏥',
  };
  return icons[category] || '📍';
}

// Category colors for map markers
const categoryColors: Record<POIType, string> = {
  water: '#3b82f6',
  camping: '#22c55e',
  resupply: '#f97316',
  transport: '#8b5cf6',
  emergency: '#ef4444',
};

// Render map with route and POI markers
function renderMap(points: MapPoint[], pois: EnrichedPOI[]): void {
  // Initialize or clear map
  if (map) {
    map.remove();
  }

  map = initializeMap('poi-map');
  poiMarkers.clear();

  // Draw route
  const routeLine = createRoutePolyline(points, '#3b82f6', { weight: 3, opacity: 0.7 });
  routeLine.addTo(map);

  // Add POI markers grouped by category
  pois.forEach(poi => {
    const color = categoryColors[poi.category] || '#6b7280';
    const marker = createCircleMarker(poi.lat, poi.lon, color, {
      radius: 8,
      fillOpacity: 0.8,
      popup: `
        <strong>${getPOIName(poi)}</strong><br>
        ${getPOIDescription(poi)}<br>
        <em>${(poi.distanceFromRoute * 1000).toFixed(0)}m from route</em>
      `,
    });

    marker.addTo(map!);

    // Store marker by category for filtering
    if (!poiMarkers.has(poi.category)) {
      poiMarkers.set(poi.category, []);
    }
    poiMarkers.get(poi.category)!.push(marker);
  });

  // Fit map to show all points
  fitMapToBounds(map, points);
}

// Update map markers visibility based on filter
function updateMapMarkerVisibility(activeType: string): void {
  if (!map) return;

  poiMarkers.forEach((markers, category) => {
    markers.forEach(marker => {
      if (activeType === 'all' || category === activeType) {
        if (!map!.hasLayer(marker)) {
          marker.addTo(map!);
        }
      } else {
        if (map!.hasLayer(marker)) {
          map!.removeLayer(marker);
        }
      }
    });
  });
}

// Tab filtering
function setupTabFilters(): void {
  const tabs = document.querySelectorAll('.poi-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const type = (tab as HTMLElement).dataset.type!;
      const items = poiList.querySelectorAll('.poi-item');

      // Filter list items
      items.forEach(item => {
        const category = (item as HTMLElement).dataset.category;
        if (type === 'all' || category === type) {
          (item as HTMLElement).style.display = 'block';
        } else {
          (item as HTMLElement).style.display = 'none';
        }
      });

      // Filter map markers
      updateMapMarkerVisibility(type);
    });
  });
}

// Downloads
downloadCsvBtn.addEventListener('click', () => {
  if (enrichedPOIs.length === 0) return;
  const csv = exportPOIsToCSV(enrichedPOIs);
  const blob = new Blob([csv], { type: 'text/csv' });
  saveAs(blob, `${routeName}_pois.csv`);
});

downloadGpxBtn.addEventListener('click', () => {
  if (enrichedPOIs.length === 0) return;
  const gpx = exportPOIsToGPX(enrichedPOIs, routeName);
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  saveAs(blob, `${routeName}_pois.gpx`);
});
