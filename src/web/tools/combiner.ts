import { combineGpx, type CombineResult } from '../../lib/index.js';
import { saveAs } from 'file-saver';

// DOM Elements
const gpxUploadArea = document.getElementById('gpx-upload-area')!;
const gpxFileInput = document.getElementById('gpx-file-input') as HTMLInputElement;
const fileListContainer = document.getElementById('file-list-container')!;
const sortableFileList = document.getElementById('sortable-file-list')!;
const clearAllBtn = document.getElementById('clear-all-btn')!;
const processBtn = document.getElementById('process-btn') as HTMLButtonElement;
const results = document.getElementById('results')!;
const stats = document.getElementById('stats')!;
const warnings = document.getElementById('warnings')!;
const resultFilename = document.getElementById('result-filename')!;
const resultMeta = document.getElementById('result-meta')!;
const downloadBtn = document.getElementById('download-btn')!;

// Options
const trackNameInput = document.getElementById('track-name') as HTMLInputElement;
const removeDuplicatesCheckbox = document.getElementById('remove-duplicates') as HTMLInputElement;
const autoOrderCheckbox = document.getElementById('auto-order') as HTMLInputElement;
const gapThresholdInput = document.getElementById('gap-threshold') as HTMLInputElement;

// State
interface FileEntry {
  file: File;
  content: string;
}

let fileEntries: FileEntry[] = [];
let combineResult: CombineResult | null = null;

// Utility functions
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateUI(): void {
  const hasFiles = fileEntries.length > 0;
  fileListContainer.hidden = !hasFiles;
  processBtn.disabled = fileEntries.length < 2;
  results.hidden = true;

  if (hasFiles) {
    gpxUploadArea.classList.add('has-file');
  } else {
    gpxUploadArea.classList.remove('has-file');
  }

  renderFileList();
}

function renderFileList(): void {
  sortableFileList.innerHTML = fileEntries.map((entry, index) => `
    <li class="sortable-file-item" data-index="${index}" draggable="true">
      <span class="drag-handle">☰</span>
      <span class="file-name">${entry.file.name}</span>
      <span class="file-size">${formatFileSize(entry.file.size)}</span>
      <button class="remove-file-btn" data-index="${index}" title="Remove">✕</button>
    </li>
  `).join('');

  // Add remove handlers
  sortableFileList.querySelectorAll('.remove-file-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt((btn as HTMLElement).dataset.index!);
      fileEntries.splice(index, 1);
      updateUI();
    });
  });

  // Add drag and drop reordering
  setupDragAndDrop();
}

function setupDragAndDrop(): void {
  const items = sortableFileList.querySelectorAll('.sortable-file-item');

  items.forEach(item => {
    item.addEventListener('dragstart', (e) => {
      (item as HTMLElement).classList.add('dragging');
      (e as DragEvent).dataTransfer!.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      (item as HTMLElement).classList.remove('dragging');
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = sortableFileList.querySelector('.dragging');
      if (dragging && dragging !== item) {
        const rect = (item as HTMLElement).getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if ((e as DragEvent).clientY < midY) {
          sortableFileList.insertBefore(dragging, item);
        } else {
          sortableFileList.insertBefore(dragging, item.nextSibling);
        }
      }
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      // Reorder fileEntries based on new DOM order
      const newOrder: FileEntry[] = [];
      sortableFileList.querySelectorAll('.sortable-file-item').forEach(el => {
        const index = parseInt((el as HTMLElement).dataset.index!);
        newOrder.push(fileEntries[index]);
      });
      fileEntries = newOrder;
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
  if (fileEntries.length < 2) return;

  processBtn.disabled = true;
  processBtn.textContent = 'Processing...';

  try {
    const gpxContents = fileEntries.map(entry => entry.content);

    combineResult = combineGpx(gpxContents, {
      trackName: trackNameInput.value || 'Combined Track',
      removeDuplicateWaypoints: removeDuplicatesCheckbox.checked,
      autoOrder: autoOrderCheckbox.checked,
      gapThresholdMeters: parseInt(gapThresholdInput.value) || 100,
    });

    // Show results
    results.hidden = false;

    stats.innerHTML = `
      <p><strong>Files combined:</strong> ${combineResult.fileCount}</p>
      <p><strong>Total points:</strong> ${combineResult.pointCount.toLocaleString()}</p>
      <p><strong>Waypoints:</strong> ${combineResult.waypointCount}</p>
      ${combineResult.wasReordered ? '<p><strong>Note:</strong> Files were reordered for better continuity</p>' : ''}
    `;

    // Show warnings for gaps
    if (combineResult.gaps.length > 0) {
      warnings.hidden = false;
      warnings.innerHTML = `
        <h4>Gap Warnings</h4>
        <ul>
          ${combineResult.gaps.map(gap => `
            <li>Gap of ${gap.distanceMeters.toLocaleString()}m after segment ${gap.afterSegmentIndex + 1}</li>
          `).join('')}
        </ul>
      `;
    } else {
      warnings.hidden = true;
    }

    const outputFilename = 'combined.gpx';
    resultFilename.textContent = outputFilename;
    resultMeta.textContent = `${combineResult.pointCount.toLocaleString()} points, ${combineResult.waypointCount} waypoints`;

  } catch (error) {
    alert(`Error combining GPX files: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = 'Combine GPX Files';
  }
});

// Download handler
downloadBtn.addEventListener('click', () => {
  if (!combineResult) return;

  const blob = new Blob([combineResult.content], { type: 'application/gpx+xml' });
  const filename = trackNameInput.value
    ? `${trackNameInput.value.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.gpx`
    : 'combined.gpx';
  saveAs(blob, filename);
});

// Load preferences from localStorage
function loadPreferences(): void {
  const prefs = localStorage.getItem('gpx-tools-prefs');
  if (prefs) {
    try {
      const parsed = JSON.parse(prefs);
      if (parsed.combiner?.trackName) trackNameInput.value = parsed.combiner.trackName;
      if (parsed.combiner?.removeDuplicates !== undefined) removeDuplicatesCheckbox.checked = parsed.combiner.removeDuplicates;
      if (parsed.combiner?.autoOrder !== undefined) autoOrderCheckbox.checked = parsed.combiner.autoOrder;
      if (parsed.combiner?.gapThreshold) gapThresholdInput.value = parsed.combiner.gapThreshold;
    } catch {
      // Ignore invalid stored prefs
    }
  }
}

function savePreferences(): void {
  const existingPrefs = JSON.parse(localStorage.getItem('gpx-tools-prefs') || '{}');
  existingPrefs.combiner = {
    trackName: trackNameInput.value,
    removeDuplicates: removeDuplicatesCheckbox.checked,
    autoOrder: autoOrderCheckbox.checked,
    gapThreshold: parseInt(gapThresholdInput.value),
  };
  localStorage.setItem('gpx-tools-prefs', JSON.stringify(existingPrefs));
}

// Save preferences on change
[trackNameInput, gapThresholdInput].forEach(input => {
  input.addEventListener('change', savePreferences);
});
[removeDuplicatesCheckbox, autoOrderCheckbox].forEach(checkbox => {
  checkbox.addEventListener('change', savePreferences);
});

// Load preferences on startup
loadPreferences();
