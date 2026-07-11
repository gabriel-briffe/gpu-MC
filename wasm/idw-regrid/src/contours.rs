use serde::Serialize;
use std::collections::HashMap;

const SECTOR_POSITIVE_MIN: f64 = 0.5;
const SECTOR_POSITIVE_MAX: f64 = 5.0;
const SECTOR_NEGATIVE_START: f64 = -0.5;
const SECTOR_NEGATIVE_END: f64 = -5.0;
const SECTOR_STEP: f64 = 0.5;

const MS_SEGMENTS: [&[(usize, usize)]; 16] = [
    &[],
    &[(3, 0)],
    &[(0, 1)],
    &[(3, 1)],
    &[(1, 2)],
    &[(3, 0), (1, 2)],
    &[(0, 2)],
    &[(3, 2)],
    &[(2, 3)],
    &[(2, 0)],
    &[(0, 1), (2, 3)],
    &[(2, 1)],
    &[(1, 3)],
    &[(1, 0)],
    &[(0, 3)],
    &[],
];

const CORNER_OFFSETS: [(usize, usize); 4] = [(0, 0), (1, 0), (1, 1), (0, 1)];
const EDGE_VERTICES: [(usize, usize); 4] = [(0, 1), (1, 2), (2, 3), (3, 0)];

type Point = [f64; 2];
type Segment = (Point, Point);
type Line = Vec<Point>;
type Ring = Vec<Point>;
type Polygon = Vec<Ring>;

#[derive(Clone)]
struct SectorLevel {
    threshold: f64,
    color: String,
    compare_lt: bool,
}

struct Field<'a> {
    ni: usize,
    nj: usize,
    la1_deg: f64,
    lo1_deg: f64,
    di_deg: f64,
    dj_deg: f64,
    scan_mode: u32,
    values: &'a [f32],
}

#[derive(Serialize)]
struct FeatureCollection {
    #[serde(rename = "type")]
    kind: &'static str,
    features: Vec<Feature>,
}

#[derive(Serialize)]
struct Feature {
    #[serde(rename = "type")]
    kind: &'static str,
    properties: FeatureProperties,
    geometry: Geometry,
}

#[derive(Serialize)]
struct FeatureProperties {
    threshold: f64,
    color: String,
    polygons: usize,
}

#[derive(Serialize)]
struct Geometry {
    #[serde(rename = "type")]
    kind: &'static str,
    coordinates: Vec<Polygon>,
}

fn parse_hex(hex: &str) -> (u8, u8, u8) {
    let n = u32::from_str_radix(&hex[1..], 16).unwrap_or(0);
    ((n >> 16) as u8, ((n >> 8) & 255) as u8, (n & 255) as u8)
}

