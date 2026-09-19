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

**Resolution (2026-08-17):** Path 1 (EIP-7702 Direct) is now **confirmed working on testnet**. Full lifecycle: create → write → revoke → blocked. Testnet txs: write `0xd017ff5c...`, revoke `0x9d5ceaee...`.

**Path 2 testnet status:** End-to-end delegation/redemption on testnet has **not** been executed. Only smart account provisioning and an EIP-7702 upgrade were attempted. Mainnet Path 2 is confirmed working (approval `0x3f6bf183...`, redemption `0x0f48471f...`, revoke `0xb0778e08...`).

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
