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

test("optional mask stays above the airport cone", () => {
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

test("optional mask can step around a ridge already raised in the cone", () => {
  const width = 3;
  const height = 3;
  const terrain = new Float32Array(9).fill(0);
  const altitudes = new Float32Array(9).fill(150);
  altitudes[1 * width + 1] = 400;
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

import { ridgeEscapeSeed } from "./ridge-escape.js";

function coneDem(width, height, cellSizeM = 100) {
  return { width, height, cellSizeM };
}

test("above the cone keeps the glider as the options seed", () => {
  const decision = ridgeEscapeSeed({
    dem: coneDem(3, 1),
    altitudes: new Float32Array([100, 200, 300]),
    originX: new Int32Array([0, 0, 1]),
    originY: new Int32Array([0, 0, 0]),
    ground: new Uint32Array([0, 1, 1]),
    maxAltitude: 5000,
    gi: 2,
    gj: 0,
    startAlt: 400,
    glideRatio: 10,
  });
  assert.equal(decision.kind, "normal");
});

test("below the cone with an air next cell has no options", () => {
  const decision = ridgeEscapeSeed({
    dem: coneDem(2, 1),
    altitudes: new Float32Array([100, 2080]),
    originX: new Int32Array([0, 0]),
    originY: new Int32Array([0, 0]),
    ground: new Uint32Array([0, 1]),
    maxAltitude: 5000,
    gi: 1,
    gj: 0,
    startAlt: 2000,
    glideRatio: 20,
  });
  assert.equal(decision.kind, "none");
});

test("escape seed is the last ground cell when the glide arrives above it", () => {
  const decision = ridgeEscapeSeed({
    dem: coneDem(3, 1, 400),
    altitudes: new Float32Array([1800, 1950, 2080]),
    originX: new Int32Array([0, 0, 1]),
    originY: new Int32Array([0, 0, 0]),
    ground: new Uint32Array([0, 1, 1]),
    maxAltitude: 5000,
    gi: 2,
    gj: 0,
    startAlt: 2000,
    glideRatio: 20,
  });
  assert.equal(decision.kind, "escape");
  assert.equal(decision.gi, 1);
  assert.equal(decision.gj, 0);
  assert.ok(decision.arrival > 1950);
  assert.equal(decision.cells.length, 2);
});

test("no options when the glide is still below the last ground cell", () => {
  const decision = ridgeEscapeSeed({
    dem: coneDem(3, 1, 1000),
    altitudes: new Float32Array([1800, 1950, 2080]),
    originX: new Int32Array([0, 0, 1]),
    originY: new Int32Array([0, 0, 0]),
    ground: new Uint32Array([0, 1, 1]),
    maxAltitude: 5000,
    gi: 2,
    gj: 0,
    startAlt: 1960,
    glideRatio: 20,
  });
  assert.equal(decision.kind, "none");
});
