import { splitGpx, processTravelPlan, processGpxTravelPlan, optimizeGpx, type SplitResult, type ProcessResult, type DistanceUnit, type ElevationUnit, type CsvDelimiter, type OptimizationResult, type OptimizationOptions } from '../lib';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// DOM Elements
const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
const panels = document.querySelectorAll<HTMLElement>('.panel');

// GPX Elements
const gpxUploadArea = document.getElementById('gpx-upload-area')!;
const gpxFileInput = document.getElementById('gpx-file-input') as HTMLInputElement;
const gpxFileInfo = document.getElementById('gpx-file-info')!;
const gpxProcessBtn = document.getElementById('gpx-process-btn') as HTMLButtonElement;
const gpxResults = document.getElementById('gpx-results')!;
const gpxStats = document.getElementById('gpx-stats')!;
const gpxFileList = document.getElementById('gpx-file-list')!;
const gpxDownloadAll = document.getElementById('gpx-download-all')!;
const maxPointsInput = document.getElementById('max-points') as HTMLInputElement;
const waypointDistanceInput = document.getElementById('waypoint-distance') as HTMLInputElement;

// CSV Elements
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

// GPX-only options elements
const gpxOnlyOptions = document.querySelectorAll<HTMLElement>('.gpx-only-option');

// Optimizer Elements
const optimizerUploadArea = document.getElementById('optimizer-upload-area')!;
const optimizerFileInput = document.getElementById('optimizer-file-input') as HTMLInputElement;
const optimizerFileInfo = document.getElementById('optimizer-file-info')!;
const optimizerProcessBtn = document.getElementById('optimizer-process-btn') as HTMLButtonElement;
const optimizerResults = document.getElementById('optimizer-results')!;
const optimizerStats = document.getElementById('optimizer-stats')!;
const optimizerFileList = document.getElementById('optimizer-file-list')!;
const optimizerDownloadAll = document.getElementById('optimizer-download-all')!;
const simplificationToleranceInput = document.getElementById('simplification-tolerance') as HTMLInputElement;
const simplificationToleranceValue = document.getElementById('simplification-tolerance-value')!;
const elevationSmoothingCheckbox = document.getElementById('elevation-smoothing') as HTMLInputElement;
const smoothingWindowInput = document.getElementById('smoothing-window') as HTMLInputElement;
const spikeThresholdInput = document.getElementById('spike-threshold') as HTMLInputElement;
const truncateStartInput = document.getElementById('truncate-start') as HTMLInputElement;
const truncateEndInput = document.getElementById('truncate-end') as HTMLInputElement;
const preserveTimestampsCheckbox = document.getElementById('preserve-timestamps') as HTMLInputElement;
const elevationOptions = document.querySelectorAll<HTMLElement>('.elevation-option');

// State
let gpxFile: File | null = null;
let csvFile: File | null = null;
let optimizerFiles: File[] = [];
let gpxSplitResults: SplitResult[] = [];
let csvProcessResults: ProcessResult | null = null;
let optimizerResults_data: OptimizationResult[] = [];

/**
 * Show or hide GPX-only options based on the selected file type
 */
function updateGpxOnlyOptionsVisibility(file: File | null): void {
  const isGpxFile = file?.name.toLowerCase().endsWith('.gpx') ?? false;
  gpxOnlyOptions.forEach(el => {
    el.classList.toggle('visible', isGpxFile);
  });
}

// Tab switching
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const tabId = tab.dataset.tab!;
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    panels.forEach(p => {
      p.classList.toggle('active', p.id === `${tabId}-panel`);
    });
  });
});

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

// GPX Upload handling
function setupUploadArea(
  area: HTMLElement,
  input: HTMLInputElement,
  fileInfo: HTMLElement,
  onFile: (file: File) => void
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
    onFile(null as unknown as File);
  });
}

function showFileInfo(area: HTMLElement, fileInfo: HTMLElement, file: File): void {
  area.classList.add('has-file');
  area.querySelector('.upload-content')!.setAttribute('hidden', '');
  fileInfo.removeAttribute('hidden');
  fileInfo.querySelector('.file-name')!.textContent = file.name;
  fileInfo.querySelector('.file-size')!.textContent = formatFileSize(file.size);
}

// GPX handling
setupUploadArea(gpxUploadArea, gpxFileInput, gpxFileInfo, (file) => {
  gpxFile = file;
  if (file) {
    showFileInfo(gpxUploadArea, gpxFileInfo, file);
    gpxProcessBtn.disabled = false;
    gpxResults.setAttribute('hidden', '');
  } else {
    gpxProcessBtn.disabled = true;
    gpxResults.setAttribute('hidden', '');
  }
});

