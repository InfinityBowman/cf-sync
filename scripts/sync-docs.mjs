#!/usr/bin/env node
// Copies the canonical docs/ set into the package being packed, so the guide and
// API reference ship inside the tarball instead of living only in this repo.
// Consumers — and the coding agents working in their repos — then read the docs
// straight out of node_modules, version-matched to the package they installed.
//
// Runs from each package's `prepack`, where the cwd is the package directory.
// The copies are gitignored; docs/ at the repo root stays the source of truth.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'docs')
const target = join(process.cwd(), 'docs')

if (target === source) {
  throw new Error('sync-docs.mjs must run from a package directory, not the repo root')
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

for (const entry of ['config.json', 'index.md', 'guide', 'reference']) {
  cpSync(join(source, entry), join(target, entry), { recursive: true })
}
