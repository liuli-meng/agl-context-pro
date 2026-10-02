#!/usr/bin/env node
/**
 * update-antigravity probe
 *
 * Why this exists: `dir /AL` and `fsutil` cannot reliably resolve the
 * Chinese user path (C:\Users\灵梦\...) when spawned from cmd.exe under a
 * non-UTF8 codepage. Node's fs.lstatSync() handles it correctly.
 *
 * Prints KEY=VALUE lines so update-antigravity.cmd can consume them
 * without any Chinese text passing through the cmd parser.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC_BASE = process.argv[2] || 'D:\\Antigravity';
const APP_DIR = path.join(SRC_BASE, 'app');
const C_LINK = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity');
const PENDING = path.join(os.homedir(), 'AppData', 'Local', 'antigravity-updater', 'pending', 'Antigravity-x64.exe');

function isJunction(p) {
  try {
    const lst = fs.lstatSync(p);
    // A Windows junction reports isSymbolicLink() === true
    if (!lst.isSymbolicLink()) return false;
    // Confirm it actually resolves into a directory (guards against dangling links)
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  } catch {
    return false;
  }
}

function resolveTarget(p) {
  try { return fs.realpathSync(p); } catch { return ''; }
}

function sizeOf(p) {
  try {
    let total = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        try {
          if (e.isDirectory()) walk(f);
          else if (e.isFile()) total += fs.statSync(f).size;
        } catch { /* skip unreadable */ }
      }
    };
    walk(p);
    return total;
  } catch { return -1; }
}

const out = {
  APP_EXISTS: fs.existsSync(path.join(APP_DIR, 'Antigravity.exe')) ? 1 : 0,
  APP_DIR: APP_DIR,
  C_LINK: C_LINK,
  C_EXISTS: fs.existsSync(C_LINK) ? 1 : 0,
  C_IS_JUNCTION: isJunction(C_LINK) ? 1 : 0,
  C_TARGET: resolveTarget(C_LINK),
  PENDING: PENDING,
  PENDING_EXISTS: fs.existsSync(PENDING) ? 1 : 0,
  PENDING_MB: fs.existsSync(PENDING) ? Math.round(fs.statSync(PENDING).size / 1048576) : 0,
  APP_MB: fs.existsSync(APP_DIR) ? Math.round(sizeOf(APP_DIR) / 1048576) : 0,
};

for (const [k, v] of Object.entries(out)) {
  console.log(k + '=' + v);
}