gpxProcessBtn.addEventListener('click', async () => {
  if (!gpxFile) return;

  gpxProcessBtn.disabled = true;
  gpxProcessBtn.textContent = 'Processing...';

  try {
    const content = await gpxFile.text();
    const maxPoints = parseInt(maxPointsInput.value) || 5000;
    const waypointMaxDistance = parseFloat(waypointDistanceInput.value) || 5;

    gpxSplitResults = splitGpx(content, { maxPoints, waypointMaxDistance });

    // Show results
    gpxResults.removeAttribute('hidden');

    const totalPoints = gpxSplitResults.reduce((sum, r) => sum + r.pointCount, 0);
    const totalWaypoints = gpxSplitResults.reduce((sum, r) => sum + r.waypointCount, 0);

    gpxStats.innerHTML = `
      <p><strong>Files created:</strong> ${gpxSplitResults.length}</p>
      <p><strong>Total points:</strong> ${totalPoints.toLocaleString()}</p>
      <p><strong>Waypoints included:</strong> ${totalWaypoints}</p>
    `;

    gpxFileList.innerHTML = gpxSplitResults.map((result, i) => `
      <div class="file-item">
        <div class="file-item-info">
          <span class="file-item-name">${result.filename}</span>
          <span class="file-item-meta">${result.pointCount.toLocaleString()} points, ${result.waypointCount} waypoints</span>
        </div>
        <button class="download-btn" data-index="${i}">Download</button>
      </div>
    `).join('');

    // Add download handlers
    gpxFileList.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt((btn as HTMLElement).dataset.index!);
        const result = gpxSplitResults[index];
        downloadFile(result.filename, result.content, 'application/gpx+xml');
      });
    });

  } catch (error) {
    alert(`Error processing GPX: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    gpxProcessBtn.disabled = false;
    gpxProcessBtn.textContent = 'Split GPX';
  }
});

gpxDownloadAll.addEventListener('click', async () => {
  if (gpxSplitResults.length === 0) return;

  const zip = new JSZip();
  for (const result of gpxSplitResults) {
    zip.file(result.filename, result.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const baseName = gpxFile?.name.replace('.gpx', '') || 'gpx-split';
  saveAs(blob, `${baseName}-split.zip`);
});

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

    // Detect file type by extension
    const isGpxFile = csvFile.name.toLowerCase().endsWith('.gpx');

    if (isGpxFile) {
      // Process as GPX file
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
      // Process as CSV file
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
      if (parsed.gpx?.maxPoints) maxPointsInput.value = parsed.gpx.maxPoints;
      if (parsed.gpx?.waypointDistance) waypointDistanceInput.value = parsed.gpx.waypointDistance;
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
  const prefs = {
    gpx: {
      maxPoints: parseInt(maxPointsInput.value),
      waypointDistance: parseFloat(waypointDistanceInput.value),
    },
    csv: {
      resupplyKeywords: resupplyKeywordsInput.value.split(',').map(k => k.trim()).filter(k => k),
      includeStartAsResupply: includeStartCheckbox.checked,
      includeEndAsResupply: includeEndCheckbox.checked,
      distanceUnit: distanceUnitSelect.value,
      elevationUnit: elevationUnitSelect.value,
      csvDelimiter: csvDelimiterSelect.value,
      waypointMaxDistance: parseInt(waypointMaxDistanceInput.value),
    },
  };
  localStorage.setItem('gpx-tools-prefs', JSON.stringify(prefs));
}

// Save preferences on change
[maxPointsInput, waypointDistanceInput, resupplyKeywordsInput, includeStartCheckbox, includeEndCheckbox,
 distanceUnitSelect, elevationUnitSelect, csvDelimiterSelect, waypointMaxDistanceInput].forEach(input => {
  input.addEventListener('change', savePreferences);
});

// Load preferences on startup
loadPreferences();

// ============ GPX Optimizer ============

// Update tolerance display value
simplificationToleranceInput.addEventListener('input', () => {
  simplificationToleranceValue.textContent = `${simplificationToleranceInput.value}m`;
});

// Toggle elevation options visibility
function updateElevationOptionsVisibility(): void {
  const enabled = elevationSmoothingCheckbox.checked;
  elevationOptions.forEach(el => {
    el.classList.toggle('disabled', !enabled);
    const inputs = el.querySelectorAll('input');
    inputs.forEach(input => (input as HTMLInputElement).disabled = !enabled);
  });
}

elevationSmoothingCheckbox.addEventListener('change', updateElevationOptionsVisibility);
updateElevationOptionsVisibility();

// Multi-file upload handling for optimizer
function setupMultiFileUploadArea(
  area: HTMLElement,
  input: HTMLInputElement,
  fileInfo: HTMLElement,
  onFiles: (files: File[]) => void
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
      onFiles(Array.from(files).filter(f => f.name.toLowerCase().endsWith('.gpx')));
    }
  });

  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) {
      onFiles(Array.from(input.files));
    }
  });

  const clearBtn = fileInfo.querySelector('.clear-btn');
  clearBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    input.value = '';
    area.classList.remove('has-file');
    area.querySelector('.upload-content')!.removeAttribute('hidden');
    fileInfo.setAttribute('hidden', '');
    onFiles([]);
  });
}

function showMultiFileInfo(area: HTMLElement, fileInfo: HTMLElement, files: File[]): void {
  area.classList.add('has-file');
  area.querySelector('.upload-content')!.setAttribute('hidden', '');
  fileInfo.removeAttribute('hidden');
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  fileInfo.querySelector('.file-name')!.textContent = files.length === 1
    ? files[0].name
    : `${files.length} GPX files`;
  fileInfo.querySelector('.file-size')!.textContent = formatFileSize(totalSize);
}

setupMultiFileUploadArea(optimizerUploadArea, optimizerFileInput, optimizerFileInfo, (files) => {
  optimizerFiles = files;
  if (files.length > 0) {
    showMultiFileInfo(optimizerUploadArea, optimizerFileInfo, files);
    optimizerProcessBtn.disabled = false;
    optimizerResults.setAttribute('hidden', '');
  } else {
    optimizerProcessBtn.disabled = true;
    optimizerResults.setAttribute('hidden', '');
  }
});

optimizerProcessBtn.addEventListener('click', async () => {
  if (optimizerFiles.length === 0) return;

  optimizerProcessBtn.disabled = true;
  optimizerProcessBtn.textContent = 'Optimizing...';

  try {
    const options: Partial<OptimizationOptions> = {
      simplificationTolerance: parseInt(simplificationToleranceInput.value) || 10,
      elevationSmoothing: elevationSmoothingCheckbox.checked,
      elevationSmoothingWindow: parseInt(smoothingWindowInput.value) || 7,
      spikeThreshold: parseInt(spikeThresholdInput.value) || 50,
      truncateStart: parseInt(truncateStartInput.value) || 0,
      truncateEnd: parseInt(truncateEndInput.value) || 0,
      preserveTimestamps: preserveTimestampsCheckbox.checked,
    };

    optimizerResults_data = [];

    for (const file of optimizerFiles) {
      const content = await file.text();
      const result = optimizeGpx(content, file.name, options);
      optimizerResults_data.push(result);
    }

    // Show results
    optimizerResults.removeAttribute('hidden');

    // Calculate totals
    const totalOriginalSize = optimizerResults_data.reduce((sum, r) => sum + r.original.fileSize, 0);
    const totalOptimizedSize = optimizerResults_data.reduce((sum, r) => sum + r.optimized.fileSize, 0);
    const totalOriginalPoints = optimizerResults_data.reduce((sum, r) => sum + r.original.pointCount, 0);
    const totalOptimizedPoints = optimizerResults_data.reduce((sum, r) => sum + r.optimized.pointCount, 0);
    const avgReduction = totalOriginalSize > 0
      ? ((1 - totalOptimizedSize / totalOriginalSize) * 100)
      : 0;
    const filesWithWarnings = optimizerResults_data.filter(r => r.warnings.length > 0).length;

    optimizerStats.innerHTML = `
      <p><strong>Files processed:</strong> ${optimizerResults_data.length}</p>
      <p><strong>Total points:</strong> ${totalOriginalPoints.toLocaleString()} → ${totalOptimizedPoints.toLocaleString()} (${((1 - totalOptimizedPoints / totalOriginalPoints) * 100).toFixed(1)}% reduction)</p>
      <p><strong>Total size:</strong> ${formatFileSize(totalOriginalSize)} → ${formatFileSize(totalOptimizedSize)} (${avgReduction.toFixed(1)}% reduction)</p>
      ${filesWithWarnings > 0 ? `<p class="warning"><strong>Warnings:</strong> ${filesWithWarnings} file(s) have warnings</p>` : ''}
    `;

    optimizerFileList.innerHTML = optimizerResults_data.map((result, i) => {
      const pointReduction = ((1 - result.optimized.pointCount / result.original.pointCount) * 100).toFixed(1);
      const sizeReduction = ((1 - result.optimized.fileSize / result.original.fileSize) * 100).toFixed(1);
      const statusClass = result.passed ? 'passed' : 'warning';
      const statusText = result.passed ? 'PASSED' : 'WARNING';

      return `
        <div class="file-item">
          <div class="file-item-info">
            <span class="file-item-name">${result.filename}</span>
            <span class="file-item-meta">
              ${result.original.pointCount.toLocaleString()} → ${result.optimized.pointCount.toLocaleString()} points (${pointReduction}% reduction)
              | ${formatFileSize(result.original.fileSize)} → ${formatFileSize(result.optimized.fileSize)} (${sizeReduction}%)
            </span>
            <span class="file-item-status ${statusClass}">${statusText}</span>
            ${result.warnings.length > 0 ? `<span class="file-item-warnings">${result.warnings.join('; ')}</span>` : ''}
          </div>
          <button class="download-btn" data-index="${i}">Download</button>
        </div>
      `;
    }).join('');

    // Add download handlers
    optimizerFileList.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt((btn as HTMLElement).dataset.index!);
        const result = optimizerResults_data[index];
        downloadFile(result.filename, result.content, 'application/gpx+xml');
      });
    });

  } catch (error) {
    alert(`Error optimizing GPX: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    optimizerProcessBtn.disabled = false;
    optimizerProcessBtn.textContent = 'Optimize GPX Files';
  }
});

