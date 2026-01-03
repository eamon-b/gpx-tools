import { processTravelPlan, processGpxTravelPlan, type ProcessResult, type DistanceUnit, type ElevationUnit, type CsvDelimiter } from '../../lib/index.js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// DOM Elements
const csvUploadArea = document.getElementById('csv-upload-area')!;
const csvFileInput = document.getElementById('csv-file-input') as HTMLInputElement;
const csvFileInfo = document.getElementById('csv-file-info')!;
const csvProcessBtn = document.getElementById('csv-process-btn') as HTMLButtonElement;
const csvResults = document.getElementById('csv-results')!;
const csvStats = document.getElementById('csv-stats')!;
const csvFileList = document.getElementById('csv-file-list')!;
const csvDownloadAll = document.getElementById('csv-download-all')!;
const resupplyKeywordsInput = document.getElementById('resupply-keywords') as HTMLInputElement;
const includeStartCheckbox = document.getElementById('include-start') as HTMLInputElement;
const includeEndCheckbox = document.getElementById('include-end') as HTMLInputElement;
const distanceUnitSelect = document.getElementById('distance-unit') as HTMLSelectElement;
const elevationUnitSelect = document.getElementById('elevation-unit') as HTMLSelectElement;
const csvDelimiterSelect = document.getElementById('csv-delimiter') as HTMLSelectElement;
const waypointMaxDistanceInput = document.getElementById('waypoint-max-distance') as HTMLInputElement;
const gpxOnlyOptions = document.querySelectorAll<HTMLElement>('.gpx-only-option');

// State
let csvFile: File | null = null;
let csvProcessResults: ProcessResult | null = null;

// Utility functions
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  saveAs(blob, filename);
}

