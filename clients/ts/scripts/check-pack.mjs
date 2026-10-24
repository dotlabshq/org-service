#!/usr/bin/env node
// Refuse a tarball that would install broken. 2.1.0 went out with
// `workspace:*` in its dependencies because it was published with npm, which
// does not rewrite them; nobody could install it. This reads the packed
// package.json, the one consumers get, not the one in the repo.
//
//   node scripts/check-pack.mjs <tarball>
import { execFileSync } from 'node:child_process'

const tarball = process.argv[2]
if (!tarball) { console.error('usage: check-pack.mjs <tarball>'); process.exit(2) }

const tar = (...args) => execFileSync('tar', args, { encoding: 'utf8' })
const files = new Set(tar('-tzf', tarball).split('\n').filter(Boolean).map((f) => f.replace(/^package\//, '')))
const pkg = JSON.parse(tar('-xzOf', tarball, 'package/package.json'))
const problems = []

for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, range] of Object.entries(pkg[field] ?? {})) {
    if (/^(workspace|link|file):/.test(range)) problems.push(`${field}.${name} is "${range}"`)
  }
}

// Every export the package promises must be in the tarball.
const targets = []
const walk = (v) => typeof v === 'string' ? targets.push(v) : v && Object.values(v).forEach(walk)
walk(pkg.exports ?? pkg.main)
for (const t of targets) {
  const f = t.replace(/^\.\//, '')
  if (!files.has(f)) problems.push(`export target ${t} is not in the tarball`)
}

if (problems.length) {
  console.error(`✗ ${pkg.name}@${pkg.version} must not be published:\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}
console.log(`✓ ${pkg.name}@${pkg.version}: ${files.size} files, no workspace ranges, ${targets.length} exports present`)
