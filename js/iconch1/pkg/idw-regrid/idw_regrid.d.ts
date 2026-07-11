/* tslint:disable */
/* eslint-disable */

export class IdwWeightTableResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly cell_count: number;
    readonly di_deg: number;
    readonly dj_deg: number;
    readonly indices: Uint32Array;
    readonly la1_deg: number;
    readonly la2_deg: number;
    readonly lo1_deg: number;
    readonly lo2_deg: number;
    readonly neighbor_count: number;
    readonly ni: number;
    readonly nj: number;
    readonly scan_mode: number;
    readonly weights: Float32Array;
}

export function apply_idw_weight_table(indices: Uint32Array, weights: Float32Array, values: Float32Array, neighbor_count: number): Float32Array;

export function build_idw_weight_table(lats: Float32Array, lons: Float32Array, spacing_deg: number): IdwWeightTableResult;

export function build_sector_geojson_json(ni: number, nj: number, la1_deg: number, lo1_deg: number, la2_deg: number, lo2_deg: number, di_deg: number, dj_deg: number, scan_mode: number, values: Float32Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_idwweighttableresult_free: (a: number, b: number) => void;
    readonly apply_idw_weight_table: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly build_idw_weight_table: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly build_sector_geojson_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly idwweighttableresult_cell_count: (a: number) => number;
    readonly idwweighttableresult_di_deg: (a: number) => number;
    readonly idwweighttableresult_dj_deg: (a: number) => number;
    readonly idwweighttableresult_indices: (a: number) => [number, number];
    readonly idwweighttableresult_la1_deg: (a: number) => number;
    readonly idwweighttableresult_la2_deg: (a: number) => number;
    readonly idwweighttableresult_lo1_deg: (a: number) => number;
    readonly idwweighttableresult_lo2_deg: (a: number) => number;
    readonly idwweighttableresult_neighbor_count: (a: number) => number;
    readonly idwweighttableresult_ni: (a: number) => number;
    readonly idwweighttableresult_nj: (a: number) => number;
    readonly idwweighttableresult_scan_mode: (a: number) => number;
    readonly idwweighttableresult_weights: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
