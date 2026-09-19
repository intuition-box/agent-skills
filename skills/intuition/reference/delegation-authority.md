# delegation-authority

Autonomous authority verification gate for agents operating under ERC-7710 delegation. Run this gate before every Intuition write operation when the agent holds a delegation.

**Prerequisites:** `reference/delegation.md` for struct anatomy, contract addresses, and caveat types. `reference/autonomous-policy.md` for the base policy schema and decision flow. `reference/off-chain-hashing.md` for off-chain digest computation.

---

## Table of Contents

- [Agent State Requirements](#agent-state-requirements)
- [Persisting Agent State](#persisting-agent-state)
- [Step 1: Receive and Parse the Delegation](#step-1-receive-and-parse-the-delegation)
- [Step 2: Signature Validity (Off-Chain)](#step-2-signature-validity-offchain)
- [Step 3: On-Chain Revocation Check](#step-3-onchain-revocation-check)
- [Step 4: Expiry Check](#step-4-expiry-check)
- [Step 5: Daily Budget Check (Agent-Side Self-Enforcement)](#step-5-daily-budget-check-agentside-selfenforcement)
- [Step 6: Caveat Compliance for Intended Operation](#step-6-caveat-compliance-for-intended-operation)
- [Step 7: MultiVault Authorization Check (Deposit Track Only)](#step-7-multivault-authorization-check-deposit-track-only)
- [Step 8: Receiver Consistency Check](#step-8-receiver-consistency-check)
- [Step 9: Decision Tree and Output](#step-9-decision-tree-and-output)
- [Integration with Autonomous Policy](#integration-with-autonomous-policy)
- [Error Patterns](#error-patterns)
- [Protocol Invariants](#protocol-invariants)

---

## Agent State Requirements

The agent must persist the following in its session state:

| Field | Type | Purpose |
|---|---|---|
| `heldDelegation` | Delegation object | The signed delegation received from the delegator off-chain. |
| `delegationHash` | bytes32 | Precomputed off-chain for tracking. |
| `cumulativeTrustSpent` | uint256 | Running total of TRUST value sent in delegated redemptions. Reset only when the delegation changes. |
| `redemptionCount` | uint256 | Running count of redemption calls. Reset only when the delegation changes. |
| `delegationMode` | `'creation_only' \| 'deposit_only' \| 'both' \| 'direct'` | Which track is active. `direct` means no delegation (fallback to standard Path B). |
| `mainAccount` | address | The ultimate beneficiary (Main Account). Used for receiver binding. |
| `smartWallet` | address \| null | The Smart Wallet address (deposit track only). Used for approval checks. |
| `dailyBudgetSpent` | uint256 | TRUST spent today (agent-side self-enforcement). |
| `dailyBudgetDate` | number | UTC day index (days since epoch) for the current budget window. |

> If `delegationMode` is `direct`, skip this gate entirely and proceed to standard Path B write operations.

---

## Persisting Agent State

The agent should persist its state across restarts. Recommended storage:

| Field | Storage | Permissions |
|---|---|---|
| `heldDelegation` | Secure file: `~/.intuition/agent-state.json` | `0600` (owner read/write only) |
| `cumulativeTrustSpent` | Same state file | `0600` |
| `redemptionCount` | Same state file | `0600` |
| `dailyBudgetSpent` / `dailyBudgetDate` | Same state file | `0600` |
| `delegationMode` / `mainAccount` / `smartAccount` | Loaded from `autonomous-policy.json` at session start | Read-only |

### Example State File

```json
{
  "delegationHash": "0x...",
  "cumulativeTrustSpent": "50000000000000000000",
  "redemptionCount": 12,
  "dailyBudgetSpent": "25000000000000000000",
  "dailyBudgetDate": 20045
}
```

The `heldDelegation` object is stored separately or encrypted. It contains the signed delegation which is sensitive material.

---

## Step 1: Receive and Parse the Delegation

The agent receives the delegation object off-chain (e.g., via environment variable, secure message, or state file). Parse and validate the struct shape.

### Expected Input Shape

```json
{
  "delegation": {
    "delegator": "0x<delegator-address>",
    "delegate": "0x<agent-address>",
    "authority": "0x<root-or-parent-hash>",
    "caveats": [
      {
        "enforcer": "0x<enforcer-address>",
        "terms": "0x<encoded-terms>",
        "args": "0x"
      }
    ],
    "salt": "0x<uint256>",
    "signature": "0x<signature>"
  },
  "delegationHash": "0x<off-chain-computed-hash>",
  "path": "creation_only | deposit_only | both",
  "mainAccount": "0x<main-account-address>"
}
```

### Parse and Validate

```typescript
// Validate required fields
if (!delegation.delegate || !delegation.delegator || !delegation.signature) {
  throw new Error('delegation_parse_failed: missing required fields')
}

// Verify delegate matches agent's own address
if (delegation.delegate.toLowerCase() !== agentAddress.toLowerCase()) {
  throw new Error('delegation_parse_failed: delegate mismatch')
}

// Cache in agent state
agentState.heldDelegation = delegation
agentState.delegationHash = delegationHash
agentState.delegationMode = path  // 'creation_only' | 'deposit_only' | 'both'
agentState.mainAccount = mainAccount
agentState.smartWallet = (path === 'deposit_only' || path === 'both') ? delegation.delegator : null
```

---

## Step 2: Signature Validity (Off-Chain)

Verify that the delegation's signature was produced by the delegator.

> **Important:** The DelegationManager does not expose `hashTypedData` or `isValidDelegation` on-chain. Signature verification must be done off-chain. The contract checks signature validity inside `redeemDelegations` at redemption time.

### Step 2a: EOA Signature Recovery

For plain EOA delegators, recover the signer via EIP-712 and verify it matches the delegator address.

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

```typescript
// Compute digest off-chain (viem handles this)
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

Using the SDK (recommended):

```typescript
import { hashTypedDataForDelegation } from '@metamask/smart-accounts-kit'
import { recoverAddress } from 'viem'

const digest = hashTypedDataForDelegation(delegation, CHAIN_ID, DELEGATION_MANAGER)
const recovered = recoverAddress({ hash: digest, signature: delegation.signature })

if (recovered.toLowerCase() !== delegation.delegator.toLowerCase()) {
  throw new Error('signature_invalid: recovered address does not match delegator')
}
```

> Do not call `hashTypedData` on-chain — it does not exist.

### Step 2b: Contract Delegator ERC-1271 Probe

For contract delegators (code.length > 0), call `isValidSignature` on the
delegator contract **in isolation** before any delegation transaction. This is
the **Layer 1 probe** — it bypasses all delegation encoding and tells you
instantly whether the contract accepts your signature.

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
  abi: parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)]),
  functionName: 'isValidSignature',
  args: [eip712Digest, delegation.signature],
})

if (magicValue !== '0x1626ba7e') {
  throw new Error('signature_invalid: ERC-1271 magic value mismatch')
}
```

The on-chain ERC-1271 magic value is left-padded to 32 bytes:

```typescript
const ERC1271_MAGIC_VALUE = '0x1626ba7e'  // bytes4, left-padded to 32 bytes on-chain
```

> **Layer 1 probe:** Call `isValidSignature` in isolation before wrapping anything
> in `redeemDelegations`. If this fails, the bug is in the digest or signature,
> not the delegation encoding.

---

## Step 3: On-Chain Revocation Check

Query the DelegationManager to confirm the delegation has not been disabled.

Use `disabledDelegations(bytes32)`, not `isRevoked(bytes32)`.

**Read the delegation hash from-chain.** Call `getDelegationHash()` on the
DelegationManager with the full delegation object. The contract accepts the
full struct but excludes `signature` before hashing.

```bash
# Pass the full delegation object; getDelegationHash strips signature internally
cast call $DELEGATION_MANAGER "getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)" "$DELEGATOR" "$DELEGATE" "$AUTHORITY" "[($ENFORCER,\"$TERMS\",\"$ARGS\")]" "$SALT" "$SIGNATURE" --rpc-url $RPC
```

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
    salt: delegation.salt,
    signature: delegation.signature,
  }],
})

const isDisabled = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function disabledDelegations(bytes32) view returns (bool)']),
  functionName: 'disabledDelegations',
  args: [delegationHash],
})

if (isDisabled) {
  throw new Error('delegation_revoked: this delegation has been disabled on-chain')
}
```

> **Note:** `getDelegationHash()` accepts the full delegation struct but strips
> `signature` before hashing. Pass the complete delegation object. Do NOT use
> `keccak256(abi.encode(delegation_struct))` — standard ABI encoding includes
> `signature` and uses raw tuple encoding for `caveats[]`, neither of which
> matches on-chain EIP-712 struct hashing.

---

## Step 3.5: Verify Delegation is Enabled (Optional)

`disabledDelegations(bytes32)` returns `false` for active delegations and `true` for disabled ones.

`enableDelegation` is **not required** for the standard signature-based flow. It is an optional caching alternative for delegators who want the delegation stored on-chain. The standard off-chain sign → `redeemDelegations` flow works without it. Calling `enableDelegation` from any address other than the delegator reverts with `InvalidDelegator`.

```typescript
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem'

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
    salt: delegation.salt,
    signature: delegation.signature,
  }],
})

const disabled = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function disabledDelegations(bytes32) view returns (bool)']),
  functionName: 'disabledDelegations',
  args: [delegationHash],
})

if (disabled) {
  throw new Error('delegation_revoked: delegation has been disabled on-chain')
}

// If disabledDelegations returns false, the delegation is active.
// Proceed to expiry and caveat checks.
```

> **Note:** If `disabledDelegations` returns `true` immediately after `enableDelegation`, the delegation was stored in a disabled state. Create a new delegation with a new salt.

---

## Step 4: Expiry Check

If the delegation includes an expiry caveat, decode and verify.

```bash
# Decode expiry from caveat terms (assumes terms is a single uint256)
EXPIRY=$(cast --to-dec $EXPIRY_TERMS)
BLOCK_TIME=$(cast block-number --rpc-url $RPC | xargs cast block --field timestamp --rpc-url $RPC)
test "$BLOCK_TIME" -lt "$EXPIRY" || { echo "Delegation expired"; exit 1; }
```

```typescript
// Find the expiry caveat (if present)
const expiryCaveat = delegation.caveats.find(c =>
  c.enforcer.toLowerCase() === EXPIRY_ENFORCER.toLowerCase()
)

if (expiryCaveat) {
  const expiryTimestamp = decodeAbiParameters(
    [{ type: 'uint256' }],
    expiryCaveat.terms
  )[0]

  const currentBlock = await client.getBlock()
  if (currentBlock.timestamp > expiryTimestamp) {
    throw new Error('delegation_expired: caveat timestamp exceeded')
  }
}
```

---

## Step 5: Daily Budget Check (Agent-Side Self-Enforcement)

If `delegationPolicy.dailyBudgetWei` is configured, verify the agent has not exceeded its self-imposed daily spend limit. This limit is agent-side only and not enforced on-chain by caveat enforcers.

```typescript
if (policy.delegation.dailyBudgetWei) {
  const dailyBudget = BigInt(policy.delegation.dailyBudgetWei)
  const today = Math.floor(Date.now() / 86400000) // days since epoch

  // Reset budget window if day has changed
  if (agentState.dailyBudgetDate !== today) {
    agentState.dailyBudgetSpent = 0n
    agentState.dailyBudgetDate = today
  }

  const newTotal = agentState.dailyBudgetSpent + proposedValue
  if (newTotal > dailyBudget) {
    throw new Error(`daily_budget_exceeded: ${newTotal} > ${dailyBudget}`)
  }
}
```

```bash
# Bash equivalent
DAILY_BUDGET="100000000000000000000"  # 100 TRUST
TODAY=$(($(date +%s) / 86400))

# Load from state file or default to 0
DAILY_SPENT=$(jq -r '.dailyBudgetSpent // 0' ~/.intuition/agent-state.json)
DAILY_DATE=$(jq -r '.dailyBudgetDate // 0' ~/.intuition/agent-state.json)

if [ "$DAILY_DATE" -ne "$TODAY" ]; then
  DAILY_SPENT=0
fi

NEW_TOTAL=$(echo "$DAILY_SPENT + $PROPOSED_VALUE" | bc)
if [ "$NEW_TOTAL" -gt "$DAILY_BUDGET" ]; then
  echo "daily_budget_exceeded: $NEW_TOTAL > $DAILY_BUDGET"
  exit 1
fi
```

---

## Step 6: Caveat Compliance for Intended Operation

For the requested Intuition operation, verify that all caveats permit it.

### 6a: AllowedMethods Check

Compute the function selector of the intended operation and verify it is in the allowlist.

```bash
# Intended operation selector
INTENDED_SELECTOR=$(cast sig "deposit(address,bytes32,uint256,uint256)")

# Decode allowed selectors from caveat terms
# (Requires parsing the bytes4[] from the encoded terms)
```

```typescript
import { toFunctionSelector } from 'viem'

const intendedSelector = toFunctionSelector(
  'deposit(address,bytes32,uint256,uint256)'
)

const allowedMethodsCaveat = delegation.caveats.find(c =>
  c.enforcer.toLowerCase() === ALLOWED_METHODS_ENFORCER.toLowerCase()
)

if (!allowedMethodsCaveat) {
  throw new Error('caveat_missing: no AllowedMethodsEnforcer found')
}

// Parse raw concatenated bytes4 selectors from terms
// Terms format: 0x + selector1 (8 hex chars) + selector2 (8 hex chars) + ...
const termsHex = allowedMethodsCaveat.terms.slice(2); // strip 0x
const allowedSelectors = [];
for (let i = 0; i < termsHex.length; i += 8) {
  allowedSelectors.push('0x' + termsHex.slice(i, i + 8));
}

if (!allowedSelectors.includes(intendedSelector)) {
  throw new Error(`method_not_allowed: selector ${intendedSelector} not in delegation allowlist`)
}
```

### 6b: Spend Cap Check (Payable Operations Only)

If the operation involves TRUST value (create, deposit), verify the cumulative spend would not exceed the cap.

```bash
# Decode max spend from caveat terms
MAX_SPEND=$(cast --to-dec $SPEND_CAP_TERMS)
NEW_TOTAL=$(echo "$CUMULATIVE_SPENT + $PROPOSED_VALUE" | bc)
test "$NEW_TOTAL" -le "$MAX_SPEND" || { echo "Spend cap exceeded"; exit 1; }
```

```typescript
const nativeTokenCaveat = delegation.caveats.find(c =>
  c.enforcer.toLowerCase() === NATIVE_TOKEN_ENFORCER.toLowerCase()
)

if (nativeTokenCaveat && proposedValue > 0n) {
  const maxSpend = decodeAbiParameters(
    [{ type: 'uint256' }],
    nativeTokenCaveat.terms
  )[0]

  const newTotal = agentState.cumulativeTrustSpent + proposedValue
  if (newTotal > maxSpend) {
    throw new Error(`spend_cap_exceeded: ${newTotal} > ${maxSpend}`)
  }
}
```

### 6c: Call Count Check

If using LimitedCallsEnforcer, verify the agent has not exceeded the maximum number of redemptions.

```typescript
const callsCaveat = delegation.caveats.find(c =>
  c.enforcer.toLowerCase() === LIMITED_CALLS_ENFORCER.toLowerCase()
)

if (callsCaveat) {
  const maxCalls = decodeAbiParameters(
    [{ type: 'uint256' }],
    callsCaveat.terms
  )[0]

  if (agentState.redemptionCount >= maxCalls) {
    throw new Error(`call_limit_exceeded: ${agentState.redemptionCount} >= ${maxCalls}`)
  }
}
```

---

## Step 7: MultiVault Authorization Check (Deposit Track Only)

If `delegationMode` is `'deposit_only'` or `'both'`, simulate the inner call from the Smart Wallet's context to confirm the approval exists. Skip for `creation_only` or `direct` modes.

```bash
# Simulate the inner MultiVault call from the Smart Wallet's context
cast call $MULTIVAULT $INNER_CALLDATA --from $SMART_WALLET --rpc-url $RPC
# If this reverts with MultiVault_Unauthorized, the approval is missing
```

```typescript
// Simulate the call (only for deposit track)
if (agentState.delegationMode === 'deposit_only' || agentState.delegationMode === 'both') {
  try {
    await client.call({
      account: agentState.smartWallet,
      to: MULTIVAULT,
      data: innerCalldata,
      value: proposedValue,
    })
  } catch (err) {
    if (err.message.includes('Unauthorized')) {
      throw new Error('multivault_unauthorized: Smart Wallet lacks approval from Main Account')
    }
    throw err
  }
}
```

> Skip this step for creation track or direct mode. The OWS does not need MultiVault approval for creation operations.

---

## Step 8: Receiver Consistency Check

For operations with a receiver parameter, verify the receiver is set to the Main Account address.

### Operation-to-Receiver Mapping

The following Intuition operations have a receiver parameter:

| Function Signature | Has receiver? | Receiver Position |
|---|---|---|
| `deposit(address,bytes32,uint256,uint256)` | Yes | First argument (`address receiver`) |
| `redeem(address,bytes32,uint256,uint256)` | Yes | First argument (`address receiver`) |
| `depositBatch(address,bytes32[],uint256[],uint256[],uint256[])` | Yes | First argument (`address receiver`) |
| `redeemBatch(address,bytes32[],uint256[],uint256[],uint256[])` | Yes | First argument (`address receiver`) |
| `createAtoms(bytes[],uint256[])` | No | Attribution follows `msg.sender` |
| `createTriples(bytes32[],bytes32[],bytes32[],uint256[])` | No | Attribution follows `msg.sender` |

```typescript
const receiverOperations = [
  'deposit(address,bytes32,uint256,uint256)',
  'redeem(address,bytes32,uint256,uint256)',
  'depositBatch(address,bytes32[],uint256[],uint256[],uint256[])',
  'redeemBatch(address,bytes32[],uint256[],uint256[],uint256[])',
]

const receiverOperationSignatures = receiverOperations.map(sig => toFunctionSelector(sig))

if (receiverOperationSignatures.includes(intendedSelector)) {
  const decoded = decodeFunctionData({ abi: writeAbi, data: innerCalldata })
  const receiver = decoded.args[0] // first arg is receiver for deposit/redeem

  if (receiver.toLowerCase() !== mainAccount.toLowerCase()) {
    throw new Error(`receiver_mismatch: expected ${mainAccount}, got ${receiver}`)
  }
}
```

---

## Step 9: Decision Tree and Output

After all checks, the agent makes an autonomous decision.

### Full Authority → Proceed

All checks passed. Wrap the Intuition calldata in `redeemDelegations` and output the nested transaction.

```typescript
// ERC-7579 execution mode for single default calls
const MODE_SINGLE_DEFAULT = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

// Build the inner transaction (standard Path B output)
const innerTx = {
  to: MULTIVAULT,
  data: intuitionCalldata,
  value: proposedValue.toString(),
}

// Encode execution call data (ERC-7579 single call format)
// MUST use solidityPacked — abi.encode(tuple) adds a 32-byte offset pointer
const executionCallData = solidityPacked(
  ['address', 'uint256', 'bytes'],
  [MULTIVAULT, proposedValue, intuitionCalldata]
)

// Step 9a: Read the canonical permission context from-chain.
// getDelegationHash() accepts the full delegation object and excludes
// signature before hashing. This is the exact value redeemDelegations
// expects in _permissionContexts.
const permissionContext = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation) view returns (bytes32)']),
  functionName: 'getDelegationHash',
  args: [{
    delegator: delegation.delegator,
    delegate: delegation.delegate,
    authority: delegation.authority,
    caveats: delegation.caveats,
    salt: delegation.salt,
    signature: delegation.signature,
  }],
})

