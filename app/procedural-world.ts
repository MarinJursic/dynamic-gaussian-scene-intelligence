export type PortalPhase = "idle" | "threshold" | "generating" | "ready";
export type Registration = "registered-panorama" | "unregistered" | "procedural";

export type RoomProvenance = {
  room: 1 | 2;
  sourceLabel: string;
  renderedCaptures: number;
  uniqueCaptures: number;
  observedPercent: number;
  registration: Registration;
  completion: "none" | "deterministic-local" | "provider" | "procedural-local";
};

export const GENERATION_STEPS = [
  "Reading doorway context",
  "Completing hidden directions",
  "Building a bounded navigation cell",
  "Checking the threshold",
] as const;

export function uniqueCaptureCount(signatures: string[]) {
  return new Set(signatures.filter(Boolean)).size;
}

export function renderedCaptureEvidence(
  signatures: string[],
  renderedCaptures: number,
  registeredPanorama = false,
) {
  const rendered = Math.min(8, Math.max(0, Math.floor(renderedCaptures)));
  const unique = Math.min(rendered, uniqueCaptureCount(signatures.slice(0, rendered)));
  if (registeredPanorama) {
    return { rendered, unique, observedPercent: unique > 0 ? 100 : 0, registration: "registered-panorama" as const };
  }
  // Unknown images and sampled video frames do not carry solved camera poses.
  // Treat extra unique frames as additional evidence, never angular coverage.
  const observedPercent = unique === 0 ? 0 : Math.min(36, 14 + (unique - 1) * 4);
  return { rendered, unique, observedPercent, registration: "unregistered" as const };
}

export function completionCoverage(observed: number) {
  return 100 - Math.min(100, Math.max(0, observed));
}

export function nextPortalPhase(
  phase: PortalPhase,
  action: "approach" | "generate" | "finish" | "reset",
): PortalPhase {
  if (action === "reset") return "idle";
  if (action === "approach" && phase === "idle") return "threshold";
  if (action === "generate" && phase === "threshold") return "generating";
  if (action === "finish" && phase === "generating") return "ready";
  return phase;
}

export function completionDisclosure(
  observed: number,
  providerUsed: boolean,
  registration: Registration = "unregistered",
) {
  const completed = completionCoverage(observed);
  const registrationLabel = registration === "registered-panorama"
    ? "registered panorama"
    : registration === "procedural"
      ? "procedural room"
      : "views unregistered";
  if (providerUsed) {
    return `${observed}% rendered source footprint · ${completed}% provider-completed context · ${registrationLabel} · non-metric`;
  }
  return `${observed}% rendered source footprint · ${completed}% deterministic local fill · ${registrationLabel} · non-metric`;
}

export function roomProvenanceLabel(room: RoomProvenance) {
  if (room.registration === "registered-panorama") {
    return `Room ${String(room.room).padStart(2, "0")} · registered 360° source`;
  }
  if (room.registration === "procedural") {
    return `Room ${String(room.room).padStart(2, "0")} · local procedural completion · 0% observed`;
  }
  return `Room ${String(room.room).padStart(2, "0")} · ${room.uniqueCaptures}/${room.renderedCaptures} unique rendered captures · unregistered`;
}

export function canEnterPortal(phase: PortalPhase) {
  return phase === "ready";
}

export function videoSampleFractions(durationSeconds: number) {
  return Number.isFinite(durationSeconds) && durationSeconds > 1.5
    ? [0.08, 0.32, 0.58, 0.84]
    : [0.12, 0.48, 0.82];
}

export function roomAfterPortalAction(
  current: 1 | 2,
  action: "enter" | "return",
  phase: PortalPhase,
): 1 | 2 {
  if (action === "enter") return phase === "ready" ? 2 : current;
  return 1;
}
