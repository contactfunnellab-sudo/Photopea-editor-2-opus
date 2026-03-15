const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '50mb' }));

const ROOT = __dirname;
const PORT = process.env.EXECUTOR_PORT || 3000;

let browser = null;
let executorPage = null;       // legacy feature-swap page
let transferPage = null;       // feature-transfer page (polygon path + transforms)
let geometryPage = null;       // MediaPipe Face Mesh geometry page

const MEDIAPIPE_DEBUG = process.env.MEDIAPIPE_DEBUG === '1';

// Serve executor HTML and static assets
app.use(express.static(ROOT));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    executorReady: !!(executorPage && !executorPage.isClosed()),
    transferReady: !!(transferPage && !transferPage.isClosed()),
    geometryReady: !!(geometryPage && !geometryPage.isClosed()),
    mediapipeDebug: MEDIAPIPE_DEBUG,
    uptime: process.uptime()
  });
});

// Serve local files by absolute path (for n8n source images)
app.get('/api/file', (req, res) => {
  const filePath = String(req.query.path || '');
  if (!filePath || !path.isAbsolute(filePath)) {
    return res.status(400).json({ error: 'path must be absolute' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file not found: ' + filePath });
  }
  res.sendFile(filePath);
});

// Validate executor payload against contract
function validatePayload(payload) {
  const errors = [];

  if (!payload.baseImageUrl) errors.push('baseImageUrl is required');
  if (!payload.referenceImageUrl) errors.push('referenceImageUrl is required');

  if (payload.photopeaOp !== 'feature_swap') {
    errors.push('photopeaOp must be "feature_swap" (got: ' + payload.photopeaOp + ')');
  }

  if (!Array.isArray(payload.featureRegions) || payload.featureRegions.length === 0) {
    errors.push('featureRegions must be a non-empty array');
  } else {
    for (let i = 0; i < payload.featureRegions.length; i++) {
      const r = payload.featureRegions[i];
      for (const k of ['srcX', 'srcY', 'srcWidth', 'srcHeight']) {
        if (typeof r[k] !== 'number' || r[k] < 0) {
          errors.push('featureRegions[' + i + '].' + k + ' must be a non-negative number');
        }
      }
      if (r.srcWidth <= 0 || r.srcHeight <= 0) {
        errors.push('featureRegions[' + i + '] has zero-size region');
      }
      // tgtX/tgtY: optional for backward compat, but if present must be valid
      if (r.tgtX !== undefined && (typeof r.tgtX !== 'number' || r.tgtX < 0)) {
        errors.push('featureRegions[' + i + '].tgtX must be a non-negative number');
      }
      if (r.tgtY !== undefined && (typeof r.tgtY !== 'number' || r.tgtY < 0)) {
        errors.push('featureRegions[' + i + '].tgtY must be a non-negative number');
      }
    }
  }

  const fr = payload.featherRadius;
  if (fr !== undefined && (typeof fr !== 'number' || fr < 0 || fr > 50)) {
    errors.push('featherRadius must be 0-50');
  }

  return errors;
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  browser = await chromium.launch({ headless: false });
}

// Dismiss Photopea's "Start using" splash if visible
async function dismissSplash(page) {
  try {
    const ppFrame = await page.$('#pp');
    if (!ppFrame) return;
    const frame = await ppFrame.contentFrame();
    if (!frame) return;
    const btn = frame.getByRole('button', { name: /start using photopea/i }).first();
    await btn.waitFor({ state: 'visible', timeout: 2500 });
    await btn.click();
    await page.waitForTimeout(1000);
  } catch (_) {
    // Button not visible — Photopea already ready
  }
}

async function getExecutorPage() {
  await ensureBrowser();
  if (!executorPage || executorPage.isClosed()) {
    const context = await browser.newContext();
    executorPage = await context.newPage();
    await executorPage.goto(
      'http://127.0.0.1:' + PORT + '/feature-swap.html',
      { waitUntil: 'domcontentloaded' }
    );
    // Give Photopea iframe time to initialize
    await executorPage.waitForTimeout(4000);
    await dismissSplash(executorPage);
  }
  return executorPage;
}

// Main executor endpoint
app.post('/api/feature-swap', async (req, res) => {
  const startTime = Date.now();

  try {
    const payload = req.body;

    // Detailed request logging
    const reqId = payload.requestId || 'no-id';
    console.log('[feature-swap] requestId=' + reqId +
      ' | baseImageUrl=' + (payload.baseImageUrl || '').substring(0, 80) +
      ' | referenceImageUrl=' + (payload.referenceImageUrl || '').substring(0, 80) +
      ' | regions=' + (Array.isArray(payload.featureRegions) ? payload.featureRegions.length : 0) +
      ' | featherRadius=' + (payload.featherRadius || 12));
    if (Array.isArray(payload.featureRegions)) {
      payload.featureRegions.forEach(function(r, i) {
        console.log('[feature-swap]   region[' + i + '] src=(' + r.srcX + ',' + r.srcY + ' ' + r.srcWidth + 'x' + r.srcHeight + ')' +
          ' tgt=(' + (r.tgtX !== undefined ? r.tgtX : 'n/a') + ',' + (r.tgtY !== undefined ? r.tgtY : 'n/a') + ')');
      });
    }

    // Validate against contract
    const errors = validatePayload(payload);
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: errors,
        logs: ['VALIDATION FAILED: ' + errors.join('; ')]
      });
    }

    const page = await getExecutorPage();
    await dismissSplash(page);

    // Execute the feature swap in the browser context
    let result;
    try {
      result = await page.evaluate(async function(p) {
        return window.runFeatureSwap(p);
      }, {
        baseImageUrl: payload.baseImageUrl,
        referenceImageUrl: payload.referenceImageUrl,
        featureRegions: payload.featureRegions,
        featherRadius: payload.featherRadius || 12,
        exportFormat: payload.exportFormat || 'png'
      });
    } catch (firstErr) {
      // Retry once after dismissing splash (Photopea may have shown it mid-run)
      await dismissSplash(page);
      result = await page.evaluate(async function(p) {
        return window.runFeatureSwap(p);
      }, {
        baseImageUrl: payload.baseImageUrl,
        referenceImageUrl: payload.referenceImageUrl,
        featureRegions: payload.featureRegions,
        featherRadius: payload.featherRadius || 12,
        exportFormat: payload.exportFormat || 'png'
      });
    }

    // Clean up documents for next request
    await page.evaluate(function() { return window.cleanup(); }).catch(function() {});

    const durationMs = Date.now() - startTime;
    const outputBytes = result.imageBase64 ? Math.round(result.imageBase64.length * 3 / 4) : 0;
    console.log('[feature-swap] SUCCESS requestId=' + reqId +
      ' | duration=' + durationMs + 'ms' +
      ' | outputSize=' + Math.round(outputBytes / 1024) + 'KB');

    res.json({
      success: true,
      imageBase64: result.imageBase64,
      psdBase64: result.psdBase64,
      logs: result.logs,
      durationMs: durationMs
    });

  } catch (error) {
    // Reset executor page on failure so next request gets a fresh state
    if (executorPage && !executorPage.isClosed()) {
      await executorPage.evaluate(function() { return window.cleanup(); }).catch(function() {});
    }
    executorPage = null;

    res.status(500).json({
      success: false,
      error: error.message,
      logs: ['EXECUTOR ERROR: ' + error.message],
      durationMs: Date.now() - startTime
    });
  }
});

