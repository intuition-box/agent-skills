# Delegation Lifecycle — Quick Start (Under 15 Minutes)

> **Goal:** Go from zero to a fully working delegated create → deposit → revoke
> workflow on Intuition in under 15 minutes. Every code block below is tested
> on testnet and copy-paste ready.
>
> **Last verified:** 2026-09-12 on Intuition testnet (chain 13579)
>
> **Live proof TXs:**
> - Create: `0xad44b8709bdc2cfe00ad3053ece3951341b750f044c4f11a74f5ec7cb7fbcfcf`
> - Deposit: `0xecce25f5a38a1210e44eefb15fef784793f560968a11db0b5abd48f312e0aea8`
> - Revoke: `0xc507ce129f082c8b0f6cdff6afed40773ee89d36f4f02e0549031928b6785ef1`
> - Post-revert: `0x05baa052` = `CannotUseADisabledDelegation()`

---

## Table of Contents

1. [What You Need (Prerequisites)](#1-prerequisites)
2. [Network & Contract Addresses](#2-network--contract-addresses)
3. [The Fork Differences (Read This First)](#3-the-fork-differences)
4. [Step 1: Environment Setup](#4-step-1-environment-setup)
5. [Step 2: Create the Delegation](#5-step-2-create-the-delegation)
6. [Step 3: Execute a Delegated Write](#6-step-3-execute-a-delegated-write)
7. [Step 4: Revoke the Delegation](#7-step-4-revoke-the-delegation)
8. [Step 5: Verify Post-Revoke is Blocked](#8-step-5-verify-post-revoke-is-blocked)
9. [Full Agent: Two-Track Composition](#9-full-agent-two-track-composition)
10. [Troubleshooting (Copy-Paste Fixes)](#10-troubleshooting)

---

## 1. Prerequisites

Before starting, you need:

| Requirement | Details |
|---|---|
| **Node.js** | v18+ with `ethers` v6 installed (`npm install ethers`) |
| **cast** | Foundry's `cast` CLI for on-chain calls |
| **A funded delegator wallet** | The "Main Account" — owns the positions. Needs tTRUST for deposits + gas. |
| **A funded agent wallet** | Separate address that broadcasts transactions. Needs tTRUST for gas only. |
| **Private keys** | Both wallets' private keys (session-only, never persisted to disk) |

### Key Separation Rules

| Role | Owner | Persisted to disk? |
|---|---|---|
| **Main Account key** | User | **NEVER** |
| **Agent key** | Agent | Yes (`~/.intuition/agent-wallet.json`, chmod 600) |

The Main Account private key signs the delegation OFF-CHAIN. It is NEVER stored
by the agent or skill. Only the agent's key may be persisted.

---

## 2. Network & Contract Addresses

### Testnet (chain 13579) — Use this for testing

```bash
export CHAIN_ID=13579
export RPC="https://testnet.rpc.intuition.systems/http"
export MULTIVAULT="0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91"
export DELEGATION_MANAGER="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"

# Enforcer addresses (same on all chains — deterministic CREATE2)
export ALLOWED_METHODS_ENFORCER="0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5"
export LIMITED_CALLS_ENFORCER="0x04658B29F6b82ed55274221a06Fc97D318E25416"
export NATIVE_TOKEN_ENFORCER="0xA9BC5458E3eD352Df2eA4AbE9e0bBA41173513B9"
```

### Mainnet (chain 1155) — Production

```bash
export CHAIN_ID=1155
export RPC="https://rpc.intuition.systems/http"
export MULTIVAULT="0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e"
export DELEGATION_MANAGER="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
# Enforcer addresses are the same as testnet (deterministic CREATE2)
```

### Enforcer Quick Reference

| Enforcer | What It Restricts | Terms Encoding |
|---|---|---|
| `AllowedMethodsEnforcer` | Which function selectors can be called | Raw concatenated `bytes4` (e.g., `"0x3c6bbf452fb1d270"`) |
| `LimitedCallsEnforcer` | Total number of `redeemDelegations` calls | `abi.encode(uint256)` (e.g., `abi.encode([100])`) |
| `NativeTokenTransferAmountEnforcer` | Cumulative TRUST spend cap | `abi.encode(uint256)` |

---

## 3. The Fork Differences (Read This First)

The Intuition Delegation Framework fork has **three critical differences** from
standard OpenZeppelin / MetaMask Delegation Framework v1.3.0. Getting any of
these wrong causes silent failures that are hard to debug.

### Difference 1: Reversed Struct Field Order

**Standard OZ:** `(delegator, delegate, authority, caveats, salt)`
**Standard MetaMask pattern:** `(delegate, delegator, authority, caveats, salt)` — **delegate FIRST**

This affects:
- `getDelegationHash()` on-chain calls
- `disableDelegation()` calls
- The EIP-712 typehash string for signing

**Wrong order causes:** `InvalidDelegate()` (0xb5863604) or `InvalidDelegator()` (0xb9f0f171)

### Difference 2: execCallData Encoding

**Standard OZ:** `abi.encode(['address','uint256','bytes'], [target, value, calldata])`
**Standard MetaMask pattern:** `solidityPacked(['address','uint256','bytes'], [target, value, calldata])`

The fork's `ExecutionLib.decodeSingle()` reads the inner calldata from byte
offset **0x34** of execCallData. `solidityPacked` places it there. `abi.encode`
adds ABI offset headers and left-padding, placing the inner calldata at byte
**0x80+**, so `decodeSingle` reads garbage.

**Wrong encoding causes:** `AllowedMethodsEnforcer:method-not-allowed` (0x08c379a0) at gas 76543

### Difference 3: Salt is uint256, Not bytes32

The on-chain `Delegation` struct uses `uint256 salt`. Passing `bytes32 salt`
causes `abi.decode` failures.

---

## 4. Step 1: Environment Setup

### 4a: Verify Contracts Exist

```bash
cast code $MULTIVAULT --rpc-url $RPC
# Must NOT return 0x. If it does, wrong address.

cast code $DELEGATION_MANAGER --rpc-url $RPC
# Must NOT return 0x.
```

### 4b: Verify Enforcers Have Code

```bash
for addr in $ALLOWED_METHODS_ENFORCER $LIMITED_CALLS_ENFORCER; do
  code=$(cast code $addr --rpc-url $RPC 2>&1 | head -1)
  echo "$addr: code_length=${#code}"
done
# Both should have code_length > 2 (not just "0x")
```

### 4c: Query Session State

```bash
# Costs
ATOM_COST=$(cast call $MULTIVAULT "getAtomCost()(uint256)" --rpc-url $RPC)
TRIPLE_COST=$(cast call $MULTIVAULT "getTripleCost()(uint256)" --rpc-url $RPC)
CURVE_ID=$(cast call $MULTIVAULT "getBondingCurveConfig()((address,uint256))" --rpc-url $RPC | awk -F', ' '{print $2}' | tr -d ')')

echo "atomCost: $ATOM_COST | tripleCost: $TRIPLE_COST | curveId: $CURVE_ID"
```

### 4d: Read Domain Hash (NEVER guess this)

```bash
DOMAIN_HASH=$(cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC)
echo "domainHash: $DOMAIN_HASH"
```

---

## 5. Step 2: Create the Delegation

This is the core step. We'll create a delegation that allows the Agent to call
`createTriples` and `deposit` on behalf of the Main Account.

### 5a: Build the Delegation Object

Save this as `create-delegation.cjs`:

```javascript
const { ethers } = require('ethers');

// ── CONFIG — change these ──
const CHAIN_ID = Number(process.env.CHAIN_ID || "13579");
const RPC = process.env.RPC;
const MULTIVAULT = process.env.MULTIVAULT;
const DELEGATION_MANAGER = process.env.DELEGATION_MANAGER;
const ALLOWED_METHODS_ENFORCER = process.env.ALLOWED_METHODS_ENFORCER;
const LIMITED_CALLS_ENFORCER = process.env.LIMITED_CALLS_ENFORCER;

const DELEGATOR = process.env.DELEGATOR;       // Main Account address
const DELEGATE = process.env.DELEGATE;         // Agent address
const DELEGATOR_KEY = process.env.DELEGATOR_KEY; // Main Account private key (session-only!)

// ── ENCODING RULES (fork-specific) ──
// Typehash MUST use standard field order: delegate FIRST, then delegator
const DELEGATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "Delegation(address delegate,address delegator,bytes32 authority," +
    "Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)"
  )
);
const CAVEAT_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes("Caveat(address enforcer,bytes terms)")
);
const ROOT_AUTHORITY = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// ── CAVEAT ENCODING ──
// AllowedMethodsEnforcer: raw concatenated bytes4 selectors
const SELECTOR_CREATE_TRIPLES = ethers.id("createTriples(bytes32[],bytes32[],bytes32[],uint256[])").slice(0, 10);
const SELECTOR_DEPOSIT = ethers.id("deposit(address,bytes32,uint256,uint256)").slice(0, 10);
const allowedMethodsTerms = "0x" + SELECTOR_CREATE_TRIPLES.slice(2) + SELECTOR_DEPOSIT.slice(2);

// LimitedCallsEnforcer: abi.encode(uint256)
const limitedCallsTerms = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100]);

// ── BUILD DELEGATION ──
const salt = BigInt("0x" + require('crypto').randomBytes(32).toString("hex"));

const delegation = {
  delegate: DELEGATE,      // FIRST (fork order)
  delegator: DELEGATOR,    // SECOND
  authority: ROOT_AUTHORITY,
  caveats: [
    { enforcer: ALLOWED_METHODS_ENFORCER, terms: allowedMethodsTerms, args: "0x" },
    { enforcer: LIMITED_CALLS_ENFORCER, terms: limitedCallsTerms, args: "0x" },
  ],
  salt: salt.toString(),
  signature: "0x",
};

// ── COMPUTE HASHES ──
function caveatPacketHash(enforcer, terms) {
  const termsHash = ethers.keccak256(terms);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "bytes32"],
      [CAVEAT_TYPEHASH, enforcer, termsHash]
    )
  );
}

function caveatsArrayHash(caveats) {
  let concat = "0x";
  for (const c of caveats) concat += caveatPacketHash(c.enforcer, c.terms).slice(2);
  return ethers.keccak256(concat);
}

const caveatsHash = caveatsArrayHash(delegation.caveats);
const structEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes32", "address", "address", "bytes32", "bytes32", "uint256"],
  [DELEGATION_TYPEHASH, delegation.delegate, delegation.delegator, delegation.authority, caveatsHash, BigInt(delegation.salt)]
);
const delegationHash = ethers.keccak256(structEncoded);

// ── VERIFY ON-CHAIN ──
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const domainHash = await provider.call({ to: DELEGATION_MANAGER, data: "0x83ebb771" });

  // Verify struct hash matches on-chain
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["(address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)"],
    [[
      delegation.delegate,
      delegation.delegator,
      delegation.authority,
      delegation.caveats.map(c => [c.enforcer, c.terms, c.args]),
      BigInt(delegation.salt),
      delegation.signature
    ]]
  );
  const onChainHash = await provider.call({
    to: DELEGATION_MANAGER,
    data: "0x66134607" + encoded.slice(2)
  });
  const onChainHashStr = "0x" + onChainHash.slice(-64);

  if (delegationHash !== onChainHashStr) {
    throw new Error(`Hash mismatch! Off-chain: ${delegationHash} != On-chain: ${onChainHashStr}`);
  }
  console.log("Hash verified on-chain:", delegationHash);

  // ── SIGN ──
  const digest = ethers.keccak256(
    ethers.concat([ethers.getBytes("0x1901"), ethers.getBytes(domainHash), ethers.getBytes(delegationHash)])
  );
  const signingKey = new ethers.SigningKey(DELEGATOR_KEY);
  const sig = signingKey.sign(digest);
  delegation.signature = sig.serialized;

  // ── VERIFY SIGNATURE ──
  const recovered = ethers.recoverAddress(digest, delegation.signature);
  if (recovered.toLowerCase() !== DELEGATOR.toLowerCase()) {
    throw new Error(`Signature recovery failed! Recovered: ${recovered} != Delegator: ${DELEGATOR}`);
  }
  console.log("Signature verified. Recovered:", recovered);

  // ── OUTPUT ──
  const output = { delegation, delegationHash, domainHash, network: CHAIN_ID === 13579 ? "testnet" : "mainnet", chainId: CHAIN_ID };
  require('fs').writeFileSync("delegation-signed.json", JSON.stringify(output, null, 2));
  console.log("\nSaved to delegation-signed.json");
  console.log("Share this file with the Agent for execution.");
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

### 5b: Run It

```bash
export DELEGATOR="0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee"
export DELEGATE="0xe9BfdEC6Fa795a24e3069292248d9d16570E050d"
export DELEGATOR_KEY="0xe541f066dd79dc125d45aa98c27bc0a2c722432d4c2e820e0e09920f59ba5634"

node create-delegation.cjs
```

Expected output:
```
Hash verified on-chain: 0x33983d37...
Signature verified. Recovered: 0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee
Saved to delegation-signed.json
```

---

## 6. Step 3: Execute a Delegated Write

### 6a: Create a Triple via Delegation

Save as `execute-create.cjs`:

```javascript
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.RPC;
const MULTIVAULT = process.env.MULTIVAULT;
const DELEGATION_MANAGER = process.env.DELEGATION_MANAGER;
const AGENT_KEY = process.env.AGENT_KEY;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(AGENT_KEY, provider);

  const sd = JSON.parse(fs.readFileSync("delegation-signed.json"));
  const d = sd.delegation;

  // ── INNER CALLDATA ──
  const subjectId = "0x2e998db01c32a8892763e104a40528f49b86a0e0a2ba0e27937a20e039114d85";
  const predicateId = "0xffd07650dc7ab341184362461ebf52144bf8bcac5a19ef714571de15f1319260";
  const objectId = "0x4aaa11b291944312701c14fa39e190fd88c07f12468f6095c2ca1ea16acc4329";
  const tripleCost = "1000000002000000";

  const innerCalldata = new ethers.Interface(['function createTriples(bytes32[],bytes32[],bytes32[],uint256[]) payable'])
    .encodeFunctionData("createTriples(bytes32[],bytes32[],bytes32[],uint256[])", [[subjectId], [predicateId], [objectId], [tripleCost]]);

  // ── execCallData: solidityPacked (NOT abi.encode!) ──
  const execCallData = ethers.solidityPacked(
    ["address", "uint256", "bytes"],
    [MULTIVAULT, tripleCost, innerCalldata]
  );

  // ── PERMISSION CONTEXT ──
  const permissionContext = ethers.AbiCoder.defaultAbiCoder().encode(
    ["(address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]"],
    [[[
      d.delegate,
      d.delegator,
      d.authority,
      d.caveats.map(c => [c.enforcer, c.terms, c.args]),
      BigInt(d.salt),
      d.signature
    ]]]
  );

  const MODE_DEFAULT = "0x" + "0".repeat(64);
  const redeemIface = new ethers.Interface(['function redeemDelegations(bytes[],bytes32[],bytes[]) external']);
  const redeemCalldata = redeemIface.encodeFunctionData("redeemDelegations(bytes[],bytes32[],bytes[])", [
    [permissionContext], [MODE_DEFAULT], [execCallData]
  ]);

  const feeData = await provider.getFeeData();
  const tx = await wallet.sendTransaction({
    to: DELEGATION_MANAGER,
    data: redeemCalldata,
    gasLimit: 800000,
    gasPrice: feeData.gasPrice,
    value: 0
  });

  console.log("Create TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("Status:", receipt.status === 1 ? "SUCCESS" : "FAILED", "| Block:", receipt.blockNumber);
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

### 6b: Deposit via Delegation

```javascript
// In execute-deposit.cjs — same setup as above, different inner calldata:

const tripleId = "0x88c64e37687bf17f7bc1fbc449ea700910cf7e80a92ab4d0fa3ae9d9eb15ae65";
const depositAmount = "1000000000000000";

// Get minShares from previewDeposit (REQUIRED — zero causes SlippageExceeded)
const previewCalldata = new ethers.Interface(['function previewDeposit(bytes32,uint256,uint256) view returns (uint256,uint256)'])
  .encodeFunctionData("previewDeposit(bytes32,uint256,uint256)", [tripleId, "1", depositAmount]);
const previewResult = await provider.call({ to: MULTIVAULT, data: previewCalldata });
const [minShares] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256","uint256"], previewResult);

const innerCalldata = new ethers.Interface(['function deposit(address,bytes32,uint256,uint256) payable'])
  .encodeFunctionData("deposit(address,bytes32,uint256,uint256)", [delegation.delegator, tripleId, "1", minShares]);

const execCallData = ethers.solidityPacked(
  ["address", "uint256", "bytes"],
  [MULTIVAULT, depositAmount, innerCalldata]
);
// ... same redeemDelegations wrapping as above
```

---

## 7. Step 4: Revoke the Delegation

Save as `revoke-delegation.cjs`:

```javascript
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.RPC;
const DELEGATION_MANAGER = process.env.DELEGATION_MANAGER;
const DELEGATOR_KEY = process.env.DELEGATOR_KEY;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(DELEGATOR_KEY, provider);

  const sd = JSON.parse(fs.readFileSync("delegation-signed.json"));
  const d = sd.delegation;

  // disableDelegation takes the FULL struct (not just a hash)
  // Uses standard field order: (delegate, delegator, authority, caveats, salt, signature)
  const iface = new ethers.Interface([
    "function disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"
  ]);

  const disableCalldata = iface.encodeFunctionData("disableDelegation", [[
    d.delegate,      // FIRST (fork order)
    d.delegator,     // SECOND
    d.authority,
    d.caveats.map(c => [c.enforcer, c.terms, c.args]),
    BigInt(d.salt),
    d.signature
  ]]);

  const feeData = await provider.getFeeData();
  const tx = await wallet.sendTransaction({
    to: DELEGATION_MANAGER,
    data: disableCalldata,
    gasLimit: 200000,
    gasPrice: feeData.gasPrice
  });

  console.log("Revoke TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("Status:", receipt.status === 1 ? "SUCCESS" : "FAILED", "| Block:", receipt.blockNumber);
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

---

## 8. Step 5: Verify Post-Revoke is Blocked

```bash
# Try to use the same delegation again — should revert with 0x05baa052
node execute-create.cjs
# Expected: "transaction execution reverted"

# Verify on-chain
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" \
  "0x33983d374f738f25b4efdcea5f21a3be87d29b17ce6eb9a3f0d3e858d95bce48" \
  --rpc-url $RPC
# Expected: true
```

---

## 9. Full Agent: Two-Track Composition

For a complete agent that both creates AND deposits, set up both tracks:

```
Phase 1 — Setup (one-time, Main Account key):
  Main Account → OWS (creation delegation, EIP-7702)
  OWS → Agent (creation delegation, cached)
  Main Account → approve(Smart Wallet, 3) on MultiVault
  Smart Wallet → Agent (deposit delegation, cached)

Phase 2 — Operations (Agent autonomous):
  Create:  redeemDelegations([MainAcc→OWS, OWS→Agent], createTriples(...))
  Deposit: redeemDelegations([SmartWallet→Agent], deposit(receiver: MainAcc, ...))

Phase 3 — Management:
  Revoke OWS delegation (creation setup complete)
  Revoke Smart Wallet delegation (kill switch for deposits)
```

See `reference/unified-delegation-architecture.md` for the full model.

---

## 10. Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `AllowedMethodsEnforcer:method-not-allowed` (0x08c379a0) at gas 76543 | execCallData uses `abi.encode` instead of `solidityPacked` | Change to `solidityPacked(['address','uint256','bytes'], ...)` |
| `InvalidDelegate()` (0xb5863604) | Struct field order is wrong (delegator first instead of delegate first) | Use reversed order: delegate FIRST |
| `InvalidDelegator()` (0xb9f0f171) | `disableDelegation` uses wrong field order (delegator first, should be delegate first) (delegator first, should be delegate first) | Use reversed order: delegate FIRST |
| `MultiVault_SlippageExceeded` (0x40a0e8d2) | `minShares = 0` in deposit | Query `previewDeposit` first, use returned shares as `minShares` |
| `CannotUseADisabledDelegation()` (0x05baa052) | Delegation was revoked | Expected after revoke — create a new delegation |
| `AlreadyEnabled` (0xf2a5f75a) | `enableDelegation` called twice | Not an error — delegation is already active |
| `InvalidERC1271Signature()` (0x155ff427) | Wrong digest or signature | Read `getDomainHash()` on-chain, verify struct hash matches |
| Hash mismatch between off-chain and on-chain | Wrong typehash string or field order | Use `Delegation(address delegate,address delegator,...)` — delegate first |
| `require(false)` with no data | Multiple possible causes | Check struct field order, execCallData encoding, minShares |

### Quick Diagnostic Commands

```bash
# Check if a delegation is disabled
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" $HASH --rpc-url $RPC

# Get delegation hash on-chain
cast call $DELEGATION_MANAGER "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))" \
  "($DELEGATE,$DELEGATOR,$AUTHORITY,[($ENFORCER,$TERMS,0x)],$SALT,$SIGNATURE)" --rpc-url $RPC

# Preview deposit to get minShares
cast call $MULTIVAULT "previewDeposit(bytes32,uint256,uint256)(uint256,uint256)" $TRIPLE_ID $CURVE_ID $AMOUNT --rpc-url $RPC

# Check enforcer has code
cast code $ALLOWED_METHODS_ENFORCER --rpc-url $RPC
```

---

## File Reference

For the full GitHub upload, these are the delegation-related files:

### Core (required)
- `SKILL.md` — Main skill entry point with protocol invariants
- `reference/network-config.md` — All addresses, enforcers, RPCs
- `reference/delegation.md` — Core delegation concepts
- `reference/delegation-authority.md` — Agent-side authority gate
- `reference/off-chain-hashing.md` — EIP-712 digest computation
- `reference/reading-state.md` — Session setup queries

### Operations (required)
- `operations/create-delegation.md` — Build and sign delegations
- `operations/revoke-delegation.md` — Revoke delegations
- `operations/approve.md` — MultiVault approval for deposit track

### Architecture (recommended)
- `reference/unified-delegation-architecture.md` — Two-track model
- `references/creation-authority-track.md` — Creation track details
- `references/deposit-authority-track.md` — Deposit track details
- `references/delegation-chain-attribution.md` — Attribution semantics

### Encoding & Debugging (recommended)
- `reference/delegation-encoding-rules.md` — Exact encoding rules
- `references/allowed-methods-enforcer-debugging.md` — Enforcer deep-dive
- `references/delegation-debugging.md` — Layered debugging
- `references/delegation-field-order-debug.md` — Field order discovery

### Templates (optional)
- `templates/sign-delegation.html` — MetaMask signing page
- `templates/sign-delegation-cli.mjs` — CLI signer
- `templates/redeem-creation.mjs` — Creation track executor
- `templates/redeem-deposit.mjs` — Deposit track executor
- `templates/revoke-delegation.mjs` — Revocation script
