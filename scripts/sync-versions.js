#!/usr/bin/env node
/**
 * sync-versions.js — propagate root package.json version to all workspaces.
 *
 * Run directly:          node scripts/sync-versions.js
 * Run via npm lifecycle: npm run version:sync
 *
 * Also called automatically by the npm `version` lifecycle hook (defined in
 * root package.json "scripts.version"). This means `npm version patch/minor/major`
 * bumps the root version AND syncs it to all workspace packages in one step,
 * so the git commit created by npm includes all three package.json files.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string} rel */
function readPkg(rel) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'))
}

/** @param {string} rel @param {object} pkg */
function writePkg(rel, pkg) {
  writeFileSync(resolve(ROOT, rel), JSON.stringify(pkg, null, 2) + '\n')
}

const root    = readPkg('package.json')
const version = root.version

/** Workspace package.json paths relative to repo root */
const workspaces = ['gateway/package.json', 'dashboard/package.json']

for (const rel of workspaces) {
  const pkg = readPkg(rel)
  if (pkg.version === version) {
    console.log(`  ✓ ${rel} already at ${version}`)
    continue
  }
  const prev = pkg.version
  pkg.version = version
  writePkg(rel, pkg)
  console.log(`  ✓ ${rel}: ${prev} → ${version}`)
}