// Build outer transaction
// _permissionContexts[i] = abi.encode(Delegation[]) — no hash tuple
const permissionContextTuple = encodeAbiParameters(
  parseAbiParameters('(address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]'),
  [[delegation]]
)

const outerData = encodeFunctionData({
  abi: parseAbi(['function redeemDelegations(bytes[] calldata _permissionContexts, bytes32[] calldata _modes, bytes[] calldata _executionCallData) external']),
  functionName: 'redeemDelegations',
  args: [
    [permissionContextTuple],
    [MODE_SINGLE_DEFAULT],
    [executionCallData],
  ],
})

// Update agent state
agentState.cumulativeTrustSpent += proposedValue
agentState.redemptionCount += 1
agentState.dailyBudgetSpent += proposedValue

// Output
const output = {
  to: DELEGATION_MANAGER,
  data: outerData,
  value: '0',
  chainId: CHAIN_ID.toString(),
  delegationContext: {
    delegationHash: agentState.delegationHash,
    delegator: delegation.delegator,
    wrappedOperation: operationName,
    caveatChecks: {
      signature: 'pass',
      revocation: 'pass',
      expiry: 'pass',
      dailyBudget: 'pass',
      methodAllowlist: 'pass',
      spendCap: 'pass',
      callLimit: 'pass',
      multivaultApproval: (agentState.delegationMode === 'deposit_only' || agentState.delegationMode === 'both') ? 'pass' : 'n/a',
      receiver: 'pass',
    },
  },
}
```

### Expired / Revoked → Halt and Report

```json
{
  "status": "delegation_failure",
  "reason": "delegation_revoked",
  "delegationHash": "0x...",
  "failedCheck": "revocation",
  "details": {
    "delegator": "0x...",
    "delegate": "0x..."
  }
}
```

### Caveat Mismatch → Reject Specific Action, Report

```json
{
  "status": "delegation_failure",
  "reason": "method_not_allowed",
  "delegationHash": "0x...",
  "failedCheck": "methodAllowlist",
  "details": {
    "intendedSelector": "0x...",
    "allowedSelectors": ["0x...", "0x..."]
  }
}
```

### Spend Cap Exceeded → Halt and Report

```json
{
  "status": "delegation_failure",
  "reason": "spend_cap_exceeded",
  "delegationHash": "0x...",
  "failedCheck": "spendCap",
  "details": {
    "cumulativeSpent": "...",
    "proposedValue": "...",
    "maxSpend": "..."
  }
}
```

---

## Integration with Autonomous Policy

This authority gate is inserted into the existing Path B decision flow from `reference/autonomous-policy.md`.

### Updated Decision Flow for Delegated Writes

```
01. Resolve a trusted intent object (operation + semantic inputs).
02. Recompute contract arguments from trusted reads and canonicalized input data.
03. Encode calldata from the intended operation ABI fragment.
04. Decode the calldata and verify selector + arguments exactly match the
    intended operation and computed args.
