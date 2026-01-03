import { parseGpx } from '../../lib/gpx-parser.js';
import { createDaylightPlan, exportDaylightPlanToCSV, formatTime, formatDaylightHours, getMoonInfo, type DaylightPlan } from '../../lib/daylight.js';
import { saveAs } from 'file-saver';

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

// Set default start date to today
startDateInput.valueAsDate = new Date();

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

  const startDate = startDateInput.valueAsDate;
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

    const dailyTargetKm = parseFloat(dailyTargetInput.value) || 25;
    const hikingSpeedKmh = parseFloat(hikingSpeedInput.value) || 4;
    const startTimeOffset = parseInt(startOffsetInput.value) || 30;
    const endTimeOffset = parseInt(endOffsetInput.value) || 30;

    daylightPlan = createDaylightPlan(points, {
      startDate,
      dailyTargetKm,
      hikingSpeedKmh,
      startTimeOffset,
      endTimeOffset,
    });

    // Display results
    results.removeAttribute('hidden');

    totalDaysEl.textContent = daylightPlan.totalDays.toString();
    totalDistanceEl.textContent = `${daylightPlan.totalDistance.toFixed(1)} km`;
    nightHikingDaysEl.textContent = daylightPlan.nightHikingDays.toString();
    shortestDayEl.textContent = formatDaylightHours(daylightPlan.shortestDay.hours);
    longestDayEl.textContent = formatDaylightHours(daylightPlan.longestDay.hours);

    renderDayList();

  } catch (error) {
    alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    calculateBtn.disabled = false;
    calculateBtn.textContent = 'Calculate Daylight Plan';
  }
});

// Render day list
function renderDayList(): void {
  if (!daylightPlan) return;

  dayListEl.innerHTML = daylightPlan.days.map((day, i) => {
    const moon = getMoonInfo(day.date);
    const dateStr = day.date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    return `
      <div class="day-item ${day.nightHikingRequired ? 'night-hiking' : ''}">
        <div class="day-header">
          <span class="day-number">Day ${i + 1}</span>
          <span class="day-date">${dateStr}</span>
          ${day.nightHikingRequired ? '<span class="night-warning">Night hiking required</span>' : ''}
        </div>
        <div class="day-details">
          <div class="day-stat">
            <span class="day-stat-label">Sunrise</span>
            <span class="day-stat-value">${formatTime(day.sunrise)}</span>
          </div>
          <div class="day-stat">
            <span class="day-stat-label">Sunset</span>
            <span class="day-stat-value">${formatTime(day.sunset)}</span>
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
