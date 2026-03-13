'use strict';

/**
 * Face landmark detection using @tensorflow-models/face-landmarks-detection
 * with @tensorflow/tfjs-node backend (CPU).
 *
 * Returns actual runtime landmark counts (not hardcoded).
 * Keypoint x/y are pixel-space coordinates.
 * Primary image decode: tf.node.decodeImage(). sharp optional for metadata.
 */

const tf = require('@tensorflow/tfjs-node');
const faceLandmarksDetection = require('@tensorflow-models/face-landmarks-detection');

// Singleton model
let detector = null;
let modelLoading = null;

async function ensureModel() {
  if (detector) return detector;
  if (modelLoading) return modelLoading;

  modelLoading = (async () => {
    console.log('[face-landmarks] Loading MediaPipe FaceMesh model (runtime: tfjs, CPU)...');
    const t0 = Date.now();

    detector = await faceLandmarksDetection.createDetector(
      faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
      {
        runtime: 'tfjs',
        refineLandmarks: true,
        maxFaces: 10
      }
    );

    console.log('[face-landmarks] Model loaded in ' + (Date.now() - t0) + 'ms');
    modelLoading = null;
    return detector;
  })();

  return modelLoading;
}

// MediaPipe FaceMesh feature group indices
const FEATURE_GROUPS = {
  left_eye: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
  right_eye: [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382],
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  left_eyebrow: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  right_eyebrow: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  face_oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
};

/**
 * Decode an image buffer into a tf.Tensor3D using tf.node.decodeImage.
 * Returns { tensor, width, height }. Caller must dispose tensor.
 */
function decodeImage(buffer) {
  const tensor = tf.node.decodeImage(buffer, 3); // force 3 channels (RGB)
  const [height, width] = tensor.shape;
  return { tensor, width, height };
}

/**
 * Detect faces in an image buffer.
 * Returns { faces[], width, height, totalLandmarkCount }
 */
async function detectInBuffer(imageBuffer) {
  const model = await ensureModel();
  const { tensor, width, height } = decodeImage(imageBuffer);

  try {
    const faces = await model.estimateFaces(tensor);
    const totalLandmarkCount = faces.length > 0 ? faces[0].keypoints.length : 0;

    return {
      faces: faces.map((face, idx) => ({
        index: idx,
        keypoints: face.keypoints,
        box: face.box || null
      })),
      width,
      height,
      totalLandmarkCount
    };
  } finally {
    tensor.dispose();
  }
}

/**
 * Select a face from detections based on targetFaceHint.
 */
function selectFace(faces, hint, imageWidth) {
  if (!faces || faces.length === 0) return null;
  if (faces.length === 1) return 0;

  if (typeof hint === 'number') {
    return hint >= 0 && hint < faces.length ? hint : 0;
  }

  switch (hint) {
    case 'leftmost': {
      let minX = Infinity, idx = 0;
      for (let i = 0; i < faces.length; i++) {
        const cx = avgX(faces[i].keypoints);
        if (cx < minX) { minX = cx; idx = i; }
      }
      return idx;
    }
    case 'rightmost': {
      let maxX = -Infinity, idx = 0;
      for (let i = 0; i < faces.length; i++) {
        const cx = avgX(faces[i].keypoints);
        if (cx > maxX) { maxX = cx; idx = i; }
      }
      return idx;
    }
    case 'largest':
    default: {
      let maxArea = 0, idx = 0;
      for (let i = 0; i < faces.length; i++) {
        const area = faceArea(faces[i].keypoints);
        if (area > maxArea) { maxArea = area; idx = i; }
      }
      return idx;
    }
  }
}

function avgX(keypoints) {
  let sum = 0;
  for (const kp of keypoints) sum += kp.x;
  return sum / keypoints.length;
}

function faceArea(keypoints) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const kp of keypoints) {
    if (kp.x < minX) minX = kp.x;
    if (kp.x > maxX) maxX = kp.x;
    if (kp.y < minY) minY = kp.y;
    if (kp.y > maxY) maxY = kp.y;
  }
  return (maxX - minX) * (maxY - minY);
}