// =============================================
// MediaPipe Geometry — Browser-side Face Mesh
// for deterministic eye landmark detection
//
// RESPONSE SCHEMA HISTORY:
//   Old format: result.eyeGeometry = { transform, confidence, featherRadius,
//     source: { rawPoints, pathPoints, boundingBox },
//     target: { rawPoints, pathPoints, boundingBox } }
//   New format (canonical): result.features = [
//     { name: 'left_eye', source: {...}, target: {...},
//       placementTransform: {...}, recommendedBlend: {...} },
//     { name: 'right_eye', ... } ]
//
// The old format returned a single merged eye band. The new format returns
// separate per-eye primitives with per-eye transforms. The server previously
// crashed on the new format because success-path logging assumed
// result.eyeGeometry always existed (TypeError: reading 'transform' of undefined).
//
// normalizeGeometryResult() handles both schemas safely for logging/validation.
// =============================================

/**
 * Normalize a geometry result into a consistent summary for logging and
 * validation, regardless of whether the response uses the old eyeGeometry
 * schema or the new features[] schema.
 *
 * Returns { schema, featureCount, summary, confidence } or throws with
 * a clear message if neither schema is usable.
 */
function normalizeGeometryResult(result) {
  // Case 1: New per-eye features[] format (canonical, preferred)
  if (Array.isArray(result.features) && result.features.length > 0) {
    const summaries = result.features.map(f => {
      const t = f.placementTransform || {};
      return f.name + ': scale=' + (t.scale || 1) +
        ' rot=' + (t.rotation !== undefined ? (Math.round(t.rotation * 180 / Math.PI * 10) / 10) + 'deg' : '0') +
        ' tx=' + (t.translateX || 0) + ' ty=' + (t.translateY || 0);
    });
    return {
      schema: 'features',
      featureCount: result.features.length,
      summary: summaries.join(' | '),
      confidence: result.confidence
    };
  }

  // Case 2: Old merged eyeGeometry format (legacy)
  if (result.eyeGeometry) {
    const eg = result.eyeGeometry;
    const t = eg.transform || {};
    return {
      schema: 'eyeGeometry',
      featureCount: 1,
      summary: 'merged-band: scale=' + (t.scale || 1) +
        ' rot=' + (t.rotation || 0) + ' tx=' + (t.translateX || 0) + ' ty=' + (t.translateY || 0) +
        ' feather=' + (eg.featherRadius || 'n/a') +
        ' srcBox=' + JSON.stringify((eg.source && eg.source.boundingBox) || {}) +
        ' tgtBox=' + JSON.stringify((eg.target && eg.target.boundingBox) || {}),
      confidence: eg.confidence
    };
  }

  // Case 3: Neither schema present — this is a malformed success payload
  return null;
}

