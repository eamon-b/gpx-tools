import { splitGpx, type SplitResult } from '../../lib/index.js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// DOM Elements
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

// State
let gpxFile: File | null = null;
let gpxSplitResults: SplitResult[] = [];

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

// Load preferences from localStorage
function loadPreferences(): void {
  const prefs = localStorage.getItem('gpx-tools-prefs');
  if (prefs) {
    try {
      const parsed = JSON.parse(prefs);
      if (parsed.gpx?.maxPoints) maxPointsInput.value = parsed.gpx.maxPoints;
      if (parsed.gpx?.waypointDistance) waypointDistanceInput.value = parsed.gpx.waypointDistance;
    } catch {
      // Ignore invalid stored prefs
    }
  }
}

function savePreferences(): void {
  const existingPrefs = JSON.parse(localStorage.getItem('gpx-tools-prefs') || '{}');
  existingPrefs.gpx = {
    maxPoints: parseInt(maxPointsInput.value),
    waypointDistance: parseFloat(waypointDistanceInput.value),
  };
  localStorage.setItem('gpx-tools-prefs', JSON.stringify(existingPrefs));
}

// Save preferences on change
[maxPointsInput, waypointDistanceInput].forEach(input => {
  input.addEventListener('change', savePreferences);
});

// Load preferences on startup
loadPreferences();
