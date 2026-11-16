// Maps the slider position (0..1) to a volume percentage (0..MAX_VOLUME) and back.
//
// The left half of the slider covers 0–100% on a cubic curve, so the quiet end
// gets most of the precision (e.g. position 0.1 ≈ 0.8%). The right half covers
// 100–600% linearly. 100% sits exactly in the middle.

export const MIN_VOLUME = 0;
export const DEFAULT_VOLUME = 100;
export const MAX_VOLUME = 600;

const MID = 0.5;
const EXPONENT = 3;

export function clampVolume(volume) {
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME;
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, volume));
}

export function positionToVolume(position) {
  const p = Math.min(1, Math.max(0, position));
  if (p <= MID) {
    return DEFAULT_VOLUME * Math.pow(p / MID, EXPONENT);
  }
  return DEFAULT_VOLUME + (MAX_VOLUME - DEFAULT_VOLUME) * ((p - MID) / (1 - MID));
}

export function volumeToPosition(volume) {
  const v = clampVolume(volume);
  if (v <= DEFAULT_VOLUME) {
    return MID * Math.cbrt(v / DEFAULT_VOLUME);
  }
  return MID + (1 - MID) * ((v - DEFAULT_VOLUME) / (MAX_VOLUME - DEFAULT_VOLUME));
}

// Rounds to a precision that fits the magnitude: 0.1 below 10%, whole numbers above.
export function roundVolume(volume) {
  const v = clampVolume(volume);
  return v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
}

// Step used by the −/+ buttons, arrow keys and mouse wheel:
// 0.1 between 0–1%, 1 between 1–10%, 10 between 10–200%, 20 between 200–600%.
export function stepFor(volume, direction) {
  const v = clampVolume(volume);
  // Pick the step based on which side of a boundary we're moving towards,
  // so stepping down from 10 goes to 9 and stepping up from 10 goes to 20.
  if (direction > 0) {
    if (v < 1) return 0.1;
    if (v < 10) return 1;
    if (v < 200) return 10;
    return 20;
  }
  if (v <= 1) return 0.1;
  if (v <= 10) return 1;
  if (v <= 200) return 10;
  return 20;
}

const EPSILON = 1e-9;

// Moves to the next multiple of the step, so off-grid values snap back
// onto it (15% → 20% going up, 10% going down).
export function stepVolume(volume, direction) {
  const v = clampVolume(volume);
  const step = stepFor(v, direction);
  const next =
    direction > 0
      ? (Math.floor(v / step + EPSILON) + 1) * step
      : (Math.ceil(v / step - EPSILON) - 1) * step;
  // Avoid float drift like 0.30000000000000004.
  return clampVolume(Math.round(next * 10) / 10);
}

export function formatVolume(volume) {
  return `${roundVolume(volume)}%`;
}

// Short label that fits the 4-character toolbar badge.
export function badgeText(volume) {
  const v = roundVolume(volume);
  if (v === DEFAULT_VOLUME) return '';
  return v < 1 && v > 0 ? `.${Math.round(v * 10)}` : String(Math.round(v));
}