fn lerp_color(hex_a: &str, hex_b: &str, t: f64) -> String {
    let (ar, ag, ab) = parse_hex(hex_a);
    let (br, bg, bb) = parse_hex(hex_b);
    let t = t.clamp(0.0, 1.0);
    let r = (f64::from(ar) + (f64::from(br) - f64::from(ar)) * t).round() as u8;
    let g = (f64::from(ag) + (f64::from(bg) - f64::from(ag)) * t).round() as u8;
    let b = (f64::from(ab) + (f64::from(bb) - f64::from(ab)) * t).round() as u8;
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

fn build_sector_level_scale(
    start: f64,
    end: f64,
    step: f64,
    color_start: &str,
    color_mid: Option<&str>,
    color_end: &str,
    compare_lt: bool,
) -> Vec<SectorLevel> {
    let count = ((end - start).abs() / step).round() as usize + 1;
    let direction = if end >= start { 1.0 } else { -1.0 };
    let mut levels = Vec::with_capacity(count);

    for i in 0..count {
        let threshold = ((start + direction * i as f64 * step) * 10.0).round() / 10.0;
        let t = if count == 1 {
            0.0
        } else {
            i as f64 / (count - 1) as f64
        };
        let color = match color_mid {
            Some(mid) if t <= 0.5 => lerp_color(color_start, mid, t / 0.5),
            Some(mid) => lerp_color(mid, color_end, (t - 0.5) / 0.5),
            None => lerp_color(color_start, color_end, t),
        };
        levels.push(SectorLevel {
            threshold,
            color,
            compare_lt,
        });
    }

    levels
}

fn sector_levels() -> Vec<SectorLevel> {
    let mut levels = build_sector_level_scale(
        SECTOR_NEGATIVE_START,
        SECTOR_NEGATIVE_END,
        SECTOR_STEP,
        "#40e0d0",
        None,
        "#0c1844",
        true,
    );
    levels.extend(build_sector_level_scale(
        SECTOR_POSITIVE_MIN,
        SECTOR_POSITIVE_MAX,
        SECTOR_STEP,
        "#f5d000",
        Some("#ff2a2a"),
        "#9b4dca",
        false,
    ));
    levels
}

fn normalize_lon(lon: f64) -> f64 {
    let mut out = lon;
    while out > 180.0 {
        out -= 360.0;
    }
    while out <= -180.0 {
        out += 360.0;
    }
    out
}

fn index_from_ij(i: usize, j: usize, ni: usize, scan_mode: u32) -> usize {
    let col_major = (scan_mode & 0x20) != 0;
    if col_major {
        i * ni + j
    } else {
        j * ni + i
    }
}

fn cell_lat_lon(i: usize, j: usize, field: &Field<'_>) -> Point {
    let i_dir = if (field.scan_mode & 0x80) == 0 { 1.0 } else { -1.0 };
    let j_dir = if (field.scan_mode & 0x40) != 0 { 1.0 } else { -1.0 };
    let lat = field.la1_deg + j as f64 * field.dj_deg * j_dir;
    let lon = normalize_lon(field.lo1_deg + i as f64 * field.di_deg * i_dir);
    [lon, lat]
}

fn endpoint_key(lon: f64, lat: f64) -> String {
    format!("{:.7},{:.7}", lon, lat)
}

fn sample_field_value(i: isize, j: isize, field: &Field<'_>) -> f64 {
    if i < 0 || j < 0 || i as usize >= field.ni || j as usize >= field.nj {
        return f64::NAN;
    }
    let idx = index_from_ij(i as usize, j as usize, field.ni, field.scan_mode);
    if idx >= field.values.len() {
        return f64::NAN;
    }
    let value = f64::from(field.values[idx]);
    if value.is_finite() {
        value
    } else {
        f64::NAN
    }
}

fn edge_point(
    edge: usize,
    corner_values: &[f64; 4],
    corners: &[[f64; 2]; 4],
    threshold: f64,
) -> Option<Point> {
    let (a, b) = EDGE_VERTICES[edge];
    let z1 = corner_values[a];
    let z2 = corner_values[b];
    let p1 = corners[a];
    let p2 = corners[b];
    if !z1.is_finite() || !z2.is_finite() || z1 == z2 {
        return None;
    }
    let t = (threshold - z1) / (z2 - z1);
    if !(0.0..=1.0).contains(&t) {
        return None;
    }
    Some([
        p1[0] + t * (p2[0] - p1[0]),
        p1[1] + t * (p2[1] - p1[1]),
    ])
}

fn follow_segment(
    segments: &[Segment],
    endpoint_map: &HashMap<String, Vec<(usize, usize)>>,
    used: &mut [bool],
    start_seg: usize,
    start_end: usize,
    lines: &mut Vec<Line>,
) {
    let mut coords: Vec<Point> = Vec::new();
    let mut seg = Some(start_seg);
    let mut end = start_end;

    while let Some(current_seg) = seg {
        if used[current_seg] {
            break;
        }
        used[current_seg] = true;
        let (a, b) = segments[current_seg];
        if end == 0 {
            coords.push(a);
            coords.push(b);
        } else {
            coords.push(b);
            coords.push(a);
        }
        let tip = if end == 0 { b } else { a };
        let key = endpoint_key(tip[0], tip[1]);
        let mut next = None;
        if let Some(candidates) = endpoint_map.get(&key) {
            for &(cand_seg, cand_end) in candidates {
                if cand_seg == current_seg || used[cand_seg] {
                    continue;
                }
                next = Some((cand_seg, cand_end));
                break;
            }
        }
        seg = next.map(|(s, _)| s);
        end = next.map(|(_, e)| e).unwrap_or(0);
    }

    let mut deduped: Vec<Point> = Vec::new();
    for pt in coords {
        if let Some(last) = deduped.last() {
            if last[0] == pt[0] && last[1] == pt[1] {
                continue;
            }
        }
        deduped.push(pt);
    }
    if deduped.len() >= 2 {
        lines.push(deduped);
    }
}

fn stitch_segments(segments: &[Segment]) -> Vec<Line> {
    if segments.is_empty() {
        return Vec::new();
    }

    let mut endpoint_map: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    for (i, (a, b)) in segments.iter().enumerate() {
        let ka = endpoint_key(a[0], a[1]);
        let kb = endpoint_key(b[0], b[1]);
        endpoint_map.entry(ka).or_default().push((i, 0));
        endpoint_map.entry(kb).or_default().push((i, 1));
    }

    let mut used = vec![false; segments.len()];
    let mut lines = Vec::new();

    for i in 0..segments.len() {
        if used[i] {
            continue;
        }
        follow_segment(segments, &endpoint_map, &mut used, i, 0, &mut lines);
        if !used[i] {
            follow_segment(segments, &endpoint_map, &mut used, i, 1, &mut lines);
        }
    }

    lines
}

fn close_line_ring(line: &Line) -> Option<Ring> {
    if line.len() < 3 {
        return None;
    }
    let mut ring = line.clone();
    let first = ring[0];
    let last = ring[ring.len() - 1];
    if endpoint_key(first[0], first[1]) != endpoint_key(last[0], last[1]) {
        ring.push(first);
    }
    if ring.len() >= 4 {
        Some(ring)
    } else {
        None
    }
}

fn ring_signed_area(ring: &Ring) -> f64 {
    let mut area = 0.0;
    for i in 0..ring.len().saturating_sub(1) {
        area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    area / 2.0
}

fn ring_centroid(ring: &Ring) -> Point {
    let n = ring.len().saturating_sub(1);
    if n == 0 {
        return ring[0];
    }
    let mut sum_lon = 0.0;
    let mut sum_lat = 0.0;
    for i in 0..n {
        sum_lon += ring[i][0];
        sum_lat += ring[i][1];
    }
    [sum_lon / n as f64, sum_lat / n as f64]
}

fn point_in_ring(point: Point, ring: &Ring) -> bool {
    let (x, y) = (point[0], point[1]);
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (xi, yi) = (ring[i][0], ring[i][1]);
        let (xj, yj) = (ring[j][0], ring[j][1]);
        let intersect = (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi;
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn lines_to_multi_polygon(lines: &[Line]) -> Vec<Polygon> {
    let rings: Vec<Ring> = lines
        .iter()
        .filter_map(|line| close_line_ring(line))
        .map(|ring| {
            if ring_signed_area(&ring) < 0.0 {
                let mut reversed = ring.clone();
                reversed.reverse();
                reversed
            } else {
                ring
            }
        })
        .collect();

    let mut ranked: Vec<(Ring, f64, Point)> = rings
        .iter()
        .map(|ring| {
            let area = ring_signed_area(ring).abs();
            let centroid = ring_centroid(ring);
            (ring.clone(), area, centroid)
        })
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut assigned = vec![false; ranked.len()];
    let mut polygons = Vec::new();

    for i in 0..ranked.len() {
        if assigned[i] {
            continue;
        }
        let mut polygon = vec![ranked[i].0.clone()];
        assigned[i] = true;

        for j in (i + 1)..ranked.len() {
            if assigned[j] {
                continue;
            }
            let candidate = &ranked[j];
            if !point_in_ring(candidate.2, &ranked[i].0) {
                continue;
            }

            let mut nested_in_hole = false;
            for hole_idx in 1..polygon.len() {
                if point_in_ring(candidate.2, &polygon[hole_idx]) {
                    nested_in_hole = true;
                    break;
                }
            }
            if nested_in_hole {
                continue;
            }

            let mut hole_ring = candidate.0.clone();
            if ring_signed_area(&hole_ring) > 0.0 {
                hole_ring.reverse();
            }
            polygon.push(hole_ring);
            assigned[j] = true;
        }

        polygons.push(polygon);
    }

    polygons
}

fn contours_for_threshold(field: &Field<'_>, threshold: f64, compare_lt: bool) -> Vec<Line> {
    let mut segments = Vec::new();

    for j in 0..field.nj.saturating_sub(1) {
        for i in 0..field.ni.saturating_sub(1) {
            let mut corner_values = [0.0; 4];
            let mut corners = [[0.0; 2]; 4];
            let mut valid = true;

            for (c, &(dx, dy)) in CORNER_OFFSETS.iter().enumerate() {
                let value = sample_field_value(i as isize + dx as isize, j as isize + dy as isize, field);
                if !value.is_finite() {
                    valid = false;
                    break;
                }
                corner_values[c] = value;
                corners[c] = cell_lat_lon(i + dx, j + dy, field);
            }

            if !valid {
                continue;
            }

            let mut case_index = 0usize;
            for c in 0..4 {
                let inside = if compare_lt {
                    corner_values[c] < threshold
                } else {
                    corner_values[c] > threshold
                };
                if inside {
                    case_index |= 1 << c;
                }
            }

            if case_index == 0 || case_index == 15 {
                continue;
            }

            for &(e0, e1) in MS_SEGMENTS[case_index] {
                if let (Some(p0), Some(p1)) = (
                    edge_point(e0, &corner_values, &corners, threshold),
                    edge_point(e1, &corner_values, &corners, threshold),
                ) {
                    segments.push((p0, p1));
                }
            }
        }
    }

    stitch_segments(&segments)
}

pub fn build_sector_geojson_json(
    ni: u32,
    nj: u32,
    la1_deg: f64,
    lo1_deg: f64,
    la2_deg: f64,
    lo2_deg: f64,
    di_deg: f64,
    dj_deg: f64,
    scan_mode: u32,
    values: &[f32],
) -> Result<String, String> {
    let ni = ni as usize;
    let nj = nj as usize;
    if ni < 2 || nj < 2 {
        return Err("grid dimensions must be at least 2x2".into());
    }
    if values.len() < ni * nj {
        return Err("values length is smaller than ni * nj".into());
    }

    let field = Field {
        ni,
        nj,
        la1_deg,
        lo1_deg,
        di_deg,
        dj_deg,
        scan_mode,
        values,
    };

    let _ = (la2_deg, lo2_deg);

    let mut features = Vec::new();
    for level in sector_levels() {
        let lines = contours_for_threshold(&field, level.threshold, level.compare_lt);
        let polygons = lines_to_multi_polygon(&lines);
        if polygons.is_empty() {
            continue;
        }
        features.push(Feature {
            kind: "Feature",
            properties: FeatureProperties {
                threshold: level.threshold,
                color: level.color.clone(),
                polygons: polygons.len(),
            },
            geometry: Geometry {
                kind: "MultiPolygon",
                coordinates: polygons,
            },
        });
    }

    let collection = FeatureCollection {
        kind: "FeatureCollection",
        features,
    };

    serde_json::to_string(&collection).map_err(|error| error.to_string())
}
