/*
 * Research Institutions Map
 * ---------------------------------------------------
 * 1. Fetches MAP_DATA.csv (semicolon-delimited, UTF-8).
 * 2. Parses it with PapaParse.
 * 3. Builds two GeoJSON layers:
 *      - institutions: one point per institution with valid coordinates
 *      - countries:    one big point per country (paper-weighted average
 *                      position of its institutions)
 * 4. Renders them on a MapLibre GL map using a free Esri raster style
 *    (no API key required).
 * 5. Zoomed OUT: only the country nodes are shown.
 *    Zoomed IN (past COUNTRY_TO_INSTITUTION_ZOOM): the country nodes
 *    disappear and the individual institutions appear.
 * 6. Node radius is scaled by sqrt(papers) so a few very large
 *    nodes don't drown out everything else.
 * 7. Clicking a node shows a popup:
 *      - institution node: institution / country / papers
 *      - country node:     country name / papers / top 3 institutes
 * 8. Left sidebar (see the SIDEBAR section near the bottom):
 *      - search box: type an institution name, click a result and the
 *        map flies to it and opens its popup
 *      - country filter: tick/untick countries to show/hide their nodes
 *      - venue filter: tick/untick venues; only institutions with papers
 *        in the ticked venues stay on the map
 *      - institution popups also list the top 5 authors (author profiles
 *        are on authors.html)
 */

const CSV_PATH = "MAP_DATA.csv";
const CSV_DELIMITER = ";";

// Radius range (in pixels) for individual institution circles.
const MIN_RADIUS = 3;
const MAX_RADIUS = 24;

// Radius range (in pixels) for the big merged country circles.
const COUNTRY_MIN_RADIUS = 8;
const COUNTRY_MAX_RADIUS = 50;

// CHANGE THIS to control when countries split into institutions.
// Below this zoom level you see countries; at or above it you see institutions.
// (Bigger number = you have to zoom in further before they split.)
const COUNTRY_TO_INSTITUTION_ZOOM = 3;

// How many institutes to list in a country popup.
const TOP_INSTITUTES_COUNT = 3;

const statusBox = document.getElementById("status");

function showStatus(message, isError = false) {
  statusBox.hidden = false;
  statusBox.textContent = message;
  statusBox.style.borderColor = isError ? "#000" : "#000";
}

function hideStatus() {
  statusBox.hidden = true;
}

/**
 * Free, no-API-key base map style: Esri's classic "Light Gray Canvas" raster
 * tile service (services.arcgisonline.com). This is a legacy, long-standing
 * public REST tile service — distinct from Esri's newer key-gated basemap
 * APIs — and has historically not required any account, token, or key for
 * this kind of usage. It renders a minimal light-gray map showing only
 * country/region borders, water, and streets — no building outlines,
 * land-use coloring, or text labels.
 *
 * A CSS grayscale filter (see style.css) is applied on top as a safety net
 * to guarantee a fully black-and-white look regardless of subtle tinting.
 *
 * Note: this is a third-party free service governed by Esri's terms of use.
 * If it's ever unavailable or terms change, the OSM raw tile fallback used
 * earlier can be swapped back in (see the commented block below).
 */
