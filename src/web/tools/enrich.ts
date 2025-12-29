import { parseGpx } from '../../lib/gpx-parser.js';
import { enrichRoute, exportPOIsToCSV, exportPOIsToGPX, getPOIName, getPOIDescription, type POIType, type EnrichedPOI } from '../../lib/poi-enrichment.js';
import { saveAs } from 'file-saver';

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
    const points: { lat: number; lon: number }[] = [];
    for (const track of gpxData.tracks) {
      for (const segment of track.segments) {
        points.push(...segment.points.map(p => ({ lat: p.lat, lon: p.lon })));
      }
    }

    // Also check routes if no tracks
    if (points.length === 0) {
      for (const route of gpxData.routes) {
        points.push(...route.points.map(p => ({ lat: p.lat, lon: p.lon })));
      }
    }

    if (points.length === 0) {
      throw new Error('No track or route points found in GPX file');
    }

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

// Tab filtering
function setupTabFilters(): void {
  const tabs = document.querySelectorAll('.poi-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const type = (tab as HTMLElement).dataset.type;
      const items = poiList.querySelectorAll('.poi-item');

      items.forEach(item => {
        const category = (item as HTMLElement).dataset.category;
        if (type === 'all' || category === type) {
          (item as HTMLElement).style.display = 'block';
        } else {
          (item as HTMLElement).style.display = 'none';
        }
      });
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
