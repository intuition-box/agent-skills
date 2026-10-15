# Delegation Debugging

Session-specific debugging guide for ERC-7710 delegation issues on Intuition L3.
Use when `redeemDelegations` reverts, `getDelegationHash` returns empty data, or
delegated writes fail unexpectedly.

---

## Canonical Debugging Order

When a delegation redemption fails, rule out causes in this exact order:

1. **ERC-1271 probe (Layer 1)** — Call `isValidSignature(digest, signature)` on the delegator contract in isolation. Pass: returns `0x1626ba7e`. If this fails, fix the digest/signature before proceeding.
2. **Domain hash from-chain (Layer 2)** — Call `getDomainHash()` on the DelegationManager and use the returned `bytes32` directly in the EIP-712 digest. Pass: domain hash matches on-chain read.
3. **Struct hash verified on-chain (Layer 3)** — Compute `getDelegationHash()` off-chain, then call `getDelegationHash(delegation)` on-chain. Pass: `offChainHash === onChainHash`.
4. **Signature recovery (Layer 4)** — Run `ethers.recoverAddress(digest, signature)` and verify it equals `delegator` byte-for-byte. Pass: `recovered.toLowerCase() === DELEGATOR.toLowerCase()`.
5. **Encoding compliance (Layer 5)** — Verify: `_permissionContexts[i]` is `abi.encode(Delegation[], bytes32 delegationHash)`; `execCallData` is `solidityPacked(address,uint256,bytes)`; `AllowedMethodsEnforcer` terms are raw bytes4 selectors; `LimitedCallsEnforcer` terms are `abi.encode(uint256)`.
6. **Pre-compute atom/triple ID (Layer 6)** — Call the creation function via `provider.call({ to: MULTIVAULT, data, value, from: DELEGATOR })` to get the deterministic ID. On mainnet, always include `from: DELEGATOR` for value-carrying static calls.
7. **Systematic debugging (Layer 7)** — When `redeemDelegations` fails, rule out causes in this order: permission context encoding → execCallData packing → enforcer terms format → inner value field → delegator balance → bare direct call from delegator → atom/triple existence check.

---

## Known Testnet Blocker (2026-08-08 — partially resolved)

**Symptom (historical):** `redeemDelegations` reverted on Intuition testnet (chain 13579) with empty data or Panic 65.

**Resolution (2026-08-17):** Creation track (OWS) is now **confirmed working on testnet**. Full lifecycle: create → write → revoke → blocked. Testnet txs: write `0xd017ff5c...`, revoke `0x9d5ceaee...`.

**Deposit track testnet status:** End-to-end delegation/redemption on testnet has **not** been executed. Only smart account provisioning and an EIP-7702 upgrade were attempted. Mainnet deposit track is confirmed working (approval `0x3f6bf183...`, redemption `0x0f48471f...`, revoke `0xb0778e08...`).

**Root cause of earlier testnet failures:** Off-chain hash mismatch between the `permissionContext` computed by the signing script and the on-chain `getDelegationHash()`. Common culprits: (1) `_permissionContexts[i]` missing the `delegationHash` tuple element, (2) `execCallData` using `abi.encode(tuple)` instead of `solidityPacked(address,uint256,bytes)`, (3) `AllowedMethodsEnforcer` terms ABI-encoded as `bytes4[]` instead of raw concatenated bytes4 selectors.

---

## Domain Separator

**Source:** MUST read `getDomainHash()` on-chain. Never guess.

```bash
cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC
```

The DelegationManager uses standard OpenZeppelin EIP-712 v4 (MetaMask Delegation Framework):
- Domain: EIP712("DelegationManager", "1") with dynamic chainId
- Struct hash: `getDelegationHash` on-chain. Prefer reading it directly from-chain.
- Field order: delegate, delegator, authority, caveats_hash, salt
- Caveat hash: per-caveat hashes with args excluded
- **Always read `getDomainHash()` on-chain and use the returned `bytes32` directly. Prefer reading `getDelegationHash()` on-chain over recomputing the struct hash off-chain.**

---

## Delegation Struct Hash

**Source:** Verified from DelegationManager v1.3.0 live source.

```solidity
struct Delegation {
  address delegator;
  address delegate;
  bytes32 authority;
  Caveat[] caveats;
  uint256 salt;
  bytes signature;
}
```

**Signing field order (typehash):** `delegate, delegator, authority, caveats_hash, salt`
**Signature is excluded from hash computation.**

**Caveat struct hash (note: `args` is NOT included in typehash):**

```solidity
struct Caveat {
  address enforcer;
  bytes terms;
  bytes args;
}
```

Caveat typehash: `keccak256("Caveat(address enforcer,bytes terms)")`

---

## Enforcer Term Formats

| Enforcer | Terms Format | Common Pitfall |
|----------|-------------|----------------|
| **AllowedMethodsEnforcer** | Raw concatenated `bytes4` selectors | Do NOT use `abi.encode(bytes4[])` — it produces an array header that `decodeSingle()` misreads as the first selector |
| **NativeTokenTransferAmountEnforcer** | `abi.encode(uint256 maxCumulativeSpend)` | Global cumulative cap, not periodic |
| **LimitedCallsEnforcer** | `abi.encode(uint256 maxCalls)` | Stateful counter in DelegationManager |

