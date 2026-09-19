import { ethers } from "ethers";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Rebuild a delegation-backed Intuition write transaction.
//
// Produces an unsigned nested tx JSON for `redeemDelegations` targeting the
// DelegationManager, with the inner Intuition operation encoded correctly.
//
// Critical encoding rules (verified against live on-chain AllowedMethodsEnforcer):
//   - execCallData MUST use solidityPacked(address, uint256, bytes),
//     NOT abi.encode(tuple). AllowedMethodsEnforcer.decodeSingle() expects
//     the packed layout.
//   - Permission contexts MUST be full ABI-encoded Delegation[] structs,
//     NOT bare bytes32 hashes.
//   - Selectors are Keccak-256, NOT NIST SHA3-256.
//     Use ethers.id() or `cast sig`, never crypto.createHash('sha3-256').
//   - Domain hash: read getDomainHash() on-chain. If it reverts (mainnet),
//     compute off-chain from NAME="DelegationManager", VERSION="1".
//   - Authority: must equal on-chain ROOT_AUTHORITY (0xffff...ffff).
// ---------------------------------------------------------------------------

// ---------- CONFIG ----------
const DELEGATOR = process.env.DELEGATOR_ADDRESS || "0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee";
const DELEGATE = process.env.DELEGATE_ADDRESS || DELEGATOR;
const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const MULTIVAULT = process.env.MULTIVAULT || "0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91";
const CHAIN_ID = Number(process.env.CHAIN_ID || "13579");
const RPC = process.env.RPC || "https://testnet.rpc.intuition.systems/http";

// Delegation params
const ALLOWED_METHODS_ENFORCER = "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5";
const LIMITED_CALLS_ENFORCER = "0x04658B29F6b82ed55274221a06Fc97D318E25416";

// ---------- HELPERS ----------

