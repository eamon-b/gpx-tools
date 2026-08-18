import { combineGpx, type CombineResult } from '../../lib/index.js';
import { saveAs } from 'file-saver';

// DOM Elements
const gpxUploadArea = document.getElementById('gpx-upload-area')!;
const gpxFileInput = document.getElementById('gpx-file-input') as HTMLInputElement;
const fileListContainer = document.getElementById('file-list-container')!;
const sortableFileList = document.getElementById('sortable-file-list')!;
const clearAllBtn = document.getElementById('clear-all-btn')!;
const skipNotice = document.getElementById('skip-notice')!;
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
let outputFilename = 'combined.gpx';

// Utility functions
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]!));
}

function computeOutputFilename(trackName: string): string {
  const slug = trackName
    .trim()
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
  return slug ? `${slug}.gpx` : 'combined.gpx';
}

function formatGapDistance(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${meters.toLocaleString()} m`;
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
      <span class="file-name">${escapeHtml(entry.file.name)}</span>
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
      // Commit the visual reorder to state here: dragend always fires (even
      // when the item is released outside a list item), unlike drop, so the
      // DOM order and fileEntries can never get out of sync.
      const newOrder: FileEntry[] = [];
      sortableFileList.querySelectorAll('.sortable-file-item').forEach(el => {
        const index = parseInt((el as HTMLElement).dataset.index!);
        newOrder.push(fileEntries[index]);
      });
      fileEntries = newOrder;
      updateUI();
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
      // Reordering is committed in dragend; just prevent default drop handling
      e.preventDefault();
    });
  });
}

async function addFiles(files: FileList): Promise<void> {
  const skipped: string[] = [];

  for (const file of Array.from(files)) {
    if (!file.name.toLowerCase().endsWith('.gpx')) {
      skipped.push(file.name);
      continue;
    }

    try {
      const content = await file.text();
      fileEntries.push({ file, content });
    } catch (error) {
      console.error(`Error reading ${file.name}:`, error);
      skipped.push(file.name);
    }
  }

  if (skipped.length > 0) {
    skipNotice.textContent = `Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'} (not readable GPX): ${skipped.join(', ')}`;
    skipNotice.hidden = false;
  } else {
    skipNotice.hidden = true;
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
  skipNotice.hidden = true;
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

    // segmentOrder holds file indices (waypoint-only files contribute no
    // segment, so they simply never appear); map positions back to filenames.
    const orderedNames = combineResult.segmentOrder.map(fileIndex =>
      fileEntries[fileIndex]?.file.name ?? `file ${fileIndex + 1}`
    );

    const reorderNote = combineResult.wasReordered
      ? `<p><strong>Note:</strong> Files were reordered for better continuity: ${orderedNames.map(escapeHtml).join(' → ')}</p>`
      : '';

    stats.innerHTML = `
      <p><strong>Files combined:</strong> ${combineResult.fileCount}</p>
      <p><strong>Total points:</strong> ${combineResult.pointCount.toLocaleString()}</p>
      <p><strong>Waypoints:</strong> ${combineResult.waypointCount}</p>
      ${reorderNote}
    `;

    // Show warnings for gaps, named by the files on either side of each gap
    if (combineResult.gaps.length > 0) {
      warnings.hidden = false;
      warnings.innerHTML = `
        <h4>Gap Warnings</h4>
        <ul>
          ${combineResult.gaps.map(gap => {
            const fromName = orderedNames[gap.afterSegmentIndex] ?? `segment ${gap.afterSegmentIndex + 1}`;
            const toName = orderedNames[gap.afterSegmentIndex + 1] ?? `segment ${gap.afterSegmentIndex + 2}`;
            return `<li>Gap of ${formatGapDistance(gap.distanceMeters)} between ${escapeHtml(fromName)} and ${escapeHtml(toName)}</li>`;
          }).join('')}
        </ul>
      `;
    } else {
      warnings.hidden = true;
    }

    outputFilename = computeOutputFilename(trackNameInput.value);
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
  // Same filename that was shown in the results panel
  saveAs(blob, outputFilename);
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
