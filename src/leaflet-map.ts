/**
 * Leaflet satellite map module for angl3r.
 *
 * Replaces the static SVG county map with a real satellite-imagery map
 * powered by Leaflet + Esri World Imagery (free, no API key).
 *
 * Features:
 *   - Satellite base layer with labels overlay
 *   - County GeoJSON overlay (clickable, hoverable, choropleth)
 *   - Click anywhere on the map to drop a pin and identify the county
 *   - County click shows the same county summary panel as before
 */

// Leaflet is loaded from CDN in index.html. We declare the global so
// TypeScript doesn't complain.
declare const L: any;

import type { RegsData } from "./types";

// County GeoJSON is fetched at runtime (it's ~60KB, separate from the
// main regs.json bundle).
let countyGeoJson: any | null = null;
let countyGeoJsonPromise: Promise<any> | null = null;

async function loadCountyGeoJson(): Promise<any> {
  if (countyGeoJson) return countyGeoJson;
  if (countyGeoJsonPromise) return countyGeoJsonPromise;
  const base = import.meta.env.BASE_URL || "/";
  countyGeoJsonPromise = fetch(`${base}data/mi-counties-geojson.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch county GeoJSON: ${r.status}`);
      return r.json();
    })
    .then((json) => {
      countyGeoJson = json;
      return countyGeoJson;
    });
  return countyGeoJsonPromise;
}

// Active Leaflet map instance (only one at a time).
let mapInstance: any = null;
let countyLayer: any = null;
let pinMarker: any = null;
let waterbodyMarkerLayer: any = null; // Layer group for waterbody markers

// Waterbody coordinates cache (name|county -> [lat, lon])
let coordsCache: Record<string, [number, number]> | null = null;
let coordsPromise: Promise<Record<string, [number, number]>> | null = null;

async function loadWaterbodyCoords(): Promise<Record<string, [number, number]>> {
  if (coordsCache) return coordsCache;
  if (coordsPromise) return coordsPromise;
  const base = import.meta.env.BASE_URL || "/";
  coordsPromise = fetch(`${base}data/coords_by_waterbody.json`)
    .then((r) => {
      if (!r.ok) {
        // File might not exist yet (geocoding in progress)
        console.warn("coords_by_waterbody.json not available yet");
        return {};
      }
      return r.json();
    })
    .then((json) => {
      coordsCache = json as Record<string, [number, number]>;
      return coordsCache;
    })
    .catch(() => {
      console.warn("Failed to load waterbody coordinates");
      return {};
    });
  return coordsPromise;
}

// County data cache (same structure as main.ts but for Leaflet)
interface CountyMapData {
  waterbodyCount: number;
  lakeCount: number;
  streamCount: number;
  hasExceptions: boolean;
  typeCodes: string[];
  waterbodies: { name: string; kind: string; type?: string; source: string }[];
  speciesSet: string[];
}

let countyDataCache: Map<string, CountyMapData> | null = null;

function getCountyData(data: RegsData): Map<string, CountyMapData> {
  if (countyDataCache) return countyDataCache;
  const map = new Map<string, CountyMapData>();
  const stats = data.counties?.stats ?? {};

  for (const [county, s] of Object.entries(stats)) {
    map.set(county, {
      waterbodyCount: (s as any).waterbodies ?? 0,
      lakeCount: 0,
      streamCount: 0,
      hasExceptions: (s as any).has_exceptions ?? false,
      typeCodes: [],
      waterbodies: [],
      speciesSet: [],
    });
  }

  for (const wb of data.waterbodies ?? []) {
    const entry = map.get(wb.county);
    if (!entry) continue;
    entry.waterbodies.push({
      name: wb.name,
      kind: wb.kind,
      type: wb.type,
      source: wb.source,
    });
    if (wb.kind === "lake" || wb.kind === "pond") {
      entry.lakeCount++;
    } else if (
      wb.kind === "river" ||
      wb.kind === "stream" ||
      wb.kind === "creek" ||
      wb.kind === "channel"
    ) {
      entry.streamCount++;
    }
    if (wb.type && wb.source === "pdf") {
      if (!entry.typeCodes.includes(wb.type)) {
        entry.typeCodes.push(wb.type);
      }
    }
  }

  const sbw = data.species_by_waterbody ?? {};
  for (const [county, wbs] of Object.entries(sbw)) {
    const entry = map.get(county);
    if (!entry) continue;
    const speciesSet = new Set<string>();
    for (const wbData of Object.values(wbs) as any[]) {
      for (const sp of wbData.species ?? []) {
        speciesSet.add(sp);
      }
    }
    entry.speciesSet = Array.from(speciesSet).sort();
  }

  countyDataCache = map;
  return map;
}

