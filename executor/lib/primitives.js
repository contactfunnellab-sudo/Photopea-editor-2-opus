'use strict';

/**
 * Primitive router. Dispatches to the appropriate geometry builder
 * based on primitive type.
 *
 * Operational:
 *   - face_landmarks (MediaPipe FaceMesh via tfjs-node)
 *   - box_fallback
 *   - ellipse_fallback
 *
 * Stubs (architecture-ready, not implemented):
 *   - pose_landmarks
 *   - segment_mask
 */

// Capability flags — only face_landmarks is operational in v1
const CAPABILITIES = {
  face_landmarks: true,
  pose_landmarks: false,
  segment_mask: false
};

/**
 * Build geometry primitives for a given type.
 *
 * @param {string} type - Primitive type
 * @param {object} payload - { baseImageBuffer, referenceImageBuffer, features, ... }
 * @returns {Promise<object>} Primitive result with selectionPrimitives
 */
async function buildPrimitives(type, payload) {
  // Fallbacks are always available — no capability gating
  if (type === 'box_fallback') return buildBoxFallback(payload);
  if (type === 'ellipse_fallback') return buildEllipseFallback(payload);

  // Detector-based primitives require capability flag
  if (!(type in CAPABILITIES)) {
    throw new Error('UNKNOWN_PRIMITIVE: ' + type);
  }
  if (!CAPABILITIES[type]) {
    throw new Error('NOT_AVAILABLE: ' + type + ' is not capability-flagged in this version');
  }

  switch (type) {
    case 'face_landmarks':
      return require('./face-landmarks').build(payload);

    case 'pose_landmarks':
      // Architecture-ready stub
      throw new Error('NOT_IMPLEMENTED: pose_landmarks is architecture-ready but not implemented. ' +
        'Required: @mediapipe/tasks-vision pose landmarker or equivalent Node.js package.');

    case 'segment_mask':
      // Architecture-ready stub
      throw new Error('NOT_IMPLEMENTED: segment_mask is architecture-ready but not implemented. ' +
        'Required: segmentation model (SAM, DeepLab, or equivalent) for Node.js.');

    default:
      throw new Error('UNKNOWN_PRIMITIVE: ' + type);
  }
}

/**
 * Box fallback — generates a simple bounding box selection.
 * Used when no landmark detector applies.
 */
function buildBoxFallback(payload) {
  // Box fallback expects region hints from the brain
  const { regions } = payload;
  if (!regions || !Array.isArray(regions) || regions.length === 0) {
    throw new Error('box_fallback requires regions array with {x, y, width, height} entries');
  }

  return {
    success: true,
    primitiveType: 'box_fallback',
    features: regions.map(r => ({
      name: r.label || 'region',
      base: {
        rawPointCount: 4,
        pixelPoints: [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]],
        pathPoints: [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]]
      },
      reference: {
        rawPointCount: 4,
        pixelPoints: [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]],
        pathPoints: [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]]
      },
      placementTransform: { translateX: 0, translateY: 0, rotation: 0, scale: 1.0 },
      recommendedBlend: { expandPx: 0, smoothPx: 0, featherRadius: 8 }
    }))
  };
}

/**
 * Ellipse fallback — generates an elliptical polygon selection (48 points).
 * Legacy compatibility only.
 */
function buildEllipseFallback(payload) {
  const { regions } = payload;
  if (!regions || !Array.isArray(regions) || regions.length === 0) {
    throw new Error('ellipse_fallback requires regions array with {cx, cy, rx, ry} entries');
  }

  return {
    success: true,
    primitiveType: 'ellipse_fallback',
    features: regions.map(r => {
      const steps = 48;
      const points = [];
      for (let i = 0; i < steps; i++) {
        const t = (Math.PI * 2 * i) / steps;
        points.push([
          Math.round((r.cx + Math.cos(t) * r.rx) * 10) / 10,
          Math.round((r.cy + Math.sin(t) * r.ry) * 10) / 10
        ]);
      }
      return {
        name: r.label || 'region',
        base: { rawPointCount: steps, pixelPoints: points, pathPoints: points },
        reference: { rawPointCount: steps, pixelPoints: points, pathPoints: points },
        placementTransform: { translateX: 0, translateY: 0, rotation: 0, scale: 1.0 },
        recommendedBlend: { expandPx: 0, smoothPx: 0, featherRadius: 12 }
      };
    })
  };
}

module.exports = {
  buildPrimitives,
  CAPABILITIES,
  buildBoxFallback,
  buildEllipseFallback
};
