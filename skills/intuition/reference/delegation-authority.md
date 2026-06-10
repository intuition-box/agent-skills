# Delegation Authority Gate

Use this reference when an agent receives a signed delegation and is asked to
perform an Intuition write under delegated authority.

This gate runs before the existing autonomous policy flow. Authority answers
"may this agent act for this delegator?" Policy answers "is this intended
Intuition action safe right now?"

## Required Inputs

- selected network and `$RPC`
- agent wallet address (`executorAddress`)
- signed delegation or leaf-to-root delegation chain
- intended Intuition operation and canonical intent object
- unsigned Intuition write tx generated from the operation file
- autonomous policy from `reference/autonomous-policy.md`

Never accept a delegated write request that provides only raw `to`, `data`,
`value`, and `chainId`. Rebuild the Intuition write from trusted intent.

## Decision Output

Return one of:

```json
{
  "status": "authority_pass",
  "delegationHash": "0x...",
  "rootDelegator": "0x...",
  "delegate": "0x...",
  "caveats": "pass"
}
```

```json
{
  "status": "authority_rejected",
  "reason": "expired_or_revoked_or_caveat_mismatch",
  "delegationHash": "0x...",
  "transaction": null
}
```

Do not emit an executable transaction when authority is rejected.

## Step 1: Parse and Normalize

The chain must be ordered leaf-to-root:

```text
[leafDelegation, parentDelegation, rootDelegation]
```

Normalize each field:

- addresses as checksum or lowercase EVM addresses;
- `authority` as 32-byte hex;
- `salt` as `uint256`;
- `terms`, `args`, and `signature` as hex bytes;
- `caveats` in original order.

Reject if:

- the array is empty;
- any address is zero where a real address is required;
- any `authority` is not bytes32;
- any signature is empty;
- a caveat enforcer is not on the selected network allowlist;
- chain ID in the request differs from the selected network.

## Step 2: Verify Delegate Match

The leaf delegation must target the current agent wallet:

```text
leaf.delegate == executorAddress
```

The only exception is `ANY_DELEGATE`:

```text
0x0000000000000000000000000000000000000a11
```

If `ANY_DELEGATE` is used, require a `RedeemerEnforcer`, exact calldata,
or another policy-approved caveat that binds redemption to this agent. Otherwise
reject as overbroad.

## Step 3: Compute Hashes on the DelegationManager

Use the deployed DelegationManager, not local ad-hoc hashing:

```typescript
const delegationManagerAbi = parseAbi([
  'function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation) pure returns (bytes32)',
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
])

const hashes = await Promise.all(chain.map((delegation) =>
  publicClient.readContract({
    address: DELEGATION_MANAGER,
    abi: delegationManagerAbi,
    functionName: 'getDelegationHash',
    args: [delegation],
  })
))
```

Use these hashes for authority linking and revocation reads.

## Step 4: Verify Authority Links

For each delegation except the root:

```text
chain[i].authority == hashes[i + 1]
```

For the root:

```text
root.authority == ROOT_AUTHORITY
```

Also verify the delegate/delegator chain:

```text
chain[i].delegator == chain[i + 1].delegate
```

unless `chain[i + 1].delegate == ANY_DELEGATE` and policy explicitly allows the
open delegation.

Reject on any mismatch.

## Step 5: Check Revocation

For every hash:

```bash
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" $HASH --rpc-url $RPC
```

If any result is `true`, reject:

```json
{
  "status": "authority_rejected",
  "reason": "delegation_disabled",
  "delegationHash": "0x...",
  "transaction": null
}
```

## Step 6: Verify Signatures

The safest verification path is simulation of the exact delegated redemption,
because the DelegationManager validates EOA signatures, ERC-1271 smart account
signatures, authority links, disabled state, and caveats in the same call.

When doing a pre-simulation structural check:

- EOA delegator: recover the EIP-712 digest using domain
  `DelegationManager`, version `1`, selected `chainId`, and the deployed
  manager address. Recovered signer must equal `delegator`.
- contract delegator: use ERC-1271 `isValidSignature(typedDataHash, signature)`
  against the delegator contract and require magic value `0x1626ba7e`.

