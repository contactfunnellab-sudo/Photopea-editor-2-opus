const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '50mb' }));

const ROOT = __dirname;
const PORT = process.env.EXECUTOR_PORT || 3000;

let browser = null;
let executorPage = null;

// Serve executor HTML and static assets
app.use(express.static(ROOT));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    executorReady: !!(executorPage && !executorPage.isClosed()),
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

app.listen(PORT, async () => {
  console.log('Feature Swap Executor running at http://127.0.0.1:' + PORT);
  console.log('API endpoint: POST http://127.0.0.1:' + PORT + '/api/feature-swap');
  console.log('Health check: GET http://127.0.0.1:' + PORT + '/api/health');
  try {
    await ensureBrowser();
    console.log('Browser launched. Ready for requests.');
  } catch (e) {
    console.error('Failed to launch browser:', e.message);
    console.error('Install Playwright browsers: npx playwright install chromium');
  }
});
