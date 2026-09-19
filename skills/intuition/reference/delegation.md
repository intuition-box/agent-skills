# Delegation

Reference for ERC-7710 delegation concepts, Smart Account Kit integration,
and agent wallet setup. Use this file when building, signing, or redeeming
delegations on the Intuition Protocol.

**Prerequisites:** Load `reference/network-config.md` first for chain IDs,
RPC endpoints, and contract addresses.

---

## Table of Contents

- [Core Concepts](#core-concepts)
- [Two Delegation Paths](#two-delegation-paths)
- [Smart Account Kit Contract Addresses](#smart-account-kit-contract-addresses)
- [Delegation Struct Anatomy](#delegation-struct-anatomy)
- [Caveat Struct and Enforcer Validation](#caveat-struct-and-enforcer-validation)
- [Reading Delegation State](#reading-delegation-state)
- [Signing Flow: EIP-712](#signing-flow-eip-712)
- [Agent Wallet Setup](#agent-wallet-setup)
- [Permission Context Encoding](#permission-context-encoding)
- [Integration with Autonomous Policy](#integration-with-autonomous-policy)
- [Output Contracts](#output-contracts)
- [Error Patterns](#error-patterns)

---

## Core Concepts

A **delegation** is a signed, off-chain authorization that grants an **Agent**
the ability to execute specific on-chain actions on behalf of a **delegator**.
The Agent is purely a transaction submitter and gas payer. The on-chain identity
performing the action is always the delegator's address — either the Main
Account (via EIP-7702) or a separate Smart Account.

The Delegation Manager validates the delegation and triggers execution via
`executeFromExecutor` on the delegator. From MultiVault's perspective,
`msg.sender` is the delegator's address, not the Agent's.

**Key principle:** Approvals on MultiVault are **not transitive**. The Agent
does not inherit approvals held by a separate Smart Account. The Smart Account
holds the approval; the Agent merely triggers the Smart Account to use it.

---

## Security: Key Separation

The Intuition delegation flow involves two distinct private keys. They must
never be mixed or stored together.

| Role | Owner | Where it lives | May the skill persist it? |
|------|-------|----------------|--------------------------|
| **Delegator key** | User / Main Account | User's wallet only (MetaMask, hardware wallet, etc.) | **NO — never.** |
| **Agent key** | Agent | `~/.intuition/agent-wallet.json` (chmod 600) | **YES — required.** |

**Hard rules:**
1. The agent/skill must **never** write the delegator's private key to disk, logs, chat, or any artifact.
2. The delegator's private key is a session-only variable (`DELEGATOR_PRIVATE_KEY`). It is not persisted.
3. Only the agent's private key may be saved to `~/.intuition/agent-wallet.json`.
4. If you are the agent and the user shares their private key with you, you must refuse to persist it and warn them that sharing private keys is unsafe.

---

## Unified Delegation Architecture

> **Model (2026-09):** "Main Account = beneficial owner everywhere." The old
> "Path 1 vs Path 2" dichotomy is retired. Delegated operations now use two
> **complementary tracks** that compose together:
>
> 1. **Creation Authority** — Main Account → OWS → Agent (one-time, revocable)
> 2. **Deposit/Redemption Authority** — Main Account → approve(Smart Wallet) → Smart Wallet → Agent (standing)
>
> Both tracks share the same DelegationManager, encoding rules, and signing
> flow. They differ only in delegator type, setup, and lifecycle.

### Creation Authority Track

Used for `createAtoms` and `createTriples` — operations that have no `receiver` parameter.

**Setup (one-time, Main Account key required):**
1. Main Account signs EIP-7702 delegation to OWS (creation authority)
2. OWS signs EIP-712 delegation to Agent (cached until revoked)
3. Optionally: revoke OWS→Main Account delegation after creation is complete

**Operation:**
- Agent calls `redeemDelegations` with the chain `[Main Account → OWS, OWS → Agent]`
- `msg.sender` at MultiVault = OWS
- Atoms/triples are created with OWS as `msg.sender` in events
- This is acceptable: creation attribution does not carry semantic weight

**Characteristics:**
- OWS is a temporary EIP-7702 upgraded wallet (session-only)
- Main Account key used once for setup, then shelved
- Revocable: revoke OWS delegation after creation setup
- No `approve` needed on MultiVault (creation doesn't check approvals)

### Deposit/Redemption Authority Track

Used for `deposit`, `redeem`, `depositBatch`, `redeemBatch` — operations with a `receiver` parameter.

**Setup (one-time, Main Account key required):**
1. Main Account calls `approve(SmartWallet, 3)` on MultiVault (signed in MetaMask)
2. Smart Wallet signs EIP-712 delegation to Agent (cached)
3. Optional: Main Account grants ERC-7715 stream to Smart Wallet for funding

**Operation:**
- Agent calls `redeemDelegations` with delegation `[Smart Wallet → Agent]`
- `msg.sender` at MultiVault = Smart Wallet
- `receiver = Main Account` routes shares correctly
- Main Account is the beneficial owner of all positions

**Characteristics:**
- Smart Wallet is a persistent contract or agent-held key
- `approve(SmartWallet, 3)` is standing until revoked
- Revocable: revoke Smart Wallet delegation or remove `approve`
- `receiver` override guarantees Main Account ownership

### Key Separation (4 roles)

| Role | Owner | Where it lives | May the skill persist it? |
|------|-------|----------------|---------------------------|
| **Main Account key** | User / Main Account | User's wallet only (MetaMask, hardware) | **NO** |
| **OWS key** | Temporary (session-only) | Session memory, discarded after setup | Optional — only during setup window |
| **Smart Wallet key** | Agent | Agent secure storage | **YES** |
| **Agent key** | Agent | `~/.intuition/agent-wallet.json` (chmod 600) | **YES** |

**Hard rules:**
1. The agent/skill must **never** write the Main Account private key to disk, logs, chat, or any artifact.
2. The Main Account private key is a session-only variable during setup. It is not persisted.
3. Only the Agent's and Smart Wallet's private keys may be saved.

### When to use which track

| Scenario | Track |
|---|---|
| Create atoms/triples only | Creation Authority |
| Deposit/redeem only | Deposit/Redemption Authority |
| Full agent (create + deposit) | Both tracks (compose) |
| No delegation needed | Direct (Path B) — no delegation |

### Composition example (full agent setup)

```
Phase 1 — Setup (Main Account key, one-time):
  Main Account --(EIP-7702 delegation)--> OWS
  OWS --(EIP-712 delegation)--> Agent
  Main Account --(approve)--> Smart Wallet
  Smart Wallet --(EIP-712 delegation)--> Agent
  [Main Account key goes back in vault]

Phase 2 — Operations (Agent autonomous):
  Agent creates atoms:  redeemDelegations([MainAcc→OWS, OWS→Agent], createAtoms(...))
  Agent deposits:        redeemDelegations([SmartWallet→Agent], deposit(receiver: MainAcc, ...))

Phase 3 — Management (optional):
  Revoke OWS→Main Account delegation (creation setup complete)
  Revoke Smart Wallet delegation (kill switch for deposits)
```

---

## Smart Account Kit Contract Addresses

| Contract | Mainnet (1155) | Testnet (13579) | Notes |
|----------|---------------|-----------------|-------|
| **DelegationManager** | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | Deterministic CREATE2, fixed `"GATOR"` salt. Testnet verified via live `DisabledDelegation` log. Mainnet inferred from same CREATE2 guarantee. |
| **EIP7702 DeleGator Impl** | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` | Confirmed labeled on block explorers. Designator pattern: `0xef0100` + this address. |
| **AllowedMethodsEnforcer** | `TBD` | `0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5` | Testnet confirmed. Mainnet address pending verification. |

**ERC-7579 execution mode:**
- `MODE_SINGLE_DEFAULT` = `0x0000000000000000000000000000000000000000000000000000000000000000` (32 zero bytes)

---

## Constants

```typescript
const ERC1271_MAGIC_VALUE = '0x1626ba7e'  // bytes4 return value for valid ERC-1271 signatures
const MODE_SINGLE_DEFAULT = '0x0000000000000000000000000000000000000000000000000000000000000000'
```

---

## Delegation Struct Anatomy

```solidity
struct Delegation {
  address delegator;      // The authority owner (Main Account or Smart Account)
  address delegate;       // The Agent wallet address that will redeem
  bytes32 authority;      // ROOT_AUTHORITY (0xffff...ffff) for fresh delegation;
                          // parent delegation hash for redelegation
  Caveat[] caveats;       // Restrictions enforced by the DelegationManager
  uint256 salt;           // Replay protection nonce
  bytes signature;        // EIP-712 signature from delegator
}
```

### ROOT_AUTHORITY vs Chained Authority

| Authority Value | Meaning |
|-----------------|---------|
| `0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` | **ROOT_AUTHORITY** — the delegator is delegating its own native authority. Use for the first delegation in any chain. |
| `keccak256(abi.encode(parentDelegation))` | **Chained authority** — the delegator is redelegating authority it received from a parent delegation. The DelegationManager validates the full chain. |

---

## Caveat Struct and Enforcer Validation

```solidity
struct Caveat {
  address enforcer;       // CaveatEnforcer contract address
  bytes terms;            // Static restriction parameters (encoded at creation)
  bytes args;             // Runtime arguments (encoded at redemption)
}
```

### How Enforcers Are Validated

When a delegation is redeemed, the DelegationManager runs a **beforeHook →
execution → afterHook** sequence for each caveat:

1. **beforeHook:** Validates preconditions before execution. Reverts if terms
   are violated.
2. **Execution:** The delegator's code runs the encoded call.
3. **afterHook:** Validates postconditions. Reverts if execution violated terms.

### Built-In Enforcer Types

| Enforcer | What It Restricts | Terms Encoding | Args Encoding |
|----------|-------------------|----------------|---------------|
| **AllowedMethodsEnforcer** | Which function selectors the Agent can call | Raw concatenated `bytes4` selectors | `0x` |
| **NativeTokenTransferAmountEnforcer** | Cumulative native token (TRUST) spend across all redemptions | `abi.encode(uint256 maxCumulativeSpend)` | `0x` |
| **LimitedCallsEnforcer** | Total number of redemption calls allowed | `abi.encode(uint256 maxCalls)` | `0x` |

**Important:** `NativeTokenTransferAmountEnforcer` is a **global cumulative**
cap, not a periodic rate limit. True periodic rate-limiting (e.g., "100 TRUST
per day") is not available as a built-in ERC-7710 caveat enforcer. Agents may
implement self-enforced daily budgets in addition to on-chain caps.

### Example: Intuition Operation Allowlist

Encode the allowed function selectors for Intuition operations.

> **Critical:** `AllowedMethodsEnforcer` expects **raw concatenated bytes4 selectors** (e.g., `"0x61403309"`), NOT ABI-encoded `bytes4[]`. Using `abi.encode(bytes4[])` produces an array header that `decodeSingle()` misreads as the first selector.

```bash
# Using cast — raw concatenation, NOT abi-encode bytes4[]
SELECTOR_CREATE_ATOMS=$(cast sig "createAtoms(bytes[],uint256[])")
SELECTOR_DEPOSIT=$(cast sig "deposit(address,bytes32,uint256,uint256)")
ALLOWED_METHODS_TERMS="0x${SELECTOR_CREATE_ATOMS#0x}${SELECTOR_DEPOSIT#0x}"
```

```typescript
// Using viem — raw concatenation
const selectors = [
  toFunctionSelector('createAtoms(bytes[],uint256[])'),
  toFunctionSelector('deposit(address,bytes32,uint256,uint256)'),
]
const allowedMethodsTerms = '0x' + selectors.map(s => s.replace('0x', '')).join('')
```

---

## Reading Delegation State

The DelegationManager does not expose view functions for querying delegation
validity (signature recovery, structural checks) — those are handled off-chain
via `@metamask/smart-accounts-kit` utilities. However, it **does** expose
`disabledDelegations(bytes32 delegationHash)` to check on-chain revocation status.

### Computing the Delegation Hash (Off-Chain)

Use the MetaMask Smart Accounts Kit to compute the delegation hash:

```typescript
import { getDelegationHash } from '@metamask/smart-accounts-kit'

const delegationHash = getDelegationHash(delegation)
```

The hash is a `keccak256` of the ABI-encoded `Delegation` struct, consistent
with the EIP-712 `Delegation` type used for signing. Agents should store this
hash alongside the delegation object in secure session state.

### Checking if a Delegation is Disabled (On-Chain)

The DelegationManager exposes `disabledDelegations(bytes32)` to check if a delegation
has been revoked:

```bash
# Using cast
DELEGATION_HASH=$(node -e "
const { ethers } = require('ethers');
const delegation = { delegator: '$DELEGATOR', delegate: '$DELEGATE', authority: '$AUTHORITY', caveats: [/*...*/], salt: '$SALT', signature: '$SIGNATURE' };
const encoded = new ethers.AbiCoder().encode(
  ['(address delegator, address delegate, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)'],
  [delegation]
);
console.log(ethers.keccak256(encoded));
")
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" "$DELEGATION_HASH" --rpc-url $RPC
# Returns true if disabled/revoked, false if active
```

```typescript
// Using viem
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem'

// Compute the delegation hash off-chain
const encoded = encodeAbiParameters(
  parseAbiParameters('(address delegator, address delegate, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)'),
  [delegation]
)
const delegationHash = keccak256(encoded)

const isDisabled = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi([
    'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  ]),
  functionName: 'disabledDelegations',
  args: [delegationHash],
})
```

### Revoking a Delegation

Before revoking, compute the delegation hash off-chain and verify the delegation is currently active using `disabledDelegations(bytes32)` as shown in the section above.

Call `disableDelegation(delegation)` on the DelegationManager:

```bash
# Encode the disableDelegation call
DISABLE_CALLDATA=$(cast calldata "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))" "$DELEGATION_STRUCT")
```

```typescript
// Using viem
const hash = await walletClient.writeContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi([
    abi: parseAbi(['function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation) view returns (bytes32)']),
  ]),
  functionName: 'disableDelegation',
  args: [delegation],
  account: delegatorAccount, // must be the delegator
})
```

The caller must be the delegator (`msg.sender == delegation.delegator`).
Revocation is permanent and propagates to all downstream redelegations.

### Check Expiry (via Caveat)

If the delegation includes an expiry caveat, decode the terms to get the
expiry timestamp and compare against the current block:

```bash
EXPIRY_TIMESTAMP=$(cast --to-dec $TERMS)  # if terms is a single uint256
cast block-number --rpc-url $RPC
# Compare: if block.timestamp > EXPIRY_TIMESTAMP, delegation is expired
```

```typescript
const expiryTimestamp = decodeAbiParameters([{ type: 'uint256' }], caveat.terms)[0]
const currentTimestamp = BigInt((await client.getBlock()).timestamp)
const isExpired = currentTimestamp > expiryTimestamp
```

---

## Signing Flow: EIP-712

Delegations are signed using EIP-712 typed data with a fixed domain.

### EIP-712 Domain

**Read the domain separator from-chain. Never reconstruct it from guessed
`name`/`version` literals.**

The DelegationManager exposes `getDomainHash()` (selector `0x83ebb771`).
Call it first and use the returned `bytes32` directly as the domain separator
in the EIP-712 digest: `keccak256("\x19\x01" ++ domainSeparator ++ structHash)`.

```bash
# Read the real domain separator
cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC
```

```typescript
const domainHash = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function getDomainHash() view returns (bytes32)']),
  functionName: 'getDomainHash',
})
```

Use `domainHash` as the domain separator in the signing digest. If you need the
literal `name`/`version` for type definitions, confirm them against the verified
contract source — do not guess.

### EIP-712 Types

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

### Signing with EOA (Delegator)

```typescript
import { signTypedData } from 'viem'

const signature = await signTypedData({
  privateKey: delegatorPrivateKey,
  domain,
  types,
  primaryType: 'Delegation',
  message: {
    delegate: delegateAddress,
    delegator: delegatorAddress,
    authority: ROOT_AUTHORITY,
    caveats: [
      { enforcer: allowedMethodsEnforcer, terms: allowedMethodsTerms, args: '0x' },
      { enforcer: nativeTokenEnforcer, terms: spendCapTerms, args: '0x' },
    ],
    salt: randomUint256(),
  },
})
```

### Mandatory Pre-Broadcast Check

Before broadcasting any delegation transaction, verify the signature recovers
to the correct delegator:

```typescript
import { recoverTypedDataAddress } from 'viem'

const recovered = await recoverTypedDataAddress({
  domain,
  types,
  primaryType: 'Delegation',
  message: {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats,
    salt: delegation.salt,
  },
  signature: delegation.signature,
})

if (recovered.toLowerCase() !== delegation.delegator.toLowerCase()) {
  throw new Error('signature_invalid: recovered address does not match delegator')
}
```

> **Critical:** Recover the signer from the EIP-712 digest + signature and
> confirm it equals `delegation.delegator` byte-for-byte. If using a signing
> library that exposes `yParity` as a separate 0/1 field, normalize it to
> `v = 27 + yParity` (or use the library's fully-assembled signature output
> directly) and re-verify recovery after normalizing.
```

### ERC-1271 Verification for Contract Delegators

If the delegator is a smart contract (e.g., a UUPS DeleGator or EIP-7702
account), verify the signature via `isValidSignature` **before** any delegation
transaction. This is an isolated on-chain call that does not require a transaction.

```bash
# Compute the EIP-712 digest off-chain first
# Use @metamask/smart-accounts-kit or manual encoding (see reference/off-chain-hashing.md)
EIP712_DIGEST="0x..."

# Validate via ERC-1271
MAGIC=$(cast call $DELEGATOR "isValidSignature(bytes32,bytes)(bytes4)" $EIP712_DIGEST $SIGNATURE --rpc-url $RPC)
test "$MAGIC" = "0x1626ba7e" || { echo "ERC-1271 signature invalid"; exit 1; }
```

```typescript
const magicValue = await client.readContract({
  address: delegation.delegator,
  abi: parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']),
  functionName: 'isValidSignature',
  args: [eip712Digest, delegation.signature],
})

if (magicValue !== '0x1626ba7e') {
  throw new Error('signature_invalid: ERC-1271 magic value mismatch')
}
```

The constant value for ERC-1271 valid signature is:

```typescript
const ERC1271_MAGIC_VALUE = '0x1626ba7e'  // left-padded to 32 bytes on-chain
```

> **Layer 1 probe:** Call `isValidSignature` in isolation before wrapping anything
> in `redeemDelegations`. If this fails, the bug is in the digest or signature,
> not the delegation encoding.

---

## Agent Wallet Setup

The Agent needs its own wallet — the address that will receive the delegation
from the delegator. This wallet is used only to sign redemption transactions
(submitting `redeemDelegations` to the DelegationManager), not to sign the
Intuition operations themselves.

### Generate Agent Wallet Using OpenWallet

```bash
# Install OpenWallet (if not already installed)
npm install -g @openwallet/cli

# Generate a new EVM wallet
openwallet generate --chain eip155 --name intuition-agent

# Export the address
AGENT_ADDRESS=$(openwallet address --name intuition-agent)
echo "Agent address: $AGENT_ADDRESS"
```

**Expose this address to the delegator.** The delegator uses it as the
`delegate` field when creating the delegation.

> **Critical:** If you do not persist the private key now, it is unrecoverable.
> The agent cannot sign `redeemDelegations` without it. Save the key to a
> durable, permission-restricted file before proceeding.

### Persisting the Agent Key (Mandatory)

After generating the agent wallet, write the **agent's** key material to a secure file:

```bash
mkdir -p ~/.intuition
chmod 700 ~/.intuition

cat > ~/.intuition/agent-wallet.json <<EOF
{
  "address": "$AGENT_ADDRESS",
  "privateKey": "$AGENT_PRIVATE_KEY"
}
EOF

chmod 600 ~/.intuition/agent-wallet.json
```

> **AGENT KEY ONLY.** `agent-wallet.json` must contain **only the agent's private key**. It must **never** contain the delegator's private key. The delegator's key stays in the user's own wallet and is never written to disk by the agent or skill. If you are unsure which key is which, do not write anything.

Treat `agent-wallet.json` as a secret. Do not commit it to git, paste it in
chat, or store it in world-readable locations. If the file is lost, the
delegation cannot be used and the delegator must issue a new delegation to a
new agent address.

### Fallback: Generate with cast

If OpenWallet is unavailable, use Foundry:

```bash
# Generate a new private key
cast wallet new
# Returns: Address + Private Key

# Export for session use
AGENT_ADDRESS="0x..."
AGENT_PRIVATE_KEY="0x..."
```

After generation, persist immediately using the same `~/.intuition/agent-wallet.json` pattern above.

### Fallback: Generate with viem

```typescript
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const privateKey = generatePrivateKey()
const account = privateKeyToAccount(privateKey)
const agentAddress = account.address
```

### Signing Redemption Transactions

When exercising delegated authority, the Agent signs the `redeemDelegations`
transaction with its own key:

```bash
# Using cast (sign and broadcast)
cast send $DELEGATION_MANAGER "redeemDelegations(bytes[],bytes32[],bytes[])"   "[$PERMISSION_CONTEXT]"   "[$MODE_SINGLE_DEFAULT]"   "[$EXECUTION_CALLDATA]"   --rpc-url $RPC   --private-key $AGENT_PRIVATE_KEY
```

```typescript
// Using viem
const hash = await walletClient.writeContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function redeemDelegations(bytes[] calldata _permissionContexts, bytes32[] calldata _modes, bytes[] calldata _executionCallData) external']),
  functionName: 'redeemDelegations',
  args: [[permissionContext], [MODE_SINGLE_DEFAULT], [executionCallData]],
  account: agentAccount,
})
```

---

## Permission Context Encoding

The `redeemDelegations` function accepts `bytes[] calldata _permissionContexts`.
**Each element must be `abi.encode(Delegation[])` — a flat array of Delegation structs.**

The contract decodes each context with `abi.decode(_permissionContexts[batchIndex_], (Delegation[]))`.
There is NO separate `bytes32 delegationHash` tuple element. Including one causes
an `abi.decode` mismatch.

> **Note:** This differs from the standard MetaMask Delegation Framework which uses
> a 2-element tuple `(Delegation[], bytes32 delegationHash)`. The Intuition fork
> uses only `abi.encode(Delegation[])`.

### Computing the delegation hash

The safest approach is to call `getDelegationHash(delegation)` on-chain and use
its returned `bytes32` directly. The on-chain hash is computed from the delegation
fields excluding `signature`, using standard EIP-712 struct hashing rules:
- Dynamic arrays like `Caveat[]` are hashed per-element with
  `hashStruct(caveat)` and then concatenated with `abi.encodePacked(...)`
  before the final `keccak256`
- `args` is excluded from each caveat's hash
- `signature` is excluded from the delegation hash

Off-chain reproduction must match this exact encoding. A naive `keccak256(abi.encode(delegation_struct))`
will NOT match because standard ABI tuple encoding includes `signature` and uses
raw tuple encoding for `caveats[]`, neither of which matches on-chain EIP-712 struct
hashing.

### Using cast (requires helper script)

```bash
# Step 1: Encode the full delegation struct off-chain
ENCODED=$(cast abi-encode "(address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)" \
  "$DELEGATOR" "$DELEGATE" "$AUTHORITY" \
  "[($ENFORCER1,$TERMS1,$ARGS1),($ENFORCER2,$TERMS2,$ARGS2)]" \
  "$SALT" "$SIGNATURE")

# Step 2: Hash it — this is what goes in _permissionContexts
PERMISSION_CONTEXT=$(cast keccak $ENCODED)
```

### Using viem (manual — standard EIP-712 struct hash)

```typescript
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem'

const encoded = encodeAbiParameters(
  parseAbiParameters('(address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]'),
  [[{
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats,
    salt: delegation.salt,
    signature: delegation.signature,
  }]]
)

const permissionContext = encoded
```

**Do NOT wrap in a 2-element tuple with `delegationHash`.** The contract decodes
each context as `(Delegation[])` only.

---

## Enabling a Delegation On-Chain

After creating and signing a delegation off-chain, you must **explicitly enable it** on-chain before it can be redeemed. The DelegationManager does not auto-enable delegations.

### Step 1: Encode `enableDelegation` calldata

```bash
# Using Node.js + ethers v6 (recommended for nested tuples)
ENABLE_CALLDATA=$(node -e "
const { ethers } = require('ethers');
const delegation = { /* full delegation object */ };
const data = new ethers.AbiCoder().encode(
  ['(address delegator, address delegate, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)'],
  [delegation]
);
console.log('0x3ed01015' + data.slice(2)); // enableDelegation selector = 0x3ed01015
")
```

### Step 2: Broadcast from the delegator

```bash
cast send $DELEGATION_MANAGER $ENABLE_CALLDATA \
  --private-key $DELEGATOR_PRIVATE_KEY \
  --rpc-url $RPC
```

### Step 3: Verify

```bash
# Compute delegation hash off-chain
DELEGATION_HASH=$(node -e "
const { ethers } = require('ethers');
const delegation = { delegator: '$DELEGATOR', delegate: '$DELEGATE', authority: '$AUTHORITY', caveats: [/*...*/], salt: '$SALT', signature: '$SIGNATURE' };
const encoded = new ethers.AbiCoder().encode(
  ['(address delegator, address delegate, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)'],
  [delegation]
);
console.log(ethers.keccak256(encoded));
")
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" "$DELEGATION_HASH" --rpc-url $RPC
# Must return false
```

> **Note:** `enableDelegation` is optional, not mandatory. For the standard
> signature-based flow (delegator signs off-chain, Agent calls
> `redeemDelegations` directly), `enableDelegation` is **not required**. The
> Agent should attempt `redeemDelegations` directly. Only use `enableDelegation`
> if the delegator prefers not to provide an EIP-712 signature.

---

## Integration with Autonomous Policy

When running in autonomous mode, authority verification is a gate that runs
**before** the transaction is emitted. The full flow is:

1. Load autonomous policy from `reference/autonomous-policy.md`
2. Verify delegation (signature, expiry, revocation, caveats) per
   `reference/delegation-authority.md`
3. If deposit track, simulate to confirm MultiVault approval exists from the Main Account to the Smart Wallet
4. Verify receiver consistency: `receiver` in the inner transaction must match
   the expected Main Account address
5. If all checks pass, emit the nested transaction object
6. If any check fails, emit an `approval_required` or `delegation_failure`
   object and halt

See `reference/autonomous-policy.md` for the full policy schema, decision flow,
and output contracts.

---

## Output Contracts

### Signed Delegation Object (Off-Chain)

When creating a delegation, output the signed object for transmission to the
Agent:

```json
{
  "delegation": {
    "delegator": "0x<delegator-address>",
    "delegate": "0x<agent-address>",
    "authority": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "caveats": [
      {
        "enforcer": "0x<enforcer-address>",
        "terms": "0x<encoded-terms>",
        "args": "0x"
      }
    ],
    "salt": "<random-uint256>",
    "signature": "0x<signature>"
  },
  "delegationHash": "0x<keccak256-of-delegation>"
}
```

### Nested Transaction Object (Delegated Execution)

When the Agent redeems a delegation to perform an Intuition write, the skill
outputs a **nested** transaction structure:

**Inner transaction** (what the delegator executes):
```json
{
  "to": "0x<multivault-address>",
  "data": "0x<intuition-calldata>",
  "value": "<wei-as-base-10-string>"
}
```

**Outer transaction** (what the Agent submits):
```json
{
  "to": "0x<delegation-manager-address>",
  "data": "0x<redeemDelegations-calldata>",
  "value": "0",
  "chainId": "<chain-id-as-base-10-string>",
  "delegationContext": {
    "delegationHash": "0x<hash>",
    "delegator": "0x<delegator-address>",
    "wrappedOperation": "createAtoms",
    "caveatChecks": "pending"
  }
}
```

**Critical rule:** The Agent sets `value = 0` on the outer transaction. All
TRUST value is carried in the **inner** transaction's `value` field.

---

## Error Patterns

| Error | Cause | Fix |
|-------|-------|-----|
| `MultiVault_CannotApproveOrRevokeSelf` | Deposit track: attempted `approve` with `receiver == sender` | Skip the `approve` step for the creation track. `approve` is only needed for the deposit/redemption track. |
| `DelegationManager_InvalidSignature` | EIP-712 signature does not recover to delegator address | Verify the signing key matches the delegator. For contract delegators, ensure ERC-1271 `isValidSignature` returns `0x1626ba7e` (`ERC1271_MAGIC_VALUE`). |
| `DelegationManager_DelegationDisabled` (or `disabledDelegations` returns `true`) | Delegation has been disabled/revoked on-chain | The delegator must create a new delegation. Revocation is permanent. |
| `DelegationManager_CaveatViolation` | A caveat's `beforeHook` or `afterHook` reverted | Check caveat terms against the intended operation. Common causes: disallowed function selector, cumulative spend exceeded, call count exceeded. |
| `MultiVault_Unauthorized` | Deposit track: Smart Wallet lacks `approve` from Main Account | Main Account must call `approve(SmartWallet, 3)` on MultiVault before deposit delegation redemption. |
| `DelegationManager_AuthorityNotFound` | Redelegation uses a parent delegation hash that does not exist or is invalid | Verify the parent delegation was created and signed correctly. Compute the parent hash off-chain and ensure the `authority` field matches it. |

---

## Protocol Invariants

01. **The Agent is never the on-chain actor.** `msg.sender` at MultiVault is
the delegator's address (Smart Account or Main Account), not the Agent.

02. **Approvals are not transitive.** The Agent does not inherit MultiVault
approvals held by a separate Smart Account. The Smart Account holds the
approval; the Agent triggers it.

03. **Nested value placement.** All `msg.value` lives in the inner transaction.
The outer `redeemDelegations` call carries `value = 0`.

04. **Receiver binding is non-negotiable.** For receiver-bearing operations, the receiver MUST be the Main Account. Any other value is a hard failure.

05. **Creation track bypasses approve.** In the creation authority track, the OWS cannot and need not approve itself on MultiVault. The `approve` prerequisite exists only for the deposit/redemption track (Smart Wallet architecture).

06. **Cumulative vs periodic caps.** `NativeTokenTransferAmountEnforcer` caps
total cumulative spend, not a rolling daily rate. Agents should implement
self-enforced daily budgets if periodic limits are required.

07. **`salt` is `uint256`.** The on-chain `Delegation` struct uses `uint256
salt`. Passing `bytes32 salt` causes `abi.decode` failures in the
DelegationManager.

08. **`disabledDelegations(bytes32)` is the only revocation view.** The DelegationManager does
not expose `isRevoked(bytes32)`. Call `getDelegationHash()` on-chain and pass the returned
bytes32 to `disabledDelegations(bytes32)`. Do not use `isRevoked(bytes32)` or `isDisabled(Delegation)`.

09. **`getDelegationHash(Delegation)` exists on-chain** (`0x66134607`). `getDomainHash()` also exists (`0x83ebb771`). Off-chain computation is preferred only to avoid an extra RPC round-trip. Always read the domain separator from `getDomainHash()` — do not reconstruct it from guessed `name`/`version` literals.

10. **`permissionContext` is `abi.encode(Delegation[])` — a flat array of Delegation structs.** There is NO separate `bytes32 delegationHash` tuple element. Including one causes an `abi.decode` mismatch. This differs from standard MetaMask Delegation Framework which uses a 2-element tuple.

11. **`execCallData` must use `solidityPacked(address,uint256,bytes)`.** The inner execution data for ERC-7579 single-call mode must be flat-packed. Using `abi.encode(tuple)` adds a 32-byte offset pointer that shifts all fields and causes `decodeSingle` to read garbage.

12. **`AllowedMethodsEnforcer` terms are raw bytes4 selectors.** `decodeSingle()` reads 4-byte chunks directly from `_terms`. Using `abi.encode(bytes4[])` produces an array header that is misread as the first selector.

13. **`LimitedCallsEnforcer` terms are `abi.encode(uint256)`.** NOT raw bytes.

14. **`enableDelegation` is optional.** For the standard signature-based flow
(delegator signs off-chain, Agent calls `redeemDelegations`), `enableDelegation`
is not required. It is an optional caching alternative for delegators who do not
want to provide an EIP-712 signature.

15. **Signature verification is a layered gate.** Run ERC-1271 `isValidSignature` in isolation (Layer 1) before composing any `redeemDelegations` calldata. Pin domain hash from `getDomainHash()` on-chain (Layer 2). Verify struct hash on-chain via `getDelegationHash()` (Layer 3). Recover signature to correct address (Layer 4). Only after all layers pass, encode the nested transaction.