optimizerDownloadAll.addEventListener('click', async () => {
  if (optimizerResults_data.length === 0) return;

  const zip = new JSZip();
  for (const result of optimizerResults_data) {
    zip.file(result.filename, result.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, 'gpx-optimized.zip');
});

// Save optimizer preferences
function saveOptimizerPreferences(): void {
  const prefs = localStorage.getItem('gpx-tools-prefs');
  const parsed = prefs ? JSON.parse(prefs) : {};
  parsed.optimizer = {
    simplificationTolerance: parseInt(simplificationToleranceInput.value),
    elevationSmoothing: elevationSmoothingCheckbox.checked,
    smoothingWindow: parseInt(smoothingWindowInput.value),
    spikeThreshold: parseInt(spikeThresholdInput.value),
    truncateStart: parseInt(truncateStartInput.value),
    truncateEnd: parseInt(truncateEndInput.value),
    preserveTimestamps: preserveTimestampsCheckbox.checked,
  };
  localStorage.setItem('gpx-tools-prefs', JSON.stringify(parsed));
}

function loadOptimizerPreferences(): void {
  const prefs = localStorage.getItem('gpx-tools-prefs');
  if (prefs) {
    try {
      const parsed = JSON.parse(prefs);
      if (parsed.optimizer) {
        if (parsed.optimizer.simplificationTolerance !== undefined) {
          simplificationToleranceInput.value = parsed.optimizer.simplificationTolerance;
          simplificationToleranceValue.textContent = `${parsed.optimizer.simplificationTolerance}m`;
        }
        if (parsed.optimizer.elevationSmoothing !== undefined) {
          elevationSmoothingCheckbox.checked = parsed.optimizer.elevationSmoothing;
        }
        if (parsed.optimizer.smoothingWindow !== undefined) {
          smoothingWindowInput.value = parsed.optimizer.smoothingWindow;
        }
        if (parsed.optimizer.spikeThreshold !== undefined) {
          spikeThresholdInput.value = parsed.optimizer.spikeThreshold;
        }
        if (parsed.optimizer.truncateStart !== undefined) {
          truncateStartInput.value = parsed.optimizer.truncateStart;
        }
        if (parsed.optimizer.truncateEnd !== undefined) {
          truncateEndInput.value = parsed.optimizer.truncateEnd;
        }
        if (parsed.optimizer.preserveTimestamps !== undefined) {
          preserveTimestampsCheckbox.checked = parsed.optimizer.preserveTimestamps;
        }
        updateElevationOptionsVisibility();
      }
    } catch {
      // Ignore invalid stored prefs
    }
  }
}

// Add optimizer inputs to save handlers
[simplificationToleranceInput, elevationSmoothingCheckbox, smoothingWindowInput,
 spikeThresholdInput, truncateStartInput, truncateEndInput, preserveTimestampsCheckbox].forEach(input => {
  input.addEventListener('change', saveOptimizerPreferences);
});

// Load optimizer preferences
loadOptimizerPreferences();
