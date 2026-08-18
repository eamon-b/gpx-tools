import { parseGpx } from '../../lib/gpx-parser.js';
import { createDaylightPlan, exportDaylightPlanToCSV, formatTime, formatDaylightHours, formatUtcOffset, shiftToUtcOffset, getMoonInfo, type DaylightPlan, type DaylightPlanDay } from '../../lib/daylight.js';
import { saveAs } from 'file-saver';
import L from 'leaflet';
import { Chart, registerables } from 'chart.js';
import { initializeMap, fitMapToBounds, createRoutePolyline, createNumberedMarker, type MapPoint } from '../shared/map-utils.js';

// Register Chart.js components
Chart.register(...registerables);

// DOM Elements
const gpxUploadArea = document.getElementById('gpx-upload-area')!;
const gpxFileInput = document.getElementById('gpx-file-input') as HTMLInputElement;
const gpxFileInfo = document.getElementById('gpx-file-info')!;
const calculateBtn = document.getElementById('calculate-btn') as HTMLButtonElement;
const results = document.getElementById('results')!;

// Options
const startDateInput = document.getElementById('start-date') as HTMLInputElement;
const dailyTargetInput = document.getElementById('daily-target') as HTMLInputElement;
const hikingSpeedInput = document.getElementById('hiking-speed') as HTMLInputElement;
const startOffsetInput = document.getElementById('start-offset') as HTMLInputElement;
const endOffsetInput = document.getElementById('end-offset') as HTMLInputElement;

// Result elements
const totalDaysEl = document.getElementById('total-days')!;
const totalDistanceEl = document.getElementById('total-distance')!;
const nightHikingDaysEl = document.getElementById('night-hiking-days')!;
const shortestDayEl = document.getElementById('shortest-day')!;
const longestDayEl = document.getElementById('longest-day')!;
const dayListEl = document.getElementById('day-list')!;
const downloadCsvBtn = document.getElementById('download-csv')!;

// State
let gpxFile: File | null = null;
let daylightPlan: DaylightPlan | null = null;
let routePoints: MapPoint[] = [];
let map: L.Map | null = null;
let daylightChart: Chart | null = null;

// Set default start date to today (browser-local calendar day; using
// valueAsDate would set the UTC day, which can be off by one)
const today = new Date();
startDateInput.value = [
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, '0'),
  String(today.getDate()).padStart(2, '0'),
].join('-');

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
    calculateBtn.disabled = false;
    results.setAttribute('hidden', '');
  } else {
    calculateBtn.disabled = true;
    results.setAttribute('hidden', '');
  }
});

// Calculate daylight plan
calculateBtn.addEventListener('click', async () => {
  if (!gpxFile) return;

  // Read the date input as its string value ('YYYY-MM-DD'); the library
  // interprets it as a calendar day in the route's local time zone.
  // (valueAsDate would give UTC midnight, which shifts the calendar day
  // when the browser's time zone differs from the route's.)
  const startDate = startDateInput.value;
  if (!startDate) {
    alert('Please select a start date');
    return;
  }

  calculateBtn.disabled = true;
  calculateBtn.textContent = 'Calculating...';

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

    const dailyTargetKm = parseFloat(dailyTargetInput.value) || 25;
    const hikingSpeedKmh = parseFloat(hikingSpeedInput.value) || 4;
    // Not `parseInt(...) || 30`: 0 is a valid offset (start right at sunrise
    // / end right at sunset) and must not fall back to the default
    const parsedStartOffset = parseInt(startOffsetInput.value, 10);
    const parsedEndOffset = parseInt(endOffsetInput.value, 10);
    const startTimeOffset = Number.isNaN(parsedStartOffset) ? 30 : parsedStartOffset;
    const endTimeOffset = Number.isNaN(parsedEndOffset) ? 30 : parsedEndOffset;

    daylightPlan = createDaylightPlan(points, {
      startDate,
      dailyTargetKm,
      hikingSpeedKmh,
      startTimeOffset,
      endTimeOffset,
    });

    // Display results
    results.removeAttribute('hidden');

    // Label the (approximate) time zone all times are displayed in
    const tzNote = document.getElementById('tz-note');
    if (tzNote) {
      tzNote.textContent = `Times shown in route local time (${formatUtcOffset(daylightPlan.utcOffsetHours)}, approx — estimated from route longitude)`;
      tzNote.removeAttribute('hidden');
    }

    totalDaysEl.textContent = daylightPlan.totalDays.toString();
    totalDistanceEl.textContent = `${daylightPlan.totalDistance.toFixed(1)} km`;
    nightHikingDaysEl.textContent = daylightPlan.nightHikingDays.toString();
    shortestDayEl.textContent = formatDaylightHours(daylightPlan.shortestDay.hours);
    longestDayEl.textContent = formatDaylightHours(daylightPlan.longestDay.hours);

    // Render map and chart
    renderDaylightMap(routePoints, daylightPlan);
    renderDaylightChart(daylightPlan);

    renderDayList();

  } catch (error) {
    alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    calculateBtn.disabled = false;
    calculateBtn.textContent = 'Calculate Daylight Plan';
  }
});

