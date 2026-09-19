import { ethers } from "ethers";
import crypto from "crypto";
import fs from "fs";

// ---------- TESTNET CONFIG ----------
const DELEGATOR = "0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee"; // EIP-7702 upgraded EOA
const DELEGATE = DELEGATOR; // Path 1: EOA broadcast => delegate == delegator == msg.sender
const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const MULTIVAULT = "0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91";
const CHAIN_ID = 13579;
const RPC = "https://testnet.rpc.intuition.systems/http";

const ALLOWED_METHODS_ENFORCER = "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5";
const LIMITED_CALLS_ENFORCER = "0x04658B29F6b82ed55274221a06Fc97D318E25416";

const provider = new ethers.JsonRpcProvider(RPC);
const DELEGATOR_PK = process.env.DELEGATOR_PRIVATE_KEY;
if (!DELEGATOR_PK) {
  console.error("ERROR: DELEGATOR_PRIVATE_KEY not set in environment");
  process.exit(1);
}
const delegatorWallet = new ethers.Wallet(DELEGATOR_PK, provider);

// ---------- TYPEHASHES ----------
const DELEGATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)")
);
const CAVEAT_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes("Caveat(address enforcer,bytes terms)"));
const ROOT_AUTHORITY = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// ---------- HASH HELPERS ----------
function getCaveatPacketHash(enforcer, terms) {
  const termsHash = ethers.keccak256(terms);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "bytes32"],
    [CAVEAT_TYPEHASH, enforcer, termsHash]
  );
  return ethers.keccak256(encoded);
}

