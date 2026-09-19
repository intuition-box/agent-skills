# createDelegation

Delegate authority from one account (delegator) to another (delegate).
All hashing and digest computation is done off‑chain. The DelegationManager
does not expose `domainSeparator` or `hashTypedData` on‑chain, but it **does**
expose `getDelegationHash(Delegation)` (`0x66134607`) and `getDomainHash()` (`0x83ebb771`).

**Requires:** `$RPC`, `$CHAIN_ID`, `$DELEGATION_MANAGER`, `$MULTIVAULT` from session setup (`reference/reading-state.md`).
**Output:** Signed Delegation object (off‑chain) — not an on‑chain transaction.

---

## Table of Contents

- [Quick Start: Minimal Delegation](#quick-start-minimal-delegation)
- [Prerequisites](#prerequisites)
- [Step 1: Determine Delegation Path](#step-1-determine-delegation-path)
- [Step 2: Query Delegation State](#step-2-query-delegation-state)
- [Step 3: Encode Caveats](#step-3-encode-caveats)
- [Step 4: Build the Delegation Struct](#step-4-build-the-delegation-struct)
- [Step 5: Sign via EIP-712](#step-5-sign-via-eip-712)
- [Step 6: Compute Delegation Hash (Off-Chain)](#step-6-compute-delegation-hash-offchain)
- [Step 7: Output the Signed Delegation Object](#step-7-output-the-signed-delegation-object)
- [Redelegation: Chained Authority](#redelegation-chained-authority)
- [Error Patterns](#error-patterns)
- [Protocol Invariants](#protocol-invariants)

---

## Quick Start: Minimal Delegation

Create a delegation that allows the Agent to call `deposit` and `createAtoms` on MultiVault, with a 100 TRUST cumulative spend cap. This example uses MetaMask's standard `@metamask/smart-accounts-kit` for EIP-712 v4 off‑chain hashing (recommended). For manual encoding, see the detailed steps below.

```typescript
import { getDelegationHash, hashTypedDataForDelegation } from '@metamask/smart-accounts-kit'
import { signTypedData, randomBytes, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// --- Setup ---
const DELEGATION_MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'
const CHAIN_ID = 13579  // testnet
const DELEGATOR = '0x<main-or-smart-account>'
const DELEGATE = '0x<agent-address>'
const DELEGATOR_PRIVATE_KEY = '0x<private-key>'

> **Security Warning:** `DELEGATOR_PRIVATE_KEY` controls the user's account. This key must **never** be written to disk by the agent or skill. It exists only as an in-memory session variable. The user is responsible for keeping it in their own wallet (MetaMask, hardware wallet, etc.). If you are the agent, you must not persist, log, or transmit the delegator's private key. Only the **agent's** private key may be written to `~/.intuition/agent-wallet.json`.

// --- Encode caveats ---
const selectors = [
  '0x...', // createAtoms selector
  '0x...', // deposit selector
]
const allowedMethodsTerms = encodeAbiParameters([{ type: 'bytes4[]' }], [selectors])
const spendCapTerms = encodeAbiParameters([{ type: 'uint256' }], [parseEther('100')])

// --- Build delegation object (without signature) ---
const delegation = {
  delegator: DELEGATOR,
  delegate: DELEGATE,
  authority: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  caveats: [
    { enforcer: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5', terms: allowedMethodsTerms, args: '0x' },
    { enforcer: '<native-token-enforcer>', terms: spendCapTerms, args: '0x' },
  ],
  salt: BigInt('0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')), // uint256
  signature: '0x', // will be filled
}

// --- Compute EIP-712 digest and sign ---
const digest = hashTypedDataForDelegation(delegation, CHAIN_ID, DELEGATION_MANAGER)
const signature = await signTypedData({
  privateKey: DELEGATOR_PRIVATE_KEY,
  domain: { name: 'DelegationManager', version: '1', chainId: CHAIN_ID, verifyingContract: DELEGATION_MANAGER },
  types: {
    Delegation: [
      { name: 'delegator', type: 'address' },
      { name: 'delegate', type: 'address' },
      { name: 'authority', type: 'bytes32' },
      { name: 'caveats', type: 'Caveat[]' },
      { name: 'salt', type: 'uint256' },
    ],
    Caveat: [
      { name: 'enforcer', type: 'address' },
      { name: 'terms', type: 'bytes' },
      { name: 'args', type: 'bytes' },
    ],
  },
  primaryType: 'Delegation',
  message: delegation,
})
delegation.signature = signature

// --- Compute delegation hash (struct hash) ---
const delegationHash = getDelegationHash(delegation)

// --- Output ---
console.log(JSON.stringify({ delegation, delegationHash }, null, 2))
```

---

## Prerequisites

1. **Delegator address** — the authority owner. For the creation track, this is the OWS address. For the deposit track, this is the Smart Wallet address.
2. **Delegate address** — the Agent's wallet address (see `reference/delegation.md` → Agent Wallet Setup).
3. **DelegationManager address** — from `reference/network-config.md` or `reference/delegation.md`.
4. **MultiVault address** — from `reference/network-config.md`.
5. **Caveat enforcer addresses** — from `reference/delegation.md`.
6. **Track determination** — see Step 1 below.
7. **Off‑chain hashing capability** — use MetaMask's standard `@metamask/smart-accounts-kit` (recommended) or manual viem encoding (see `reference/off-chain-hashing.md`).

---

## Step 1: Determine Authority Track

Before encoding, determine which delegation track applies. See `reference/delegation.md` → Unified Delegation Architecture for the full model.

### Creation Authority Track (for `createAtoms`, `createTriples`)

Used when the Agent needs to create atoms or triples. This is a one-time setup track.

**Setup (one-time, Main Account key required):**

**Step A — Create OWS (one-time)**

Generate a temporary EIP-7702 upgradable EOA. This is the OWS (Operational Wallet Setup). Its key exists only during the setup window.

**Step B — Main Account delegates to OWS**

Set `DELEGATOR="$MAIN_ACCOUNT"`, `DELEGATE="$OWS"`. The Main Account signs the creation-scoped delegation to OWS.

**Step C — OWS delegates to Agent**

Set `DELEGATOR="$OWS"`, `DELEGATE="$AGENT"`. The OWS signs the delegation to the Agent. This is cached for repeated creation operations.

> **Pitfall:** OWS must be EIP-7702 upgraded (have contract code) before it can be a delegator. Use `cast send $OWS --auth $IMPL --private-key $OWS_PK`.
> **Pitfall:** The OWS key is temporary. It only needs to exist during setup and any active creation windows. Discard after.

### Deposit/Redemption Authority Track (for `deposit`, `redeem`, batch variants)

Used when the Agent needs to deposit or redeem $TRUST. This is a standing track.

**Setup (one-time, Main Account key required):**

**Step A — Main Account approves Smart Wallet on MultiVault**

```bash
cast send $MULTIVAULT "approve(address,uint8)" $SMART_WALLET 3 --from $MAIN_ACCOUNT --rpc-url $RPC
```

`approvalType = 3` (`BOTH = DEPOSIT | REDEMPTION`). Caller is Main Account; sender is `$SMART_WALLET`.

> **Pitfall:** `approvalType = 255` (`APPROVE_ALL`) reverts on mainnet. Use `3` instead.
> **Pitfall:** `isApprovedFor(address,address)` exists on mainnet but **not** on testnet. On testnet, call `approve(SmartWallet, 3)` directly without a pre-check.

**Step B — Smart Wallet delegates to Agent**

Set `DELEGATOR="$SMART_WALLET"`, `DELEGATE="$AGENT"`. The Smart Wallet signs the delegation to the Agent. This is cached for repeated deposit/redemption operations.

### Both Tracks (full agent)

For a full agent that creates AND deposits, set up both tracks:
1. Creation track: Main Account → OWS → Agent
2. Deposit track: Main Account → approve(Smart Wallet) + Smart Wallet → Agent

---

## Step 2: Query Delegation State

### 2a: Generate a Random Salt

`salt` is `uint256`. Generate a random 256-bit unsigned integer.

```bash
SALT=$(($(openssl rand -hex 32) % 2**256))
```

```typescript
import { randomBytes } from 'crypto'
const salt = BigInt('0x' + randomBytes(32).toString('hex'))
```

### 2b: Check Parent Delegation (for Redelegation)

If creating a redelegation, read the parent delegation hash from-chain and set `AUTHORITY` to that hash.

```bash
# Read the canonical parent hash from-chain
cast call $DELEGATION_MANAGER "getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)" "$PARENT_DELEGATOR" "$PARENT_DELEGATE" "$PARENT_AUTHORITY" "[($PARENT_ENFORCER,\"$PARENT_TERMS\",\"$PARENT_ARGS\")]" "$PARENT_SALT" "$PARENT_SIGNATURE" --rpc-url $RPC
```

```typescript
const parentHash = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation) view returns (bytes32)']),
  functionName: 'getDelegationHash',
  args: [{
    delegator: parentDelegation.delegator,
    delegate: parentDelegation.delegate,
    authority: parentDelegation.authority,
    caveats: parentDelegation.caveats,
    salt: BigInt(parentDelegation.salt),
    signature: parentDelegation.signature,
  }],
})
```

> **Note:** `getDelegationHash()` accepts the full delegation struct but strips `signature` before hashing. This check is optional — the DelegationManager will validate the chain at redemption time.

---

## Step 3: Encode Caveats

Encode each caveat's `terms` field. `args` is typically `0x`.

### 3a: AllowedMethodsEnforcer — Operation Allowlist

> **Critical:** `AllowedMethodsEnforcer` expects **raw concatenated bytes4 selectors** (e.g., `"0x61403309"`), NOT ABI-encoded `bytes4[]`. Using `abi.encode(bytes4[])` produces an array header that `decodeSingle()` misreads as the first selector.

```bash
SELECTOR_CREATE_ATOMS=$(cast sig "createAtoms(bytes[],uint256[])")
SELECTOR_DEPOSIT=$(cast sig "deposit(address,bytes32,uint256,uint256)")
# Raw concatenation, NOT abi-encode bytes4[]
ALLOWED_METHODS_TERMS="0x${SELECTOR_CREATE_ATOMS#0x}${SELECTOR_DEPOSIT#0x}"
```

```typescript
const selectors = [
  toFunctionSelector('createAtoms(bytes[],uint256[])'),
  toFunctionSelector('deposit(address,bytes32,uint256,uint256)'),
]
// Raw concatenation of bytes4 selectors
const allowedMethodsTerms = '0x' + selectors.map(s => s.replace('0x', '')).join('')
```

### 3b: NativeTokenTransferAmountEnforcer — Spend Cap

```bash
MAX_SPEND=$(cast --to-wei 100)
SPEND_CAP_TERMS=$(cast abi-encode "uint256" $MAX_SPEND)
```

```typescript
const maxSpend = parseEther('100')
const spendCapTerms = encodeAbiParameters(
  parseAbiParameters('uint256'),
  [maxSpend]
)
```

### 3c: LimitedCallsEnforcer — Call Count Cap

```bash
MAX_CALLS=50
CALLS_TERMS=$(cast abi-encode "uint256" $MAX_CALLS)
```

```typescript
const maxCalls = 50n
const callsTerms = encodeAbiParameters(
  parseAbiParameters('uint256'),
  [maxCalls]
)
```

### 3d: Expiry Caveat (if available)

```bash
EXPIRY=$(($(cast block-number --rpc-url $RPC | cast --to-dec) + 604800))
EXPIRY_TERMS=$(cast abi-encode "uint256" $EXPIRY)
```

```typescript
const currentBlock = await client.getBlock()
const expiryTimestamp = currentBlock.timestamp + 604800n
const expiryTerms = encodeAbiParameters(
  parseAbiParameters('uint256'),
  [expiryTimestamp]
)
```

---

## Step 4: Build the Delegation Struct

### 4a: Set Authority

| Delegation Type | Authority Value |
|---|---|
| Root delegation | `0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` |
| Redelegation | Read parent hash from-chain via `getDelegationHash()` on the DelegationManager |

```bash
AUTHORITY="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
```

```typescript
const authority = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
```

### 4b: Assemble the Struct (without signature)

```bash
DELEGATOR="0x<delegator-address>"
DELEGATE="0x<agent-address>"
AUTHORITY="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
SALT="0x$(openssl rand -hex 32)"  # uint256 (32-byte hex, treated as uint256 in ABI)
CAVEAT_1="($ALLOWED_METHODS_ENFORCER,$ALLOWED_METHODS_TERMS,0x)"
CAVEAT_2="($NATIVE_TOKEN_ENFORCER,$SPEND_CAP_TERMS,0x)"
```

```typescript
// Note: Property order in the object doesn't matter for EIP-712 hashing —
// the type definition order in Step 5b determines the hash encoding.
// The contract uses standard order (delegate first) in the type definition.
const delegation = {
  delegate: delegateAddress,    // encoded FIRST (fork order)
  delegator: delegatorAddress, // encoded SECOND
  authority: authority,
  caveats: [
    { enforcer: allowedMethodsEnforcer, terms: allowedMethodsTerms, args: '0x' },
    { enforcer: nativeTokenEnforcer, terms: spendCapTerms, args: '0x' },
  ],
  salt: salt,
  signature: '0x' as `0x${string}`, // will be filled
}
```

---

## Step 5: Sign via EIP‑712

All hashing is off‑chain. The DelegationManager does not expose `domainSeparator` or `hashTypedData`. Use the fixed domain below.

### 5a: Define EIP‑712 Domain (Off‑Chain)

**Read the domain separator from-chain. Never reconstruct it from guessed
`name`/`version` literals.**

```bash
DOMAIN_HASH=$(cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC)
```

```typescript
const domainHash = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function getDomainHash() view returns (bytes32)']),
  functionName: 'getDomainHash',
})
```

Use `domainHash` as the domain separator in the EIP-712 digest: `keccak256("\x19\x01" ++ domainHash ++ structHash)`.

If you need the literal `name`/`version` for type definitions, confirm them
against the verified contract source — do not guess.
```

### 5b: Define EIP‑712 Types

> **CRITICAL:** The standard MetaMask struct field order is: `delegate` FIRST, then `delegator`. This is the opposite of standard OpenZeppelin. Using the standard order causes hash mismatch against on-chain `getDelegationHash()`.

```typescript
const types = {
  Delegation: [
    { name: 'delegate', type: 'address' },   // FIRST (standard order)
    { name: 'delegator', type: 'address' },  // SECOND
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
    { name: 'args', type: 'bytes' },
  ],
}
```

### 5c: Compute EIP‑712 Digest (Off‑Chain)

Use MetaMask's standard `@metamask/smart-accounts-kit` or viem:

```typescript
// Using MetaMask standard SDK
import { hashTypedDataForDelegation } from '@metamask/smart-accounts-kit'
const digest = hashTypedDataForDelegation(delegation, CHAIN_ID, DELEGATION_MANAGER)
```

```typescript
// Using viem directly
import { hashTypedData } from 'viem'
const digest = hashTypedData({ domain, types, primaryType: 'Delegation', message: delegation })
```

For `cast`, use the manual digest computation (see `reference/off-chain-hashing.md`) or use a node script to output the digest, then sign it.

### 5d: Sign the Digest

**Using viem (recommended)**

```typescript
import { signTypedData } from 'viem'

const signature = await signTypedData({
  privateKey: delegatorPrivateKey,
  domain,
  types,
  primaryType: 'Delegation',
  message: delegation,
})
```

**Using cast (requires the digest)**

```bash
# First, get the digest via a helper script (e.g., using node)
EIP712_DIGEST="0x..."  # computed off-chain
SIGNATURE=$(cast wallet sign --private-key $DELEGATOR_PRIVATE_KEY $EIP712_DIGEST)
```

> Do not use `cast call $DELEGATION_MANAGER "hashTypedData(...)"` — it does not exist.

### 5e: Mandatory Pre-Broadcast Signature Recovery Check

Before broadcasting anything, recover the signer from the digest + signature and
confirm it equals `delegation.delegator`. This catches invalid signatures,
wrong keys, and encoding bugs before any on-chain submission.

```typescript
import { recoverTypedDataAddress } from 'viem'

const recovered = await recoverTypedDataAddress({
  domain,
  types,
  primaryType: 'Delegation',
  message: {
    delegator: delegation.delegator,
    delegate: delegation.delegate,
    authority: delegation.authority,
    caveats: delegation.caveats,
    salt: delegation.salt,
  },
  signature,
})

if (recovered.toLowerCase() !== delegation.delegator.toLowerCase()) {
  throw new Error('signature_invalid: recovered address does not match delegator')
}
```

> If recovery fails, the bug is in the off-chain digest computation, not the
> on-chain contract. Fix the digest before proceeding.

### 5f: Contract Delegator ERC‑1271 Probe

If the delegator is a contract account (code.length > 0), validate via ERC-1271
**before** any delegation transaction. This is the Layer 1 probe.

```bash
cast call $DELEGATOR "isValidSignature(bytes32,bytes)(bytes4)" $EIP712_DIGEST $SIGNATURE --rpc-url $RPC
# Must return 0x1626ba7e (ERC1271_MAGIC_VALUE)
```

> **Layer 1 probe:** Call `isValidSignature` in isolation before wrapping anything
> in `redeemDelegations`. If this fails, the bug is in the digest or signature,
> not the delegation encoding.

---

## Step 6: Compute Delegation Hash (Off‑Chain)

The delegation hash is the EIP-712 struct hash of the delegation fields
excluding `signature`. **Always call `getDelegationHash()` on-chain and use its
returned `bytes32` directly for `_permissionContexts`.** Off-chain reproduction
must match standard EIP-712 struct hashing, not raw ABI encoding. If you must
compute it off-chain, use the algorithm from `reference/off-chain-hashing.md`.

**Using MetaMask standard SDK (recommended)**

```typescript
import { getDelegationHash } from '@metamask/smart-accounts-kit'
const delegationHash = getDelegationHash(delegation)
```

**Using on-chain (optional)**

```bash
cast call $DELEGATION_MANAGER "getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)" \
  "($DELEGATOR,$DELEGATE,$AUTHORITY,[($ENFORCER,$TERMS,$ARGS)],$SALT,$SIGNATURE)" \
  --rpc-url $RPC
```

Note: the on-chain ABI shown above includes the `signature` field in the struct parameter because that is the function's accepted type, but the returned hash is computed from the 5-field struct only.

## Step 6.5: Verification Gate (Mandatory)

Before broadcasting any transaction, verify that off-chain hashing matches on-chain:

```typescript
// 1. Compute struct hash off-chain using standard EIP-712 (see reference/off-chain-hashing.md)
const offChainHash = computeDelegationHash(delegation)

// 2. Read canonical hash from-chain
const onChainHash = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation) view returns (bytes32)']),
  functionName: 'getDelegationHash',
  args: [{
    delegator: delegation.delegator,
    delegate: delegation.delegate,
    authority: delegation.authority,
    caveats: delegation.caveats,
    salt: BigInt(delegation.salt),
    signature: delegation.signature,
  }],
})

// 3. Compare
if (offChainHash !== onChainHash) {
  throw new Error(`hash_mismatch: off-chain ${offChainHash} != on-chain ${onChainHash}`)
}
```

If the hashes don't match, the bug is in the off-chain struct-hash implementation
(most likely: array hashing done as raw `abi.encode` instead of per-element
`hashStruct`). Fix that before touching anything else.

---

## Step 7: Output the Signed Delegation Object

Emit exactly one signed delegation object for off‑chain transmission to the Agent.

> **Important:** The Agent receives this object off-chain. The delegation is not submitted on-chain at creation time. For the standard signature-based flow, `enableDelegation` is **not required**. The Agent should call `redeemDelegations` directly. If the delegator prefers not to sign off-chain, `enableDelegation` is an optional alternative that caches the delegation on-chain without a signature.

---

## Step 8: Enable the Delegation On-Chain (Optional)

If the delegator prefers not to use an off-chain EIP-712 signature, they can
call `enableDelegation(Delegation)` to cache the delegation on-chain. This is
**optional** — the standard sign → `redeemDelegations` flow does not need it.

The caller must be the delegator (`msg.sender == delegation.delegator`).

### Encode `enableDelegation` calldata

Use Node.js + ethers v6 for nested tuple encoding:

```bash
ENABLE_CALLDATA=$(node -e "
const { ethers } = require('ethers');
const fs = require('fs');
const delegation = JSON.parse(fs.readFileSync('delegation.json')).delegation;
const encoded = new ethers.AbiCoder().encode(
  ['(address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)'],
  [delegation]
);
console.log('0x3ed01015' + encoded.slice(2)); // enableDelegation selector
")
```

### Broadcast from the delegator

```bash
cast send $DELEGATION_MANAGER $ENABLE_CALLDATA \
  --private-key $DELEGATOR_PRIVATE_KEY \
  --rpc-url $RPC
```

### Verify delegation is enabled

```bash
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" \
  "$(cast call $DELEGATION_MANAGER \"getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)\" \"$(node -e \"const d=JSON.parse(require('fs').readFileSync('delegation.json')).delegation; console.log(d.delegate, d.delegator, d.authority, JSON.stringify(d.caveats), d.salt, d.signature)\")\" --rpc-url $RPC)" \
  --rpc-url $RPC
# Must return false
```

> **Note:** If `disabledDelegations` returns `true` immediately after `enableDelegation`, the delegation was stored in a disabled state. Create a new delegation with a new salt.

---

## Redelegation: Chained Authority

A delegate can redelegate authority to a downstream agent. Each link inherits parent restrictions.

### Flow

```
Main Account → Delegation A → Agent 1
Agent 1 → Delegation B (authority = hash(A)) → Agent 2
Agent 2 → Delegation C (authority = hash(B)) → Agent 3
```

### Encoding a Redelegation

Compute the parent hash off‑chain (same as Step 6) and set `authority` to that hash.

```typescript
const parentHash = getDelegationHash(parentDelegation)  // using SDK
const redelegation = {
  delegator: agent1Address,
  delegate: agent2Address,
  authority: parentHash,
  caveats: [...], // narrower
  salt: randomSalt,
  signature: '0x',
}
// Sign and compute hash the same way as above
```

**Rules:**

- Authority must chain to parent hash.
- Restrictions accumulate; cannot remove.
- Revoking parent kills all downstream.

---

## Error Patterns

| Error | Cause | Fix |
|---|---|---|
| `MultiVault_CannotApproveOrRevokeSelf` | Creation track attempted approve | Skip approve for creation track. It is only needed for the deposit track. |
| `DelegationManager_InvalidSignature` | Signature does not recover to delegator | Verify signing key; use correct EIP‑712 digest. |
| `DelegationManager_AuthorityNotFound` | Redelegation uses invalid parent hash | Verify parent hash computed correctly off‑chain. |
| `DelegationManager_CaveatViolation` | Enforcer address invalid or terms malformed | Verify enforcer address and ABI encoding. |
| `TypeError` (ABI mismatch) | Wrong struct encoding | Ensure field order and types match the Delegation struct. |
| `MultiVault_Unauthorized` (at redemption) | Deposit track: Smart Wallet lacks approval | Main Account must call `approve(SmartWallet, 3)` on MultiVault before deposit delegation redemption. |

---

## Protocol Invariants

1. **All hashing is off‑chain.** Do not call `domainSeparator` or `hashTypedData` on‑chain — they do not exist. `getDelegationHash` and `getDomainHash` do exist and should be read from-chain.
2. **The delegation is signed off‑chain** and submitted only at redemption time.
3. **Authority is non‑escalating** — redelegations only add restrictions.
4. **Salt must be unique** — use a cryptographically random `uint256` value.
5. **The Agent is the transaction submitter**, not the on-chain actor.
6. **EIP‑712 digest != delegation hash.** The digest is used for signing; the hash is used for tracking.
7. **Domain separator comes from-chain.** Always call `getDomainHash()` and use the returned bytes32 directly. Never reconstruct from guessed `name`/`version` literals.
8. **`permissionContext` comes from-chain.** Read `getDelegationHash()` on the DelegationManager and pass the returned bytes32 to `redeemDelegations` as `_permissionContexts[0]`. Do not compute it with `keccak256(abi.encode(delegation_struct))` — standard ABI encoding includes `signature` and uses raw tuple encoding for `caveats[]`, neither of which matches on-chain EIP-712 struct hashing.
9. **`enableDelegation` is optional.** The standard off-chain sign → `redeemDelegations` flow does not require it. Only use it if the delegator wants on-chain caching without a signature.
10. **Verification gate is mandatory.** Off-chain struct hash must match on-chain `getDelegationHash()` before signing. Signature recovery must match `delegation.delegator` before broadcast.
