Canonical source for all Intuition L3 network metadata. All other docs in this skill should point here rather than restating chain IDs, contract addresses, RPC URLs, GraphQL endpoints, explorer URLs, or viem chain definitions.

---

Network Table

| Network | Chain ID | MultiVault | RPC | GraphQL | Explorer |
|---|---|---|---|---|---|
| Intuition Mainnet | 1155 | `0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e` | https://rpc.intuition.systems/http | https://mainnet.intuition.sh/v1/graphql | https://explorer.intuition.systems |
| Intuition Testnet | 13579 | `0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91` | https://testnet.rpc.intuition.systems/http | https://testnet.intuition.sh/v1/graphql | https://testnet.explorer.intuition.systems |

---

## Contract Health Check

Before any write or delegation operation, verify that the target contract exists on-chain. This prevents silent ETH transfers to EOAs and cryptic revert messages.

```bash
# Verify MultiVault is a contract (not an EOA)
cast code $MULTIVAULT --rpc-url $RPC

# If the output is 0x, the address is an EOA. BLOCKED — do not broadcast.
# If the output is non-empty, the address is a contract. Proceed.
```

> **Note:** The Mainnet MultiVault address listed above is now confirmed as a contract. Writes and delegation redemptions targeting that address are valid.

---

Delegation Framework Contract Addresses

The Intuition Protocol uses the MetaMask Delegation Framework for ERC-7710 delegation. These contracts are deployed via deterministic CREATE2 with a fixed "GATOR" salt. Addresses are identical across all chains.

Contract Mainnet (1155) Testnet (13579) Notes
DelegationManager 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3 MetaMask Delegation Framework. Exposes getDelegationHash and getDomainHash on-chain (verified). Does NOT expose domainSeparator, isValidDelegation, or hashTypedData.
EIP7702 DeleGator Impl 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B Confirmed labeled on block explorers. Designator pattern: 0xef0100 + this address.
AllowedMethodsEnforcer 0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5 0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5 Restricts which function selectors the delegate can call. From delegation-core 3.0.0 / V3 (verified 2026-10-03).
LimitedCallsEnforcer 0x04658B29F6b82ed55274221a06Fc97D318E25416 0x04658B29F6b82ed55274221a06Fc97D318E25416 Caps total number of redemption calls. Stateful counter tracked by the DelegationManager.
SimpleFactory | 0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c | 0x54c68ad35b082546a1e2e3e1a7542Ce9d3A2e756 | **Chain-specific — verified 2026-10-03.** `0x69Aa2f9f…` (751B) is live on BOTH chains; `0x54c68ad3…` (751B) is live on 13579 ONLY and has ZERO code on 1155. They are different contracts returning different CREATE2 addresses for the same initCode: `0x69Aa…` → `0x99D9ca38…`, `0x54c6…` → `0xFEc573E3…`. Use `0x69Aa2f9f…` on mainnet. |
HybridDeleGatorImpl | 0x48dbe696a4d990079e039489ba2053b36e8ffec4 | 0x48dbe696a4d990079e039489ba2053b36e8ffec4 | Delegation logic (20203B). The Hybrid account itself is a per-deployment ERC-1967 proxy pointing here. |
EntryPoint (ERC-4337 v0.7) | 0x0000000071727De22E5E9d8BAf0edAc6f37da032 | 0x0000000071727De22E5E9d8BAf0edAc6f37da032 | Canonical v0.7 EntryPoint (16035B), live on both. `handleOps` is permissionless — no bundler required. Needed for revocation (see `operations/revoke-delegation.md`). |

---

Enforcer Quick Reference

Enforcer What It Restricts Terms Encoding Args
AllowedMethodsEnforcer Function selector allowlist raw concatenated bytes4 selectors 0x
LimitedCallsEnforcer Total redemption call count abi.encode(uint256 maxCalls) 0x
ValueLteEnforcer Native value cap abi.encode(uint256 maxWad) 0x

Important Notes:

· **Value caps ARE enforced** by `ValueLteEnforcer` `0x92bf1232…` (1272B, live on BOTH chains, verified 2026-10-03). Only the historical `NativeTokenTransferAmountEnforcer` `0xA9BC5458…` is absent (zero code on both chains) — do not use it. Enforce native-value caps off-chain in the agent (self-enforced budget) — there is no built-in native-token transfer-amount enforcer in this deployment. Periodic rate-limiting (e.g., "100 TRUST/day") is likewise unavailable as a built-in; agents may self-enforce daily budgets.
· LimitedCallsEnforcer enforces call count against a counter stored in the DelegationManager. The agent does not need to track this manually — the contract reverts if the limit is exceeded. However, the agent should check the remaining allowance before attempting redemption to avoid unnecessary gas costs.

---

DelegationManager Interface Limitations

Critical: The DelegationManager deployed on Intuition L3 does not expose the following functions that are commonly assumed for ERC-7710:

Function Status
domainSeparator() ❌ Does NOT exist
isValidDelegation(...) ❌ Does NOT exist
hashTypedData(...) ❌ Does NOT exist
revokeDelegation(bytes32) ❌ Does NOT exist
Available Functions:

| Function | Purpose |
|----------|---------|
| `redeemDelegations(bytes[],bytes32[],bytes[])` | Execute a delegation (the core redemption function) |
| `disableDelegation(Delegation)` | Revoke/disable a delegation (takes the full struct) |
| `enableDelegation(Delegation)` | Re-enable a previously disabled delegation |
| `disabledDelegations(bytes32 delegationHash) view returns (bool)` | Check if a delegation is disabled/revoked (takes the delegation hash) |
| `getDelegationHash(Delegation) view returns (bytes32)` | Compute the delegation hash on-chain (takes the full struct) |

