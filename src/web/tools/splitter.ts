import { splitGpx, type SplitResult } from '../../lib/index.js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { setupUploadArea, showFileInfo, stripExtension } from '../shared/file-utils.js';
import { escapeHtml } from '../shared/html-utils.js';
import { PREFS_KEY, savePrefs } from '../shared/prefs.js';
import { setupErrorBanner, errorText } from '../shared/error-banner.js';

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
function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  saveAs(blob, filename);
}

const errorBanner = setupErrorBanner();

// GPX handling
setupUploadArea(gpxUploadArea, gpxFileInput, gpxFileInfo, (file) => {
  gpxFile = file;
  errorBanner.hide();
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
  errorBanner.hide();

  try {
    const content = await gpxFile.text();
    // Clamp to a sane minimum: negative/zero values would be invalid
    const maxPoints = Math.max(100, parseInt(maxPointsInput.value) || 5000);
    const waypointMaxDistance = parseFloat(waypointDistanceInput.value) || 5;
    maxPointsInput.value = String(maxPoints);

    gpxSplitResults = splitGpx(content, { maxPoints, waypointMaxDistance });

    if (gpxSplitResults.length === 0) {
      gpxResults.setAttribute('hidden', '');
      errorBanner.show('No track or route points were found in this file, so no output files were created. Check that the GPX contains a <trk> or <rte> with points.');
      return;
    }

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
          <span class="file-item-name">${escapeHtml(result.filename)}</span>
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
    gpxResults.setAttribute('hidden', '');
    errorBanner.show(`Error processing GPX: ${errorText(error)}`);
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
  const baseName = (gpxFile && stripExtension(gpxFile.name)) || 'gpx-split';
  saveAs(blob, `${baseName}-split.zip`);
});

// Load preferences from localStorage
function loadPreferences(): void {
  const prefs = localStorage.getItem(PREFS_KEY);
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
  savePrefs('gpx', {
    maxPoints: parseInt(maxPointsInput.value),
    waypointDistance: parseFloat(waypointDistanceInput.value),
  });
}

// Save preferences on change
[maxPointsInput, waypointDistanceInput].forEach(input => {
  input.addEventListener('change', savePreferences);
});

// Load preferences on startup
loadPreferences();