/** Compute choropleth fill color based on waterbody count. */
function choroplethFill(count: number, maxCount: number): string {
  if (maxCount === 0 || count === 0) return "#d4e0ed";
  const t = Math.min(1, count / maxCount);
  const r = Math.round(207 + t * (26 - 207));
  const g = Math.round(224 + t * (90 - 224));
  const b = Math.round(240 + t * (158 - 240));
  return `rgb(${r},${g},${b})`;
}

/**
 * Point-in-polygon test using ray-casting algorithm.
 * Returns the county name containing the point, or null.
 */
function pointInCounty(lat: number, lng: number, geoJson: any): string | null {
  for (const feature of geoJson.features) {
    const name = feature.properties.name;
    const geom = feature.geometry;
    if (geom.type === "Polygon") {
      if (rayCastInPolygon(lat, lng, geom.coordinates[0])) {
        return name;
      }
    } else if (geom.type === "MultiPolygon") {
      for (const polygon of geom.coordinates) {
        if (rayCastInPolygon(lat, lng, polygon[0])) {
          return name;
        }
      }
    }
  }
  return null;
}

/**
 * Ray-casting point-in-polygon. Coordinates are [lng, lat] in GeoJSON.
 */
function rayCastInPolygon(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    // GeoJSON is [lng, lat], so yi=y, xi=x
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Callback type for when a county is selected on the map.
 * The main module provides this to show the county summary panel.
 */
export type CountySelectedCallback = (county: string, data: RegsData) => void;

/**
 * Callback type for when a specific waterbody marker is clicked.
 */
export type WaterbodySelectedCallback = (
  name: string,
  county: string,
  data: RegsData
) => void;

/**
 * Initialize the Leaflet map in the given container element.
 * Must be called after the container is in the DOM.
 */
export async function initLeafletMap(
  containerId: string,
  data: RegsData,
  onCountySelected: CountySelectedCallback,
  onWaterbodySelected?: WaterbodySelectedCallback
): Promise<void> {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Clean up any existing map instance
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
    countyLayer = null;
    pinMarker = null;
  }

  // Load county GeoJSON
  let geoJson: any;
  try {
    geoJson = await loadCountyGeoJson();
  } catch (err) {
    container.innerHTML = `<div style="padding:2rem;text-align:center;color:#8b9bb3">Failed to load county boundary data.</div>`;
    return;
  }

  // Michigan center: approximately 44.5N, -85.0W
  mapInstance = L.map(containerId, {
    center: [44.5, -85.0],
    zoom: 7,
    zoomControl: true,
    attributionControl: true,
  });

  // Esri World Imagery (satellite) - free, no API key needed
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution:
        'Tiles &copy; Esri &mdash; Source: Esri, Earthstar Geographics',
      crossOrigin: true,
    }
  ).addTo(mapInstance);

  // Esri reference overlay (place names and boundaries) - subtle labels on top of satellite
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      opacity: 0.6,
      crossOrigin: true,
    }
  ).addTo(mapInstance);

  // County data for choropleth and tooltips
  const countyData = getCountyData(data);
  const maxWB = Math.max(
    ...Array.from(countyData.values()).map((d) => d.waterbodyCount),
    1
  );

  // Style function for the GeoJSON layer
  function styleFeature(feature: any) {
    const countyName = feature.properties.name;
    const cd = countyData.get(countyName);
    const count = cd?.waterbodyCount ?? 0;
    return {
      fillColor: choroplethFill(count, maxWB),
      weight: 1,
      opacity: 1,
      color: "#ffffff",
      dashArray: "",
      fillOpacity: 0.35,
    };
  }

  // Add the county GeoJSON layer
  countyLayer = L.geoJson(geoJson, {
    style: styleFeature,
    onEachFeature: (feature: any, layer: any) => {
      const countyName = feature.properties.name;
      const cd = countyData.get(countyName);
      const wbCount = cd?.waterbodyCount ?? 0;
      const lakeCount = cd?.lakeCount ?? 0;
      const streamCount = cd?.streamCount ?? 0;
      const hasExc = cd?.hasExceptions ?? false;
      const typeCodes = cd?.typeCodes ?? [];
      const speciesCount = cd?.speciesSet.length ?? 0;

      // Tooltip content
      const tooltipHtml = `
        <div style="font-weight:700;font-size:0.875rem;margin-bottom:0.25rem">${esc(countyName)} County</div>
        <div style="font-size:0.75rem;color:#5a6c83">
          <span>${lakeCount} lakes</span> &middot;
          <span>${streamCount} rivers/streams</span> &middot;
          <span>${wbCount} total</span>
        </div>
        <div style="margin-top:0.25rem;font-size:0.6875rem">
          ${hasExc ? '<span style="color:#c47820;font-weight:600">Has exceptions</span>' : '<span style="color:#8b9bb3">No exceptions</span>'}
          ${typeCodes.length > 0 ? ` &middot; <span style="color:#2563eb">Types: ${esc(typeCodes.join(", "))}</span>` : ""}
          ${speciesCount > 0 ? ` &middot; <span style="color:#5b8a5b">${speciesCount} species</span>` : ""}
        </div>
      `;
      layer.bindTooltip(tooltipHtml, {
        sticky: true,
        className: "leaflet-county-tooltip",
        direction: "top",
      });

      // Click on county
      layer.on("click", () => {
        // Highlight selection
        if (countyLayer) {
          countyLayer.setStyle(styleFeature);
        }
        layer.setStyle({
          weight: 3,
          color: "#0d9488",
          dashArray: "",
          fillOpacity: 0.5,
        });
        layer.bringToFront();
        onCountySelected(countyName, data);
      });

      // Hover highlight
      layer.on("mouseover", () => {
        layer.setStyle({
          weight: 2,
          color: "#0d9488",
          fillOpacity: 0.5,
        });
        layer.bringToFront();
      });
      layer.on("mouseout", () => {
        if (countyLayer) {
          countyLayer.resetStyle(layer);
        }
      });
    },
  }).addTo(mapInstance);

  // Click anywhere on the map (not on a county) to drop a pin and identify the county
  mapInstance.on("click", (e: any) => {
    const { lat, lng } = e.latlng;

    // Find which county this point is in
    const county = pointInCounty(lat, lng, geoJson);
    if (county) {
      // Drop a pin marker
      if (pinMarker) {
        mapInstance.removeLayer(pinMarker);
      }
      pinMarker = L.marker([lat, lng]).addTo(mapInstance);
      pinMarker.bindPopup(
        `<div style="font-weight:700">${esc(county)} County</div>` +
          `<div style="font-size:0.75rem;color:#5a6c83">Click the county outline for details</div>`
      ).openPopup();

      // Also highlight the county and trigger the callback
      countyLayer.eachLayer((layer: any) => {
        if (layer.feature.properties.name === county) {
          countyLayer.setStyle(styleFeature);
          layer.setStyle({
            weight: 3,
            color: "#0d9488",
            fillOpacity: 0.5,
          });
          layer.bringToFront();
        }
      });

      onCountySelected(county, data);
    } else {
      // Outside Michigan - show a note
      if (pinMarker) {
        mapInstance.removeLayer(pinMarker);
      }
      pinMarker = L.marker([lat, lng]).addTo(mapInstance);
      pinMarker.bindPopup(
        `<div style="color:#8b9bb3">This location is outside Michigan.</div>`
      ).openPopup();
    }
  });

  // Fit the map bounds to Michigan
  try {
    const bounds = countyLayer.getBounds();
    mapInstance.fitBounds(bounds, { padding: [20, 20] });
  } catch {
    // If getBounds fails, default center/zoom is fine
  }

  // Load and display waterbody markers (if coordinates are available)
  try {
    const coords = await loadWaterbodyCoords();
    const coordEntries = Object.entries(coords);
    if (coordEntries.length > 0) {
      waterbodyMarkerLayer = L.layerGroup();

      for (const wb of data.waterbodies ?? []) {
        const key = `${wb.name}|${wb.county}`;
        const coords = coordsCache?.[key];
        if (!coords) continue;

        const [lat, lon] = coords;
        // Color by kind: lakes=blue, rivers=green, others=purple
        const color =
          wb.kind === "lake" || wb.kind === "pond"
            ? "#2563eb"
            : wb.kind === "river" || wb.kind === "stream" || wb.kind === "creek"
            ? "#16a34a"
            : "#7c3aed";

        // Check if this waterbody has species data
        const hasSpecies =
          (data.species_by_waterbody?.[wb.county]?.[wb.name]?.species ?? [])
            .length > 0;

        const marker = L.circleMarker([lat, lon], {
          radius: hasSpecies ? 6 : 4,
          fillColor: color,
          color: "#ffffff",
          weight: 1,
          opacity: 0.9,
          fillOpacity: hasSpecies ? 0.8 : 0.5,
        });

        // Tooltip with waterbody name and info
        const typeLabel = wb.type ? ` (Type ${wb.type})` : "";
        const speciesInfo = hasSpecies
          ? `<div style="font-size:0.6875rem;color:#5b8a5b;margin-top:0.15rem">Has species data</div>`
          : "";
        marker.bindTooltip(
          `<div style="font-weight:600;font-size:0.8125rem">${esc(wb.name)}${typeLabel}</div>` +
            `<div style="font-size:0.6875rem;color:#5a6c83">${esc(wb.county)} County</div>` +
            speciesInfo,
          {
            className: "leaflet-waterbody-tooltip",
            direction: "top",
            offset: [0, -4],
          }
        );

        // Click on marker shows waterbody in detail panel
        marker.on("click", () => {
          if (onWaterbodySelected) {
            onWaterbodySelected(wb.name, wb.county, data);
          }
        });

        waterbodyMarkerLayer.addLayer(marker);
      }

      // Add markers to map, but only show them at higher zoom levels
      // (showing 700+ markers at state-wide zoom would be cluttered)
      const markerLayer = waterbodyMarkerLayer;
      markerLayer.addTo(mapInstance);

      // Toggle marker visibility based on zoom level
      function updateMarkerVisibility() {
        if (!mapInstance) return;
        const z = mapInstance.getZoom();
        if (z >= 10) {
          if (!mapInstance.hasLayer(markerLayer)) {
            mapInstance.addLayer(markerLayer);
          }
        } else {
          if (mapInstance.hasLayer(markerLayer)) {
            mapInstance.removeLayer(markerLayer);
          }
        }
      }
      updateMarkerVisibility();
      mapInstance.on("zoomend", updateMarkerVisibility);
    }
  } catch {
    // Coordinates file not available yet - skip markers
  }
}