async function getOnChainDomainHash() {
  const { execSync } = await import("child_process");
  try {
    return execSync(`cast call ${DELEGATION_MANAGER} "getDomainHash()(bytes32)" --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
  } catch {
    // Fallback for mainnet where getDomainHash reverts via eth_call
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes("DelegationManager"));
    const versionHash = ethers.keccak256(ethers.toUtf8Bytes("1"));
    const typeHash = ethers.keccak256(ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32","bytes32","bytes32","uint256","address"], [typeHash, nameHash, versionHash, CHAIN_ID, DELEGATION_MANAGER])
    );
  }
}

async function getOnChainRootAuthority() {
  const { execSync } = await import("child_process");
  const out = execSync(`cast call ${DELEGATION_MANAGER} "ROOT_AUTHORITY()(bytes32)" --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
  return out;
}

async function getOnChainDelegationHash(delegation) {
  const { execSync } = await import("child_process");
  const encoded = new ethers.AbiCoder().encode(
    ["(address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)"],
    [delegation]
  );
  const out = execSync(
    `cast call ${DELEGATION_MANAGER} "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" "${encoded}" --rpc-url ${RPC}`,
    { encoding: "utf8" }
  ).trim();
  return { computed: ethers.keccak256(encoded), onChain: out };
}

async function getSessionSetup() {
  const { execSync } = await import("child_process");
  const atomCost = execSync(`cast call ${MULTIVAULT} "getAtomCost()(uint256)" --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
  return { atomCost: BigInt(atomCost) };
}

// ---------- MAIN ----------

(async () => {
  const { atomCost } = await getSessionSetup();

  // Read domain hash on-chain first, fallback to constants if reverts
  const domainHash = await getOnChainDomainHash();
  console.log("Domain hash:", domainHash);

  // Read ROOT_AUTHORITY on-chain
  const ROOT_AUTHORITY = await getOnChainRootAuthority();
  console.log("ROOT_AUTHORITY:", ROOT_AUTHORITY);

  // AllowedMethodsEnforcer terms = raw concatenated bytes4 selectors
  const selectors = [
    ethers.id("createAtoms(bytes[],uint256[])").slice(0, 10),
    ethers.id("deposit(address,bytes32,uint256,uint256)").slice(0, 10),
  ];
  const allowedMethodsTerms = ethers.concat(selectors.map((s) => ethers.zeroPad(s, 4)));

  // LimitedCallsEnforcer terms = abi.encode(uint256) — NOT raw bytes
  const limitedCallsTerms = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [5]);

  const caveats = [
    { enforcer: ALLOWED_METHODS_ENFORCER, terms: allowedMethodsTerms, args: "0x" },
    { enforcer: LIMITED_CALLS_ENFORCER, terms: limitedCallsTerms, args: "0x" },
  ];

  const salt = BigInt("0x" + crypto.randomBytes(32).toString("hex"));

  // Standard OpenZeppelin EIP-712 v4 struct hashing (matches on-chain getDelegationHash)
  const DELEGATION_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)"));
  const CAVEAT_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("Caveat(address enforcer,bytes terms)"));

  function caveatPacketHash(enforcer, terms) {
    const termsHash = ethers.keccak256(terms);
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32","address","bytes32"], [CAVEAT_TYPEHASH, enforcer, termsHash])
    );
  }

  function caveatsArrayHash(caveats) {
    const hashes = caveats.map(c => caveatPacketHash(c.enforcer, c.terms));
    let concat = "0x";
    for (const h of hashes) concat += h.slice(2);
    return ethers.keccak256(concat);
  }

  function computeDelegationHash(delegate, delegator, authority, caveats, salt) {
    const enc = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32","address","address","bytes32","bytes32","uint256"],
      [DELEGATION_TYPEHASH, delegate, delegator, authority, caveatsArrayHash(caveats), salt]
    );
    return ethers.keccak256(enc);
  }

  const delegation = {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    authority: ROOT_AUTHORITY,
    caveats,
    salt,
    signature: "0x",
  };

  const delegationHash = computeDelegationHash(delegation.delegate, delegation.delegator, delegation.authority, delegation.caveats, delegation.salt);
  console.log("Computed delegation hash:", delegationHash);

  // Verify on-chain
  const { computed, onChain } = await getOnChainDelegationHash(delegation);
  console.log("On-chain getDelegationHash:", onChain);
  console.log("Hash matches:", computed === onChain);

  // Sign using on-chain domain hash as the EIP-712 domain separator
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32","address","address","bytes32","bytes32","uint256"],
      [DELEGATION_TYPEHASH, delegation.delegate, delegation.delegator, delegation.authority, caveatsArrayHash(delegation.caveats), delegation.salt]
    )
  );
  const digest = ethers.keccak256(ethers.concat(["0x1901", domainHash, structHash]));

  const DELEGATOR_PK = process.env.DELEGATOR_PRIVATE_KEY;
  if (!DELEGATOR_PK) {
    console.error("Set DELEGATOR_PRIVATE_KEY in the environment.");
    process.exit(1);
  }
  const signingKey = new ethers.SigningKey(DELEGATOR_PK.startsWith("0x") ? DELEGATOR_PK : "0x" + DELEGATOR_PK);
  const sig = signingKey.sign(ethers.getBytes(digest)).serialized;
  delegation.signature = sig;

  const recovered = ethers.recoverAddress(digest, sig);
  console.log("Recovered:", recovered);
  console.log("Expected:", DELEGATOR);
  console.log("Signature valid:", recovered.toLowerCase() === DELEGATOR.toLowerCase());

  // Permission context: full ABI-encoded Delegation[] struct array + delegationHash
  const permissionContext = new ethers.AbiCoder().encode(
    [
      "(address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)[]",
      "bytes32"
    ],
    [[delegation], delegationHash]
  );

  // Inner calldata: createAtoms
  const innerIface = new ethers.Interface(["function createAtoms(bytes[],uint256[]) payable returns (bytes32[])"]);
  const atomData = ethers.hexlify(ethers.toUtf8Bytes("caip10:eip155:" + CHAIN_ID + ":" + DELEGATOR + "-lifecycle-" + Date.now()));
  const innerCalldata = innerIface.encodeFunctionData("createAtoms", [[atomData], [atomCost]]);

  // execCallData: MUST use solidityPacked, NOT abi.encode(tuple)
  const execCallData = ethers.solidityPacked(["address","uint256","bytes"], [MULTIVAULT, atomCost, innerCalldata]);

  const MODE_SINGLE_DEFAULT = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const outerIface = new ethers.Interface(["function redeemDelegations(bytes[],bytes32[],bytes[]) external"]);
  const outerCalldata = outerIface.encodeFunctionData("redeemDelegations", [[permissionContext], [MODE_SINGLE_DEFAULT], [execCallData]]);

  const output = {
    to: DELEGATION_MANAGER,
    data: outerCalldata,
    value: "0",
    chainId: CHAIN_ID,
    delegationHash: delegationHash,
    selector: ethers.id("createAtoms(bytes[],uint256[])").slice(0, 10),
    innerCallData: innerCalldata,
    execCallData: execCallData,
    atomCost: atomCost.toString(),
  };

  console.log("\n=== REBUILT TX (unsigned — for review) ===");
  console.log(JSON.stringify(output, (key, value) =>
    typeof value === "bigint" ? value.toString() : value
  , 2));
})();

// EIP-712 types (for ethers.js typing only — on-chain uses MetaMask Delegation Framework v1.3.0 EIP-712 v4 `getDelegationHash`)
const types = {
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
    { name: "args", type: "bytes" },
  ],
};
