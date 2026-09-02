import { parseGpx } from "../../lib/gpx-parser.js";
import {
  enrichRoute,
  exportPOIsToCSV,
  exportPOIsToGPX,
  getPOIName,
  getPOIDescription,
  type POIType,
  type EnrichedPOI,
  type EnrichmentProgress,
} from "../../lib/poi-enrichment.js";
import { POI_TYPES, POI_TYPE_LABELS, poiKey } from "../../lib/osm-poi.js";
import { saveAs } from "file-saver";
import L from "leaflet";
import {
  initializeMap,
  fitMapToBounds,
  createRoutePolyline,
  createCircleMarker,
  type MapPoint,
} from "../shared/map-utils.js";
import { escapeHtml } from "../shared/html-utils.js";

// DOM Elements
const gpxUploadArea = document.getElementById("gpx-upload-area")!;
const gpxFileInput = document.getElementById(
  "gpx-file-input"
) as HTMLInputElement;
const gpxFileInfo = document.getElementById("gpx-file-info")!;
const enrichBtn = document.getElementById("enrich-btn") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
const progressArea = document.getElementById("progress-area")!;
const progressFill = document.getElementById("progress-fill")!;
const progressText = document.getElementById("progress-text")!;
const results = document.getElementById("results")!;
const stats = document.getElementById("stats")!;
const poiTabs = document.getElementById("poi-tabs")!;
const poiItems = document.getElementById("poi-items")!;
const showMoreBtn = document.getElementById(
  "poi-show-more"
) as HTMLButtonElement;
const downloadCsvBtn = document.getElementById("download-csv")!;
const downloadGpxBtn = document.getElementById("download-gpx")!;
const errorArea = document.getElementById("error-area")!;

// POI type checkboxes
const poiWaterCheckbox = document.getElementById(
  "poi-water"
) as HTMLInputElement;
const poiCampingCheckbox = document.getElementById(
  "poi-camping"
) as HTMLInputElement;
const poiResupplyCheckbox = document.getElementById(
  "poi-resupply"
) as HTMLInputElement;
const poiTransportCheckbox = document.getElementById(
  "poi-transport"
) as HTMLInputElement;
const poiEmergencyCheckbox = document.getElementById(
  "poi-emergency"
) as HTMLInputElement;

// Options
const searchRadiusInput = document.getElementById(
  "search-radius"
) as HTMLInputElement;

const DEFAULT_SEARCH_RADIUS_KM = 2;
const MIN_SEARCH_RADIUS_KM = 0.1;
// 8 km, not the 10 km server cap: enrichRoute pads the Overpass radius by 1.25x to
// cover corridor simplification, and that headroom vanishes at the cap.
const MAX_SEARCH_RADIUS_KM = 8;

/** Items rendered per page in the results list. */
const PAGE_SIZE = 200;

// State
let gpxFile: File | null = null;
let enrichedPOIs: EnrichedPOI[] = [];
let routeName = "route";
/** One entry per track segment (or per <rte>) so disjoint tracks stay disjoint. */
let routeSegments: MapPoint[][] = [];
let map: L.Map | null = null;
let abortController: AbortController | null = null;

/** Rows for the active tab. Filtering always runs over the full result set. */
let filteredPOIs: EnrichedPOI[] = [];
/** How many of `filteredPOIs` are actually in the DOM. */
let renderedCount = 0;

/** All markers, by `type/id`, so a marker click can find its list row and back. */
const markersByKey = new Map<string, L.CircleMarker>();
/** One layer group per category — toggling a group beats toggling N markers. */
const categoryLayers = new Map<POIType, L.LayerGroup>();

// Utility functions
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Inline error display (replaces alert())
function showError(message: string): void {
  errorArea.textContent = message;
  errorArea.removeAttribute("hidden");
}

function clearError(): void {
  errorArea.textContent = "";
  errorArea.setAttribute("hidden", "");
}

// Upload handling
function setupUploadArea(
  area: HTMLElement,
  input: HTMLInputElement,
  fileInfo: HTMLElement,
  onFile: (file: File | null) => void
): void {
  area.addEventListener("click", () => {
    if (!area.classList.contains("has-file")) {
      input.click();
    }
  });

  area.addEventListener("dragover", (e) => {
    e.preventDefault();
    area.classList.add("dragover");
  });

  area.addEventListener("dragleave", () => {
    area.classList.remove("dragover");
  });

  area.addEventListener("drop", (e) => {
    e.preventDefault();
    area.classList.remove("dragover");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      onFile(files[0]);
    }
  });

  input.addEventListener("change", () => {
    if (input.files && input.files.length > 0) {
      onFile(input.files[0]);
    }
  });

  const clearBtn = fileInfo.querySelector(".clear-btn");
  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    input.value = "";
    area.classList.remove("has-file");
    area.querySelector(".upload-content")!.removeAttribute("hidden");
    fileInfo.setAttribute("hidden", "");
    onFile(null);
  });
}