Action Items:

1. Always compute the EIP-712 digest from on-chain reads — `getDelegationHash()` + `getDomainHash()` (see operations/create-delegation.md → Step 5c). Do NOT use `@metamask/smart-accounts-kit` or off-line/off-chain struct hashing — both mismatch the contract's Caveat[] encoding.
2. Fixed EIP-712 domain. Use the fixed domain:
   ```typescript
   const domain = {
     name: 'DelegationManager',
     version: '1',
     chainId: CHAIN_ID,
     verifyingContract: DELEGATION_MANAGER,
   }
   ```
3. Revocation uses the full struct. Call `disableDelegation(delegation)` where delegation is the complete signed Delegation object.
4. Revocation check uses `disabledDelegations(bytes32)`. Pass `keccak256(abi.encode(delegation_struct))` as the argument. Do NOT pass the raw struct bytes.

---

Native Token and Bridge

 Mainnet Testnet
Symbol $TRUST tTRUST
Decimals 18 18
Bridge URL https://app.intuition.systems/bridge https://app.intuition.systems/bridge

parseEther('0.5') works for formatting TRUST amounts (same 18-decimal math). The unit is TRUST, not ETH.

---

Session Environment Variables

Use these values to pin a session before reads or writes.

Mainnet

```bash
export NETWORK="Intuition Mainnet"
export CHAIN_ID=1155
export RPC="https://rpc.intuition.systems/http"
export MULTIVAULT="0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e"
export DELEGATION_MANAGER="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
export GRAPHQL="https://mainnet.intuition.sh/v1/graphql"
export EXPLORER="https://explorer.intuition.systems"

# Enforcer addresses (for convenience)
export ALLOWED_METHODS_ENFORCER="0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5"
export LIMITED_CALLS_ENFORCER="0x04658B29F6b82ed55274221a06Fc97D318E25416"
export VALUE_LTE_ENFORCER="0x92bf12322527caa612fd31a0e810472bbb106a8f"
```

Testnet

```bash
export NETWORK="Intuition Testnet"
export CHAIN_ID=13579
export RPC="https://testnet.rpc.intuition.systems/http"
export MULTIVAULT="0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91"
export DELEGATION_MANAGER="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
export GRAPHQL="https://testnet.intuition.sh/v1/graphql"
export EXPLORER="https://testnet.explorer.intuition.systems"

# Enforcer addresses (for convenience)
export ALLOWED_METHODS_ENFORCER="0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5"
export LIMITED_CALLS_ENFORCER="0x04658B29F6b82ed55274221a06Fc97D318E25416"
export VALUE_LTE_ENFORCER="0x92bf12322527caa612fd31a0e810472bbb106a8f"
```

---

viem Chain Definitions

```typescript
import { defineChain } from 'viem'

export const intuitionMainnet = defineChain({
  id: 1155,
  name: 'Intuition',
  nativeCurrency: { decimals: 18, name: 'Intuition', symbol: 'TRUST' },
  rpcUrls: { default: { http: ['https://rpc.intuition.systems/http'] } },
  blockExplorers: {
    default: { name: 'Intuition Explorer', url: 'https://explorer.intuition.systems' },
  },
})

export const intuitionTestnet = defineChain({
  id: 13579,
  name: 'Intuition Testnet',
  nativeCurrency: { decimals: 18, name: 'Test Trust', symbol: 'tTRUST' },
  rpcUrls: { default: { http: ['https://testnet.rpc.intuition.systems/http'] } },
  blockExplorers: {
    default: { name: 'Intuition Testnet Explorer', url: 'https://testnet.explorer.intuition.systems' },
  },
})
```

---

Governance Note

These values are stable operational defaults, but governance can change them. Verify here before copying network metadata anywhere else in the skill.

Delegation Framework Note: all enforcer addresses below were verified live on both chains on
2026-10-03 with `cast code`; they are deterministic CREATE2 deployments of
delegation-core 3.0.0 / V3. Re-verify with `scripts/delegation-doc-verification.sh` before
relying on them. Deterministic CREATE2 deployments with fixed "GATOR" salt ensure identical addresses across all chains, including Intuition mainnet (1155) and testnet (13579).

---

Quick Reference: DelegationManager ABI

The DelegationManager exposes only these key functions:

```typescript
const delegationAbi = parseAbi([
  // Core redemption
  'function redeemDelegations(bytes[] calldata _permissionContexts, bytes32[] calldata _modes, bytes[] calldata _executionCallData) external',
  
  // Revocation
  'function disableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer,bytes terms,bytes args)[] caveats, uint256 salt, bytes signature) delegation) external',
  
  // Re-enable
  'function enableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer,bytes terms,bytes args)[] caveats, uint256 salt, bytes signature) delegation) external',
  
  // Revocation view (takes delegation hash)
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  
  // Hash computation (takes full struct)
  'function getDelegationHash((address delegate, address delegator, bytes32 authority, (address enforcer,bytes terms,bytes args)[] caveats, uint256 salt, bytes signature) delegation) view returns (bytes32)',
  
  // ERC-7579 execution mode
  // MODE_SINGLE_DEFAULT = 0x0000000000000000000000000000000000000000000000000000000000000000
])
```

Remember:
· `disabledDelegations(bytes32)` → ✅ Exists (pass `keccak256(abi.encode(delegation_struct))`)
· `disableDelegation(Delegation)` → ✅ Exists (pass the full struct)
· `enableDelegation(Delegation)` → ✅ Exists (pass the full struct)
· `getDelegationHash(Delegation)` → ✅ Exists (pass the full struct, returns bytes32)