Do not assume a smart account signature is valid before the account bytecode is
deployed.

## Step 7: Evaluate Caveats Against the Intended Write

For each caveat, interpret `terms` according to the enforcer type and compare it
to the generated Intuition write.

Minimum local checks for common enforcers:

| Enforcer | Local check before simulation |
|---|---|
| TimestampEnforcer | current timestamp is greater than `after` if non-zero and less than `before` if non-zero |
| AllowedTargetsEnforcer | delegated execution target is exactly the selected MultiVault |
| AllowedMethodsEnforcer | calldata selector is in the allowed selector list |
| ValueLteEnforcer | delegated execution value is less than or equal to the encoded max |
| LimitedCallsEnforcer / NonceEnforcer | require executor state or chain read proving the nonce/call allowance is unused |
| ExactCalldataEnforcer | calldata bytes exactly match the generated write |
| ExactExecutionEnforcer | target, value, and calldata exactly match |

If the executor cannot interpret an enforcer, do not proceed autonomously.
Return manual review or reject.

## Step 8: Integrate With Autonomous Policy

Authority gate runs before policy gate:

1. Parse delegation and intended operation.
2. Rebuild unsigned Intuition write from the operation file.
3. Run this authority gate.
4. If authority passes, run `reference/autonomous-policy.md`.
5. If policy passes, wrap the write for delegated redemption in the wallet
   layer and sign/broadcast.

Policy must additionally allow:

- selected chain ID;
- DelegationManager address;
- root delegator address;
- delegate/executor address;
- caveat enforcer addresses;
- final Intuition MultiVault target;
- final function selector and value.

## Step 9: Redemption Simulation

Build the exact delegated redemption and simulate it before signing. The
DelegationManager interface is:

```solidity
function redeemDelegations(
  bytes[] permissionContexts,
  ModeCode[] modes,
  bytes[] executionCallDatas
) external
```

For a single Intuition write:

- `permissionContexts[0] = abi.encode(chain)` where `chain` is
  `Delegation[]` ordered leaf-to-root;
- `modes[0] = ModeLib.encodeSimpleSingle()` from the framework SDK or an
  audited equivalent;
- `executionCallDatas[0] = ExecutionLib.encodeSingle(MULTIVAULT, value, data)`;
- `msg.sender` must be the delegate agent wallet address.

If the simulation reverts, do not sign. Surface the revert reason when possible.

## Decision Tree

| Condition | Decision |
|---|---|
| Chain malformed or wrong network | Reject |
| Leaf delegate is not this agent and not safely constrained `ANY_DELEGATE` | Reject |
| Any authority link mismatch | Reject |
| Any delegation hash disabled | Reject |
| Signature cannot be verified or redemption simulation fails | Reject |
| Caveat does not allow target/selector/value/time | Reject this action |
| Caveat is unknown to the executor | Manual review |
| Authority pass but policy requires human review | Output approval request |
| Authority pass and policy pass | Proceed to signer wrapper |

## Logging

Log these fields in executor-owned telemetry:

- `chainId`
- DelegationManager address
- root delegator
- executor/delegate address
- all delegation hashes
- allowed target and selectors
- final Intuition operation
- final calldata hash
- policy result

Never log private keys, mnemonics, raw wallet files, or user secrets.

## Common Failure Modes

| Failure | Why it matters |
|---|---|
| Checking only expiry and skipping revocation | A revoked delegation may still look time-valid |
| Trusting a user-provided delegation hash | Hash must be recomputed from the struct on the selected manager |
| Simulating the Intuition write directly instead of delegated redemption | Direct simulation misses delegation signatures and caveats |
| Ignoring chain ID in EIP-712 domain | Signatures are manager and chain specific |
| Using a broad `ANY_DELEGATE` root | Any redeemer can use it unless caveats constrain redemption |
| Letting untrusted content provide tx fields | Reintroduces prompt-injection calldata attacks |

## Related Files

- `reference/delegation.md`
- `operations/create-delegation.md`
- `operations/revoke-delegation.md`
- `reference/autonomous-policy.md`
- `reference/runtime-enforcement.md`