function showFileInfo(
  area: HTMLElement,
  fileInfo: HTMLElement,
  file: File
): void {
  area.classList.add("has-file");
  area.querySelector(".upload-content")!.setAttribute("hidden", "");
  fileInfo.removeAttribute("hidden");
  fileInfo.querySelector(".file-name")!.textContent = file.name;
  fileInfo.querySelector(".file-size")!.textContent = formatFileSize(file.size);
}

// Setup upload area
setupUploadArea(gpxUploadArea, gpxFileInput, gpxFileInfo, (file) => {
  gpxFile = file;
  clearError();
  if (file) {
    showFileInfo(gpxUploadArea, gpxFileInfo, file);
    enrichBtn.disabled = false;
    results.setAttribute("hidden", "");
    progressArea.setAttribute("hidden", "");
    routeName = file.name.replace(/\.gpx$/i, "");
  } else {
    enrichBtn.disabled = true;
    results.setAttribute("hidden", "");
  }
});

// Get selected POI types
function getSelectedTypes(): POIType[] {
  const types: POIType[] = [];
  if (poiWaterCheckbox.checked) types.push("water");
  if (poiCampingCheckbox.checked) types.push("camping");
  if (poiResupplyCheckbox.checked) types.push("resupply");
  if (poiTransportCheckbox.checked) types.push("transport");
  if (poiEmergencyCheckbox.checked) types.push("emergency");
  return types;
}

function getSearchRadiusKm(): number {
  const value = parseFloat(searchRadiusInput.value);
  if (!Number.isFinite(value)) return DEFAULT_SEARCH_RADIUS_KM;
  return Math.min(Math.max(value, MIN_SEARCH_RADIUS_KM), MAX_SEARCH_RADIUS_KM);
}

/**
 * Progress display driven by the structured `EnrichmentProgress` object:
 * prepare 5%, fetch 10-85% scaled by chunk, process 90%, done 100%. The bar
 * pulses while a chunk request is in flight (a chunk can take many seconds and
 * the percentage does not move until it lands).
 */
function updateProgress(progress: EnrichmentProgress): void {
  progressText.textContent = progress.message;

  let percent: number;
  let inFlight = false;

  switch (progress.stage) {
    case "prepare":
      percent = 5;
      break;
    case "fetch": {
      const total = progress.total ?? 1;
      const current = progress.current ?? 1;
      // The event fires *before* the request, so show completed chunks only.
      percent = total > 0 ? 10 + (Math.max(current - 1, 0) / total) * 75 : 10;
      inFlight = true;
      break;
    }
    case "process":
      percent = 90;
      break;
    case "done":
      percent = 100;
      break;
  }

  progressFill.style.width = `${percent}%`;
  progressFill.classList.toggle("indeterminate", inFlight);
}

function resetProgress(): void {
  progressFill.style.width = "0%";
  progressFill.classList.remove("indeterminate", "cancelled");
  progressText.classList.remove("cancelled");
}

function setRunning(running: boolean): void {
  enrichBtn.disabled = running || !gpxFile;
  cancelBtn.hidden = !running;
  cancelBtn.disabled = false;
}

