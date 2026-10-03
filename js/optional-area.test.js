import assert from "node:assert/strict";
import test from "node:test";
import { buildOptionalMask } from "./optional-area-mask.js";

function demOf(width, height, terrain, cellSizeM = 100) {
  return {
    width,
    height,
    cellSizeM,
    groundClearance: 100,
    terrainMsl: terrain,
    elevation: terrain.map((value) => value + 100),
  };
}

test("optional mask stays above ground clearance and the airport cone", () => {
  const width = 5;
  const height = 1;
  const terrain = new Float32Array([0, 0, 0, 0, 500]);
  const altitudes = new Float32Array([200, 220, 240, 260, 280]);
  const mask = buildOptionalMask({
    dem: demOf(width, height, terrain),
    altitudes,
    maxAltitude: 5000,
    gi: 0,
    gj: 0,
    startAlt: 300,
    glideRatio: 10,
    groundClearance: 100,
  });

  assert.equal(mask[0], 1);
  assert.equal(mask[1], 1);
  assert.equal(mask[2], 1);
  assert.equal(mask[3], 1);
  assert.equal(mask[4], 0);
});

test("optional mask can step around a ridge that blocks the straight cell", () => {
  const width = 3;
  const height = 3;
  const terrain = new Float32Array(9).fill(0);
  terrain[1 * width + 1] = 400;
  const altitudes = new Float32Array(9).fill(150);
  const mask = buildOptionalMask({
    dem: demOf(width, height, terrain, 100),
    altitudes,
    maxAltitude: 5000,
    gi: 0,
    gj: 1,
    startAlt: 250,
    glideRatio: 10,
    groundClearance: 100,
  });

  assert.equal(mask[1 * width + 0], 1);
  assert.equal(mask[1 * width + 1], 0);
  assert.equal(mask[1 * width + 2], 1);
});

test("no emulated altitude leaves the mask empty", () => {
  const terrain = new Float32Array([0]);
  const mask = buildOptionalMask({
    dem: demOf(1, 1, terrain),
    altitudes: new Float32Array([100]),
    maxAltitude: 5000,
    gi: 0,
    gj: 0,
    startAlt: Number.NaN,
    glideRatio: 25,
    groundClearance: 100,
  });
  assert.equal(mask[0], 0);
});