05. [DELEGATION AUTHORITY CHECK — if delegation.mode !== 'direct']
    5a. Parse held delegation from agent state.
    5b. Verify signature off-chain (EIP-712 recovery or ERC-1271).
    5c. Check on-chain revocation via `disabledDelegations(bytes32)`. Pass the value returned by on-chain `getDelegationHash()`.
    5d. Check expiry via caveat terms vs block.timestamp.
    5e. Verify daily budget if configured (agent-side self-enforcement).
    5f. Verify intended operation selector is in AllowedMethods caveat.
    5g. Verify proposed value does not exceed NativeTokenTransferAmount caveat.
    5h. Verify call count does not exceed LimitedCalls caveat.
    5i. If deposit track (deposit_only or both), simulate inner call from Smart Wallet to confirm MultiVault approval exists.
    5j. Verify receiver == mainAccountAddress for receiver-bearing ops.
    5k. If any check fails → emit delegation_failure object; STOP (exit code 3).
06. Validate term binding (isTermCreated, getVaultType, etc.).
07. Resolve receiver for receiver-bearing operations:
    - If delegationMode !== 'direct': receiver MUST be mainAccountAddress
      (enforced in Step 5j).
    - If delegationMode === 'direct' and receiver is omitted: set it to
      signer address.
08. Validate chain allowlist and exact MultiVault address match.
09. Validate operation-specific and global value limits.
10. Resolve slippage bounds from previews.
11. Simulate transaction with the exact calldata and value.
12. Evaluate approval mode:
    - manual-review mode always emits an approval request object.
    - strict/permissive emit approval request if value/op exceeds policy.
    - Otherwise emit executable tx JSON.
