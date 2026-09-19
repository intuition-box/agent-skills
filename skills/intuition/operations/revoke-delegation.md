# disableDelegation

Disable (revoke) a delegation on-chain. The delegator calls this with the full Delegation struct. Once disabled, the delegation is permanently invalid and all downstream redelegations die.

**Requires:** `$RPC`, `$CHAIN_ID`, `$DELEGATION_MANAGER` from session setup (`reference/reading-state.md`).

**Output:** One executable unsigned transaction object.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Revocation vs Expiry: When to Use Each](#revocation-vs-expiry-when-to-use-each)
- [Step 1: Identify the Delegation to Revoke](#step-1-identify-the-delegation-to-revoke)
- [Step 2: Encode the disableDelegation Transaction](#step-2-encode-the-disabledelegation-transaction)
- [Step 3: Output the Executable Transaction](#step-3-output-the-executable-transaction)
- [Propagation Rules](#propagation-rules)
- [Batch Revocation](#batch-revocation)
- [Error Patterns](#error-patterns)
- [Protocol Invariants](#protocol-invariants)
- [Quick Reference](#quick-reference)

---

## Prerequisites

Before revoking a delegation, resolve the following:

1. **Delegator address** — the authority owner that signed the delegation. Must match the `delegator` field of the Delegation struct.
2. **Full Delegation struct** — the complete signed Delegation object (including `delegator`, `delegate`, `authority`, `caveats`, `salt`, and `signature`). You must have the original struct, not just a hash.
3. **Revoker key** — the private key or signing authority that controls the delegator address. For the creation track (OWS), this is the Main Account's EOA key or the OWS key. For the deposit track (Smart Wallet), this is the signing authority embedded in or controlling the Smart Wallet contract.

> **Security Warning:** The revoker key is the **delegator's** private key. It must **never** be written to disk by the agent or skill. It exists only as an in-memory session variable. The user is responsible for keeping it in their own wallet. The agent must not persist, log, or transmit the delegator's private key. Only the **agent's** private key may be saved to `~/.intuition/agent-wallet.json`.

4. **DelegationManager address** — from `reference/network-config.md` or `reference/delegation.md`.
5. **Revocation authority** — only the delegator (or an address the delegator has explicitly authorized) can revoke. The DelegationManager verifies the revoker's identity via `msg.sender == delegation.delegator`.
6. **Struct Validation** — read the delegation hash from-chain and confirm it matches the stored `delegationHash`:

```typescript
const delegationHash = await client.readContract({
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

if (delegationHash !== originalDelegationHash) {
  throw new Error('Delegation struct mismatch: on-chain hash does not match original')
}
```

A mismatch indicates the struct fields (caveats, salt, signature) have been altered. Use the original signed object.

---

## Revocation vs Expiry: When to Use Each

| Mechanism | On-Chain? | Gas Cost | Scope | Reversible? | When to Use |
|---|---|---|---|---|---|
| On-chain disable | Yes | Low (~0.0001 TRUST) | Permanent; kills root and all downstream | No | Security incident, immediate termination, lost Agent key, policy breach |
| Expiry caveat | No | Zero | Single delegation only | No | Planned expiration, time-boxed sessions, scheduled rotation |
| Redelegation expiry | No | Zero | That delegation only | No | Sub-agent timeout without killing parent |

### Use On-Chain Disable When

- The Agent's key is compromised or lost.
- The Agent has violated policy or caveats.
- You need to terminate authority immediately — expiry waits for the timestamp to pass.
- You want to kill an entire chain of redelegations at once.

### Use Expiry When

- The delegation was intentionally time-boxed (e.g., a 7-day session).
- You want passive invalidation without spending gas.
- You only need to terminate a single delegation, not its children.

> **Critical difference:** Expiry only affects the delegation that carries the expiry caveat. Disabling a root delegation kills the root, all redelegations, and all sub-agents in one transaction.

---

## Step 1: Identify the Delegation to Revoke

You must have the full Delegation struct to call `disableDelegation`. The DelegationManager does not expose a `revokeDelegation(bytes32)` function — it requires the complete struct.

### Option A: You Have the Full Signed Delegation Object

If you have the full Delegation object from `operations/create-delegation.md`, extract the struct:

```json
{
  "delegation": {
    "delegate": "0x...",
    "delegator": "0x...",
    "authority": "0x...",
    "caveats": [...],
    "salt": "0x...",
    "signature": "0x..."
  }
}
```

Export the values:

```bash
# NOTE: The Standard MetaMask uses field order (delegate FIRST, then delegator)
DELEGATE="0x..."
DELEGATOR="0x..."
AUTHORITY="0x..."
CAVEATS="[($ENFORCER1,$TERMS1,0x),($ENFORCER2,$TERMS2,0x)]"
SALT="0x..."
SIGNATURE="0x..."
DELEGATION_STRUCT="($DELEGATE,$DELEGATOR,$AUTHORITY,$CAVEATS,$SALT,$SIGNATURE)"
```

### Option B: You Only Have the Delegation Parameters

If you have the raw parameters but not the full struct, reconstruct it:

```bash
# NOTE: The Standard MetaMask uses field order (delegate FIRST, then delegator)
DELEGATE="0x..."
DELEGATOR="0x..."
AUTHORITY="0x..."
CAVEATS="[($ENFORCER,$TERMS,$ARGS)]"
SALT="0x..."
SIGNATURE="0x..."
DELEGATION_STRUCT="($DELEGATE,$DELEGATOR,$AUTHORITY,$CAVEATS,$SALT,$SIGNATURE)"
```

### Option C: Query DelegationManager Events

If you have lost the delegation object, query the DelegationManager for `DisabledDelegation` events emitted by the delegator's address. However, this only returns the delegation hash — you still need the original struct to call `disableDelegation`. If the struct is lost, the delegator must create a new delegation instead of disabling the old one.

```bash
# Query all DisabledDelegation events for this delegator
cast logs \
  --from-block 0 \
  --address $DELEGATION_MANAGER \
  --topic0 $(cast sig-event "DisabledDelegation(bytes32,address)") \
  --topic1 $(cast --to-uint256 $DELEGATOR) \
  --rpc-url $RPC
```

```typescript
const logs = await client.getLogs({
  address: DELEGATION_MANAGER,
  event: parseAbiItem('event DisabledDelegation(bytes32 indexed delegationHash, address indexed delegator)'),
  args: { delegator: delegatorAddress },
  fromBlock: 0n,
})
```

---

## Step 2: Encode the disableDelegation Transaction

`disableDelegation` takes the full Delegation struct as its only argument. The caller must be the delegator (`msg.sender == delegation.delegator`).

### Canonical Intuition L3 Interface

On Intuition mainnet (1155) and testnet (13579), the DelegationManager exposes:

```solidity
function disableDelegation(
  (address delegator, address delegate, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation
) external;
```

> **Important:** This is `disableDelegation`, not `revokeDelegation(bytes32)`. The function takes the full struct, not a hash.

### Using cast

```bash
# Encode the disableDelegation call
DISABLE_CALLDATA=$(cast calldata "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))" \
  "$DELEGATION_STRUCT")
```

### Using viem

```typescript
import { encodeFunctionData, parseAbi } from 'viem'

const data = encodeFunctionData({
  abi: parseAbi([
    'function disableDelegation((address delegator, address delegate, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation) external',
  ]),
  functionName: 'disableDelegation',
  args: [delegation],  // full Delegation object
})
```

---

## Step 3: Output the Executable Transaction

Emit exactly one unsigned transaction object. The revoker's wallet layer handles signing and broadcast.

```json
{
  "to": "0x<delegation-manager-address>",
  "data": "0x<disable-delegation-calldata>",
  "value": "0",
  "chainId": "<chain-id-as-base-10-string>"
}
```

Set `to` to `$DELEGATION_MANAGER`, `value` to `0` (disable is non-payable), and `chainId` to `$CHAIN_ID`.

### Post-Broadcast Verification

After the wallet layer broadcasts the tx, confirm the delegation is disabled:

```bash
# Read the canonical delegation hash from-chain
DELEGATION_HASH=$(cast call $DELEGATION_MANAGER "getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)" "$DELEGATOR" "$DELEGATE" "$AUTHORITY" "[($ENFORCER,$TERMS,$ARGS)]" "$SALT" "$SIGNATURE" --rpc-url $RPC)
# Verify the delegation is now disabled
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" "$DELEGATION_HASH" --rpc-url $RPC
# Must return true
```

```typescript
// Read the canonical delegation hash from-chain
const delegationHash = await client.readContract({
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

const isDisabled = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi([
    'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  ]),
  functionName: 'disabledDelegations',
  args: [delegationHash],
})
if (!isDisabled) throw new Error('Disable not confirmed on-chain')
```

> **Note:** The DelegationManager does not expose `isRevoked(bytes32)`. Use `disabledDelegations(bytes32)` with the hash returned by on-chain `getDelegationHash()` to check revocation status.

---

## Propagation Rules

Disabling follows a tree-kill pattern. Understanding the propagation model is critical for multi-agent workflows.

### Single Delegation (No Redelegation)

```
Main Account → Delegation A → Agent 1
```

Disabling A: Agent 1 loses all authority immediately.

### Redelegation Chain

```
Main Account → Delegation A → Agent 1
Agent 1 → Delegation B (authority = hash(A)) → Agent 2
Agent 2 → Delegation C (authority = hash(B)) → Agent 3
```

| Disabled | Effect |
|---|---|
| A (root) | B and C are instantly invalid. All three agents lose authority. |
| B only | C is instantly invalid. A remains valid; Agent 1 retains authority. Agent 2 and 3 lose authority. |
| C only | Only Agent 3 loses authority. A and B remain valid. |

### Why Propagation Works

`redeemDelegations` performs full-chain validation at redemption time: it
validates every delegation hash in the presented chain, leaf to root. If a
root delegation is disabled, any redemption presenting a chain through that
root fails at the chain-validation check.

This is the core security property: **disabling the root is a single-transaction kill switch for an entire agent hierarchy.** The "kill" happens during redemption validation, not via any separate propagation mechanism.

---

## Batch Revocation

If the DelegationManager exposes a batch disable function, revoke multiple delegations in one transaction. This is more gas-efficient for cleaning up multiple delegations.

```bash
# Encode batch disable (if available)
DELEGATION_STRUCT1="..."
DELEGATION_STRUCT2="..."

DISABLE_BATCH_CALLDATA=$(cast calldata "disableDelegations((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)[])" "[$DELEGATION_STRUCT1,$DELEGATION_STRUCT2]")
```

```typescript
const data = encodeFunctionData({
  abi: parseAbi([
    'function disableDelegations((address,address,bytes32,(address,bytes,bytes)[] caveats,uint256 salt,bytes signature)[] calldata delegations) external',
  ]),
  functionName: 'disableDelegations',
  args: [[delegation1, delegation2]],
})
```

> **Note:** Verify that `disableDelegations` exists on the deployed DelegationManager before using batch revocation. The canonical Intuition L3 interface is `disableDelegation(Delegation)` (single). Batch support is implementation-dependent.

---

## Error Patterns

| Error | Cause | Fix |
|---|---|---|
| `DelegationManager_NotDelegator` | The transaction sender is not the delegator address | Ensure the revoker's address matches the `delegator` field. For Smart Wallet delegators, the contract must execute the disable (e.g., via its owner). |
| `DelegationManager_AlreadyDisabled` | The delegation is already disabled | No action needed. The delegation is already invalid. |
| `DelegationManager_InvalidDelegation` | The provided Delegation struct is malformed or has an invalid signature | Reconstruct the struct from the original signed object. Verify all fields are correct. |
| `DelegationManager_FunctionNotFound` or transaction reverts (no reason) | Wrong function selector used | Use `disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))`, not `revokeDelegation(bytes32)`. |
| Transaction reverts with no message | DelegationManager contract not deployed at the expected address | Verify `$DELEGATION_MANAGER` against `reference/network-config.md`. Check chain ID matches. |

---

## Protocol Invariants

1. **Disable is permanent.** Once a delegation is disabled on-chain, it can never be un-disabled (except via `enableDelegation`, but only the delegator can call that). The delegator must create a new delegation with a new salt.
2. **Disable propagates downward.** Disabling a root delegation kills all redelegations that chain to it, regardless of depth. Disabling an intermediate node kills its subtree but leaves the parent chain intact.
3. **Disable is on-chain; expiry is off-chain.** Disable requires gas and a transaction. Expiry is passive and free but only affects the single delegation that carries the expiry caveat.
4. **Only the delegator can disable.** The DelegationManager enforces that the `msg.sender` of the disable transaction matches the `delegator` address in the Delegation struct. For contract delegators (Smart Wallet), the contract's access control logic determines who can trigger disable.
5. **Disable does not affect past executions.** Any transactions already submitted and confirmed by the Agent remain valid. Disable only blocks future redemptions.
6. **The Agent cannot self-revoke.** The Agent (delegate) cannot disable the delegation it holds. Only the delegator (or the delegator's authorized controller) can disable.
7. **Caveats cannot prevent disable.** The DelegationManager's `disableDelegation` function is unconditional. Caveats restrict execution, not revocation. The delegator always retains the ability to disable.
8. **Use `disableDelegation(Delegation)`, not `revokeDelegation(bytes32)`.** The MetaMask Delegation Framework uses the full struct for revocation. The `revokeDelegation(bytes32)` function does not exist.
9. **`disabledDelegations(bytes32)` is the only revocation view.** Check revocation status using `disabledDelegations(bytes32)` with the hash returned by on-chain `getDelegationHash()`, not `isDisabled(Delegation)` or `isRevoked(bytes32)` — neither exists.
10. **Full struct required for both disable and verification.** Both `disableDelegation` and `disabledDelegations` take the entire Delegation struct (including `uint256 salt` and `bytes signature`), not just a hash.

---

## Quick Reference

```bash
# --- Example: Disable a delegation ---
DELEGATION_MANAGER="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
RPC="https://testnet.rpc.intuition.systems/http"

# Full delegation struct (NOTE: fork uses reversed order — delegate FIRST)
DELEGATE="0x..."         # delegate first (fork order)
DELEGATOR="0x..."        # delegator second
AUTHORITY="0x0000..."
CAVEATS="[($ENFORCER,$TERMS,0x)]"
SALT="0x..."
SIGNATURE="0x..."
DELEGATION_STRUCT="($DELEGATE,$DELEGATOR,$AUTHORITY,$CAVEATS,$SALT,$SIGNATURE)"

# Encode and send
DISABLE_CALLDATA=$(cast calldata "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))" "$DELEGATION_STRUCT")

cast send $DELEGATION_MANAGER $DISABLE_CALLDATA \
  --value 0 \
  --private-key $DELEGATOR_PRIVATE_KEY \
  --rpc-url $RPC

# Verify
DELEGATION_HASH=$(cast call $DELEGATION_MANAGER "getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)" "$DELEGATOR" "$DELEGATE" "$AUTHORITY" "[($ENFORCER,$TERMS,$ARGS)]" "$SALT" "$SIGNATURE" --rpc-url $RPC)
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" "$DELEGATION_HASH" --rpc-url $RPC
# Output: true
```

```typescript
// --- Using viem ---
import { encodeFunctionData, parseAbi } from 'viem'

const data = encodeFunctionData({
  abi: parseAbi([
    'function disableDelegation((address,address,bytes32,(address,bytes,bytes)[] caveats,uint256 salt,bytes signature) delegation) external',
  ]),
  functionName: 'disableDelegation',
  args: [delegation],
})

const hash = await walletClient.sendTransaction({
  account: delegatorAccount,
  to: DELEGATION_MANAGER,
  data,
  value: 0n,
})

// Verify
const isDisabled = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi([
    'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  ]),
  functionName: 'disabledDelegations',
  args: [delegationHash],
})
```