/**
 * Extract pixel points for a feature group from a face's keypoints.
 * Returns [[x, y], ...] in pixel space.
 */
function extractFeaturePoints(keypoints, featureName) {
  const indices = FEATURE_GROUPS[featureName];
  if (!indices) throw new Error('Unknown feature: ' + featureName);

  const points = [];
  for (const idx of indices) {
    if (idx < keypoints.length) {
      const kp = keypoints[idx];
      points.push([kp.x, kp.y]);
    }
  }
  return points;
}

/**
 * Main build function — called from the /api/primitives/face-landmarks endpoint.
 *
 * Input: { baseImageBuffer, referenceImageBuffer, features, targetFaceHint, outputMode, includeRawLandmarks }
 * Output: { success, primitiveType, imageMeta, detections, features[] }
 */
async function build(payload) {
  const {
    baseImageBuffer,
    referenceImageBuffer,
    features,
    targetFaceHint = 'largest',
    includeRawLandmarks = false
  } = payload;

  const geometry = require('./geometry');

  // Detect faces in both images
  const [baseResult, refResult] = await Promise.all([
    detectInBuffer(baseImageBuffer),
    detectInBuffer(referenceImageBuffer)
  ]);

  if (baseResult.faces.length === 0) {
    return { success: false, error: 'No face detected in base image' };
  }
  if (refResult.faces.length === 0) {
    return { success: false, error: 'No face detected in reference image' };
  }

  // Select faces
  const baseFaceIdx = selectFace(baseResult.faces, targetFaceHint, baseResult.width);
  const refFaceIdx = selectFace(refResult.faces, targetFaceHint, refResult.width);
  const baseFace = baseResult.faces[baseFaceIdx];
  const refFace = refResult.faces[refFaceIdx];

  // Build per-feature output
  const featureResults = [];

  for (const featureName of features) {
    const basePixelPoints = extractFeaturePoints(baseFace.keypoints, featureName);
    const refPixelPoints = extractFeaturePoints(refFace.keypoints, featureName);

    // Apply per-feature geometry processing
    const basePathPoints = geometry.processFeature(featureName, basePixelPoints);
    const refPathPoints = geometry.processFeature(featureName, refPixelPoints);

    // Compute placement transform from anchor pairs
    const transform = geometry.computePlacementTransform(refPathPoints, basePathPoints);

    // Get recommended blend for this feature type
    const recommendedBlend = geometry.getRecommendedBlend(featureName);

    const featureOut = {
      name: featureName,
      base: {
        rawPointCount: basePixelPoints.length,
        pixelPoints: basePixelPoints,
        pathPoints: basePathPoints
      },
      reference: {
        rawPointCount: refPixelPoints.length,
        pixelPoints: refPixelPoints,
        pathPoints: refPathPoints
      },
      placementTransform: transform,
      recommendedBlend: recommendedBlend
    };

    if (includeRawLandmarks) {
      featureOut.base.featureIndices = FEATURE_GROUPS[featureName];
      featureOut.reference.featureIndices = FEATURE_GROUPS[featureName];
    }

    featureResults.push(featureOut);
  }

  const result = {
    success: true,
    primitiveType: 'face_landmarks',
    imageMeta: {
      base: { width: baseResult.width, height: baseResult.height },
      reference: { width: refResult.width, height: refResult.height }
    },
    detections: {
      baseFaces: baseResult.faces.length,
      referenceFaces: refResult.faces.length,
      baseTotalLandmarks: baseResult.totalLandmarkCount,
      referenceTotalLandmarks: refResult.totalLandmarkCount,
      chosenBaseFaceIndex: baseFaceIdx,
      chosenReferenceFaceIndex: refFaceIdx
    },
    features: featureResults
  };

  if (includeRawLandmarks) {
    result.rawLandmarks = {
      base: baseFace.keypoints.map(kp => ({ x: kp.x, y: kp.y, z: kp.z })),
      reference: refFace.keypoints.map(kp => ({ x: kp.x, y: kp.y, z: kp.z }))
    };
  }

  return result;
}

module.exports = {
  build,
  ensureModel,
  detectInBuffer,
  extractFeaturePoints,
  FEATURE_GROUPS
};