13. Output:
    - If delegated: nested tx { to: DelegationManager, data: redeemDelegations(...) }
    - If direct: standard tx { to: MultiVault, data: intuitionCalldata }
    - If approval required: approval request object.
    - If delegation failure: delegation failure object.
```

### Policy Schema Extension

Add to `reference/autonomous-policy.md`:

```typescript
interface DelegationPolicy {
  mode: 'creation_only' | 'deposit_only' | 'both' | 'direct'
  mainAccountAddress?: `0x${string}`    // Required for delegated modes
  smartWalletAddress?: `0x${string}`    // Required for deposit track
  requireApprovalCheck: boolean         // If true, simulate MultiVault approval
  dailyBudgetWei?: string              // Agent-side self-enforced daily limit
}
```

> The delegation authority check runs before all existing policy gates. It is a hard gate: if it fails, the agent halts immediately without reaching economic limits, slippage checks, or simulation.

---

## Error Patterns

| Error | Cause | Fix |
|---|---|---|
| `delegation_parse_failed` | Missing required fields or delegate mismatch | Verify the delegation object was transmitted completely. Ensure the `delegate` field matches the agent's own address. |
| `signature_invalid` | EIP-712 recovery does not match delegator, or ERC-1271 magic value mismatch | Verify the delegator's signing key. For contract delegators, check `isValidSignature` implementation. |
| `delegation_revoked` | Delegation is disabled on-chain (`disabledDelegations` returns true) | The delegator must create a new delegation. This one is permanently dead. |
| `delegation_expired` | Block timestamp exceeds expiry caveat | The delegator must create a new delegation with a future expiry. |
| `daily_budget_exceeded` | Agent-side daily TRUST spend limit exceeded | Wait for the next UTC day window, or request a new delegation with a higher daily budget. |
| `method_not_allowed` | Intended operation selector not in AllowedMethods caveat | The delegator must issue a new delegation with the required method included, or the agent must request a different operation. |
| `spend_cap_exceeded` | Cumulative spend + proposed value > NativeTokenTransferAmount cap | The delegator must issue a new delegation with a higher cap, or the agent must reduce the operation value. |
| `call_limit_exceeded` | Redemption count >= LimitedCalls caveat | The delegator must issue a new delegation with a higher call limit. |
| `authority_not_found` | Redelegation uses a parent delegation hash that does not exist or is invalid | Verify the parent delegation was created and signed correctly. Compute the parent hash off-chain (see `reference/off-chain-hashing.md`) and ensure the `authority` field matches it. |
| `multivault_unauthorized` | Deposit track: Smart Wallet lacks approval from Main Account | Main Account must call `approve(SmartWallet, 3)` on MultiVault. |
| `receiver_mismatch` | Receiver in inner tx does not match `mainAccountAddress` | Correct the receiver argument to the Main Account address before encoding. |

---

## Protocol Invariants

1. **The authority check is a hard gate.** If any verification step fails, the agent halts immediately. No existing policy gate is reached.
2. **The Agent decides autonomously.** Once the delegation is received, the agent verifies and acts without human approval per operation. The caveats are the policy boundary.
3. **State is cumulative across redemptions.** `cumulativeTrustSpent`, `redemptionCount`, and `dailyBudgetSpent` persist across operations within a single delegation. They reset only when a new delegation is loaded.
4. **The Agent never reveals the delegation to untrusted parties.** The signed delegation object is sensitive. The agent stores it in secure session state and only presents it to the DelegationManager during redemption.
5. **Tracks can compose.** An agent can hold both a creation-track delegation (OWS) and a deposit-track delegation (Smart Wallet) simultaneously. The `delegationMode` field is `'both'` in this case. Each track is verified independently.
6. **Receiver binding is non-negotiable.** For receiver-bearing operations, the receiver MUST be the Main Account. Any other value is a hard failure.
7. **Daily budget is agent-side only.** The `dailyBudgetWei` limit is not enforced on-chain. It is a self-imposed limit that the agent tracks and enforces independently of caveat enforcers.
8. **Layered verification order matters.** Run ERC-1271 `isValidSignature` in isolation (Layer 1). Pin domain hash from `getDomainHash()` on-chain (Layer 2). Verify struct hash via `getDelegationHash()` on-chain (Layer 3). Recover signature to correct address (Layer 4). Encode nested transaction only after all layers pass.
9. **`getDelegationHash(Delegation)` exists on-chain** (`0x66134607`). `getDomainHash()` also exists (`0x83ebb771`). Off-chain computation is preferred only to avoid an extra RPC round-trip. Always read the domain separator from `getDomainHash()` — do not reconstruct it from guessed `name`/`version` literals.
10. **`disabledDelegations(bytes32)` is the only revocation view.** Call `getDelegationHash()` on-chain and pass the returned bytes32 to `disabledDelegations(bytes32)`. Do not use `isRevoked(bytes32)` or `isDisabled(Delegation)` — neither exists.
11. **`_permissionContexts[i]` is `abi.encode(Delegation[])` — a flat array of Delegation structs.** There is NO separate `bytes32 delegationHash` tuple element. Including one causes an `abi.decode` mismatch. This differs from standard MetaMask Delegation Framework which uses a 2-element tuple.
12. **`_executionCallData` must use `solidityPacked(address,uint256,bytes)`.** The inner execution data for ERC-7579 single-call mode must be flat-packed. Using `abi.encode(tuple)` adds a 32-byte offset pointer that shifts all fields and causes `decodeSingle` to read garbage.
13. **`AllowedMethodsEnforcer` terms are raw bytes4 selectors.** `decodeSingle()` reads 4-byte chunks directly from `_terms`. Using `abi.encode(bytes4[])` produces an array header that is misread as the first selector.
14. **`LimitedCallsEnforcer` terms are `abi.encode(uint256)`.** NOT raw bytes.
15. **`enableDelegation` is optional.** For the standard signature-based flow (delegator signs off-chain, Agent calls `redeemDelegations`), `enableDelegation` is not required. It is an optional caching alternative for delegators who do not want to provide an EIP-712 signature.
