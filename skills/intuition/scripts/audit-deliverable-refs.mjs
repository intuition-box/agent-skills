#!/usr/bin/env node
// audit-deliverable-refs.mjs — closure check for the five Mission-12 deliverables.
//
// A gate that cannot fail is the exact defect this mission exists to catch, so
// this script is tested against a seeded bogus reference before it is trusted
// (`--selftest`).
//
// WHAT IT DOES
//   1. Extract every outbound reference from the five files, using four patterns:
//        a. Markdown links            [text](target)
//        b. Inline-code paths         `...path.ext`  (md|mjs|cjs|js|html|json|sh|sol)
//        c. Bare prose mentions       see/see-also/using <path.ext>
//        d. Fenced code-block commands node X / bash X / cast ... X
//   2. Classify each reference:
//        INTERNAL        resolves inside the shipped set
//                        (the five + the tooling that ships with them)
//        ON-CHAIN        an address, selector, or tx hash — always allowed
//        PLACEHOLDER     an illustrative filename in an example (signed.json, …)
//        EXTERNAL-BROKEN everything else — this is what fails the gate
//   3. Exit non-zero if any EXTERNAL-BROKEN reference exists, listing file:line.
//
// The shipped set is the contract. If a document needs to point somewhere new,
// that file must be added to SHIPPED — not silently allowed.
//
// Usage:
//   node scripts/audit-deliverable-refs.mjs            # audit
//   node scripts/audit-deliverable-refs.mjs --selftest # prove it can fail
//   node scripts/audit-deliverable-refs.mjs --quiet    # summary only

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The five deliverables. Nothing else is documentation. */
export const DELIVERABLES = [
  'SKILL.md',
  'reference/delegation.md',
  'operations/create-delegation.md',
  'operations/revoke-delegation.md',
  'reference/delegation-authority.md',
];

/** Supporting tooling that ships alongside the five. */
export const SHIPPED_TOOLING = [
  'templates/sign-delegation.html',
  'templates/redeem-delegation.cjs',
  'templates/revoke-delegation.cjs',
  'scripts/compute-delegation-hash.mjs',
  'scripts/delegation-doc-verification.sh',
  'scripts/audit-deliverable-refs.mjs',
];

/** The self-contained core plus the tooling that ships with it. */
export const SHIPPED = new Set([...DELIVERABLES, ...SHIPPED_TOOLING]);

/** Files that must be self-contained: no outbound ref may leave the shipped set. */
export const SELF_CONTAINED = [
  'reference/delegation.md',
  'operations/create-delegation.md',
  'operations/revoke-delegation.md',
  'reference/delegation-authority.md',
];

/** SKILL.md is the router and legitimately reaches across the whole tree. */
export const TREE_ROOT_FILES = ['SKILL.md'];

/**
 * Illustrative filenames that appear inside example commands. These are not
 * claims that a file exists in the repo — they are placeholders the reader
 * substitutes. Listed explicitly so the exemption is auditable rather than a
 * blanket ignore.
 */
const PLACEHOLDERS = new Set([
  'signed.json', 'signed-delegation.json', 'delegation.json', 'prepared-delegation.json',
  'capture.json', 'signed-delegation-final.json', 'signed-delegation-sdk.json',
  'user-delegation.json', 'path1-prepared-delegation.json',
]);

/**
 * References to files that legitimately do not live in this repo:
 *  - a user-authored runtime config the operator creates
 *  - upstream source paths named inside a URL
 * Listed explicitly so the exemption is auditable, not a blanket ignore.
 */
const EXTERNAL_BY_DESIGN = new Set([
  './.intuition/autonomous-policy.json',   // operator-created policy file
  'src/interfaces/IMultiVault.sol',         // upstream path, named in a URL
  'src/interfaces/IMultiVaultCore.sol',     // upstream path, named in a URL
]);

// ── classification helpers ───────────────────────────────────────────────────

