import { fetchTerrainTileBlob, pruneTerrainTileCache } from "../terrain-tiles.js";
import { fetchAirportsForCellKeys } from "../openaip-airports.js";
import { fetchAirspacesForCellKeys } from "../airspace.js";
import {
  clearAllOpenAipData,
  purgeCellCacheExcept,
  setLastCachedCellKeys,
  setOpenAipCache,
} from "./cell-store.js";
import {
  CACHE_TERRAIN_Z_MAX,
  CACHE_TERRAIN_Z_MIN,
  CACHE_TERRAIN_WARN_Z_MAX,
  terrariumTileJobsForCellKeys,
  unionCellBounds,
} from "./cell-geometry.js";
import { mergeCachedAirports, mergeCachedAirspaces } from "./cached-queries.js";
import { maxPoolZ8FromZ9, maxPoolZ7FromZ8 } from "./terrain-maxpool.js";
import { pruneAirspaceCellCacheExcept } from "./airspace-cell-cache.js";
import { pruneAirportCellCacheExcept } from "./airport-cell-cache.js";

const TERRAIN_PREFETCH_CONCURRENCY = 8;

async function prefetchTerrariumTiles(jobs, onStatus, onWarning) {
  if (jobs.length === 0) {
    return { tileCount: 0, tileFetches: 0, tileFailures: 0 };
  }

  let loaded = 0;
  let tileFetches = 0;
  let tileFailures = 0;
  onStatus?.(`Caching terrarium tiles 0/${jobs.length} (z${CACHE_TERRAIN_Z_MIN}–${CACHE_TERRAIN_Z_MAX})…`);

  for (let index = 0; index < jobs.length; index += TERRAIN_PREFETCH_CONCURRENCY) {
    const batch = jobs.slice(index, index + TERRAIN_PREFETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ z, x, y }) => {
        try {
          const { fromNetwork } = await fetchTerrainTileBlob(z, x, y);
          if (fromNetwork) {
            tileFetches += 1;
          }
        } catch (error) {
          tileFailures += 1;
          if (z <= CACHE_TERRAIN_WARN_Z_MAX) {
            onWarning?.(`Terrain z${z}/${x}/${y}: ${error.message}`);
          }
        } finally {
          loaded += 1;
          onStatus?.(
            `Caching terrarium tiles ${loaded}/${jobs.length} (z${CACHE_TERRAIN_Z_MIN}–${CACHE_TERRAIN_Z_MAX})…`
          );
        }
      })
    );
  }

  return { tileCount: jobs.length, tileFetches, tileFailures };
}

function formatCellLayerStatus(label, count, result) {
  return (
    `${label}: ${count}` +
    (result.countries?.length ? ` (${result.countries.join(", ")})` : "") +
    (result.cellsFromCache
      ? ` — ${result.cellsFromCache} cell${result.cellsFromCache === 1 ? "" : "s"} from cache`
      : "") +
    (result.cellsFetched ? ` — ${result.cellsFetched} fetched` : "") +
    (result.cellsFailed ? ` — ${result.cellsFailed} skipped` : "")
  );
}

async function cacheOpenAipForCells(cellKeys, config, onStatus, onWarning) {
  let airportFetches = 0;
  let airspaceFetches = 0;
  let cellsFetched = 0;
  let cellsFailed = 0;

  let airports = [];
  let airspaces = [];

  try {
    const airportResult = await fetchAirportsForCellKeys(cellKeys, config, {
      onStatus,
      onWarning,
    });
    airportFetches = airportResult.fetchCount;
    airports = airportResult.airports;
    if (airportResult.cellsFailed) {
      cellsFailed += airportResult.cellsFailed;
    }
    cellsFetched += airportResult.cellsFetched ?? 0;
    onStatus?.(formatCellLayerStatus("Airports", airports.length, airportResult));
  } catch (error) {
    cellsFailed += cellKeys.length;
    onWarning?.(`Airports cache: ${error.message}`);
    onStatus?.(`Airports cache failed — ${error.message}`);
  }

  try {
    const airspaceResult = await fetchAirspacesForCellKeys(cellKeys, config, {
      onStatus,
      onWarning,
    });
    airspaceFetches = airspaceResult.fetchCount;
    airspaces = airspaceResult.airspaces;
    if (airspaceResult.cellsFailed) {
      cellsFailed += airspaceResult.cellsFailed;
    }
    cellsFetched += airspaceResult.cellsFetched ?? 0;
    onStatus?.(formatCellLayerStatus("Airspaces", airspaces.length, airspaceResult));
  } catch (error) {
    onWarning?.(`Airspaces cache: ${error.message} — continuing with airports only`);
    onStatus?.(`Airspaces failed — keeping ${airports.length} airports`);
  }

  if (airports.length || airspaces.length) {
    setOpenAipCache({
      airports,
      airspaces,
      airportFetches,
      airspaceFetches,
    });
  }

  return { airportFetches, airspaceFetches, cellsFetched, cellsFailed };
}