// Process GPX
enrichBtn.addEventListener("click", async () => {
  if (!gpxFile) return;

  clearError();

  const types = getSelectedTypes();
  if (types.length === 0) {
    showError("Please select at least one POI type");
    return;
  }

  setRunning(true);
  progressArea.removeAttribute("hidden");
  results.setAttribute("hidden", "");
  resetProgress();

  const controller = new AbortController();
  abortController = controller;

  try {
    const content = await gpxFile.text();
    const gpxData = parseGpx(content);

    // One entry per track segment: passing the segments separately keeps
    // enrichment from inventing a connecting leg between disjoint tracks.
    routeSegments = [];
    for (const track of gpxData.tracks) {
      for (const segment of track.segments) {
        const points = segment.points.map((p) => ({ lat: p.lat, lon: p.lon }));
        if (points.length > 0) routeSegments.push(points);
      }
    }

    // Route-only files (<rte> with no <trk>): one entry per route.
    if (routeSegments.length === 0) {
      for (const route of gpxData.routes) {
        const points = route.points.map((p) => ({ lat: p.lat, lon: p.lon }));
        if (points.length > 0) routeSegments.push(points);
      }
    }

    if (routeSegments.length === 0) {
      throw new Error("No track or route points found in GPX file");
    }

    const result = await enrichRoute(
      routeSegments,
      {
        types,
        searchRadiusKm: getSearchRadiusKm(),
        signal: controller.signal,
      },
      updateProgress
    );

    enrichedPOIs = result.pois;

    // Show results
    progressArea.setAttribute("hidden", "");
    progressFill.classList.remove("indeterminate");
    results.removeAttribute("hidden");

    const { queryChunks, failedChunks } = result.stats;
    const coverageNote =
      failedChunks > 0
        ? `<p class="warning"><strong>Loaded ${queryChunks - failedChunks}/${queryChunks} areas (${failedChunks} failed).</strong> Results may be incomplete — try again to retry the failed area${failedChunks === 1 ? "" : "s"}.</p>`
        : "";

    stats.innerHTML = `
      ${coverageNote}
      <p><strong>Total POIs found:</strong> ${result.stats.totalFound}</p>
      <p><strong>Query time:</strong> ${(result.stats.queryTimeMs / 1000).toFixed(1)}s</p>
      <p><strong>By type:</strong></p>
      <ul>
        ${types.map((t) => `<li>${escapeHtml(POI_TYPE_LABELS[t])}: ${result.stats.byType[t] || 0}</li>`).join("")}
      </ul>
    `;

    renderMap(routeSegments, enrichedPOIs);
    renderTabs(types, result.stats.byType);
    applyFilter("all");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      showCancelled();
    } else {
      const message = error instanceof Error ? error.message : "Unknown error";
      let display = `Error: ${message}`;
      if (/failed to fetch|network|load failed/i.test(message)) {
        display =
          "Error: Could not reach the POI API. It may be down or unreachable — check your connection and try again.";
        if (import.meta.env.DEV) {
          display +=
            ' Dev hint: the API is not served by "npm run dev" — run the site with "vercel dev" to enable the serverless functions.';
        }
      }
      showError(display);
      progressArea.setAttribute("hidden", "");
      progressFill.classList.remove("indeterminate");
    }
  } finally {
    abortController = null;
    setRunning(false);
  }
});

cancelBtn.addEventListener("click", () => {
  if (!abortController) return;
  cancelBtn.disabled = true;
  progressText.textContent = "Cancelling...";
  abortController.abort();
});

/** Cancellation is a normal outcome, not an error: neutral, no red banner. */
function showCancelled(): void {
  progressArea.removeAttribute("hidden");
  progressFill.classList.remove("indeterminate");
  progressFill.classList.add("cancelled");
  progressText.classList.add("cancelled");
  progressText.textContent = "Cancelled.";
}

// ---------------------------------------------------------------------------
// Results list
// ---------------------------------------------------------------------------

const CATEGORY_ICONS: Record<POIType, string> = {
  water: "💧",
  camping: "⛺",
  resupply: "🛒",
  transport: "🚌",
  emergency: "🏥",
};

/** Short tab labels; POI_TYPE_LABELS are too long for a tab strip. */
const CATEGORY_SHORT_LABELS: Record<POIType, string> = {
  water: "Water",
  camping: "Camping",
  resupply: "Resupply",
  transport: "Transport",
  emergency: "Emergency",
};

function getCategoryIcon(category: POIType): string {
  return CATEGORY_ICONS[category] || "📍";
}

function renderTabs(types: POIType[], byType: Record<POIType, number>): void {
  const buttons = [
    `<button class="poi-tab active" data-type="all">All (${enrichedPOIs.length})</button>`,
  ];
  for (const type of POI_TYPES) {
    // Categories that were not requested get no tab at all.
    if (!types.includes(type)) continue;
    buttons.push(
      `<button class="poi-tab" data-type="${type}">${getCategoryIcon(type)} ${CATEGORY_SHORT_LABELS[type]} (${byType[type] ?? 0})</button>`
    );
  }
  poiTabs.innerHTML = buttons.join("");
}

function renderPOIItem(poi: EnrichedPOI): string {
  return `
    <div class="poi-item" data-category="${poi.category}" data-key="${escapeHtml(poiKey(poi))}">
      <div class="poi-header">
        <span class="poi-icon">${getCategoryIcon(poi.category)}</span>
        <span class="poi-name">${escapeHtml(getPOIName(poi))}</span>
        <span class="poi-distance">at km ${poi.distanceAlongRoute.toFixed(1)} &middot; ${(poi.distanceFromRoute * 1000).toFixed(0)}m from route</span>
      </div>
      <div class="poi-details">
        <p class="poi-description">${escapeHtml(getPOIDescription(poi))}</p>
        <p class="poi-coords">
          <a href="https://www.openstreetmap.org/?mlat=${poi.lat}&mlon=${poi.lon}#map=17/${poi.lat}/${poi.lon}" target="_blank" rel="noopener">
            ${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}
          </a>
        </p>
      </div>
    </div>
  `;
}