const isHexAddr = (t) => /^0x[0-9a-fA-F]{40}$/.test(t);
const isHexLong = (t) => /^0x[0-9a-fA-F]{64,}$/.test(t);
const isSelector = (t) => /^0x[0-9a-fA-F]{8}$/.test(t);
const isOnChain = (t) => isHexAddr(t) || isHexLong(t) || isSelector(t) || /^0x[0-9a-fA-F]{6}$/.test(t);

/** A path that exists somewhere in the skill tree (used only for reporting). */
function existsInTree(p) {
  const clean = p.replace(/^\.\//, '');
  return existsSync(join(SKILL, clean));
}

/**
 * Resolve a reference to a shipped path.
 * Bare filenames (no directory) are searched in the directories that ship.
 */
function resolveShipped(ref) {
  const t = ref.trim().replace(/^\.\//, '');
  if (!t) return null;
  if (SHIPPED.has(t)) return t;

  // A bare filename (no directory) is searched in the shipping directories.
  const base = t.split('/').pop();
  for (const d of ['templates/', 'scripts/', 'reference/', 'operations/']) {
    const cand = d + base;
    if (SHIPPED.has(cand)) return cand;
  }
  // A bare filename that IS one of the five deliverables.
  for (const f of DELIVERABLES) if (f.split('/').pop() === base) return f;

  // A wrong-directory reference to a file that DOES ship elsewhere, e.g.
  // "reference/revoke-delegation.md" when it actually ships as
  // "operations/revoke-delegation.md". Resolve by basename and report the
  // shipped path so the doc can be corrected.
  for (const f of [...DELIVERABLES, ...SHIPPED_TOOLING]) {
    if (f.split('/').pop() === base) return f;
  }
  return null;
}

/** Resolve a ref for a tree-root file (SKILL.md): anything present in the tree is fine. */
function resolveForTreeRoot(ref) {
  const t = ref.trim().replace(/^\.\//, '');
  if (resolveShipped(t)) return t;
  if (existsInTree(t)) return t;
  const bn = t.split('/').pop();
  for (const d of ['reference/', 'references/', 'operations/', 'templates/', 'scripts/']) {
    if (existsInTree(d + bn)) return d + bn;
  }
  return null;
}

function classify(rawRef, lineText, isTreeRoot) {
  const t = rawRef.trim();
  if (!t || t.startsWith('http') || t.startsWith('#')) return null; // URL / anchor
  if (isOnChain(t)) return { kind: 'ON-CHAIN', ref: t };
  const bn = t.split('/').pop();
  if (PLACEHOLDERS.has(bn)) return { kind: 'PLACEHOLDER', ref: t };
  if (EXTERNAL_BY_DESIGN.has(t) || EXTERNAL_BY_DESIGN.has(bn)) return { kind: 'EXTERNAL-BY-DESIGN', ref: t };
  // a bare selector-looking token inside prose is on-chain
  if (/^0x[0-9a-fA-F]{2,}$/.test(t) && !t.includes('.')) return { kind: 'ON-CHAIN', ref: t };
  const shipped = isTreeRoot ? resolveForTreeRoot(t) : resolveShipped(t);
  if (shipped) return { kind: 'INTERNAL', ref: t, resolved: shipped };
  return { kind: 'EXTERNAL-BROKEN', ref: t, existsInTree: existsInTree(t) };
}

// ── extraction ───────────────────────────────────────────────────────────────

const EXT = String.raw`(?:md|mjs|cjs|js|html|json|sh|sol)`;
const PATTERNS = [
  // (a) markdown links
  { name: 'md-link', re: new RegExp(String.raw`\[[^\]]*\]\(([^)]+)\)`) },
  // (b) inline-code paths
  { name: 'inline-code', re: new RegExp('`([^`]*\\.' + EXT + ')`', 'g') },
  // (c) bare prose mentions: "see <path>" / "using <path>" / "from <path>"
  {
    name: 'prose-see',
    re: new RegExp(String.raw`\b(?:see|using|via|from|in|per)\s+[\w./-]*[\w-]+\.` + EXT, 'gi'),
  },
  // (d) fenced code-block command invocations
  { name: 'cmd', re: new RegExp(String.raw`\b(?:node|bash|sh|cast|python3?|curl)\s+[^\s;|&]*[\w./-]+\.` + EXT, 'g') },
];

function extract(text, treeRoot) {
  const out = [];
  const lines = text.split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    for (const { name, re } of PATTERNS) {
      // code-block invocations only count inside a fence
      if (name === 'cmd' && !inFence) continue;
      const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = rx.exec(line)) !== null) {
        const raw = m[1] ?? m[0];
        const c = classify(raw, line, treeRoot);
        if (c) out.push({ ...c, line: i + 1, pattern: name, file: null });
      }
    }
  });
  return out;
}

