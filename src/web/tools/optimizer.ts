import { optimizeGpx, type OptimizationResult, type OptimizationOptions } from '../../lib/index.js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// DOM Elements
const gpxUploadArea = document.getElementById('gpx-upload-area')!;
const gpxFileInput = document.getElementById('gpx-file-input') as HTMLInputElement;
const fileListContainer = document.getElementById('file-list-container')!;
const inputFileList = document.getElementById('input-file-list')!;
const clearAllBtn = document.getElementById('clear-all-btn')!;
const processBtn = document.getElementById('process-btn') as HTMLButtonElement;
const results = document.getElementById('results')!;
const stats = document.getElementById('stats')!;
const warnings = document.getElementById('warnings')!;
const resultFileList = document.getElementById('result-file-list')!;
const downloadAllBtn = document.getElementById('download-all-btn')!;

// Options
const simplificationToleranceInput = document.getElementById('simplification-tolerance') as HTMLInputElement;
const elevationSmoothingCheckbox = document.getElementById('elevation-smoothing') as HTMLInputElement;
const smoothingWindowInput = document.getElementById('smoothing-window') as HTMLInputElement;
const spikeThresholdInput = document.getElementById('spike-threshold') as HTMLInputElement;
const truncateStartInput = document.getElementById('truncate-start') as HTMLInputElement;
const truncateEndInput = document.getElementById('truncate-end') as HTMLInputElement;
const preserveTimestampsCheckbox = document.getElementById('preserve-timestamps') as HTMLInputElement;
const coordinatePrecisionInput = document.getElementById('coordinate-precision') as HTMLInputElement;

// State
interface FileEntry {
  file: File;
  content: string;
}

let fileEntries: FileEntry[] = [];
let optimizationResults: OptimizationResult[] = [];

// Utility functions
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

function updateUI(): void {
  const hasFiles = fileEntries.length > 0;
  fileListContainer.hidden = !hasFiles;
  processBtn.disabled = !hasFiles;
  results.hidden = true;

  if (hasFiles) {
    gpxUploadArea.classList.add('has-file');
  } else {
    gpxUploadArea.classList.remove('has-file');
  }

  renderInputFileList();
}

function renderInputFileList(): void {
  inputFileList.innerHTML = fileEntries.map((entry, index) => `
    <li class="file-item">
      <div class="file-item-info">
        <span class="file-item-name">${entry.file.name}</span>
        <span class="file-item-meta">${formatFileSize(entry.file.size)}</span>
      </div>
      <button class="remove-file-btn" data-index="${index}" title="Remove">✕</button>
    </li>
  `).join('');

  // Add remove handlers
  inputFileList.querySelectorAll('.remove-file-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt((btn as HTMLElement).dataset.index!);
      fileEntries.splice(index, 1);
      updateUI();
    });
  });
}

async function addFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    if (!file.name.toLowerCase().endsWith('.gpx')) {
      continue;
    }

    try {
      const content = await file.text();
      fileEntries.push({ file, content });
    } catch (error) {
      console.error(`Error reading ${file.name}:`, error);
    }
  }
  updateUI();
}

// Upload handling
gpxUploadArea.addEventListener('click', () => {
  gpxFileInput.click();
});

gpxUploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  gpxUploadArea.classList.add('dragover');
});

gpxUploadArea.addEventListener('dragleave', () => {
  gpxUploadArea.classList.remove('dragover');
});

gpxUploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  gpxUploadArea.classList.remove('dragover');
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    addFiles(files);
  }
});

gpxFileInput.addEventListener('change', () => {
  if (gpxFileInput.files && gpxFileInput.files.length > 0) {
    addFiles(gpxFileInput.files);
    gpxFileInput.value = '';
  }
});

clearAllBtn.addEventListener('click', () => {
  fileEntries = [];
  updateUI();
});