/**
 * Apply a tab filter. Filtering runs over the whole result set; only the first
 * page of the filtered list is rendered (the rest arrives via "Show more"),
 * which keeps a several-thousand-POI result usable.
 */
function applyFilter(type: "all" | POIType): void {
  filteredPOIs =
    type === "all"
      ? enrichedPOIs
      : enrichedPOIs.filter((poi) => poi.category === type);

  renderedCount = 0;
  poiItems.innerHTML = "";

  if (filteredPOIs.length === 0) {
    poiItems.innerHTML = '<p class="no-results">No POIs found</p>';
    showMoreBtn.hidden = true;
  } else {
    renderMoreItems();
  }

  updateMapMarkerVisibility(type);
}

/** Append the next page of list rows. Returns false when nothing was added. */
function renderMoreItems(): boolean {
  const next = filteredPOIs.slice(renderedCount, renderedCount + PAGE_SIZE);
  if (next.length === 0) {
    showMoreBtn.hidden = true;
    return false;
  }

  poiItems.insertAdjacentHTML("beforeend", next.map(renderPOIItem).join(""));
  renderedCount += next.length;

  const remaining = filteredPOIs.length - renderedCount;
  showMoreBtn.hidden = remaining <= 0;
  showMoreBtn.textContent = `Show more (${remaining} remaining)`;
  return true;
}

showMoreBtn.addEventListener("click", () => {
  renderMoreItems();
});

// Tab filtering (delegated: the tab strip is re-rendered on every run)
poiTabs.addEventListener("click", (event) => {
  const tab = (event.target as HTMLElement).closest(
    ".poi-tab"
  ) as HTMLElement | null;
  if (!tab) return;

  poiTabs
    .querySelectorAll(".poi-tab")
    .forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");

  applyFilter((tab.dataset.type ?? "all") as "all" | POIType);
});

// List -> map: clicking a row pans to the marker and opens its popup
poiItems.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("a")) return; // let the OSM link do its job

  const item = target.closest(".poi-item") as HTMLElement | null;
  if (!item || !item.parentElement) return;

  const index = Array.prototype.indexOf.call(item.parentElement.children, item);
  const poi = filteredPOIs[index];
  if (!poi) return;

  const key = poiKey(poi);
  setHighlight(key);

  if (map) {
    map.setView([poi.lat, poi.lon], Math.max(map.getZoom(), 15));
    markersByKey.get(key)?.openPopup();
  }
});

