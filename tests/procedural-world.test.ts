import assert from "node:assert/strict";
import test from "node:test";

import {
  canEnterPortal,
  completionCoverage,
  completionDisclosure,
  nextPortalPhase,
  renderedCaptureEvidence,
  roomAfterPortalAction,
  roomProvenanceLabel,
  uniqueCaptureCount,
  videoSampleFractions,
} from "../app/procedural-world.ts";

test("capture evidence counts only unique rendered frames and caps work at eight", () => {
  assert.equal(uniqueCaptureCount(["a", "a", "b", ""]), 2);
  assert.deepEqual(
    renderedCaptureEvidence(["same", "same", "different"], 3),
    { rendered: 3, unique: 2, observedPercent: 18, registration: "unregistered" },
  );
  assert.deepEqual(
    renderedCaptureEvidence(["a", "b", "c", "d", "e", "f", "g", "h", "never-rendered"], 12),
    { rendered: 8, unique: 8, observedPercent: 36, registration: "unregistered" },
  );
  assert.equal(completionCoverage(18), 82);
});

test("registered panoramas and procedural rooms have independent provenance", () => {
  assert.equal(
    renderedCaptureEvidence(["pano"], 1, true).observedPercent,
    100,
  );
  assert.equal(
    roomProvenanceLabel({
      room: 2,
      sourceLabel: "Doorway continuation",
      renderedCaptures: 0,
      uniqueCaptures: 0,
      observedPercent: 0,
      registration: "procedural",
      completion: "procedural-local",
    }),
    "Room 02 · local procedural completion · 0% observed",
  );
});

test("doorway generation has an explicit gated state machine", () => {
  let phase = nextPortalPhase("idle", "approach");
  assert.equal(phase, "threshold");
  phase = nextPortalPhase(phase, "generate");
  assert.equal(phase, "generating");
  assert.equal(canEnterPortal(phase), false);
  phase = nextPortalPhase(phase, "finish");
  assert.equal(phase, "ready");
  assert.equal(canEnterPortal(phase), true);
  assert.equal(nextPortalPhase(phase, "reset"), "idle");
  assert.equal(roomAfterPortalAction(1, "enter", "generating"), 1);
  assert.equal(roomAfterPortalAction(1, "enter", "ready"), 2);
  assert.equal(roomAfterPortalAction(2, "return", "ready"), 1);
});

test("videos yield multiple temporal samples instead of one poster frame", () => {
  assert.deepEqual(videoSampleFractions(12), [0.08, 0.32, 0.58, 0.84]);
  assert.deepEqual(videoSampleFractions(1), [0.12, 0.48, 0.82]);
  assert.ok(new Set(videoSampleFractions(12)).size > 1);
});

test("completion disclosures distinguish local fill from provider output", () => {
  assert.equal(
    completionDisclosure(35, false),
    "35% rendered source footprint · 65% deterministic local fill · views unregistered · non-metric",
  );
  assert.equal(
    completionDisclosure(35, true),
    "35% rendered source footprint · 65% provider-completed context · views unregistered · non-metric",
  );
});
