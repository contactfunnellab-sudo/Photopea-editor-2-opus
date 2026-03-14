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
let transferPage = null;       // new feature-transfer page

// Serve executor HTML and static assets
app.use(express.static(ROOT));

// Health check
app.get('/api/health', (_req, res) => {
  let primitiveBuilderAvailable = false;
  try { require.resolve('./lib/face-landmarks'); primitiveBuilderAvailable = true; } catch(e) {}
  res.json({
    status: 'ok',
    executorReady: !!(executorPage && !executorPage.isClosed()),
    primitiveBuilderAvailable: primitiveBuilderAvailable,
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

    // Defensive logging
    console.log('[feature-swap] baseImageUrl=' + (payload.baseImageUrl || '').substring(0, 60) +
      ' | referenceImageUrl=' + (payload.referenceImageUrl || '').substring(0, 60) +
      ' | regions=' + (Array.isArray(payload.featureRegions) ? payload.featureRegions.length : 0) +
      ' | featherRadius=' + (payload.featherRadius || 12));

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

    res.json({
      success: true,
      imageBase64: result.imageBase64,
      psdBase64: result.psdBase64,
      logs: result.logs,
      durationMs: Date.now() - startTime
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

    res.json({
      success: true,
      imageBase64: result.imageBase64,
      psdBase64: result.psdBase64 || null,
      logs: result.logs,
      durationMs: Date.now() - startTime
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
  console.log('Photopea Primitive Editor running at http://127.0.0.1:' + PORT);
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /api/primitives/face-landmarks  — detect face landmarks');
  console.log('  POST /api/primitives/build            — primitive router');
  console.log('  POST /api/feature-transfer            — path-based Photopea execution');
  console.log('  POST /api/feature-swap                — legacy ellipse-based execution');
  console.log('  GET  /api/health                      — health check');
  console.log('');
  console.log('First run may be slower due to model/backend initialization.');
  try {
    await ensureBrowser();
    console.log('Browser launched. Ready for requests.');
  } catch (e) {
    console.error('Failed to launch browser:', e.message);
    console.error('Install Playwright browsers: npx playwright install chromium');
  }
});