// Format a plan date in the route's local calendar (dates are anchored at
// route-local noon, so shift by the offset and read UTC fields)
function formatPlanDate(date: Date, utcOffsetHours: number): string {
  return shiftToUtcOffset(date, utcOffsetHours).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// Sunrise/sunset display, handling polar days/nights where the sun
// never rises or sets
function formatSunTime(day: DaylightPlanDay, which: 'sunrise' | 'sunset', utcOffsetHours: number): string {
  if (day.polarDay) return which === 'sunrise' ? 'Sun up all day' : 'No sunset (polar day)';
  if (day.polarNight) return which === 'sunrise' ? 'No sunrise (polar night)' : 'Sun down all day';
  return formatTime(which === 'sunrise' ? day.sunrise : day.sunset, utcOffsetHours);
}

// Render day list
function renderDayList(): void {
  if (!daylightPlan) return;
  const offset = daylightPlan.utcOffsetHours;

  dayListEl.innerHTML = daylightPlan.days.map((day, i) => {
    const moon = getMoonInfo(day.date);
    const dateStr = formatPlanDate(day.date, offset);

    return `
      <div class="day-item ${day.nightHikingRequired ? 'night-hiking' : ''}">
        <div class="day-header">
          <span class="day-number">Day ${i + 1}</span>
          <span class="day-date">${dateStr}</span>
          ${day.nightHikingRequired ? '<span class="night-warning">Night hiking required</span>' : ''}
        </div>
        <div class="day-details">
          <div class="day-stat">
            <span class="day-stat-label">Distance (km)</span>
            <span class="day-stat-value">${day.distanceKm.toFixed(1)}</span>
          </div>
          <div class="day-stat">
            <span class="day-stat-label">Sunrise</span>
            <span class="day-stat-value">${formatSunTime(day, 'sunrise', offset)}</span>
          </div>
          <div class="day-stat">
            <span class="day-stat-label">Sunset</span>
            <span class="day-stat-value">${formatSunTime(day, 'sunset', offset)}</span>
          </div>
          <div class="day-stat">
            <span class="day-stat-label">Daylight</span>
            <span class="day-stat-value">${formatDaylightHours(day.daylightHours)}</span>
          </div>
          <div class="day-stat">
            <span class="day-stat-label">Hiking Hours</span>
            <span class="day-stat-value">${formatDaylightHours(day.hikingHoursAvailable)}</span>
          </div>
          <div class="day-stat">
            <span class="day-stat-label">Moon</span>
            <span class="day-stat-value">${moon.phaseName} (${Math.round(moon.illumination * 100)}%)</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Download CSV
downloadCsvBtn.addEventListener('click', () => {
  if (!daylightPlan) return;
  const csv = exportDaylightPlanToCSV(daylightPlan);
  const blob = new Blob([csv], { type: 'text/csv' });
  const baseName = gpxFile?.name.replace('.gpx', '') || 'route';
  saveAs(blob, `${baseName}_daylight_plan.csv`);
});

// Render daylight map with day markers
function renderDaylightMap(points: MapPoint[], plan: DaylightPlan): void {
  // Initialize or clear map
  if (map) {
    map.remove();
  }

  map = initializeMap('daylight-map');

  // Draw the full route in gray
  const routeLine = createRoutePolyline(points, '#94a3b8', { weight: 3, opacity: 0.6 });
  routeLine.addTo(map);

  // Add day start markers
  plan.days.forEach((day, i) => {
    const dayNum = i + 1;
    const color = day.nightHikingRequired ? '#ef4444' : '#22c55e';

    // Start marker with day number
    const startMarker = createNumberedMarker(
      day.startLocation.lat,
      day.startLocation.lon,
      dayNum,
      color
    );
    startMarker.bindPopup(`
      <strong>Day ${dayNum} Start</strong><br>
      ${formatPlanDate(day.date, plan.utcOffsetHours)}<br>
      Sunrise: ${formatSunTime(day, 'sunrise', plan.utcOffsetHours)}<br>
      Daylight: ${formatDaylightHours(day.daylightHours)}
      ${day.nightHikingRequired ? '<br><em style="color: #ef4444;">Night hiking required</em>' : ''}
    `);
    startMarker.addTo(map!);
  });

  // Add final end marker
  const lastDay = plan.days[plan.days.length - 1];
  if (lastDay) {
    const endMarker = L.circleMarker(
      [lastDay.endLocation.lat, lastDay.endLocation.lon],
      {
        radius: 10,
        fillColor: '#3b82f6',
        color: '#fff',
        weight: 2,
        fillOpacity: 0.9,
      }
    );
    endMarker.bindPopup('<strong>Trip End</strong>');
    endMarker.addTo(map);
  }

  // Fit map to show all points
  fitMapToBounds(map, points);
}

// Render daylight hours chart
function renderDaylightChart(plan: DaylightPlan): void {
  // Destroy existing chart
  if (daylightChart) {
    daylightChart.destroy();
  }

  const canvas = document.getElementById('daylight-chart') as HTMLCanvasElement;
  if (!canvas) return;

  const labels = plan.days.map((_, i) => `Day ${i + 1}`);
  const daylightData = plan.days.map(d => d.daylightHours);
  const hikingData = plan.days.map(d => d.hikingHoursAvailable);
  const nightHikingColors = plan.days.map(d =>
    d.nightHikingRequired ? 'rgba(239, 68, 68, 0.7)' : 'rgba(34, 197, 94, 0.7)'
  );

  daylightChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Daylight Hours',
          data: daylightData,
          backgroundColor: 'rgba(251, 191, 36, 0.7)',
          borderColor: '#f59e0b',
          borderWidth: 1,
        },
        {
          label: 'Hiking Hours Available',
          data: hikingData,
          backgroundColor: nightHikingColors,
          borderColor: plan.days.map(d =>
            d.nightHikingRequired ? '#ef4444' : '#22c55e'
          ),
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: 'Hours',
          },
          ticks: {
            stepSize: 2,
          },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (context) => {
              const hours = context.parsed.y ?? 0;
              const h = Math.floor(hours);
              const m = Math.round((hours - h) * 60);
              return `${context.dataset.label}: ${h}h ${m}m`;
            },
          },
        },
        legend: {
          position: 'bottom',
        },
      },
    },
  });
}

// Load preferences from localStorage
function loadPreferences(): void {
  const prefs = localStorage.getItem('gpx-tools-prefs');
  if (prefs) {
    try {
      const parsed = JSON.parse(prefs);
      if (parsed.daylight?.dailyTarget) dailyTargetInput.value = parsed.daylight.dailyTarget;
      if (parsed.daylight?.hikingSpeed) hikingSpeedInput.value = parsed.daylight.hikingSpeed;
      if (parsed.daylight?.startOffset !== undefined) startOffsetInput.value = parsed.daylight.startOffset;
      if (parsed.daylight?.endOffset !== undefined) endOffsetInput.value = parsed.daylight.endOffset;
    } catch {
      // Ignore invalid stored prefs
    }
  }
}

function savePreferences(): void {
  let existingPrefs: Record<string, unknown> = {};
  try {
    existingPrefs = JSON.parse(localStorage.getItem('gpx-tools-prefs') || '{}');
  } catch {
    // Corrupted stored prefs - overwrite with fresh values
  }
  existingPrefs.daylight = {
    dailyTarget: dailyTargetInput.value,
    hikingSpeed: hikingSpeedInput.value,
    startOffset: startOffsetInput.value,
    endOffset: endOffsetInput.value,
  };
  localStorage.setItem('gpx-tools-prefs', JSON.stringify(existingPrefs));
}

// Save preferences on change
[dailyTargetInput, hikingSpeedInput, startOffsetInput, endOffsetInput].forEach(input => {
  input.addEventListener('change', savePreferences);
});

// Load preferences on startup
loadPreferences();