const OSM_STYLE = {
  version: 8,
  sources: {
    "esri-light-gray": {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution:
        "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS community",
    },
  },
  layers: [
    {
      id: "base-tiles",
      type: "raster",
      source: "esri-light-gray",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

/* --- Fallback option (raw OpenStreetMap raster tiles), kept for reference:
const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm-tiles", type: "raster", source: "osm" }],
};
--- */

const map = new maplibregl.Map({
  container: "map",
  style: OSM_STYLE,
  center: [10, 30],
  zoom: 1.5,
  renderWorldCopies: false, // prevents the map repeating sideways when panned/zoomed out
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(
  new maplibregl.AttributionControl({ compact: true }),
  "bottom-right"
);

/**
 * Turns a raw "papers" count into a circle radius (in px) using a
 * square-root scale. Square-root (rather than linear) keeps a single
 * huge outlier from making every other node invisible, because circle
 * *area* then scales roughly linearly with paper count.
 * minRadius / maxRadius let us reuse this for both institutions and countries.
 */
function papersToRadius(papers, minPapers, maxPapers, minRadius = MIN_RADIUS, maxRadius = MAX_RADIUS) {
  if (maxPapers === minPapers) return (minRadius + maxRadius) / 2;

  const sqrtVal = Math.sqrt(papers);
  const sqrtMin = Math.sqrt(minPapers);
  const sqrtMax = Math.sqrt(maxPapers);

  const t = (sqrtVal - sqrtMin) / (sqrtMax - sqrtMin); // 0..1
  return minRadius + t * (maxRadius - minRadius);
}

/**
 * Cleans the raw CSV rows. Keeps every row that has a paper count
 * (so country totals are complete), and marks whether it has usable
 * coordinates (lat/lon are null when missing).
 */
function parseRows(rows) {
  const parsed = [];

  for (const row of rows) {
    const papers = parseInt(row.papers, 10);
    if (!Number.isFinite(papers)) continue;

    const lat = parseFloat(row.latitude);
    const lon = parseFloat(row.longitude);
    const hasCoords =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180;

    parsed.push({
      institution: row.institution,
      country: (row.country || "").trim(),
      papers,
      lat: hasCoords ? lat : null,
      lon: hasCoords ? lon : null,
      hasCoords,
    });
  }

  return parsed;
}

/**
 * Builds the institution points (only institutions with valid coordinates).
 */
function buildInstitutionsGeoJSON(parsedRows) {
  const withCoords = parsedRows.filter((r) => r.hasCoords);

  const paperCounts = withCoords.map((r) => r.papers);
  const minPapers = Math.min(...paperCounts);
  const maxPapers = Math.max(...paperCounts);

  const features = withCoords.map((row) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [row.lon, row.lat], // GeoJSON is [lng, lat]
    },
    properties: {
      institution: row.institution,
      country: row.country,
      papers: row.papers,
      radius: papersToRadius(row.papers, minPapers, maxPapers),
    },
  }));

  return { type: "FeatureCollection", features };
}

/**
 * Turns a 2-letter country code (e.g. "NL") into a readable name
 * ("Netherlands") using the browser's built-in region names.
 * Falls back to the code itself if the browser doesn't know it.
 */
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code) {
  try {
    return regionNames.of(code) || code;
  } catch (err) {
    return code;
  }
}

/**
 * Groups all rows by country and works out, for each country:
 *   - total paper count
 *   - top institutes by paper count
 *   - a map position (paper-weighted average of its institutions' coordinates)
 * Countries where no institution has coordinates cannot be placed and are skipped.
 */
function groupByCountry(parsedRows) {
  const groups = new Map();

  for (const row of parsedRows) {
    if (!row.country) continue;
    if (!groups.has(row.country)) groups.set(row.country, []);
    groups.get(row.country).push(row);
  }

  const countries = [];
  for (const [code, rows] of groups) {
    const placed = rows.filter((r) => r.hasCoords);
    if (placed.length === 0) continue;

    const totalPapers = rows.reduce((sum, r) => sum + r.papers, 0);
    const placedPapers = placed.reduce((sum, r) => sum + r.papers, 0);

    const lon = placed.reduce((sum, r) => sum + r.lon * r.papers, 0) / placedPapers;
    const lat = placed.reduce((sum, r) => sum + r.lat * r.papers, 0) / placedPapers;

    const topInstitutes = [...rows]
      .sort((a, b) => b.papers - a.papers)
      .slice(0, TOP_INSTITUTES_COUNT)
      .map((r) => ({ institution: r.institution, papers: r.papers }));

    countries.push({ code, name: countryName(code), totalPapers, lon, lat, topInstitutes });
  }

  return countries;
}

/**
 * Builds the big merged country points.
 */
function buildCountriesGeoJSON(parsedRows) {
  const countries = groupByCountry(parsedRows);

  const totals = countries.map((c) => c.totalPapers);
  const minPapers = Math.min(...totals);
  const maxPapers = Math.max(...totals);

  const features = countries.map((c) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    properties: {
      country: c.name,
      code: c.code, // 2-letter code, used by the sidebar country filter
      papers: c.totalPapers,
      // MapLibre flattens lists inside properties, so store the top
      // institutes as text and turn it back into a list on click.
      topInstitutes: JSON.stringify(c.topInstitutes),
      radius: papersToRadius(c.totalPapers, minPapers, maxPapers, COUNTRY_MIN_RADIUS, COUNTRY_MAX_RADIUS),
    },
  }));

  return { type: "FeatureCollection", features };
}

/**
 * Shared circle styling. Big circles are drawn first so small ones
 * are never hidden underneath them.
 */
