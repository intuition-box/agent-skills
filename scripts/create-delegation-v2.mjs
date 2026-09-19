#!/usr/bin/env node
/**
 * create-delegation-v2.mjs
 *
 * Generate a fresh Intuition ERC-7710 delegation signed with the exact
 * on-chain EIP-712 type hash. Use this when the existing delegation.json
 * was signed with an incorrect type hash and fails on-chain verification.
 *
 * Prerequisites:
 *   - DELEGATOR_PRIVATE_KEY env var set (session-only, never persisted)
 *   - Node.js + ethers v6
 *
 * Usage:
 *   DELEGATOR_PRIVATE_KEY=0x... node scripts/create-delegation-v2.mjs
 *
 * Outputs: delegation-v2.json in the current working directory
 *
 * WARNING: This script signs with the delegator's key. The agent or skill
 * must NEVER persist the delegator private key. Only the agent's own key
 * may be saved to ~/.intuition/agent-wallet.json.
 */

import { ethers } from "ethers";
import fs from "fs";

const DELEGATOR_PK = process.env.DELEGATOR_PRIVATE_KEY;
if (!DELEGATOR_PK) {
  console.error("DELEGATOR_PRIVATE_KEY env var is required");
  process.exit(1);
}

const DELEGATE = "0x51c20B06dbDad041f3B3aF75118e7F23b7326F18";
const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const ALLOWED_METHODS_ENFORCER = "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5";
const LIMITED_CALLS_ENFORCER = "0x04658B29F6b82ed55274221a06Fc97D318E25416";

// --- Read domain hash on-chain ---
const provider = new ethers.JsonRpcProvider("https://rpc.intuition.systems/http");
const dm = new ethers.Contract(DELEGATION_MANAGER, [
  "function getDomainHash() view returns (bytes32)",
], provider);
const domainHash = await dm.getDomainHash();
console.log("On-chain domain hash:", domainHash);

// --- Exact on-chain type hashes (from EncoderLib / Constants.sol) ---
const DELEGATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)")
);
const CAVEAT_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("Caveat(address enforcer,bytes terms)"));

function getCaveatPacketHash(enforcer, terms) {
  const termsHash = ethers.keccak256(terms);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "bytes32"],
    [CAVEAT_TYPEHASH, enforcer, termsHash]
  );
  return ethers.keccak256(encoded);
}

function getCaveatArrayPacketHash(caveats) {
  if (caveats.length === 0) {
    return ethers.keccak256("0x");
  }
  const hashes = caveats.map((c) => getCaveatPacketHash(c.enforcer, c.terms));
  let concatenated = "0x";
  for (const h of hashes) {
    concatenated += h.slice(2);
  }
  return ethers.keccak256(concatenated);
}

function getDelegationHash(delegate, delegator, authority, caveats, salt) {
  const caveatsHash = getCaveatArrayPacketHash(caveats);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "address", "bytes32", "bytes32", "uint256"],
    [DELEGATION_TYPEHASH, delegate, delegator, authority, caveatsHash, BigInt(salt)]
  );
  return ethers.keccak256(encoded);
}

// --- Build delegation ---
const salt = BigInt("0xa318033f7f80633a01a1659be1933982f8582265c86f3ac2414576cab4ec8a94"); // fixed for reproducibility

const allowedMethodsTerms = ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes4[]"],
  [["0x3b694f57", "0xa1448194"]]
);

const limitedCallsTerms = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256"],
  [5]
);

const caveats = [
  { enforcer: ALLOWED_METHODS_ENFORCER, terms: allowedMethodsTerms, args: "0x" },
  { enforcer: LIMITED_CALLS_ENFORCER, terms: limitedCallsTerms, args: "0x" },
];

const delegatorWallet = new ethers.Wallet(DELEGATOR_PK);
const delegatorAddress = delegatorWallet.address;

const delegation = {
  delegator: delegatorAddress,
  delegate: DELEGATE,
  authority: ethers.ZeroHash,
  caveats,
  salt,
  signature: "0x"
};

// --- Compute delegation hash ---
const delegationHash = getDelegationHash(delegation.delegate, delegation.delegator, delegation.authority, delegation.caveats, delegation.salt);
console.log("Delegation hash:", delegationHash);

// --- Sign the digest ---
// The digest to sign is: keccak256("0x1901" ++ domainHash ++ keccak256(DELEGATION_TYPEHASH ++ encodedStruct_without_signature))
const encodedStructWithoutSig = ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes32", "address", "address", "bytes32", "bytes32", "uint256"],
  [DELEGATION_TYPEHASH, delegation.delegate, delegation.delegator, delegation.authority, getCaveatArrayPacketHash(delegation.caveats), delegation.salt]
);
const structHash = ethers.keccak256(encodedStructWithoutSig);
const digestBytes = ethers.concat([ethers.getBytes("0x1901"), ethers.getBytes(domainHash), ethers.getBytes(structHash)]);
const digest = ethers.keccak256(digestBytes);

const signature = await delegatorWallet.signDigest(digest);
delegation.signature = signature;

// --- Verify recovery ---
const recovered = ethers.verifyTypedData(
  { name: "DelegationManager", version: "1", chainId: 1155, verifyingContract: DELEGATION_MANAGER },
  {
    Delegation: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      { name: "caveats", type: "Caveat[]" },
      { name: "salt", type: "uint256" },
    ],
    Caveat: [
      { name: "enforcer", type: "address" },
      { name: "terms", type: "bytes" },
    ]
  },
  {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })),
    salt: delegation.salt,
  },
  signature
);

if (recovered.toLowerCase() !== delegatorAddress.toLowerCase()) {
  throw new Error(`Signature recovery mismatch: expected ${delegatorAddress}, got ${recovered}`);
}
console.log("Signature recovery verified:", recovered);

// --- Verify delegation hash matches on-chain getDelegationHash ---
const onChainHash = await dm.getDelegationHash({
  delegate: delegation.delegate,
  delegator: delegation.delegator,
  authority: delegation.authority,
  caveats: delegation.caveats,
  salt: delegation.salt,
  signature: delegation.signature,
});

console.log("On-chain getDelegationHash:", onChainHash);
console.log("Matches computed hash:", delegationHash === onChainHash);

if (delegationHash !== onChainHash) {
  throw new Error("Hash mismatch - something is wrong");
}

const out = {
  delegation,
  delegationHash,
  domainHash,
  path: "creation_only",
  mainAccount: delegatorAddress,
  caveatSummary: {
    allowedMethods: ["createAtoms(bytes[],uint256[])", "deposit(address,bytes32,uint256,uint256)"],
    maxCalls: 5,
    expiry: null
  }
};

fs.writeFileSync("delegation-v2.json", JSON.stringify(out, null, 2));
console.log("\nSaved delegation-v2.json");
