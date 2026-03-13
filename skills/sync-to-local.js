#!/usr/bin/env node
/**
 * Syncs .mb skill files from the repo to the local n8n skills directory.
 * Run: node skills/sync-to-local.js
 *
 * Source: skills/ in this repo (canonical)
 * Target: D:\Reddit PS automation\n8n-assets\skills\
 */

const fs = require('fs');
const path = require('path');

const REPO_SKILLS = path.join(__dirname);
const LOCAL_SKILLS = 'D:\\Reddit PS automation\\n8n-assets\\skills';

function syncFile(relPath) {
  const src = path.join(REPO_SKILLS, relPath);
  const dst = path.join(LOCAL_SKILLS, relPath);

  if (!fs.existsSync(src)) {
    console.log('  SKIP (not found): ' + relPath);
    return;
  }

  const dstDir = path.dirname(dst);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }

  fs.copyFileSync(src, dst);
  console.log('  SYNC: ' + relPath + ' -> ' + dst);
}

console.log('Syncing .mb skills from repo to local n8n...');
console.log('Source: ' + REPO_SKILLS);
console.log('Target: ' + LOCAL_SKILLS);
console.log('');

const files = [
  'photopea_editing.mb',
  'categories/face_body_fix.mb',
  'categories/combine_swap.mb',
  'categories/general.mb'
];

for (const f of files) {
  syncFile(f);
}

console.log('\nDone. ' + files.length + ' files synced.');