function circleLayer(id, source, zoomRange) {
  return {
    id,
    type: "circle",
    source,
    ...zoomRange,
    layout: {
      "circle-sort-key": ["-", ["get", "papers"]],
    },
    paint: {
      "circle-radius": ["get", "radius"],
      "circle-color": "#000000",
      "circle-opacity": 0.5,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#000000",
      "circle-stroke-opacity": 0.9,
    },
  };
}

/**
 * Shows a popup at the clicked node.
 */
function showPopup(e, html) {
  const feature = e.features[0];
  const coords = feature.geometry.coordinates.slice();

  // If the map is zoomed/panned such that the point is duplicated
  // across the antimeridian, adjust the popup to the correct copy.
  while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
    coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
  }

  openPopupAt(coords, html);
}

// Remembers the popup that is currently open, so we can close it
// before opening a new one (only one popup at a time).
let currentPopup = null;

/**
 * Opens a popup at the given [lng, lat]. Used by map clicks AND by the
 * sidebar search.
 */
function openPopupAt(coords, html) {
  if (currentPopup) currentPopup.remove();

  currentPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
    .setLngLat(coords)
    .setHTML(html)
    .addTo(map);
}

/**
 * The "Top authors" part of an institution popup: the best-scoring authors
 * (see build_data.py) with their points and overall rank, each linking to
 * their profile page.
 */
function topAuthorsHtml(institution) {
  const extra = institutionExtra[institution];

  // No entry at all: the data file is missing or older than MAP_DATA.csv.
  if (!extra) {
    return `<div class="popup-row"><span class="label">Top authors:</span> no data (institution_extra.json missing or out of date)</div>`;
  }
  if (extra.topAuthors.length === 0) {
    return `<div class="popup-row"><span class="label">Top authors:</span> none ranked</div>`;
  }

  const items = extra.topAuthors
    .map(
      (a) =>
        `<li><a href="authors.html?name=${encodeURIComponent(a.name)}">${escapeHtml(a.name)}</a> ` +
        `<span class="label">(${a.points} points, rank #${a.rank}${a.uncertain ? "*" : ""})</span></li>`
    )
    .join("");
  const note = extra.topAuthors.some((a) => a.uncertain)
    ? `<div class="popup-note">* name shared by several people, affiliation may be mixed up</div>`
    : "";

  return `
    <div class="popup-row"><span class="label">Top ${extra.topAuthors.length} authors:</span></div>
    <ol class="popup-list">${items}</ol>${note}
  `;
}

function institutionPopupHtml({ institution, country, papers }) {
  return `
    <div class="popup-institution">${escapeHtml(institution)}</div>
    <div class="popup-row"><span class="label">Country:</span> ${escapeHtml(country)}</div>
    <div class="popup-row"><span class="label">Papers:</span> ${papers}</div>
    ${topAuthorsHtml(institution)}
  `;
}

function countryPopupHtml({ country, papers, topInstitutes }) {
  const top = JSON.parse(topInstitutes);
  const items = top
    .map((t) => `<li>${escapeHtml(t.institution)} <span class="label">(${t.papers})</span></li>`)
    .join("");

  return `
    <div class="popup-institution">${escapeHtml(country)}</div>
    <div class="popup-row"><span class="label">Papers:</span> ${papers}</div>
    <div class="popup-row"><span class="label">Top ${top.length} institutes:</span></div>
    <ol class="popup-list">${items}</ol>
  `;
}

/**
 * Makes a layer clickable: pointer cursor on hover, popup on click.
 */
function makeClickable(layerId, buildHtml) {
  map.on("mouseenter", layerId, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", layerId, () => {
    map.getCanvas().style.cursor = "";
  });
  map.on("click", layerId, (e) => {
    showPopup(e, buildHtml(e.features[0].properties));
  });
}

/**
 * Adds both layers. The country layer only shows BELOW the switch zoom,
 * the institution layer only AT/ABOVE it.
 */
function addLayers(institutionsGeoJSON, countriesGeoJSON) {
  map.addSource("countries", { type: "geojson", data: countriesGeoJSON });
  map.addSource("institutions", { type: "geojson", data: institutionsGeoJSON });

  map.addLayer(
    circleLayer("countries-circles", "countries", { maxzoom: COUNTRY_TO_INSTITUTION_ZOOM })
  );
  map.addLayer(
    circleLayer("institutions-circles", "institutions", { minzoom: COUNTRY_TO_INSTITUTION_ZOOM })
  );

  makeClickable("countries-circles", countryPopupHtml);
  makeClickable("institutions-circles", institutionPopupHtml);

  // The layers now exist, so apply whatever the checkboxes say.
  applyFilters();
  openInstitutionFromUrl();
}