async function getGeometryPage() {
  await ensureBrowser();
  if (!geometryPage || geometryPage.isClosed()) {
    const context = await browser.newContext();
    geometryPage = await context.newPage();
    // Set debug flag before loading page
    await geometryPage.addInitScript('window.MEDIAPIPE_DEBUG = ' + (MEDIAPIPE_DEBUG ? 'true' : 'false') + ';');
    await geometryPage.goto(
      'http://127.0.0.1:' + PORT + '/mediapipe-geometry.html',
      { waitUntil: 'domcontentloaded' }
    );
    // Wait for MediaPipe WASM + model to initialize
    console.log('[geometry] Waiting for MediaPipe to initialize...');
    await geometryPage.waitForFunction('window.mediapipeReady === true', { timeout: 120000 });
    console.log('[geometry] MediaPipe ready.');
  }
  return geometryPage;
}

app.post('/api/geometry/eye-transfer', async (req, res) => {
  const startTime = Date.now();
  try {
    const { baseImageUrl, referenceImageUrl, targetFaceHint, referenceFaceHint, requestId } = req.body;
    const reqId = requestId || 'no-id';

    if (!baseImageUrl || !referenceImageUrl) {
      return res.status(400).json({ success: false, error: 'baseImageUrl and referenceImageUrl are required' });
    }

    console.log('[geometry] requestId=' + reqId +
      ' | baseUrl=' + (baseImageUrl || '').substring(0, 80) +
      ' | refUrl=' + (referenceImageUrl || '').substring(0, 80) +
      ' | baseFaceHint=' + (targetFaceHint || 'largest') +
      ' | refFaceHint=' + (referenceFaceHint || 'largest') +
      ' | debug=' + MEDIAPIPE_DEBUG);

    const page = await getGeometryPage();

    const result = await page.evaluate(async function(params) {
      return window.detectEyeGeometry(
        params.baseUrl, params.refUrl,
        params.baseFaceHint, params.refFaceHint
      );
    }, {
      baseUrl: baseImageUrl,
      refUrl: referenceImageUrl,
      baseFaceHint: targetFaceHint || 'largest',
      refFaceHint: referenceFaceHint || 'largest'
    });

    result.durationMs = Date.now() - startTime;

    if (result.success) {
      // Normalize handles both old eyeGeometry and new features[] schemas safely.
      // Without this, logging code would crash when the geometry page returns
      // the new features[] format (eyeGeometry would be undefined).
      const norm = normalizeGeometryResult(result);

      if (!norm) {
        // success=true but neither schema is present — treat as failure
        // so the workflow gets a clear error instead of empty data
        console.log('[geometry] MALFORMED requestId=' + reqId +
          ' | success=true but payload missing both features[] and eyeGeometry' +
          ' | keys=' + Object.keys(result).join(',') +
          ' | duration=' + result.durationMs + 'ms');
        result.success = false;
        result.error = 'Geometry success payload missing both eyeGeometry and features. Keys: ' + Object.keys(result).join(', ');
      } else {
        const det = result.detections || {};
        console.log('[geometry] SUCCESS requestId=' + reqId +
          ' | schema=' + norm.schema +
          ' | features=' + norm.featureCount +
          ' | baseFaces=' + (det.baseFaces || '?') +
          ' | refFaces=' + (det.referenceFaces || '?') +
          ' | chosenBase=' + (det.chosenBaseFaceIndex !== undefined ? det.chosenBaseFaceIndex : '?') +
          ' | chosenRef=' + (det.chosenReferenceFaceIndex !== undefined ? det.chosenReferenceFaceIndex : '?') +
          ' | ' + norm.summary +
          ' | confidence=' + (norm.confidence || '?') +
          ' | duration=' + result.durationMs + 'ms');
      }
    } else {
      console.log('[geometry] FAILED requestId=' + reqId + ' | error=' + result.error +
        ' | duration=' + result.durationMs + 'ms');
    }

    res.json(result);

  } catch (error) {
    // Reset geometry page on failure
    if (geometryPage && !geometryPage.isClosed()) {
      geometryPage = null;
    }
    const durationMs = Date.now() - startTime;
    console.error('[geometry] ERROR:', error.message, '| duration=' + durationMs + 'ms');
    res.status(500).json({
      success: false,
      error: error.message,
      durationMs: durationMs
    });
  }
});