function getCaveatArrayPacketHash(caveats) {
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

// ---------- SELECTORS ----------
const SELECTOR_CREATE_ATOMS = ethers.id("createAtoms(bytes[],uint256[])").slice(0, 10);
const SELECTOR_CREATE_TRIPLES = ethers.id("createTriples(bytes32[],bytes32[],bytes32[],uint256[])").slice(0, 10);
const SELECTOR_DEPOSIT = ethers.id("deposit(address,bytes32,uint256,uint256)").slice(0, 10);
const SELECTOR_DEPOSIT_BATCH = ethers.id("depositBatch(address,bytes32[],uint256[],uint256[],uint256[])").slice(0, 10);

async function main() {
  console.log("=== MULTI-OP DELEGATION LIFECYCLE ===\n");

  // Step 0: Verify EIP-7702 upgrade
  console.log("0. Verifying EIP-7702 upgrade...");
  const code = await provider.getCode(DELEGATOR);
  const isUpgraded = code.length > 2;
  console.log(`   Code length: ${code.length} bytes`);
  console.log(`   Is upgraded: ${isUpgraded}`);
  if (!isUpgraded) {
    console.error("   Account is NOT upgraded. Path 1 requires an EIP-7702 upgraded account.");
    process.exit(1);
  }

  // Step 1: Read domain hash on-chain
  const domainHash = await provider.call({
    to: DELEGATION_MANAGER,
    data: "0x83ebb771" // getDomainHash()
  });
  console.log("\n1. Domain hash (on-chain):", domainHash);

  // Step 2: Session setup - get costs
  const atomCost = await provider.call({
    to: MULTIVAULT,
    data: "0x33332d39" // getAtomCost()
  });
  const atomCostValue = BigInt(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], atomCost)[0]);
  console.log("   Atom cost:", atomCostValue.toString());

  const tripleCost = await provider.call({
    to: MULTIVAULT,
    data: "0x0d65c91c" // getTripleCost()
  });
  const tripleCostValue = BigInt(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], tripleCost)[0]);
  console.log("   Triple cost:", tripleCostValue.toString());

  const curveConfig = await provider.call({
    to: MULTIVAULT,
    data: "0xf5da42f3" // getBondingCurveConfig()
  });
  // Returns (address registry, uint256 defaultCurveId) — 64 bytes total
  const curveId = Number(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + curveConfig.slice(-64))[0]);
  console.log("   Curve ID:", curveId);

  // Step 3: Compute deterministic IDs via on-chain calculateAtomId
  const uniqueSuffix = Date.now();
  const atomUri = `caip10:eip155:${CHAIN_ID}:${DELEGATOR}-${uniqueSuffix}`;
  const atomData = ethers.hexlify(ethers.toUtf8Bytes(atomUri));

  // calculateAtomId is the authoritative source
  const calcAtomIface = new ethers.Interface(["function calculateAtomId(bytes) view returns (bytes32)"]);
  const atomIdRaw = await provider.call({
    to: MULTIVAULT,
    data: calcAtomIface.encodeFunctionData("calculateAtomId", [atomData])
  });
  const atomId = "0x" + atomIdRaw.slice(-64);
  console.log("\n2. New atom URI:", atomUri);
  console.log("   Atom ID:", atomId);

  const predicateId = "0x3a73f3b1613d166eea141a25a2adc70db9304ab3c4e90daecad05f86487c3ee9"; // "trusts"

  // calculateTripleId is deterministic and does not require terms to exist
  const calcTripleIface = new ethers.Interface(["function calculateTripleId(bytes32,bytes32,bytes32) view returns (bytes32)"]);
  const tripleIdRaw = await provider.call({
    to: MULTIVAULT,
    data: calcTripleIface.encodeFunctionData("calculateTripleId", [atomId, predicateId, atomId])
  });
  const tripleId = "0x" + tripleIdRaw.slice(-64);
  // Verify neither exists yet
  const atomExists = await provider.call({ to: MULTIVAULT, data: "0xf5719008" + atomId.slice(2) });
  const tripleExists = await provider.call({ to: MULTIVAULT, data: "0xf5719008" + tripleId.slice(2) });
  console.log("   Atom exists:", parseInt(atomExists, 16) === 1);
  console.log("   Triple exists:", parseInt(tripleExists, 16) === 1);

  // Step 4: Build delegation
  const salt = BigInt("0x" + crypto.randomBytes(32).toString("hex"));

  const depositAmount = 1000000000000000n; // 0.001 tTRUST

  // AllowedMethods: createAtoms, createTriples, deposit, depositBatch
  const allowedMethodsTerms = ethers.concat(
    [SELECTOR_CREATE_ATOMS, SELECTOR_CREATE_TRIPLES, SELECTOR_DEPOSIT, SELECTOR_DEPOSIT_BATCH].map((s) => s)
  );

  const limitedCallsTerms = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100]);

  const caveats = [
    { enforcer: ALLOWED_METHODS_ENFORCER, terms: allowedMethodsTerms, args: "0x" },
    { enforcer: LIMITED_CALLS_ENFORCER, terms: limitedCallsTerms, args: "0x" }
  ];

  const delegation = {
    delegate: DELEGATE,
    delegator: DELEGATOR,
    authority: ROOT_AUTHORITY,
    caveats,
    salt,
    signature: "0x"
  };

  // Step 5: Compute delegation hash and verify on-chain
  const delegationHash = getDelegationHash(delegation.delegate, delegation.delegator, delegation.authority, delegation.caveats, delegation.salt);
  console.log("\n3. Computed delegation hash:", delegationHash);

  const onChainHashBytes = await provider.call({
    to: DELEGATION_MANAGER,
    data: "0x66134607" + ethers.AbiCoder.defaultAbiCoder().encode(
      ["(address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)"],
      [delegation]
    ).slice(2),
  });
  const onChainHash = "0x" + onChainHashBytes.slice(-64);
  console.log("4. On-chain getDelegationHash:", onChainHash);
  console.log("   Hash match:", delegationHash === onChainHash);
  if (delegationHash !== onChainHash) throw new Error("Hash mismatch!");

  // Step 6: Sign EIP-712 digest
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "bytes32", "bytes32", "uint256"],
      [DELEGATION_TYPEHASH, delegation.delegate, delegation.delegator, delegation.authority, getCaveatArrayPacketHash(delegation.caveats), delegation.salt]
    )
  );
  const digestBytes = ethers.concat([ethers.getBytes("0x1901"), ethers.getBytes(domainHash), ethers.getBytes(structHash)]);
  const digest = ethers.keccak256(digestBytes);
  console.log("\n5. EIP-712 digest:", digest);

  const signingKey = new ethers.SigningKey(DELEGATOR_PK.startsWith("0x") ? DELEGATOR_PK : "0x" + DELEGATOR_PK);
  const signature = signingKey.sign(ethers.getBytes(digest)).serialized;
  console.log("   Signature:", signature);

  const recovered = ethers.recoverAddress(digest, signature);
  console.log("   Recovered:", recovered);
  console.log("   Match:", recovered.toLowerCase() === DELEGATOR.toLowerCase());
  if (recovered.toLowerCase() !== DELEGATOR.toLowerCase()) throw new Error("Signature recovery failed!");

  delegation.signature = signature;

  // Step 7: Isolated ERC-1271 probe
  console.log("\n6. ISOLATED ERC-1271 TEST: isValidSignature on upgraded account");
  const isValidSigCalldata = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes"],
    [digest, signature]
  );
  const erc1271Result = await provider.call({
    to: DELEGATOR,
    data: "0x1626ba7e" + isValidSigCalldata.slice(2)
  });
  console.log("   ERC1271 result:", erc1271Result);
  const ERC1271_MAGIC = "0x1626ba7e";
  const erc1271Pass = erc1271Result.startsWith(ERC1271_MAGIC);
  console.log("   ERC-1271 validation:", erc1271Pass ? "PASS" : "FAIL");
  if (!erc1271Pass) {
    console.error("\n   STOPPING: ERC-1271 validation failed. Path 1 blocked at isolated test.");
    process.exit(1);
  }

  // Step 8: Build 4 inner operations
  console.log("\n7. Building 4 inner operations...");

  const innerIface = new ethers.Interface([
    "function createAtoms(bytes[],uint256[]) payable returns (bytes32[])",
    "function createTriples(bytes32[],bytes32[],bytes32[],uint256[]) payable returns (bytes32[])",
    "function deposit(address,bytes32,uint256,uint256) payable returns (uint256)",
    "function depositBatch(address,bytes32[],uint256[],uint256[],uint256[]) payable returns (uint256[])"
  ]);

  // Op 1: createAtoms (unique atom)
  const innerCalldata1 = innerIface.encodeFunctionData("createAtoms", [[atomData], [atomCostValue]]);
  const execCallData1 = ethers.solidityPacked(["address", "uint256", "bytes"], [MULTIVAULT, atomCostValue, innerCalldata1]);

  // Op 2: createTriples (atom trusts atom)
  const innerCalldata2 = innerIface.encodeFunctionData("createTriples", [
    [atomId],
    [predicateId],
    [atomId],
    [tripleCostValue]
  ]);
  const execCallData2 = ethers.solidityPacked(["address", "uint256", "bytes"], [MULTIVAULT, tripleCostValue, innerCalldata2]);

  // Op 3: deposit into atom vault
  const innerCalldata3 = innerIface.encodeFunctionData("deposit", [DELEGATOR, atomId, curveId, 0n]);
  const execCallData3 = ethers.solidityPacked(["address", "uint256", "bytes"], [MULTIVAULT, depositAmount, innerCalldata3]);

  // Op 4: depositBatch into atom + triple vaults
  const innerCalldata4 = innerIface.encodeFunctionData("depositBatch", [
    DELEGATOR,
    [atomId, tripleId],
    [curveId, curveId],
    [depositAmount, depositAmount],
    [0n, 0n]
  ]);
  const execCallData4 = ethers.solidityPacked(["address", "uint256", "bytes"], [MULTIVAULT, depositAmount * 2n, innerCalldata4]);

  console.log("   Op1 createAtoms execCallData selector:", ethers.id("createAtoms(bytes[],uint256[])").slice(0, 10));
  console.log("   Op2 createTriples execCallData selector:", ethers.id("createTriples(bytes32[],bytes32[],bytes32[],uint256[])").slice(0, 10));
  console.log("   Op3 deposit execCallData selector:", ethers.id("deposit(address,bytes32,uint256,uint256)").slice(0, 10));
  console.log("   Op4 depositBatch execCallData selector:", ethers.id("depositBatch(address,bytes32[],uint256[],uint256[],uint256[])").slice(0, 10));

  // Permission context: same delegation repeated for each operation
  const permContext = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "(address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]",
      "bytes32"
    ],
    [
      [delegation],
      delegationHash
    ]
  );

  const MODE_SINGLE_DEFAULT = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const outerIface = new ethers.Interface(["function redeemDelegations(bytes[],bytes32[],bytes[]) external"]);
  const redeemCalldata = outerIface.encodeFunctionData("redeemDelegations", [
    [permContext, permContext, permContext, permContext],
    [MODE_SINGLE_DEFAULT, MODE_SINGLE_DEFAULT, MODE_SINGLE_DEFAULT, MODE_SINGLE_DEFAULT],
    [execCallData1, execCallData2, execCallData3, execCallData4]
  ]);

  // Pre-compute atom ID via static call for verification
  console.log("\n8. Pre-computing IDs via static call...");
  const precomputedAtomIdRaw = await provider.call({ to: MULTIVAULT, data: innerCalldata1, value: atomCostValue });
  const computedAtomId = "0x" + precomputedAtomIdRaw.slice(-64);
  console.log("   Computed atom ID:", computedAtomId);
  console.log("   Expected atom ID:", atomId);
  console.log("   Atom ID match:", computedAtomId === atomId);

  // Triple cannot be pre-computed via static call because its subject atom
  // does not exist yet. Trust the deterministic on-chain calculateTripleId result.
  console.log("   Expected triple ID:", tripleId);

  // Step 9: Broadcast redeemDelegations
  console.log("\n9. Broadcasting redeemDelegations with 4 inner operations...");
  const writeTx = await delegatorWallet.sendTransaction({
    to: DELEGATION_MANAGER,
    data: redeemCalldata,
    value: 0n
  });
  console.log("   Tx hash:", writeTx.hash);
  const writeReceipt = await writeTx.wait();
  console.log("   Status:", writeReceipt.status === 1 ? "SUCCESS" : "FAILED");
  console.log("   Gas used:", writeReceipt.gasUsed.toString());

  if (writeReceipt.status !== 1) {
    console.error("Transaction failed! Aborting revocation.");
    process.exit(1);
  }

  // Step 10: Verify state
  console.log("\n10. Verifying on-chain state...");
  const atomCreated = await provider.call({ to: MULTIVAULT, data: "0xf5719008" + atomId.slice(2) });
  const tripleCreated = await provider.call({ to: MULTIVAULT, data: "0xf5719008" + tripleId.slice(2) });
  console.log("   Atom created:", parseInt(atomCreated, 16) === 1 ? "TRUE" : "FALSE");
  console.log("   Triple created:", parseInt(tripleCreated, 16) === 1 ? "TRUE" : "FALSE");

  const sharesAtom = await provider.call({
    to: MULTIVAULT,
    data: "0x89758079" + ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32", "uint256"], [DELEGATOR, atomId, curveId]).slice(2)
  }).catch((e) => "0x0");
  const sharesAtomValue = BigInt(sharesAtom || "0");
  console.log("   Atom shares:", sharesAtomValue.toString());

  const sharesTriple = await provider.call({
    to: MULTIVAULT,
    data: "0x89758079" + ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32", "uint256"], [DELEGATOR, tripleId, curveId]).slice(2)
  }).catch((e) => "0x0");
  const sharesTripleValue = BigInt(sharesTriple || "0");
  console.log("   Triple shares:", sharesTripleValue.toString());

  // Step 11: Revoke
  console.log("\n11. Revoking delegation...");
  const disableIface = new ethers.Interface(["function disableDelegation((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes) delegation) external"]);
  const disableCalldata = disableIface.encodeFunctionData("disableDelegation", [[
    delegation.delegate,
    delegation.delegator,
    delegation.authority,
    delegation.caveats.map(c => [c.enforcer, c.terms, c.args]),
    delegation.salt,
    delegation.signature
  ]]);

  const revokeTx = await delegatorWallet.sendTransaction({
    to: DELEGATION_MANAGER,
    data: disableCalldata,
    value: 0n
  });
  console.log("   Revoke tx hash:", revokeTx.hash);
  const revokeReceipt = await revokeTx.wait();
  console.log("   Status:", revokeReceipt.status === 1 ? "SUCCESS" : "FAILED");

  // Step 12: Verify revocation
  console.log("\n12. Verifying revocation...");
  const disabledAfter = await provider.call({
    to: DELEGATION_MANAGER,
    data: "0x2d40d052" + ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [delegationHash]).slice(2)
  });
  const isDisabledAfter = parseInt(disabledAfter, 16) === 1;
  console.log("   disabledDelegations(hash):", isDisabledAfter);

  // Step 13: Attempt post-revoke redemption
  console.log("\n13. Attempting redeemDelegations with revoked delegation...");
  try {
    const blockedTx = await delegatorWallet.sendTransaction({
      to: DELEGATION_MANAGER,
      data: redeemCalldata,
      value: 0n
    });
    const blockedReceipt = await blockedTx.wait();
    console.log("   UNEXPECTED: write succeeded after revoke");
  } catch (e) {
    console.log("   Blocked at broadcast (expected):", (e.shortMessage || e.message || "").slice(0, 300));
  }

  // Save output
  const outDir = "/data/data/com.termux/files/home/tmp";
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/multi-op-lifecycle-result.json`, JSON.stringify({
    path: "eip7702-direct-multi-op",
    erc1271Probe: erc1271Pass,
    domainHash,
    delegationHash,
    atomUri,
    atomId: atomId,
    atomCost: atomCostValue.toString(),
    tripleId: tripleId,
    tripleCost: tripleCostValue.toString(),
    operations: ["createAtoms", "createTriples", "deposit", "depositBatch"],
    writeTx: writeTx.hash,
    writeStatus: writeReceipt.status === 1 ? "success" : "failed",
    revokeTx: revokeTx.hash,
    revoked: isDisabledAfter,
    postRevokeBlocked: isDisabledAfter ? "confirmed_disabled" : "unexpected"
  }, null, 2));
  console.log("\n14. Saved to multi-op-lifecycle-result.json");
}

main().catch(console.error);
