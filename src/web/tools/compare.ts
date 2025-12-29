import { parseGpx } from '../../lib/gpx-parser.js';
import { compareRoutes, exportComparisonToCSV, type RoutePoint, type RouteComparison } from '../../lib/route-comparison.js';
import { saveAs } from 'file-saver';

// DOM Elements
const route1UploadArea = document.getElementById('route1-upload-area')!;
const route1FileInput = document.getElementById('route1-file-input') as HTMLInputElement;
const route1FileInfo = document.getElementById('route1-file-info')!;

const route2UploadArea = document.getElementById('route2-upload-area')!;
const route2FileInput = document.getElementById('route2-file-input') as HTMLInputElement;
const route2FileInfo = document.getElementById('route2-file-info')!;

const compareBtn = document.getElementById('compare-btn') as HTMLButtonElement;
const results = document.getElementById('results')!;

const proximityInput = document.getElementById('proximity-threshold') as HTMLInputElement;
const minSegmentInput = document.getElementById('min-segment') as HTMLInputElement;

// Result elements
const r1Distance = document.getElementById('r1-distance')!;
const r1Ascent = document.getElementById('r1-ascent')!;
const r1Descent = document.getElementById('r1-descent')!;
const r2Distance = document.getElementById('r2-distance')!;
const r2Ascent = document.getElementById('r2-ascent')!;
const r2Descent = document.getElementById('r2-descent')!;
const sharedDistance = document.getElementById('shared-distance')!;
const distanceDiff = document.getElementById('distance-diff')!;
const ascentDiff = document.getElementById('ascent-diff')!;
const segmentList = document.getElementById('segment-list')!;
const downloadCsvBtn = document.getElementById('download-csv')!;

// State
let route1File: File | null = null;
let route2File: File | null = null;
let comparison: RouteComparison | null = null;

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

function updateCompareButton(): void {
  compareBtn.disabled = !(route1File && route2File);
}

// Setup upload areas
setupUploadArea(route1UploadArea, route1FileInput, route1FileInfo, (file) => {
  route1File = file;
  if (file) {
    showFileInfo(route1UploadArea, route1FileInfo, file);
  }
  results.setAttribute('hidden', '');
  updateCompareButton();
});

setupUploadArea(route2UploadArea, route2FileInput, route2FileInfo, (file) => {
  route2File = file;
  if (file) {
    showFileInfo(route2UploadArea, route2FileInfo, file);
  }
  results.setAttribute('hidden', '');
  updateCompareButton();
});

// Extract points from GPX
function extractPoints(gpxContent: string): RoutePoint[] {
  const gpxData = parseGpx(gpxContent);
  const points: RoutePoint[] = [];

  // Try tracks first
  for (const track of gpxData.tracks) {
    for (const segment of track.segments) {
      points.push(...segment.points.map(p => ({
        lat: p.lat,
        lon: p.lon,
        ele: p.ele,
      })));
    }
  }

  // Fall back to routes
  if (points.length === 0) {
    for (const route of gpxData.routes) {
      points.push(...route.points.map(p => ({
        lat: p.lat,
        lon: p.lon,
        ele: p.ele,
      })));
    }
  }

  return points;
}

// Compare routes
compareBtn.addEventListener('click', async () => {
  if (!route1File || !route2File) return;

  compareBtn.disabled = true;
  compareBtn.textContent = 'Comparing...';

  try {
    const [content1, content2] = await Promise.all([
      route1File.text(),
      route2File.text(),
    ]);

    const points1 = extractPoints(content1);
    const points2 = extractPoints(content2);

    if (points1.length === 0) {
      throw new Error('No points found in Route 1');
    }
    if (points2.length === 0) {
      throw new Error('No points found in Route 2');
    }

    const proximityThreshold = parseFloat(proximityInput.value) / 1000; // Convert m to km
    const minSegmentLength = parseFloat(minSegmentInput.value) / 1000; // Convert m to km

    comparison = compareRoutes(points1, points2, {
      proximityThreshold,
      minSegmentLength,
    });

    // Display results
    results.removeAttribute('hidden');

    r1Distance.textContent = `${comparison.route1Stats.totalDistance.toFixed(1)} km`;
    r1Ascent.textContent = `${comparison.route1Stats.totalAscent.toFixed(0)} m`;
    r1Descent.textContent = `${comparison.route1Stats.totalDescent.toFixed(0)} m`;

    r2Distance.textContent = `${comparison.route2Stats.totalDistance.toFixed(1)} km`;
    r2Ascent.textContent = `${comparison.route2Stats.totalAscent.toFixed(0)} m`;
    r2Descent.textContent = `${comparison.route2Stats.totalDescent.toFixed(0)} m`;

    sharedDistance.textContent = `${comparison.sharedDistance.toFixed(1)} km (${comparison.sharedPercentage.toFixed(1)}%)`;
    const distDiff = comparison.distanceDiff;
    distanceDiff.textContent = `${distDiff >= 0 ? '+' : ''}${distDiff.toFixed(1)} km`;
    const ascDiff = comparison.elevationDiff.ascent;
    ascentDiff.textContent = `${ascDiff >= 0 ? '+' : ''}${ascDiff.toFixed(0)} m`;

    renderSegments('shared');
    setupSegmentTabs();

  } catch (error) {
    alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    compareBtn.disabled = false;
    compareBtn.textContent = 'Compare Routes';
    updateCompareButton();
  }
});

// Render segment list
function renderSegments(type: 'shared' | 'route1' | 'route2'): void {
  if (!comparison) return;

  let segments;
  switch (type) {
    case 'shared':
      segments = comparison.sharedSegments;
      break;
    case 'route1':
      segments = comparison.route1OnlySegments;
      break;
    case 'route2':
      segments = comparison.route2OnlySegments;
      break;
  }

  if (segments.length === 0) {
    segmentList.innerHTML = '<p class="no-results">No segments of this type</p>';
    return;
  }

  segmentList.innerHTML = segments.map((seg, i) => `
    <div class="segment-item">
      <div class="segment-header">
        <span class="segment-number">#${i + 1}</span>
        <span class="segment-length">${(seg.endDist - seg.startDist).toFixed(1)} km</span>
      </div>
      <div class="segment-details">
        <p>From: ${seg.startDist.toFixed(1)} km to ${seg.endDist.toFixed(1)} km</p>
        <p>Points: ${seg.points.length}</p>
      </div>
    </div>
  `).join('');
}

// Setup segment tab filtering
function setupSegmentTabs(): void {
  const tabs = document.querySelectorAll('.segment-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const type = (tab as HTMLElement).dataset.type as 'shared' | 'route1' | 'route2';
      renderSegments(type);
    });
  });
}

// Download CSV
downloadCsvBtn.addEventListener('click', () => {
  if (!comparison) return;
  const csv = exportComparisonToCSV(comparison);
  const blob = new Blob([csv], { type: 'text/csv' });
  const baseName = route1File?.name.replace('.gpx', '') || 'route';
  saveAs(blob, `${baseName}_comparison.csv`);
});
