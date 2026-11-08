// The production image runs npm run build, and so the blog prerender, in the
// Dockerfile's build stage. The prerender uses jsdom, which needs a newer
// Node than the 20 line (it calls Promise.withResolvers). This guards the
// build stage's Node tag against jsdom's declared minimum.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const require = createRequire(join(ROOT, 'package.json'))

const parse = (v) => v.split('.').map((n) => Number(n))
const atLeast = (have, need) => {
  for (let i = 0; i < need.length; i++) {
    const h = have[i] ?? 0
    if (h !== need[i]) return h > need[i]
  }
  return true
}

function buildStageNode() {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  const from = dockerfile.match(/^FROM\s+node:(\d+(?:\.\d+){0,2})[^\s]*\s+AS\s+build\b/im)
  return from && from[1]
}

// jsdom's lowest supported version on the build stage's major line, from
// an engines range like "^22.22.2 || ^24.15.0 || >=26.0.0".
function jsdomMinimumFor(major) {
  const { engines } = require('jsdom/package.json')
  const versions = [...engines.node.matchAll(/(\d+\.\d+\.\d+)/g)].map((m) => parse(m[1]))
  const onLine = versions.find((v) => v[0] === major)
  return onLine || versions.find((v) => v[0] > major)
}

describe('Dockerfile build stage Node version', () => {
  it('pins node with an explicit major and minor', () => {
    const tag = buildStageNode()
    expect(tag, 'FROM node:<major>.<minor>... AS build').toMatch(/^\d+\.\d+/)
  })

  it("meets jsdom's minimum Node version, so the prerender can run", () => {
    const have = parse(buildStageNode())
    const need = jsdomMinimumFor(have[0])
    expect(need, `jsdom supports no Node ${have[0]} release`).toBeTruthy()
    // A bare major.minor tag floats over patches; compare at that precision
    // only when the minimum's patch is all that differs.
    const needed = have.length === 2 && need[0] === have[0] && need[1] < have[1] ? need.slice(0, 2) : need
    expect(atLeast(have, needed), `node:${have.join('.')} is below jsdom's ${need.join('.')}`).toBe(true)
  })
})