/** Highlight one list row, rendering further pages if needed to reach it. */
function focusListItem(key: string): void {
  const index = filteredPOIs.findIndex((poi) => poiKey(poi) === key);
  if (index < 0) return;

  while (renderedCount <= index) {
    if (!renderMoreItems()) break;
  }

  setHighlight(key);
  const item = poiItems.children[index] as HTMLElement | undefined;
  item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setHighlight(key: string): void {
  poiItems
    .querySelector(".poi-item.highlighted")
    ?.classList.remove("highlighted");

  const index = filteredPOIs.findIndex((poi) => poiKey(poi) === key);
  if (index < 0 || index >= renderedCount) return;
  (poiItems.children[index] as HTMLElement | undefined)?.classList.add(
    "highlighted"
  );
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

// Category colors for map markers
const categoryColors: Record<POIType, string> = {
  water: "#3b82f6",
  camping: "#22c55e",
  resupply: "#f97316",
  transport: "#8b5cf6",
  emergency: "#ef4444",
};

/**
 * Render route and POI markers.
 *
 * Markers share a single canvas renderer: thousands of individual SVG circles
 * make panning unusable, one canvas does not.
 */
function renderMap(segments: MapPoint[][], pois: EnrichedPOI[]): void {
  if (map) {
    map.remove();
  }

  map = initializeMap("poi-map");
  markersByKey.clear();
  categoryLayers.clear();

  // One polyline per segment — a single polyline would draw a phantom line
  // between disjoint tracks.
  for (const segment of segments) {
    if (segment.length < 2) continue;
    createRoutePolyline(segment, "#3b82f6", { weight: 3, opacity: 0.7 }).addTo(
      map
    );
  }

  const renderer = L.canvas({ padding: 0.5 });

  for (const poi of pois) {
    let layer = categoryLayers.get(poi.category);
    if (!layer) {
      layer = L.layerGroup().addTo(map);
      categoryLayers.set(poi.category, layer);
    }

    const color = categoryColors[poi.category] || "#6b7280";
    const marker = createCircleMarker(poi.lat, poi.lon, color, {
      radius: 8,
      fillOpacity: 0.8,
      renderer,
      popup: `
        <strong>${escapeHtml(getPOIName(poi))}</strong><br>
        ${escapeHtml(getPOIDescription(poi))}<br>
        <em>at km ${poi.distanceAlongRoute.toFixed(1)} &middot; ${(poi.distanceFromRoute * 1000).toFixed(0)}m from route</em>
      `,
    });

    const key = poiKey(poi);
    // Map -> list: highlight the matching row and scroll it into view.
    marker.on("click", () => focusListItem(key));

    marker.addTo(layer);
    markersByKey.set(key, marker);
  }

  fitMapToBounds(map, segments.flat());
}

/** Show/hide whole category layers to match the active tab. */
function updateMapMarkerVisibility(type: "all" | POIType): void {
  if (!map) return;

  categoryLayers.forEach((layer, category) => {
    const visible = type === "all" || category === type;
    if (visible && !map!.hasLayer(layer)) {
      layer.addTo(map!);
    } else if (!visible && map!.hasLayer(layer)) {
      map!.removeLayer(layer);
    }
  });
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

downloadCsvBtn.addEventListener("click", () => {
  if (enrichedPOIs.length === 0) return;
  const csv = exportPOIsToCSV(enrichedPOIs);
  const blob = new Blob([csv], { type: "text/csv" });
  saveAs(blob, `${routeName}_pois.csv`);
});

downloadGpxBtn.addEventListener("click", () => {
  if (enrichedPOIs.length === 0) return;
  const gpx = exportPOIsToGPX(enrichedPOIs, routeName);
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  saveAs(blob, `${routeName}_pois.gpx`);
});

// ---------------------------------------------------------------------------
// Preferences (namespaced under `enrich` inside the shared `gpx-tools-prefs` key)
// ---------------------------------------------------------------------------

function loadPreferences(): void {
  const prefs = localStorage.getItem("gpx-tools-prefs");
  if (!prefs) return;

  try {
    const parsed = JSON.parse(prefs);
    if (parsed.enrich?.water !== undefined)
      poiWaterCheckbox.checked = parsed.enrich.water;
    if (parsed.enrich?.camping !== undefined)
      poiCampingCheckbox.checked = parsed.enrich.camping;
    if (parsed.enrich?.resupply !== undefined)
      poiResupplyCheckbox.checked = parsed.enrich.resupply;
    if (parsed.enrich?.transport !== undefined)
      poiTransportCheckbox.checked = parsed.enrich.transport;
    if (parsed.enrich?.emergency !== undefined)
      poiEmergencyCheckbox.checked = parsed.enrich.emergency;

    // `maxDistance` is the legacy key: it meant the same thing (POIs kept
    // within N km of the route), so carry it over once.
    const radius = parsed.enrich?.searchRadiusKm ?? parsed.enrich?.maxDistance;
    if (radius !== undefined && radius !== null && radius !== "") {
      const value = parseFloat(String(radius));
      if (Number.isFinite(value)) {
        searchRadiusInput.value = String(
          Math.min(Math.max(value, MIN_SEARCH_RADIUS_KM), MAX_SEARCH_RADIUS_KM)
        );
      }
    }
  } catch {
    // Ignore invalid stored prefs
  }
}

function savePreferences(): void {
  let existingPrefs: Record<string, unknown> = {};
  try {
    existingPrefs = JSON.parse(localStorage.getItem("gpx-tools-prefs") || "{}");
  } catch {
    // Corrupted stored prefs - overwrite with fresh values
  }
  existingPrefs.enrich = {
    water: poiWaterCheckbox.checked,
    camping: poiCampingCheckbox.checked,
    resupply: poiResupplyCheckbox.checked,
    transport: poiTransportCheckbox.checked,
    emergency: poiEmergencyCheckbox.checked,
    searchRadiusKm: searchRadiusInput.value,
  };
  localStorage.setItem("gpx-tools-prefs", JSON.stringify(existingPrefs));
}

// Save preferences on change
[
  poiWaterCheckbox,
  poiCampingCheckbox,
  poiResupplyCheckbox,
  poiTransportCheckbox,
  poiEmergencyCheckbox,
  searchRadiusInput,
].forEach((input) => {
  input.addEventListener("change", savePreferences);
});

// Load preferences on startup
loadPreferences();