// Process files
processBtn.addEventListener('click', async () => {
  if (fileEntries.length === 0) return;

  processBtn.disabled = true;
  processBtn.textContent = 'Processing...';

  try {
    const options: Partial<OptimizationOptions> = {
      simplificationTolerance: parseFloat(simplificationToleranceInput.value) || 10,
      elevationSmoothing: elevationSmoothingCheckbox.checked,
      elevationSmoothingWindow: parseInt(smoothingWindowInput.value) || 7,
      spikeThreshold: parseFloat(spikeThresholdInput.value) || 50,
      truncateStart: parseFloat(truncateStartInput.value) || 0,
      truncateEnd: parseFloat(truncateEndInput.value) || 0,
      preserveTimestamps: preserveTimestampsCheckbox.checked,
      coordinatePrecision: parseInt(coordinatePrecisionInput.value) || 6,
    };

    optimizationResults = [];
    const fileWarnings: Map<string, string[]> = new Map();

    for (const entry of fileEntries) {
      try {
        const result = optimizeGpx(entry.content, entry.file.name, options);
        optimizationResults.push(result);
        if (result.warnings.length > 0) {
          fileWarnings.set(entry.file.name, result.warnings);
        }
      } catch (error) {
        fileWarnings.set(entry.file.name, [error instanceof Error ? error.message : 'Unknown error']);
      }
    }

    // Show results
    results.hidden = false;

    // Calculate totals
    const totalOriginalSize = optimizationResults.reduce((sum, r) => sum + r.original.fileSize, 0);
    const totalOptimizedSize = optimizationResults.reduce((sum, r) => sum + r.optimized.fileSize, 0);
    const totalOriginalPoints = optimizationResults.reduce((sum, r) => sum + r.original.pointCount, 0);
    const totalOptimizedPoints = optimizationResults.reduce((sum, r) => sum + r.optimized.pointCount, 0);
    const reduction = totalOriginalSize > 0 ? ((1 - totalOptimizedSize / totalOriginalSize) * 100).toFixed(1) : '0';

    stats.innerHTML = `
      <p><strong>Files processed:</strong> ${optimizationResults.length}</p>
      <p><strong>Size reduction:</strong> ${formatFileSize(totalOriginalSize)} → ${formatFileSize(totalOptimizedSize)} (${reduction}% smaller)</p>
      <p><strong>Points:</strong> ${totalOriginalPoints.toLocaleString()} → ${totalOptimizedPoints.toLocaleString()}</p>
    `;

    // Show warnings grouped by file
    if (fileWarnings.size > 0) {
      warnings.hidden = false;
      let warningsHtml = '<h4>Warnings</h4>';
      for (const [filename, fileWarningList] of fileWarnings) {
        warningsHtml += `
          <div class="file-warnings">
            <strong>${filename}</strong>
            <ul>
              ${fileWarningList.map(w => `<li>${w}</li>`).join('')}
            </ul>
          </div>
        `;
      }
      warnings.innerHTML = warningsHtml;
    } else {
      warnings.hidden = true;
    }

    // Render result file list
    resultFileList.innerHTML = optimizationResults.map((result, index) => {
      const sizeReduction = ((1 - result.optimized.fileSize / result.original.fileSize) * 100).toFixed(1);
      return `
        <div class="file-item">
          <div class="file-item-info">
            <span class="file-item-name">${result.filename}</span>
            <span class="file-item-meta">
              ${formatFileSize(result.optimized.fileSize)} (${sizeReduction}% smaller) |
              ${result.optimized.pointCount.toLocaleString()} points |
              ${formatDistance(result.optimized.distance)}
            </span>
          </div>
          <button class="download-btn" data-index="${index}">Download</button>
        </div>
      `;
    }).join('');

    // Add individual download handlers
    resultFileList.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt((btn as HTMLElement).dataset.index!);
        const result = optimizationResults[index];
        const blob = new Blob([result.content], { type: 'application/gpx+xml' });
        saveAs(blob, result.filename);
      });
    });

  } catch (error) {
    alert(`Error optimizing GPX files: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = 'Optimize GPX Files';
  }
});

// Download all as ZIP
downloadAllBtn.addEventListener('click', async () => {
  if (optimizationResults.length === 0) return;

  const zip = new JSZip();
  for (const result of optimizationResults) {
    zip.file(result.filename, result.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, 'optimized-gpx.zip');
});

// Load preferences from localStorage
function loadPreferences(): void {
  const prefs = localStorage.getItem('gpx-tools-prefs');
  if (prefs) {
    try {
      const parsed = JSON.parse(prefs);
      if (parsed.optimizer?.simplificationTolerance) simplificationToleranceInput.value = parsed.optimizer.simplificationTolerance;
      if (parsed.optimizer?.elevationSmoothing !== undefined) elevationSmoothingCheckbox.checked = parsed.optimizer.elevationSmoothing;
      if (parsed.optimizer?.smoothingWindow) smoothingWindowInput.value = parsed.optimizer.smoothingWindow;
      if (parsed.optimizer?.spikeThreshold) spikeThresholdInput.value = parsed.optimizer.spikeThreshold;
      if (parsed.optimizer?.truncateStart !== undefined) truncateStartInput.value = parsed.optimizer.truncateStart;
      if (parsed.optimizer?.truncateEnd !== undefined) truncateEndInput.value = parsed.optimizer.truncateEnd;
      if (parsed.optimizer?.preserveTimestamps !== undefined) preserveTimestampsCheckbox.checked = parsed.optimizer.preserveTimestamps;
      if (parsed.optimizer?.coordinatePrecision) coordinatePrecisionInput.value = parsed.optimizer.coordinatePrecision;
    } catch {
      // Ignore invalid stored prefs
    }
  }
}

function savePreferences(): void {
  const existingPrefs = JSON.parse(localStorage.getItem('gpx-tools-prefs') || '{}');
  existingPrefs.optimizer = {
    simplificationTolerance: parseFloat(simplificationToleranceInput.value),
    elevationSmoothing: elevationSmoothingCheckbox.checked,
    smoothingWindow: parseInt(smoothingWindowInput.value),
    spikeThreshold: parseFloat(spikeThresholdInput.value),
    truncateStart: parseFloat(truncateStartInput.value),
    truncateEnd: parseFloat(truncateEndInput.value),
    preserveTimestamps: preserveTimestampsCheckbox.checked,
    coordinatePrecision: parseInt(coordinatePrecisionInput.value),
  };
  localStorage.setItem('gpx-tools-prefs', JSON.stringify(existingPrefs));
}

// Save preferences on change
const allInputs = [
  simplificationToleranceInput,
  smoothingWindowInput,
  spikeThresholdInput,
  truncateStartInput,
  truncateEndInput,
  coordinatePrecisionInput,
];
allInputs.forEach(input => {
  input.addEventListener('change', savePreferences);
});

const allCheckboxes = [elevationSmoothingCheckbox, preserveTimestampsCheckbox];
allCheckboxes.forEach(checkbox => {
  checkbox.addEventListener('change', savePreferences);
});

// Load preferences on startup
loadPreferences();