// Minimal HTML-escaping so institution/country names can't break the popup markup.
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =====================================================================
 * SIDEBAR: institution search + country filter + venue filter
 * ===================================================================== */

// How far the map zooms in when you pick a search result.
// Must be at least COUNTRY_TO_INSTITUTION_ZOOM, otherwise the institution
// nodes would still be hidden.
const SEARCH_JUMP_ZOOM = 8;

// Width of the sidebar in pixels. Must match the width in style.css.
// Used so that "fly to" centres the node in the visible part of the map,
// not underneath the sidebar.
const SIDEBAR_WIDTH = 320;

// Maximum number of results listed under the search box.
const MAX_SEARCH_RESULTS = 50;

// File made by build_data.py: top authors and venues for each institution.
const EXTRA_DATA_PATH = "institution_extra.json";

// Makes the browser check for a newer copy of the data files instead of
// reusing an old one it saved earlier.
const FRESH = { cache: "no-cache" };

// Grab the sidebar elements from index.html.
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

let allInstitutions = [];          // every institution that has coordinates
let institutionExtra = {};         // institution name -> { venues, topAuthors }
let selectedCountries = new Set(); // country codes that are currently ticked
let selectedVenues = new Set();    // venue codes that are currently ticked
let venueCount = 0;                // how many venues exist in total

/**
 * Lower-cases text and removes accents, so typing "universite" also
 * finds "Université" and "zurich" finds "Zürich".
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/* ---------- Checkbox filters (used for countries AND venues) ---------- */

/**
 * Builds one row of a checkbox list: [x] label ........ count
 */
function buildCheckboxRow({ value, label, count }) {
  const row = document.createElement("li");
  const wrapper = document.createElement("label");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = value;
  checkbox.checked = true;

  const name = document.createElement("span");
  name.textContent = label;

  const number = document.createElement("span");
  number.className = "count";
  number.textContent = count;

  wrapper.append(checkbox, name, number);
  row.append(wrapper);
  return row;
}

/**
 * Fills one collapsible checkbox box from index.html and wires up its
 * "Select all" / "Clear all" buttons.
 *   title:    heading text, e.g. "Filter by country"
 *   items:    [{ value, label, count }], one per checkbox (all start ticked)
 *   ids:      the element ids of this box in index.html
 *   onChange: function that runs every time the ticked boxes change
 * Returns the live Set of ticked values.
 */
function createCheckboxFilter({ title, items, ids, onChange }) {
  const list = document.getElementById(ids.list);
  const summary = document.getElementById(ids.summary);
  const selected = new Set(items.map((item) => item.value));

  function updateSummary() {
    summary.textContent = `${title} (${selected.size} of ${items.length} selected)`;
  }

  function changed() {
    updateSummary();
    onChange();
  }

  function setAll(checked) {
    selected.clear();
    for (const checkbox of list.querySelectorAll("input")) {
      checkbox.checked = checked;
      if (checked) selected.add(checkbox.value);
    }
    changed();
  }

  list.innerHTML = "";
  items.forEach((item) => list.append(buildCheckboxRow(item)));

  list.addEventListener("change", (event) => {
    const checkbox = event.target;
    if (checkbox.checked) selected.add(checkbox.value);
    else selected.delete(checkbox.value);
    changed();
  });
  document.getElementById(ids.selectAll).addEventListener("click", () => setAll(true));
  document.getElementById(ids.clearAll).addEventListener("click", () => setAll(false));

  updateSummary();
  return selected;
}

/**
 * One checkbox item per country (alphabetical), with its number of drawn institutions.
 */