---

## Receiver Consistency

For operations with a `receiver` parameter (`deposit`, `redeem`, batch variants),
`receiver` MUST be the Main Account address when operating under delegation.
The Agent is the tx submitter; `msg.sender` is the delegator's address.

---

## Permission Context Encoding

`_permissionContexts[i]` must be:
```
abi.encode(Delegation[], bytes32 delegationHash)
```

`_executionCallDatas[i]` must be:
```
ethers.solidityPacked(["address","uint256","bytes"], [target, value, innerCalldata])
```
NOT `abi.encode((address,uint256,bytes))` — tuple adds offset pointer.

`_modes[i]` for single execution:
```
MODE_SINGLE_DEFAULT = bytes32(0)
```

---

## Error Taxonomy

Confirmed from DelegationManager v1.3.0 source:

| Error | Cause |
|-------|-------|
| `InvalidDelegate` | `delegate == address(0)` or delegation disabled |
| `InvalidDelegator` | `msg.sender != delegation.delegator` |
| `InvalidEOASignature` | ECDSA recovery mismatch |
| `InvalidERC1271Signature` | ERC-1271 magic value mismatch |
| `InvalidAuthority` | Authority chain validation failed |
| `CannotUseADisabledDelegation` | `disabledDelegations[hash] == true` |
| `AlreadyDisabled` | `disableDelegation` on already-disabled delegation |
| `AlreadyEnabled` | `enableDelegation` on already-enabled delegation |
| `BatchDataLengthMismatch` | Arrays have different lengths |

---

## Quick Diagnostic Commands

```bash
# 1. Check MultiVault is a contract (not EOA)
cast code $MULTIVAULT --rpc-url $RPC

# 2. Read domain hash from-chain
cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC

# 3. Compute delegation hash on-chain (pass full struct)
cast call $DELEGATION_MANAGER "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" "$DELEGATOR" "$DELEGATE" "$AUTHORITY" "$CAVEATS" "$SALT" "$SIGNATURE" --rpc-url $RPC

# 4. Check if delegation is disabled
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" "$DELEGATION_HASH" --rpc-url $RPC

# 5. ERC-1271 probe (for contract delegators)
cast call $DELEGATOR "isValidSignature(bytes32,bytes)(bytes4)" "$EIP712_DIGEST" "$SIGNATURE" --rpc-url $RPC
# Expected: 0x1626ba7e
```

---

## Reverse-Engineering via Live Transactions

When source-level tracing is unavailable or blocked by RPC limitations, find a real transaction that calls the target function and inspect it.

**Step 1: Find a live tx via explorer API**

```bash
# Mainnet explorer
curl -s "https://explorer.intuition.systems/api?module=account&action=txlist&address=$MULTIVAULT&startblock=0&endblock=99999999&sort=desc&limit=10" | jq '.result[] | {hash, from, input, value}'
```

Look for transactions whose `input` starts with the function selector you want to trace (e.g., `0x61403309` for `createAtoms`).

**Step 2: Inspect the trace with `cast call --trace`**

```bash
cast call $MULTIVAULT "$RAW_CALLDATA" --rpc-url $RPC --trace
```

This forks state at the latest block and prints the execution trace, showing internal calls, delegatecalls, and revert reasons without broadcasting.

**Step 3: Identify the implementation proxy**

If MultiVault is a proxy, the trace shows a `delegatecall` to the implementation address. Use that address for further inspection:

```bash
cast code $IMPL --rpc-url $RPC
cast disassemble <(cast code $IMPL --rpc-url $RPC) | grep -i "approve\|SLOAD\|CALLER"
```

**Step 4: Search bytecode for function selectors**

```bash
cast code $TARGET --rpc-url $RPC | tr -d '\n' | grep -o '095ea7b3' | wc -l
# 0 = selector not present in bytecode
```

This definitively answers whether a function exists on a given deployment, independent of ABI declarations.

---

## Fallback to External Verification

When local tracing is exhausted but a question remains, **stop probing and ask one consolidated question**. Do not retry indefinitely.

**When to escalate:**
- `cast run --trace` returns `trace_rawTransaction does not exist` (RPC lacks tracing support)
- `forge test --fork-url` hits compiler/import version incompatibilities that block vm.record()
- Bytecode inspection gives presence/absence but not call-gate semantics

**How to ask:** Consolidate all unresolved verification points into a single query. Bad: "can you check X?" then "also Y?" then "and Z?" Good: one message covering (1) receiver parameter existence across all four functions, (2) whether `approve` is actually consulted during those calls or is dead code, (3) whether an operator-approval gate restricts non-caller receivers.

**Do not** capture RPC-specific failures as permanent constraints ("cast run is broken"). The failure is environmental; the retry pattern (find live tx → cast call --trace → bytecode search) is the durable lesson.
