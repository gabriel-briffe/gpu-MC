import { fetchTerrainTileBlob, pruneTerrainTileCache } from "../terrain-tiles.js";
import { fetchAirportsForCellKeys } from "../openaip-airports.js";
import {
  clearAllOpenAipData,
  purgeCellCacheExcept,
  setCellEntry,
  setLastCachedCellKeys,
} from "./cell-store.js";
import {
  CACHE_TERRAIN_Z_MAX,
  CACHE_TERRAIN_Z_MIN,
  CACHE_TERRAIN_WARN_Z_MAX,
  cacheCellBounds,
  terrariumTileJobsForCellKeys,
  unionCellBounds,
} from "./cell-geometry.js";
import { mergeCachedAirports, mergeCachedAirspaces } from "./cached-queries.js";

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

async function cacheAirportsForCells(cellKeys, config, onStatus, onWarning) {
  let airportFetches = 0;
  let cellsFetched = 0;
  let cellsFailed = 0;

  let airportsByCell = new Map();
  try {
    onStatus?.(`Resolving airport countries for ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"}…`);
    const result = await fetchAirportsForCellKeys(cellKeys, config, { onStatus });
    airportsByCell = result.airportsByCell;
    airportFetches = result.fetchCount;
    if (result.countries.length) {
      onStatus?.(
        `Airport exports loaded for ${result.countries.join(", ")}`
      );
    }
  } catch (error) {
    onWarning?.(`Airport exports: ${error.message}`);
    for (const cellKey of cellKeys) {
      cellsFailed += 1;
      onWarning?.(`Cell ${cellKey}: ${error.message}`);
    }
    return { airportFetches, cellsFetched, cellsFailed };
  }

  // Airspace Core API fetch disabled for now (429); store empty lists.
  for (let index = 0; index < cellKeys.length; index += 1) {
    const cellKey = cellKeys[index];
    const bounds = cacheCellBounds(cellKey);
    cellsFetched += 1;
    setCellEntry(cellKey, {
      cellKey,
      bounds,
      airports: airportsByCell.get(cellKey) ?? [],
      airspaces: [],
      fetchedAt: Date.now(),
      airportFetches: index === 0 ? airportFetches : 0,
      airspaceFetches: 0,
    });
  }

  return { airportFetches, cellsFetched, cellsFailed };
}

export async function buildCacheBundle(cellKeys, config, onStatus, onWarning, options = {}) {
  const { openAipOnly = false } = options;
  if (!cellKeys.length) {
    throw new Error("Select at least one 1° cell to cache");
  }

  const bounds = unionCellBounds(cellKeys);

  purgeCellCacheExcept(cellKeys);
  clearAllOpenAipData();

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
  }

  onStatus?.(`Fetching airports for ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"}…`);
  const { airportFetches, cellsFetched, cellsFailed } = await cacheAirportsForCells(
    cellKeys,
    config,
    onStatus,
    onWarning
  );
  const networkFetches = tileFetches + airportFetches;
  const airportCount = mergeCachedAirports(cellKeys).length;
  const airspaceCount = mergeCachedAirspaces(cellKeys).length;
  setLastCachedCellKeys(cellKeys);

  const failParts = [];
  if (tileFailures > 0) {
    failParts.push(`${tileFailures} terrain tile${tileFailures === 1 ? "" : "s"} failed`);
  }
  if (cellsFailed > 0) {
    failParts.push(`${cellsFailed} cell${cellsFailed === 1 ? "" : "s"} failed`);
  }
  const failSuffix = failParts.length ? `, ${failParts.join(", ")}` : "";

  if (openAipOnly) {
    onStatus?.(
      `OpenAIP updated — ${airportCount} airports, ${airspaceCount} airspace volumes in ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"} (${airportFetches} fetched${failSuffix})`
    );
  } else {
    onStatus?.(
      `Cache done — ${tileCount} terrarium tiles, ${airportCount} airports, ${airspaceCount} airspace volumes in ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"} (${networkFetches} fetched${failSuffix})`
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
    cellsFetched,
    cellsFailed,
    airportCount,
    airspaceCount,
  };
}