// =============================================
// Preview Regions — Landmark-aware previews
// with face detection, eye landmarks, patch boxes
// =============================================

app.post('/api/preview-regions', async (req, res) => {
  try {
    const { baseImageUrl, referenceImageUrl, geometryData, saveTo } = req.body;

    if (!baseImageUrl || !referenceImageUrl) {
      return res.status(400).json({ success: false, error: 'baseImageUrl and referenceImageUrl are required' });
    }

    const { renderPreview } = require('./lib/preview');

    // Fetch both images
    const [baseBuffer, refBuffer] = await Promise.all([
      fetchImageBuffer(baseImageUrl),
      fetchImageBuffer(referenceImageUrl)
    ]);

    // Build preview data for each role — per-eye layout
    const gd = geometryData || {};
    const baseGeoData = {
      allFaces: gd.allBaseFaces || [],
      selectedFaceIdx: gd.selectedBaseFaceIdx,
      leftEyeLandmarks: gd.baseLeftEyeLandmarks || [],
      rightEyeLandmarks: gd.baseRightEyeLandmarks || [],
      leftEyeBox: gd.leftEyeTargetBox || null,
      rightEyeBox: gd.rightEyeTargetBox || null,
      leftTransform: gd.leftTransform || null,
      rightTransform: gd.rightTransform || null
    };
    const refGeoData = {
      allFaces: gd.allRefFaces || [],
      selectedFaceIdx: gd.selectedRefFaceIdx,
      leftEyeLandmarks: gd.refLeftEyeLandmarks || [],
      rightEyeLandmarks: gd.refRightEyeLandmarks || [],
      leftEyeBox: gd.leftEyeSourceBox || null,
      rightEyeBox: gd.rightEyeSourceBox || null,
      leftTransform: null,
      rightTransform: null
    };

    // Render annotated previews
    const [basePreview, refPreview] = await Promise.all([
      renderPreview(baseBuffer, 'base', baseGeoData),
      renderPreview(refBuffer, 'reference', refGeoData)
    ]);

    const result = { success: true };

    // Save to disk if saveTo directory provided
    if (saveTo) {
      if (!fs.existsSync(saveTo)) fs.mkdirSync(saveTo, { recursive: true });
      const basePath = path.join(saveTo, 'preview_base.png');
      const refPath = path.join(saveTo, 'preview_reference.png');
      fs.writeFileSync(basePath, basePreview);
      fs.writeFileSync(refPath, refPreview);
      result.basePreviewPath = basePath;
      result.referencePreviewPath = refPath;
      console.log('[preview] Saved previews to ' + saveTo);
    }

    result.basePreviewBase64 = basePreview.toString('base64');
    result.referencePreviewBase64 = refPreview.toString('base64');

    res.json(result);
  } catch (error) {
    console.error('[preview] ERROR:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// NEW: Face Landmarks Primitive Endpoint
// =============================================

/**
 * Fetch an image from a URL and return its buffer.
 */
function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode + ' fetching ' + url));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout fetching ' + url)); });
  });
}

