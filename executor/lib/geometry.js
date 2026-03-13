'use strict';

/**
 * Geometry conversion: MediaPipe landmarks → Photopea-friendly polygon paths.
 *
 * V1 = polygon path selection (NOT bezier). Contract field: "polygon_path".
 * Future: "bezier_path" with true pen-style handles.
 *
 * Per-feature smoothing rules:
 *   eyes:     expandPx=2, chaikin=1 (preserve corners, very light)
 *   brows:    expandPx=2, chaikin=1 (light)
 *   lips:     expandPx=3, chaikin=2 (moderate)
 *   face_oval: expandPx=4, chaikin=3 (more smoothing OK)
 */

// Per-feature defaults
const FEATURE_DEFAULTS = {
  left_eye:      { expandPx: 2, chaikinIterations: 1, featherRadius: 5, smoothPx: 1 },
  right_eye:     { expandPx: 2, chaikinIterations: 1, featherRadius: 5, smoothPx: 1 },
  left_eyebrow:  { expandPx: 2, chaikinIterations: 1, featherRadius: 5, smoothPx: 1 },
  right_eyebrow: { expandPx: 2, chaikinIterations: 1, featherRadius: 5, smoothPx: 1 },
  lips:          { expandPx: 3, chaikinIterations: 2, featherRadius: 7, smoothPx: 2 },
  face_oval:     { expandPx: 4, chaikinIterations: 3, featherRadius: 9, smoothPx: 3 }
};

/**
 * Compute centroid of a point set.
 */
function centroid(points) {
  let sx = 0, sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  return [sx / points.length, sy / points.length];
}

/**
 * Expand points outward from centroid by `px` pixels.
 */
function expandPoints(points, px) {
  if (px <= 0 || points.length === 0) return points.slice();
  const [cx, cy] = centroid(points);

  return points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return [x, y]; // point at centroid, skip
    const scale = (dist + px) / dist;
    return [cx + dx * scale, cy + dy * scale];
  });
}

/**
 * Chaikin corner-cutting subdivision for polygon smoothing.
 * Each iteration replaces each edge with two new points at 25% and 75%.
 * Produces a smoother polygon while preserving the general shape.
 */
function chaikinSmooth(points, iterations) {
  if (iterations <= 0 || points.length < 3) return points.slice();

  let pts = points.slice();
  for (let iter = 0; iter < iterations; iter++) {
    const smoothed = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      smoothed.push([0.75 * x1 + 0.25 * x2, 0.75 * y1 + 0.25 * y2]);
      smoothed.push([0.25 * x1 + 0.75 * x2, 0.25 * y1 + 0.75 * y2]);
    }
    pts = smoothed;
  }
  return pts;
}

/**
 * Ensure points form a closed loop (last point matches first within epsilon).
 */
function ensureClosed(points) {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const dx = first[0] - last[0];
  const dy = first[1] - last[1];
  if (Math.sqrt(dx * dx + dy * dy) > 0.5) {
    return [...points, [first[0], first[1]]];
  }
  return points;
}

/**
 * Round point coordinates to 1 decimal place for Photopea.
 */
function roundPoints(points) {
  return points.map(([x, y]) => [
    Math.round(x * 10) / 10,
    Math.round(y * 10) / 10
  ]);
}

/**
 * Process raw pixel points for a feature into Photopea-ready path points.
 * Applies per-feature expansion + smoothing rules.
 *
 * @param {string} featureName - e.g. "left_eye"
 * @param {number[][]} rawPixelPoints - [[x,y], ...]
 * @param {object} [overrides] - optional override for expandPx, chaikinIterations
 * @returns {number[][]} Processed path points
 */
function processFeature(featureName, rawPixelPoints, overrides) {
  const defaults = FEATURE_DEFAULTS[featureName] || FEATURE_DEFAULTS.left_eye;
  const expandPx = (overrides && overrides.expandPx !== undefined) ? overrides.expandPx : defaults.expandPx;
  const iterations = (overrides && overrides.chaikinIterations !== undefined) ? overrides.chaikinIterations : defaults.chaikinIterations;

  let pts = rawPixelPoints;
  pts = expandPoints(pts, expandPx);
  pts = chaikinSmooth(pts, iterations);
  pts = ensureClosed(pts);
  pts = roundPoints(pts);
  return pts;
}

/**
 * Compute placement transform between source and target feature paths.
 *
 * Translation: centroid delta.
 * Rotation + uniform scale: computed from anchor pairs (first and midpoint),
 * NOT from centroids alone.
 *
 * @param {number[][]} sourcePoints - reference feature path points
 * @param {number[][]} targetPoints - base feature path points
 * @returns {{ translateX, translateY, rotation, scale }}
 */
function computePlacementTransform(sourcePoints, targetPoints) {
  if (sourcePoints.length < 2 || targetPoints.length < 2) {
    const [scx, scy] = centroid(sourcePoints);
    const [tcx, tcy] = centroid(targetPoints);
    return { translateX: tcx - scx, translateY: tcy - scy, rotation: 0, scale: 1.0 };
  }

  const [scx, scy] = centroid(sourcePoints);
  const [tcx, tcy] = centroid(targetPoints);

  // Use first point and midpoint as anchor pair for rotation/scale
  const sMid = Math.floor(sourcePoints.length / 2);
  const tMid = Math.floor(targetPoints.length / 2);

  const sAnchor1 = sourcePoints[0];
  const sAnchor2 = sourcePoints[sMid];
  const tAnchor1 = targetPoints[0];
  const tAnchor2 = targetPoints[tMid];

  // Source vector: anchor1 → anchor2
  const sdx = sAnchor2[0] - sAnchor1[0];
  const sdy = sAnchor2[1] - sAnchor1[1];
  const sDist = Math.sqrt(sdx * sdx + sdy * sdy);
  const sAngle = Math.atan2(sdy, sdx);

  // Target vector: anchor1 → anchor2
  const tdx = tAnchor2[0] - tAnchor1[0];
  const tdy = tAnchor2[1] - tAnchor1[1];
  const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
  const tAngle = Math.atan2(tdy, tdx);

  const rotation = tAngle - sAngle; // radians
  const scale = sDist > 0.001 ? tDist / sDist : 1.0;

  return {
    translateX: Math.round((tcx - scx) * 10) / 10,
    translateY: Math.round((tcy - scy) * 10) / 10,
    rotation: Math.round(rotation * 1000) / 1000, // radians, 3 decimal places
    scale: Math.round(scale * 1000) / 1000
  };
}

/**
 * Get recommended blend settings for a feature type.
 */
function getRecommendedBlend(featureName) {
  const d = FEATURE_DEFAULTS[featureName] || FEATURE_DEFAULTS.left_eye;
  return {
    expandPx: d.expandPx,
    smoothPx: d.smoothPx,
    featherRadius: d.featherRadius
  };
}

module.exports = {
  expandPoints,
  chaikinSmooth,
  ensureClosed,
  roundPoints,
  processFeature,
  computePlacementTransform,
  getRecommendedBlend,
  centroid,
  FEATURE_DEFAULTS
};
