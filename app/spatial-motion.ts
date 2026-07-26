export type Vec3Tuple = [number, number, number];

export function normalizedTourProgress(now: number, start: number, duration: number) {
  if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, (now - start) / duration));
}

export function clampToSafeHull(position: Vec3Tuple, minimum: Vec3Tuple, maximum: Vec3Tuple): Vec3Tuple {
  return position.map((value, index) => Math.min(maximum[index], Math.max(minimum[index], value))) as Vec3Tuple;
}

export function lookAroundYaw(progress: number) {
  return Math.min(1, Math.max(0, progress)) * Math.PI * 2;
}

export function shortestAngleDelta(from: number, to: number) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function dampedCameraValue(
  current: number,
  target: number,
  response: number,
  deltaSeconds: number,
) {
  if (![current, target, response, deltaSeconds].every(Number.isFinite)) return target;
  if (response <= 0 || deltaSeconds <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-response * deltaSeconds));
}
