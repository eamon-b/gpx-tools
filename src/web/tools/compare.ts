import { parseGpx } from '../../lib/gpx-parser.js';
import { compareRoutes, exportComparisonToCSV, type RoutePoint, type RouteComparison } from '../../lib/route-comparison.js';
import { saveAs } from 'file-saver';
import L from 'leaflet';
import { Chart, registerables } from 'chart.js';
import { initializeMap, fitMapToBounds, createRoutePolyline, type MapPoint } from '../shared/map-utils.js';

// Register Chart.js components
Chart.register(...registerables);

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
let route1Points: RoutePoint[] = [];
let route2Points: RoutePoint[] = [];
let map: L.Map | null = null;
let elevationChart: Chart | null = null;

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

    route1Points = extractPoints(content1);
    route2Points = extractPoints(content2);

    if (route1Points.length === 0) {
      throw new Error('No points found in Route 1');
    }
    if (route2Points.length === 0) {
      throw new Error('No points found in Route 2');
    }

    const points1 = route1Points;
    const points2 = route2Points;

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

    // Render map and chart
    renderComparisonMap(route1Points, route2Points, comparison);
    renderElevationChart(route1Points, route2Points);

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

// Render comparison map
function renderComparisonMap(
  points1: RoutePoint[],
  points2: RoutePoint[],
  comp: RouteComparison
): void {
  // Initialize or clear map
  if (map) {
    map.remove();
  }

  map = initializeMap('comparison-map');

  // Draw Route 1 in blue (underneath)
  const route1Line = createRoutePolyline(
    points1 as MapPoint[],
    '#3b82f6',
    { weight: 4, opacity: 0.6 }
  );
  route1Line.addTo(map);

  // Draw Route 2 in orange (underneath)
  const route2Line = createRoutePolyline(
    points2 as MapPoint[],
    '#f97316',
    { weight: 4, opacity: 0.6 }
  );
  route2Line.addTo(map);

  // Highlight shared segments in green (on top)
  comp.sharedSegments.forEach(seg => {
    const sharedLine = createRoutePolyline(
      seg.points as MapPoint[],
      '#22c55e',
      { weight: 5, opacity: 0.9 }
    );
    sharedLine.addTo(map!);
  });

  // Fit map to show all points
  const allPoints = [...points1, ...points2] as MapPoint[];
  fitMapToBounds(map, allPoints);
}

// Render elevation comparison chart
function renderElevationChart(points1: RoutePoint[], points2: RoutePoint[]): void {
  // Destroy existing chart
  if (elevationChart) {
    elevationChart.destroy();
  }

  const canvas = document.getElementById('elevation-chart') as HTMLCanvasElement;
  if (!canvas) return;

  // Calculate cumulative distances and sample points for smoother chart
  const sampleRate = Math.max(1, Math.floor(Math.max(points1.length, points2.length) / 200));

  const data1 = samplePointsWithDistance(points1, sampleRate);
  const data2 = samplePointsWithDistance(points2, sampleRate);

  elevationChart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Route 1',
          data: data1,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: 'Route 2',
          data: data2,
          borderColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            text: 'Distance (km)',
          },
          ticks: {
            callback: (value) => `${Number(value).toFixed(0)}`,
          },
        },
        y: {
          title: {
            display: true,
            text: 'Elevation (m)',
          },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (context) => {
              const label = context.dataset.label || '';
              const ele = context.parsed.y ?? 0;
              return `${label}: ${ele.toFixed(0)}m`;
            },
          },
        },
      },
    },
  });
}

// Sample points with cumulative distance for chart
function samplePointsWithDistance(
  points: RoutePoint[],
  sampleRate: number
): { x: number; y: number }[] {
  const result: { x: number; y: number }[] = [];
  let totalDist = 0;

  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const prev = points[i - 1];
      const curr = points[i];
      totalDist += haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
    }

    const ele = points[i].ele;
    if (i % sampleRate === 0 && ele != null) {
      result.push({ x: totalDist, y: ele });
    }
  }

  return result;
}

// Simple haversine distance calculation (km)
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
