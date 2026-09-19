#!/usr/bin/env node
/**
 * compute-delegation-hash.mjs
 *
 * Compute the Intuition DelegationManager `getDelegationHash` off-chain.
 *
 * Usage:
 *   node compute-delegation-hash.mjs --delegate 0x... --delegator 0x... --authority 0x... --caveats '[{"enforcer":"0x...","terms":"0x..."}]' --salt 123
 *
 * Outputs the 32-byte hex hash. Compare against on-chain `getDelegationHash`.
 *
 * WARNING: This reproduces the MetaMask Delegation Framework's on-chain `getDelegationHash` for comparison only.
 * Off-chain recomputation is fragile; prefer reading `getDelegationHash()` directly from-chain.
 */

const { ethers } = require('ethers');

const DELEGATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes('Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)')
);
const CAVEAT_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes('Caveat(address enforcer,bytes terms)')
);

function getCaveatPacketHash(enforcer, terms) {
  const termsHash = ethers.keccak256(terms);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'bytes32'],
    [CAVEAT_TYPEHASH, enforcer, termsHash]
  );
  return ethers.keccak256(encoded);
}

function getCaveatArrayPacketHash(caveats) {
  if (caveats.length === 0) return ethers.keccak256('0x');
  const hashes = caveats.map(c => getCaveatPacketHash(c.enforcer, c.terms));
  let concatenated = '0x';
  for (const h of hashes) concatenated += h.slice(2);
  return ethers.keccak256(concatenated);
}

function getDelegationHash(delegate, delegator, authority, caveats, salt) {
  const caveatsHash = getCaveatArrayPacketHash(caveats);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
    [DELEGATION_TYPEHASH, delegate, delegator, authority, caveatsHash, salt]
  );
  return ethers.keccak256(encoded);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      params[key] = args[++i];
    }
  }
  return params;
}

const p = parseArgs();
if (!p.delegate || !p.delegator || !p.authority || p.salt === undefined) {
  console.error('Missing required args. Required: --delegate --delegator --authority --salt');
  console.error('Optional: --caveats \'[{"enforcer":"0x...","terms":"0x..."}]\'');
  process.exit(1);
}

const caveats = (p.caveats ? JSON.parse(p.caveats) : []).map(c => ({
  enforcer: c.enforcer,
  terms: c.terms
}));

const hash = getDelegationHash(
  p.delegate,
  p.delegator,
  p.authority,
  caveats,
  BigInt(p.salt)
);

console.log(hash);