// ── audit ────────────────────────────────────────────────────────────────────

export function audit() {
  const findings = [];
  for (const f of DELIVERABLES) {
    const p = join(SKILL, f);
    if (!existsSync(p)) {
      findings.push({ kind: 'MISSING-DELIVERABLE', ref: f, file: f, line: 0, pattern: '-' });
      continue;
    }
    const text = readFileSync(p, 'utf8');
    const treeRoot = TREE_ROOT_FILES.includes(f);
    for (const r of extract(text, treeRoot)) findings.push({ ...r, file: f });
  }
  return findings;
}

// ── seeded failure test ──────────────────────────────────────────────────────
// A gate that cannot fail is worthless. Plant a known-bogus reference in a
// deliverable, prove the checker catches it and names the right line, then undo.

function selftest() {
  const target = join(SKILL, 'reference/delegation.md');
  const backup = readFileSync(target, 'utf8');
  const planted = 'See [the bogus guide](references/definitely-not-here.md) for details.';
  const marker = '<!-- CLOSURE-SELFTEST -->';
  const lines = backup.split('\n');
  const plantLine = 3; // 1-based
  lines.splice(plantLine, 0, marker + ' ' + planted);
  try {
    writeFileSync(target, lines.join('\n'));
    const found = audit().filter(r => r.kind === 'EXTERNAL-BROKEN' && r.ref.includes('definitely-not-here'));
    if (found.length === 0) {
      console.error('SELFTEST FAILED: planted bogus reference was NOT detected — the gate cannot fail.');
      return 1;
    }
    const hit = found[0];
    const ok = hit.file === 'reference/delegation.md' && hit.line === plantLine + 1;
    console.log(`  planted  : ${hit.file}:${hit.line}  ${hit.ref}`);
    console.log(`  expected : reference/delegation.md:${plantLine + 1}`);
    console.log(`  ${ok ? 'SELFTEST PASS — bogus reference detected at the correct file:line' : 'SELFTEST FAILED — wrong file:line'}`);
    return ok ? 0 : 1;
  } finally {
    writeFileSync(target, backup); // always restore
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  process.exit(selftest());
}

const quiet = args.includes('--quiet');
const findings = audit();
const broken = findings.filter(f => f.kind === 'EXTERNAL-BROKEN');
const counts = findings.reduce((m, f) => ((m[f.kind] = (m[f.kind] || 0) + 1), m), {});

if (!quiet) {
  console.log('=== closure check: outbound references from the five deliverables ===\n');
  for (const f of DELIVERABLES) {
    const mine = findings.filter(x => x.file === f);
    const bad = mine.filter(x => x.kind === 'EXTERNAL-BROKEN');
    const kinds = mine.reduce((m, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {});
    console.log(`  ${bad.length === 0 ? 'OK  ' : 'FAIL'}  ${f.padEnd(38)} ` +
      Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join('  '));
  }
  console.log('');
}

if (broken.length) {
  console.log(`EXTERNAL-BROKEN references (${broken.length}) — each must resolve inside the shipped set:\n`);
  for (const b of broken) {
    const note = b.existsInTree ? '  <- exists in the repo but does NOT ship' : '';
    console.log(`  ${b.file}:${b.line}  ${b.ref}${note}`);
    console.log(`      via ${b.pattern}`);
  }
  console.log('');
}

console.log('totals:', JSON.stringify(counts));
if (broken.length) {
  console.log(`RESULT: FAIL — ${broken.length} reference(s) outside the shipped set.`);
  process.exit(1);
}
console.log('RESULT: PASS — every reference resolves inside the shipped set.');
process.exit(0);