app.post('/api/primitives/face-landmarks', async (req, res) => {
  const startTime = Date.now();
  try {
    const { baseImageUrl, referenceImageUrl, features, outputMode, targetFaceHint, includeRawLandmarks } = req.body;

    if (!baseImageUrl || !referenceImageUrl) {
      return res.status(400).json({ success: false, error: 'baseImageUrl and referenceImageUrl are required' });
    }
    if (!Array.isArray(features) || features.length === 0) {
      return res.status(400).json({ success: false, error: 'features must be a non-empty array' });
    }

    // Fetch images
    const [baseBuffer, refBuffer] = await Promise.all([
      fetchImageBuffer(baseImageUrl),
      fetchImageBuffer(referenceImageUrl)
    ]);

    // Build face landmarks
    const faceLandmarks = require('./lib/face-landmarks');
    const result = await faceLandmarks.build({
      baseImageBuffer: baseBuffer,
      referenceImageBuffer: refBuffer,
      features: features,
      targetFaceHint: targetFaceHint || 'largest',
      includeRawLandmarks: includeRawLandmarks || false
    });

    result.durationMs = Date.now() - startTime;
    res.json(result);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      durationMs: Date.now() - startTime
    });
  }
});

// =============================================
// NEW: Primitives Router (dispatches to face_landmarks, stubs, fallbacks)
// =============================================

app.post('/api/primitives/build', async (req, res) => {
  const startTime = Date.now();
  try {
    const { type, baseImageUrl, referenceImageUrl, features, targetFaceHint, includeRawLandmarks, regions } = req.body;

    if (!type) {
      return res.status(400).json({ success: false, error: 'type is required' });
    }

    const primitives = require('./lib/primitives');

    if (type === 'face_landmarks') {
      if (!baseImageUrl || !referenceImageUrl) {
        return res.status(400).json({ success: false, error: 'baseImageUrl and referenceImageUrl required for face_landmarks' });
      }
      const [baseBuffer, refBuffer] = await Promise.all([
        fetchImageBuffer(baseImageUrl),
        fetchImageBuffer(referenceImageUrl)
      ]);
      const result = await primitives.buildPrimitives(type, {
        baseImageBuffer: baseBuffer,
        referenceImageBuffer: refBuffer,
        features: features || [],
        targetFaceHint: targetFaceHint || 'largest',
        includeRawLandmarks: includeRawLandmarks || false
      });
      result.durationMs = Date.now() - startTime;
      return res.json(result);
    }

    // Fallbacks don't need image fetching
    const result = await primitives.buildPrimitives(type, { regions });
    result.durationMs = Date.now() - startTime;
    res.json(result);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      durationMs: Date.now() - startTime
    });
  }
});

// =============================================
// NEW: Feature Transfer Executor (path-based)
// =============================================

async function getTransferPage() {
  await ensureBrowser();
  if (!transferPage || transferPage.isClosed()) {
    const context = await browser.newContext();
    transferPage = await context.newPage();
    await transferPage.goto(
      'http://127.0.0.1:' + PORT + '/feature-transfer.html',
      { waitUntil: 'domcontentloaded' }
    );
    await transferPage.waitForTimeout(4000);
    await dismissSplash(transferPage);
  }
  return transferPage;
}

function validateTransferPayload(payload) {
  const errors = [];
  if (!payload.baseImageUrl) errors.push('baseImageUrl is required');
  if (!payload.referenceImageUrl) errors.push('referenceImageUrl is required');
  if (payload.photopeaOp !== 'feature_transfer') {
    errors.push('photopeaOp must be "feature_transfer" (got: ' + payload.photopeaOp + ')');
  }
  if (!Array.isArray(payload.selectionPrimitives) || payload.selectionPrimitives.length === 0) {
    errors.push('selectionPrimitives must be a non-empty array');
  } else {
    for (let i = 0; i < payload.selectionPrimitives.length; i++) {
      const p = payload.selectionPrimitives[i];
      if (!p.type) errors.push('selectionPrimitives[' + i + '].type is required');
      if (!p.source || !Array.isArray(p.source.points) || p.source.points.length < 3) {
        errors.push('selectionPrimitives[' + i + '].source.points must have >= 3 points');
      }
      if (!p.target || !Array.isArray(p.target.points) || p.target.points.length < 3) {
        errors.push('selectionPrimitives[' + i + '].target.points must have >= 3 points');
      }
      if (p.blend) {
        if (p.blend.featherRadius !== undefined && (p.blend.featherRadius < 0 || p.blend.featherRadius > 50)) {
          errors.push('selectionPrimitives[' + i + '].blend.featherRadius must be 0-50');
        }
      }
    }
  }
  return errors;
}

