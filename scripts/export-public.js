#!/usr/bin/env node
'use strict'

// Builds the open-source copy of this repo (NFR-07).
//   node scripts/export-public.js <empty destination folder>
//
// The private repo is the working copy; the public repo gets one clean
// snapshot per release, with no git history. This script:
//  1. copies every tracked file except the private-only paths below;
//  2. drops the private sections of CLAUDE.md, swaps in the public README and
//     points the plugin manifest's links at the public repo and site;
//  3. scans every copied text file against .public-export/denylist.txt (one
//     regular expression per line, case-insensitive; the list itself is never
//     exported) and exits 1, listing each hit, if anything personal is left.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PUBLIC_REPO = 'https://github.com/buildproven/retirerunway'
const PUBLIC_SITE = 'https://retirerunway.buildproven.ai'

// Private-only paths: owner notes, agent state, the owner's deploy job and
// superseded plans that name the owner.
const EXCLUDE = [
  '.public-export/',
  '.claude/',
  '.buildproven/',
  'docs/archive/',
  '.github/workflows/deploy.yml',
  'tsconfig.tsbuildinfo',
]

// CLAUDE.md headings whose sections (to the next same-level heading) are
// about the owner's own setup.
const PRIVATE_SECTIONS = ['## Sibling app sync']

function isExcluded(file) {
  return EXCLUDE.some(entry =>
    entry.endsWith('/') ? file.startsWith(entry) : file === entry
  )
}

function dropSections(text, headings) {
  const lines = text.split('\n')
  const out = []
  let skipping = false
  for (const line of lines) {
    const heading = /^(#{1,6}) /.exec(line)
    if (heading) {
      const level = heading[1].length
      if (headings.some(start => line.trim().startsWith(start))) {
        skipping = true
        continue
      }
      if (skipping && level <= 2) skipping = false
    }
    if (!skipping) out.push(line)
  }
  return out
    .join('\n')
    .replace(/\n{3,}$/, '\n\n')
    .replace(/\s+$/, '\n')
}

function publicPlugin(text) {
  // Replace the link values in place so the file keeps its formatting.
  const links = {
    homepage: PUBLIC_SITE,
    repository: PUBLIC_REPO,
    privacyPolicyUrl: `${PUBLIC_SITE}/#privacy`,
  }
  let out = text
  for (const [key, value] of Object.entries(links))
    out = out.replace(
      new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`),
      (_, prefix) => `${prefix}"${value}"`
    )
  JSON.parse(out)
  return out
}

function loadDenylist(root) {
  const file = path.join(root, '.public-export/denylist.txt')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(pattern => new RegExp(pattern, 'i'))
}

function isText(buffer) {
  return !buffer.subarray(0, 8000).includes(0)
}

function scan(dest, patterns) {
  const hits = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const buffer = fs.readFileSync(full)
      if (!isText(buffer)) continue
      const lines = buffer.toString('utf8').split('\n')
      lines.forEach((line, index) => {
        for (const pattern of patterns) {
          if (pattern.test(line))
            hits.push(
              `${path.relative(dest, full)}:${index + 1}: matches /${pattern.source}/`
            )
        }
      })
    }
  }
  walk(dest)
  return hits
}

function exportPublic(root, dest) {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0)
    throw new Error(`${dest} is not empty`)
  fs.mkdirSync(dest, { recursive: true })
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(file => file !== '' && !isExcluded(file))
  for (const file of files) {
    const source = path.join(root, file)
    if (!fs.existsSync(source)) continue
    const target = path.join(dest, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.lstatSync(source).isSymbolicLink())
      fs.symlinkSync(fs.readlinkSync(source), target)
    else fs.copyFileSync(source, target)
  }
  const claude = path.join(dest, 'CLAUDE.md')
  if (fs.existsSync(claude))
    fs.writeFileSync(
      claude,
      dropSections(fs.readFileSync(claude, 'utf8'), PRIVATE_SECTIONS)
    )
  const readme = path.join(root, '.public-export/README.md')
  if (fs.existsSync(readme))
    fs.copyFileSync(readme, path.join(dest, 'README.md'))
  const plugin = path.join(dest, '.claude-plugin/plugin.json')
  if (fs.existsSync(plugin))
    fs.writeFileSync(plugin, publicPlugin(fs.readFileSync(plugin, 'utf8')))
  return { files: files.length, hits: scan(dest, loadDenylist(root)) }
}

module.exports = { dropSections, exportPublic, isExcluded, publicPlugin, scan }

if (require.main === module) {
  const dest = process.argv[2]
  if (!dest) {
    console.error('usage: node scripts/export-public.js <empty folder>')
    process.exit(2)
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()
  const { files, hits } = exportPublic(root, path.resolve(dest))
  if (hits.length > 0) {
    console.error(`Denylist hits (${hits.length}):`)
    for (const hit of hits) console.error(`  ${hit}`)
    process.exit(1)
  }
  console.log(`Exported ${files} files to ${dest}; denylist clean.`)
}