/**
 * Filter counties on the Leaflet map by search query.
 * Highlights matching counties, dims the rest.
 */
export function filterCountiesOnMap(query: string): void {
  if (!countyLayer) return;
  const q = query.trim().toLowerCase();
  if (!q) {
    countyLayer.eachLayer((layer: any) => {
      countyLayer.resetStyle(layer);
    });
    return;
  }
  countyLayer.eachLayer((layer: any) => {
    const name = layer.feature.properties.name.toLowerCase();
    if (name.includes(q)) {
      layer.setStyle({
        weight: 2,
        color: "#0d9488",
        fillOpacity: 0.6,
      });
      layer.bringToFront();
    } else {
      layer.setStyle({
        weight: 1,
        color: "#ffffff",
        fillOpacity: 0.1,
      });
    }
  });
}

/**
 * Zoom to a specific county on the map.
 */
export function zoomToCounty(countyName: string): void {
  if (!countyLayer || !mapInstance) return;
  countyLayer.eachLayer((layer: any) => {
    if (layer.feature.properties.name === countyName) {
      try {
        mapInstance.fitBounds(layer.getBounds(), { padding: [40, 40] });
        countyLayer.setStyle(() => ({
          fillColor: "#d4e0ed",
          weight: 1,
          opacity: 1,
          color: "#ffffff",
          fillOpacity: 0.35,
        }));
        layer.setStyle({
          weight: 3,
          color: "#0d9488",
          fillOpacity: 0.5,
        });
        layer.bringToFront();
      } catch {
        // skip
      }
    }
  });
}

/**
 * Clean up the Leaflet map instance.
 */
export function destroyLeafletMap(): void {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
    countyLayer = null;
    pinMarker = null;
    waterbodyMarkerLayer = null;
  }
}