export async function buildCacheBundle(cellKeys, config, onStatus, onWarning, options = {}) {
  const { openAipOnly = false } = options;
  if (!cellKeys.length) {
    throw new Error("Select at least one 3° cell to cache");
  }

  const bounds = unionCellBounds(cellKeys);

  purgeCellCacheExcept(cellKeys);
  clearAllOpenAipData();
  await pruneAirportCellCacheExcept(cellKeys);
  await pruneAirspaceCellCacheExcept(cellKeys);

  let tileCount = 0;
  let tileFetches = 0;
  let tileFailures = 0;
  let terrainPruned = 0;

  if (!openAipOnly) {
    const tileJobs = terrariumTileJobsForCellKeys(cellKeys);
    ({ removed: terrainPruned } = await pruneTerrainTileCache(tileJobs));
    if (terrainPruned > 0) {
      onStatus?.(`Removed ${terrainPruned} unused terrain tile${terrainPruned === 1 ? "" : "s"}…`);
    }

    ({ tileCount, tileFetches, tileFailures } = await prefetchTerrariumTiles(
      tileJobs,
      onStatus,
      onWarning
    ));

    // Raise only when at least one terrain tile was downloaded this run.
    // Recache with a full tile hit set would redo idempotent max-pool work.
    if (tileFetches > 0) {
      try {
        const z8 = await maxPoolZ8FromZ9(tileJobs, onStatus);
        const z7 = await maxPoolZ7FromZ8(tileJobs, onStatus);
        const raised = z8.parentsUpdated + z7.parentsUpdated;
        const skipped = z8.parentsSkipped + z7.parentsSkipped;
        if (raised > 0) {
          onStatus?.(
            `Raised ridges: ${z8.parentsUpdated} z8←z9, ${z7.parentsUpdated} z7←z8` +
              (skipped ? ` (${skipped} skipped)` : "")
          );
        }
      } catch (error) {
        onWarning?.(`Terrain ridge raise failed: ${error.message}`);
      }
    } else if (tileCount > 0) {
      onStatus?.("Terrain tiles already cached — skipped ridge raise");
    }
  }

  onStatus?.(
    `Fetching airports & airspace for ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"}…`
  );
  const { airportFetches, airspaceFetches, cellsFetched, cellsFailed } =
    await cacheOpenAipForCells(cellKeys, config, onStatus, onWarning);
  const openAipFetches = airportFetches + airspaceFetches;
  const networkFetches = tileFetches + openAipFetches;
  const airportCount = mergeCachedAirports().length;
  const airspaceCount = mergeCachedAirspaces().length;
  setLastCachedCellKeys(cellKeys);

  const failParts = [];
  if (tileFailures > 0) {
    failParts.push(`${tileFailures} terrain tile${tileFailures === 1 ? "" : "s"} failed`);
  }
  if (cellsFailed > 0) {
    failParts.push(`OpenAIP fetch failed`);
  }
  const failSuffix = failParts.length ? `, ${failParts.join(", ")}` : "";

  if (openAipOnly) {
    onStatus?.(
      `OpenAIP updated — ${airportCount} airports, ${airspaceCount} airspace volumes for ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"} (${openAipFetches} fetched${failSuffix})`
    );
  } else {
    onStatus?.(
      `Cache done — ${tileCount} terrarium tiles, ${airportCount} airports, ${airspaceCount} airspace volumes for ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"} (${networkFetches} fetched${failSuffix})`
    );
  }

  return {
    cellKeys: [...cellKeys],
    bounds,
    tileCount,
    tileFetches,
    tileFailures,
    terrainPruned,
    airportFetches,
    airspaceFetches,
    cellsFetched,
    cellsFailed,
    airportCount,
    airspaceCount,
  };
}