function updateGpxOnlyOptionsVisibility(file: File | null): void {
  const isGpxFile = file?.name.toLowerCase().endsWith('.gpx') ?? false;
  gpxOnlyOptions.forEach(el => {
    el.classList.toggle('visible', isGpxFile);
  });
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

// CSV handling
setupUploadArea(csvUploadArea, csvFileInput, csvFileInfo, (file) => {
  csvFile = file;
  updateGpxOnlyOptionsVisibility(file);
  if (file) {
    showFileInfo(csvUploadArea, csvFileInfo, file);
    csvProcessBtn.disabled = false;
    csvResults.setAttribute('hidden', '');
  } else {
    csvProcessBtn.disabled = true;
    csvResults.setAttribute('hidden', '');
  }
});

csvProcessBtn.addEventListener('click', async () => {
  if (!csvFile) return;

  csvProcessBtn.disabled = true;
  csvProcessBtn.textContent = 'Processing...';

  try {
    const content = await csvFile.text();
    const keywords = resupplyKeywordsInput.value
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0);

    const distanceUnit = distanceUnitSelect.value as DistanceUnit;
    const elevationUnit = elevationUnitSelect.value as ElevationUnit;
    const csvDelimiter = csvDelimiterSelect.value as CsvDelimiter;

    const isGpxFile = csvFile.name.toLowerCase().endsWith('.gpx');

    if (isGpxFile) {
      const waypointMaxDistance = parseInt(waypointMaxDistanceInput.value) || 200;

      csvProcessResults = processGpxTravelPlan(content, {
        resupplyKeywords: keywords,
        includeStartAsResupply: includeStartCheckbox.checked,
        includeEndAsResupply: includeEndCheckbox.checked,
        distanceUnit,
        elevationUnit,
        csvDelimiter,
        waypointMaxDistance,
      });
    } else {
      csvProcessResults = processTravelPlan(content, {
        resupplyKeywords: keywords,
        includeEndAsResupply: includeEndCheckbox.checked,
        distanceUnit,
        elevationUnit,
        csvDelimiter,
      });
    }

    // Show results
    csvResults.removeAttribute('hidden');

    const distLabel = distanceUnit === 'mi' ? 'mi' : 'km';
    const eleLabel = elevationUnit === 'ft' ? 'ft' : 'm';
    const displayDistance = distanceUnit === 'mi'
      ? csvProcessResults.stats.totalDistance * 0.621371
      : csvProcessResults.stats.totalDistance;
    const displayAscent = elevationUnit === 'ft'
      ? csvProcessResults.stats.totalAscent * 3.28084
      : csvProcessResults.stats.totalAscent;
    const displayDescent = elevationUnit === 'ft'
      ? csvProcessResults.stats.totalDescent * 3.28084
      : csvProcessResults.stats.totalDescent;

    csvStats.innerHTML = `
      <p><strong>Total points:</strong> ${csvProcessResults.stats.totalPoints}</p>
      <p><strong>Resupply points:</strong> ${csvProcessResults.stats.resupplyCount}</p>
      <p><strong>Total distance:</strong> ${displayDistance.toFixed(2)} ${distLabel}</p>
      <p><strong>Total ascent:</strong> ${Math.round(displayAscent).toLocaleString()} ${eleLabel}</p>
      <p><strong>Total descent:</strong> ${Math.round(displayDescent).toLocaleString()} ${eleLabel}</p>
    `;

    const baseName = csvFile.name.replace(/\.(csv|gpx)$/i, '');

    csvFileList.innerHTML = `
      <div class="file-item">
        <div class="file-item-info">
          <span class="file-item-name">${baseName}_processed.csv</span>
          <span class="file-item-meta">Full travel plan with cumulative stats</span>
        </div>
        <button class="download-btn" data-file="processed">Download</button>
      </div>
      <div class="file-item">
        <div class="file-item-info">
          <span class="file-item-name">${baseName}_resupply.csv</span>
          <span class="file-item-meta">${csvProcessResults.stats.resupplyCount} resupply points</span>
        </div>
        <button class="download-btn" data-file="resupply">Download</button>
      </div>
    `;

    csvFileList.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fileType = (btn as HTMLElement).dataset.file;
        if (!csvProcessResults) return;

        if (fileType === 'processed') {
          downloadFile(`${baseName}_processed.csv`, csvProcessResults.processedPlan, 'text/csv');
        } else {
          downloadFile(`${baseName}_resupply.csv`, csvProcessResults.resupplyPoints, 'text/csv');
        }
      });
    });

  } catch (error) {
    alert(`Error processing file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    csvProcessBtn.disabled = false;
    csvProcessBtn.textContent = 'Process Travel Plan';
  }
});

csvDownloadAll.addEventListener('click', async () => {
  if (!csvProcessResults || !csvFile) return;

  const baseName = csvFile.name.replace(/\.(csv|gpx)$/i, '');
  const zip = new JSZip();
  zip.file(`${baseName}_processed.csv`, csvProcessResults.processedPlan);
  zip.file(`${baseName}_resupply.csv`, csvProcessResults.resupplyPoints);

  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, `${baseName}-processed.zip`);
});

// Load preferences from localStorage
function loadPreferences(): void {
  const prefs = localStorage.getItem('gpx-tools-prefs');
  if (prefs) {
    try {
      const parsed = JSON.parse(prefs);
      if (parsed.csv?.resupplyKeywords) resupplyKeywordsInput.value = parsed.csv.resupplyKeywords.join(', ');
      if (parsed.csv?.includeStartAsResupply !== undefined) includeStartCheckbox.checked = parsed.csv.includeStartAsResupply;
      if (parsed.csv?.includeEndAsResupply !== undefined) includeEndCheckbox.checked = parsed.csv.includeEndAsResupply;
      if (parsed.csv?.distanceUnit) distanceUnitSelect.value = parsed.csv.distanceUnit;
      if (parsed.csv?.elevationUnit) elevationUnitSelect.value = parsed.csv.elevationUnit;
      if (parsed.csv?.csvDelimiter) csvDelimiterSelect.value = parsed.csv.csvDelimiter;
      if (parsed.csv?.waypointMaxDistance) waypointMaxDistanceInput.value = parsed.csv.waypointMaxDistance;
    } catch {
      // Ignore invalid stored prefs
    }
  }
}

function savePreferences(): void {
  const existingPrefs = JSON.parse(localStorage.getItem('gpx-tools-prefs') || '{}');
  existingPrefs.csv = {
    resupplyKeywords: resupplyKeywordsInput.value.split(',').map(k => k.trim()).filter(k => k),
    includeStartAsResupply: includeStartCheckbox.checked,
    includeEndAsResupply: includeEndCheckbox.checked,
    distanceUnit: distanceUnitSelect.value,
    elevationUnit: elevationUnitSelect.value,
    csvDelimiter: csvDelimiterSelect.value,
    waypointMaxDistance: parseInt(waypointMaxDistanceInput.value),
  };
  localStorage.setItem('gpx-tools-prefs', JSON.stringify(existingPrefs));
}

// Save preferences on change
[resupplyKeywordsInput, includeStartCheckbox, includeEndCheckbox,
 distanceUnitSelect, elevationUnitSelect, csvDelimiterSelect, waypointMaxDistanceInput].forEach(input => {
  input.addEventListener('change', savePreferences);
});

// Load preferences on startup
loadPreferences();
