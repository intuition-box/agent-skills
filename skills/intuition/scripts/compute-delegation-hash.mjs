#!/usr/bin/env node
// compute-delegation-hash.mjs — the AUTHORITATIVE digest/authority reader.
//
// Usage:
//   node compute-delegation-hash.mjs <signed-delegation.json>
//   node compute-delegation-hash.mjs <signed-delegation.json> --rpc <url>
//
// Emits JSON on stdout:
//   { structHash, domainHash, digest, delegationHash, disabled, delegator,
//     delegatorHasCode, erc1271, valid }
//
// WHY THIS READS THE CHAIN INSTEAD OF RECOMPUTING OFF-CHAIN:
// the DelegationManager's struct hash uses a non-standard Caveat[] packing.
// Any hand-rolled keccak of the struct is a guess. `getDelegationHash()` and
// `getDomainHash()` ARE the definition. Read them.
//
// (The previous version of this file was an .mjs that called require() — a
// ReferenceError on every run — and computed the hash off-chain, which is
// precisely the fragility this file exists to avoid. Found by the Mission 12
// fresh-agent B2 test.)

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// ethers resolves from the Termux home node_modules (verified); do NOT hardcode a
// path here — `node -e "require.resolve('ethers')"` is the way to find it.
const ethers = require('ethers');

const DM = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const DEFAULT_RPC = 'https://testnet.rpc.intuition.systems/http';
const MAGIC = '0x1626ba7e';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const i = args.indexOf('--rpc');
const rpc = i >= 0 ? args[i + 1] : DEFAULT_RPC;

if (!file) {
  console.error('Usage: node compute-delegation-hash.mjs <signed-delegation.json> [--rpc <url>]');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, 'utf8'));
const d = raw.delegation ?? raw;

const provider = new ethers.JsonRpcProvider(rpc);
const dm = new ethers.Contract(DM, [
  'function getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)) view returns (bytes32)',
  'function getDomainHash() view returns (bytes32)',
  'function disabledDelegations(bytes32) view returns (bool)',
], provider);

// POSITIONAL tuple, matching the proven scripts (redeem-delegation.cjs,
// verify-caveat-admission.mjs). The named-object form throws
// "array is wrong length" under this ethers build — use positional.
const tuple = [
  d.delegate,
  d.delegator,
  d.authority,
  (d.caveats || []).map(c => [c.enforcer, c.terms, c.args ?? '0x']),
  BigInt(d.salt),
  d.signature || '0x',
];

const structHash = await dm.getDelegationHash(tuple);
const domainHash = await dm.getDomainHash();
const digest = ethers.keccak256(ethers.concat(['0x1901', domainHash, structHash]));

const code = await provider.getCode(d.delegator);
const delegatorHasCode = code && code !== '0x';

let erc1271 = null, valid = null;
try {
  const erc = new ethers.Contract(d.delegator, ['function isValidSignature(bytes32,bytes) view returns (bytes4)'], provider);
  erc1271 = await erc.isValidSignature(digest, d.signature || '0x');
  valid = erc1271 === MAGIC;
} catch (e) {
  erc1271 = 'ERROR: ' + (e.shortMessage || e.message || '').slice(0, 120);
}

const disabled = await dm.disabledDelegations(structHash);

console.log(JSON.stringify({
  file,
  chainId: Number((await provider.getNetwork()).chainId),
  delegate: d.delegate,
  delegator: d.delegator,
  delegatorHasCode,
  structHash,
  domainHash,
  digest,
  delegationHash: structHash,
  disabled,
  erc1271,
  valid,
}, null, 2));