import assert from "node:assert/strict";
import test from "node:test";
import {
  clampToSafeHull,
  dampedCameraValue,
  lookAroundYaw,
  normalizedTourProgress,
  shortestAngleDelta,
} from "../app/spatial-motion.ts";

test("tour progress clamps and handles invalid durations", () => {
  assert.equal(normalizedTourProgress(50, 100, 100), 0);
  assert.equal(normalizedTourProgress(150, 100, 100), 0.5);
  assert.equal(normalizedTourProgress(250, 100, 100), 1);
  assert.equal(normalizedTourProgress(100, 100, 0), 1);
});

test("safe hull clamps all translation axes", () => {
  assert.deepEqual(
    clampToSafeHull([4, -2, 0.1], [-0.42, -0.18, -0.54], [0.42, 0.18, 0.24]),
    [0.42, -0.18, 0.1],
  );
});

test("360 look-around is continuous and finishes one revolution", () => {
  assert.equal(lookAroundYaw(-1), 0);
  assert.equal(lookAroundYaw(0.5), Math.PI);
  assert.equal(lookAroundYaw(2), Math.PI * 2);
  assert.ok(Math.abs(shortestAngleDelta(Math.PI * 1.9, Math.PI * 0.1) - Math.PI * 0.2) < 1e-10);
});

test("camera damping is frame-rate independent and never overshoots", () => {
  const oneFrame = dampedCameraValue(0, 1, 18, 1 / 60);
  const twoHalfFrames = dampedCameraValue(
    dampedCameraValue(0, 1, 18, 1 / 120),
    1,
    18,
    1 / 120,
  );
  assert.ok(oneFrame > 0 && oneFrame < 1);
  assert.ok(Math.abs(oneFrame - twoHalfFrames) < 1e-12);
  assert.equal(dampedCameraValue(0.4, 1, 18, 0), 0.4);
});
