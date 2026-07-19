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

async function cacheOpenAipForCells(cellKeys, config, onStatus, onWarning) {
  let airportFetches = 0;
  let airspaceFetches = 0;
  let cellsFetched = 0;
  let cellsFailed = 0;

  try {
    onStatus?.(
      `Resolving OpenAIP countries for ${cellKeys.length} cell${cellKeys.length === 1 ? "" : "s"}…`
    );
    const airportResult = await fetchAirportsForCellKeys(cellKeys, config, { onStatus });
    airportFetches = airportResult.fetchCount;
    if (airportResult.countries.length) {
      onStatus?.(`Airports loaded for ${airportResult.countries.join(", ")}`);
    }

    const airspaceResult = await fetchAirspacesForCellKeys(cellKeys, config, { onStatus });
    airspaceFetches = airspaceResult.fetchCount;
    if (airspaceResult.countries.length) {
      onStatus?.(
        `Airspaces loaded for ${airspaceResult.countries.join(", ")} (${airspaceResult.airspaces.length} volumes)`
      );
    }

    setOpenAipCache({
      airports: airportResult.airports,
      airspaces: airspaceResult.airspaces,
      airportFetches,
      airspaceFetches,
    });
    cellsFetched = cellKeys.length;
  } catch (error) {
    cellsFailed = cellKeys.length;
    onWarning?.(`OpenAIP exports: ${error.message}`);
    onStatus?.(`OpenAIP cache failed — ${error.message}`);
  }

  return { airportFetches, airspaceFetches, cellsFetched, cellsFailed };
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