app.post('/api/feature-transfer', async (req, res) => {
  const startTime = Date.now();
  try {
    const payload = req.body;
    const reqId = payload.requestId || 'no-id';

    // Log transfer request details
    console.log('[feature-transfer] requestId=' + reqId +
      ' | baseUrl=' + (payload.baseImageUrl || '').substring(0, 80) +
      ' | refUrl=' + (payload.referenceImageUrl || '').substring(0, 80) +
      ' | primitives=' + (Array.isArray(payload.selectionPrimitives) ? payload.selectionPrimitives.length : 0));
    if (Array.isArray(payload.selectionPrimitives)) {
      payload.selectionPrimitives.forEach(function(p, i) {
        const t = p.placementTransform || {};
        console.log('[feature-transfer]   prim[' + i + '] label=' + (p.label || '?') +
          ' srcPts=' + (p.source && p.source.points ? p.source.points.length : 0) +
          ' scale=' + (t.scale || 1) + ' rot=' + (t.rotation || 0) +
          ' tx=' + (t.translateX || 0) + ' ty=' + (t.translateY || 0) +
          ' feather=' + (p.blend && p.blend.featherRadius || 'n/a'));
      });
    }

    const errors = validateTransferPayload(payload);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors, logs: ['VALIDATION FAILED: ' + errors.join('; ')] });
    }

    const page = await getTransferPage();
    await dismissSplash(page);

    let result;
    try {
      result = await page.evaluate(async function(p) {
        return window.runFeatureTransfer(p);
      }, {
        baseImageUrl: payload.baseImageUrl,
        referenceImageUrl: payload.referenceImageUrl,
        selectionPrimitives: payload.selectionPrimitives,
        exportFormat: payload.exportFormat || 'png',
        debugExport: payload.debugExport !== false
      });
    } catch (firstErr) {
      await dismissSplash(page);
      result = await page.evaluate(async function(p) {
        return window.runFeatureTransfer(p);
      }, {
        baseImageUrl: payload.baseImageUrl,
        referenceImageUrl: payload.referenceImageUrl,
        selectionPrimitives: payload.selectionPrimitives,
        exportFormat: payload.exportFormat || 'png',
        debugExport: payload.debugExport !== false
      });
    }

    await page.evaluate(function() { return window.cleanup(); }).catch(function() {});

    const durationMs = Date.now() - startTime;
    const outputBytes = result.imageBase64 ? Math.round(result.imageBase64.length * 3 / 4) : 0;
    console.log('[feature-transfer] SUCCESS requestId=' + reqId +
      ' | duration=' + durationMs + 'ms' +
      ' | outputSize=' + Math.round(outputBytes / 1024) + 'KB');

    res.json({
      success: true,
      imageBase64: result.imageBase64,
      psdBase64: result.psdBase64 || null,
      logs: result.logs,
      durationMs: durationMs
    });

  } catch (error) {
    if (transferPage && !transferPage.isClosed()) {
      await transferPage.evaluate(function() { return window.cleanup(); }).catch(function() {});
    }
    transferPage = null;
    res.status(500).json({
      success: false,
      error: error.message,
      logs: ['EXECUTOR ERROR: ' + error.message],
      durationMs: Date.now() - startTime
    });
  }
});

// =============================================

app.listen(PORT, async () => {
  console.log('Photopea MVP Executor running at http://127.0.0.1:' + PORT);
  console.log('');
  console.log('Active MVP Endpoints:');
  console.log('  POST /api/geometry/eye-transfer       — MediaPipe browser-side eye geometry');
  console.log('  POST /api/feature-transfer            — path-based Photopea execution (scale+rot)');
  console.log('  POST /api/preview-regions             — landmark-aware preview rendering');
  console.log('  GET  /api/health                      — health check');
  console.log('');
  console.log('Legacy/Fallback Endpoints:');
  console.log('  POST /api/feature-swap                — ellipse-based execution (no transforms)');
  console.log('  POST /api/primitives/face-landmarks   — tfjs-node landmarks (may fail on Windows)');
  console.log('  POST /api/primitives/build            — primitive router');
  console.log('');
  console.log('MEDIAPIPE_DEBUG=' + (MEDIAPIPE_DEBUG ? 'ON' : 'OFF'));
  console.log('First run may be slower due to MediaPipe model download.');
  try {
    await ensureBrowser();
    console.log('Browser launched. Ready for requests.');
  } catch (e) {
    console.error('Failed to launch browser:', e.message);
    console.error('Install Playwright browsers: npx playwright install chromium');
  }
});