function buildCountryItems() {
  const counts = new Map();
  for (const inst of allInstitutions) {
    if (inst.country) counts.set(inst.country, (counts.get(inst.country) || 0) + 1);
  }

  return [...counts]
    .map(([code, count]) => ({ value: code, label: countryName(code), count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * One checkbox item per venue, with its total number of papers.
 */
function buildVenueItems(venues) {
  return venues.map((v) => ({ value: v.code, label: `${v.code} – ${v.name}`, count: v.papers }));
}

/* ---------- Applying the filters ---------- */

/**
 * True if the institution has at least one paper in a ticked venue.
 */
function hasPapersInSelectedVenues(institution) {
  const venues = (institutionExtra[institution] || {}).venues || {};
  return Object.keys(venues).some((venue) => selectedVenues.has(venue));
}

/**
 * An institution is shown when its country is ticked AND (all venues are
 * ticked OR it has a paper in one of the ticked venues).
 */
function isInstitutionVisible(inst) {
  if (!selectedCountries.has(inst.country)) return false;
  const allVenuesTicked = selectedVenues.size === venueCount;
  return allVenuesTicked || hasPapersInSelectedVenues(inst.institution);
}

/**
 * Shows only the nodes that pass both filters, on BOTH layers.
 * A country node is shown while at least one of its institutions is shown.
 */
function applyFilters() {
  // The layers are added a moment after the page loads; do nothing until then.
  if (!map.getLayer("institutions-circles")) return;

  const visible = allInstitutions.filter(isInstitutionVisible);
  const institutionNames = visible.map((inst) => inst.institution);
  const countryCodes = [...new Set(visible.map((inst) => inst.country))];

  map.setFilter("institutions-circles", ["in", ["get", "institution"], ["literal", institutionNames]]);
  map.setFilter("countries-circles", ["in", ["get", "code"], ["literal", countryCodes]]);
}

/**
 * Called after any filter change: refreshes the map and the search results.
 */
function onFiltersChanged() {
  applyFilters();
  renderSearchResults();
}

/* ---------- Institution search ---------- */

/**
 * Returns the visible institutions whose name contains EVERY typed word
 * (in any order, so "univ of tokyo" finds "The University of Tokyo"),
 * biggest (most papers) first.
 */
function findMatches(query) {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  return allInstitutions
    .filter(isInstitutionVisible)
    .filter((inst) => {
      const name = normalizeText(inst.institution);
      return words.every((word) => name.includes(word));
    })
    .sort((a, b) => b.papers - a.papers);
}

/**
 * Flies the map to an institution and opens its popup.
 */
function goToInstitution(inst) {
  const coords = [inst.lon, inst.lat];

  map.flyTo({
    center: coords,
    zoom: Math.max(map.getZoom(), SEARCH_JUMP_ZOOM), // never zoom OUT
    // Keep the node clear of the sidebar while it is showing.
    padding: { left: isSidebarOpen() ? SIDEBAR_WIDTH : 0 },
    essential: true,
  });

  openPopupAt(coords, institutionPopupHtml(inst));
}

/**
 * Opens the institution named in the page address (?institution=...).
 * The author profile page links here.
 */
function openInstitutionFromUrl() {
  const name = new URLSearchParams(window.location.search).get("institution");
  if (!name) return;

  const inst = allInstitutions.find((i) => i.institution === name);
  if (inst) goToInstitution(inst);
  else showStatus(`"${name}" cannot be shown on the map (no coordinates).`);
}

/**
 * Adds one line of plain text (not clickable) to the results list,
 * used for messages like "No matches".
 */
function addResultMessage(text) {
  const item = document.createElement("li");
  item.className = "no-hover";
  item.textContent = text;
  searchResults.append(item);
}

/**
 * Adds one clickable result line for an institution.
 */
function addResultItem(inst) {
  const item = document.createElement("li");
  item.tabIndex = 0; // lets keyboard users reach it with Tab

  const name = document.createElement("div");
  name.textContent = inst.institution;

  const meta = document.createElement("div");
  meta.className = "result-meta";
  meta.textContent = `${countryName(inst.country)} · ${inst.papers} papers`;

  item.append(name, meta);
  item.addEventListener("click", () => goToInstitution(inst));
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goToInstitution(inst);
  });

  searchResults.append(item);
}

/**
 * Redraws the list under the search box for whatever is typed right now.
 */
function renderSearchResults() {
  searchResults.innerHTML = "";

  if (searchInput.value.trim() === "") return; // nothing typed: empty list

  const matches = findMatches(searchInput.value);

  if (matches.length === 0) {
    addResultMessage("No matches with the current filters.");
    return;
  }

  matches.slice(0, MAX_SEARCH_RESULTS).forEach(addResultItem);

  if (matches.length > MAX_SEARCH_RESULTS) {
    addResultMessage(`…and ${matches.length - MAX_SEARCH_RESULTS} more. Keep typing to narrow it down.`);
  }
}

/* ---------- Show / hide the sidebar ---------- */

/**
 * True while the sidebar is visible. (The CSS class "sidebar-closed"
 * on <body> is what makes it slide away.)
 */
function isSidebarOpen() {
  return !document.body.classList.contains("sidebar-closed");
}

/**
 * Slides the sidebar away, or brings it back.
 */
function toggleSidebar() {
  document.body.classList.toggle("sidebar-closed");

  const label = isSidebarOpen() ? "Hide sidebar" : "Show sidebar";
  const button = document.getElementById("sidebar-toggle");
  button.setAttribute("aria-label", label);
  button.title = label;
}

/**
 * Makes the tab button work. Called straight away (not after the CSV
 * loads) so the button never depends on the data.
 */
function setupSidebarToggle() {
  document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);
}

/* ---------- Setup ---------- */

/**
 * Sets up the whole sidebar. Called once, as soon as the data is loaded.
 */
function initSidebar(parsedRows, extraData) {
  allInstitutions = parsedRows.filter((r) => r.hasCoords);
  institutionExtra = extraData.institutions;
  venueCount = extraData.venues.length;

  selectedCountries = createCheckboxFilter({
    title: "Filter by country",
    items: buildCountryItems(),
    ids: { list: "country-list", summary: "country-summary", selectAll: "select-all", clearAll: "clear-all" },
    onChange: onFiltersChanged,
  });

  selectedVenues = createCheckboxFilter({
    title: "Filter by venue",
    items: buildVenueItems(extraData.venues),
    ids: { list: "venue-list", summary: "venue-summary", selectAll: "select-all-venues", clearAll: "clear-all-venues" },
    onChange: onFiltersChanged,
  });

  searchInput.addEventListener("input", renderSearchResults);
}

/**
 * Loads institution_extra.json. If it is missing the map still works,
 * just without top authors and the venue filter.
 */
function fetchExtraData() {
  return fetch(EXTRA_DATA_PATH, FRESH)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .catch((err) => {
      console.warn(`Could not load ${EXTRA_DATA_PATH}:`, err);
      return { venues: [], institutions: {} };
    });
}

/**
 * Loads MAP_DATA.csv as text.
 */
function fetchCsvText() {
  return fetch(CSV_PATH, FRESH).then((response) => {
    if (!response.ok) {
      throw new Error(
        `Could not fetch ${CSV_PATH} (HTTP ${response.status}). ` +
          `Make sure the file sits next to index.html and you're viewing this ` +
          `over http/https (not double-clicking the file), e.g. via a local server ` +
          `or GitHub Pages.`
      );
    }
    return response.text();
  });
}

function loadData() {
  showStatus("Loading institution data…");

  Promise.all([fetchCsvText(), fetchExtraData()])
    .then(([csvText, extraData]) => {
      const parsed = Papa.parse(csvText, {
        header: true,
        delimiter: CSV_DELIMITER,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim(),
      });

      if (parsed.errors && parsed.errors.length > 0) {
        console.warn("CSV parse warnings:", parsed.errors);
      }

      const parsedRows = parseRows(parsed.data);
      initSidebar(parsedRows, extraData); // fills the search box and both filters
      const institutionsGeoJSON = buildInstitutionsGeoJSON(parsedRows);
      const countriesGeoJSON = buildCountriesGeoJSON(parsedRows);

      const totalCount = parsed.data.length;
      const skippedRows = parsedRows.filter((r) => !r.hasCoords);
      const skippedCount = totalCount - institutionsGeoJSON.features.length;

      if (skippedRows.length > 0) {
        console.warn(
          `${skippedRows.length} institution(s) have no coordinates (not drawn zoomed in, but still counted in country totals):`,
          skippedRows.map((r) => r.institution)
        );
      }

      if (institutionsGeoJSON.features.length === 0) {
        showStatus(
          "No institutions with valid coordinates were found in the CSV.",
          true
        );
        return;
      }

      const addLayersOnce = () => addLayers(institutionsGeoJSON, countriesGeoJSON);
      if (map.isStyleLoaded()) {
        addLayersOnce();
      } else {
        map.once("load", addLayersOnce);
      }

      if (skippedCount > 0) {
        showStatus(
          `Showing ${totalCount - skippedCount} of ${totalCount} institutions ` +
            `(${skippedCount} not drawn when zoomed in — missing coordinates; they still count in country totals). See browser console for the list.`
        );
      } else {
        hideStatus();
      }
    })
    .catch((err) => {
      console.error(err);
      showStatus(err.message, true);
    });
}

setupSidebarToggle();
loadData();
