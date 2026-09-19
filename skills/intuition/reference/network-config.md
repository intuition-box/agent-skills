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
DelegationManager 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3 MetaMask Delegation Framework. Does NOT expose domainSeparator, getDelegationHash, isValidDelegation, or hashTypedData. Use off-chain SDK for hashing.
EIP7702 DeleGator Impl 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B Confirmed labeled on block explorers. Designator pattern: 0xef0100 + this address.
AllowedMethodsEnforcer 0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5 0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5 Restricts which function selectors the delegate can call. From MetaMask Delegation Framework v1.3.0.
NativeTokenTransferAmountEnforcer 0xA9BC5458E3eD352Df2eA4AbE9e0bBA41173513B9 0xA9BC5458E3eD352Df2eA4AbE9e0bBA41173513B9 Caps cumulative native token (TRUST) spend across all redemptions. Global cap, not periodic.
LimitedCallsEnforcer 0x04658B29F6b82ed55274221a06Fc97D318E25416 0x04658B29F6b82ed55274221a06Fc97D318E25416 Caps total number of redemption calls. Stateful counter tracked by the DelegationManager.
SimpleFactory 0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c 0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c Deterministic Smart Wallet deployment (legacy — see deposit-authority-track.md).

---

Enforcer Quick Reference

Enforcer What It Restricts Terms Encoding Args
AllowedMethodsEnforcer Function selector allowlist raw concatenated bytes4 selectors 0x
NativeTokenTransferAmountEnforcer Cumulative TRUST spend cap abi.encode(uint256 maxCumulativeSpend) 0x
LimitedCallsEnforcer Total redemption call count abi.encode(uint256 maxCalls) 0x

Important Notes:

· NativeTokenTransferAmountEnforcer is a global cumulative cap, not a periodic rate limit. True periodic rate-limiting (e.g., "100 TRUST per day") is not available as a built-in enforcer. Agents may implement self-enforced daily budgets in addition to on-chain caps.
· LimitedCallsEnforcer enforces call count against a counter stored in the DelegationManager. The agent does not need to track this manually — the contract reverts if the limit is exceeded. However, the agent should check the remaining allowance before attempting redemption to avoid unnecessary gas costs.

---

DelegationManager Interface Limitations

Critical: The DelegationManager deployed on Intuition L3 does not expose the following functions that are commonly assumed for ERC-7710:

Function Status
domainSeparator() ❌ Does NOT exist
getDelegationHash(...) ❌ Does NOT exist
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

1. All hashing is off-chain. Use `@metamask/smart-accounts-kit` or manual viem encoding (see `reference/off-chain-hashing.md`).
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
export NATIVE_TOKEN_ENFORCER="0xA9BC5458E3eD352Df2eA4AbE9e0bBA41173513B9"
export LIMITED_CALLS_ENFORCER="0x04658B29F6b82ed55274221a06Fc97D318E25416"
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
export NATIVE_TOKEN_ENFORCER="0xA9BC5458E3eD352Df2eA4AbE9e0bBA41173513B9"
export LIMITED_CALLS_ENFORCER="0x04658B29F6b82ed55274221a06Fc97D318E25416"
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

Delegation Framework Note: All enforcer addresses are sourced from the MetaMask Delegation Framework v1.3.0 deployment registry. Deterministic CREATE2 deployments with fixed "GATOR" salt ensure identical addresses across all chains, including Intuition mainnet (1155) and testnet (13579).

---

Quick Reference: DelegationManager ABI

The DelegationManager exposes only these key functions:

```typescript
const delegationAbi = parseAbi([
  // Core redemption
  'function redeemDelegations(bytes[] calldata _permissionContexts, bytes32[] calldata _modes, bytes[] calldata _executionCallData) external',
  
  // Revocation
  'function disableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation) external',
  
  // Re-enable
  'function enableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation) external',
  
  // Revocation view (takes delegation hash)
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  
  // Hash computation (takes full struct)
  'function getDelegationHash((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation) view returns (bytes32)',
  
  // ERC-7579 execution mode
  // MODE_SINGLE_DEFAULT = 0x0000000000000000000000000000000000000000000000000000000000000000
])
```

Remember:
· `disabledDelegations(bytes32)` → ✅ Exists (pass `keccak256(abi.encode(delegation_struct))`)
· `disableDelegation(Delegation)` → ✅ Exists (pass the full struct)
· `enableDelegation(Delegation)` → ✅ Exists (pass the full struct)
· `getDelegationHash(Delegation)` → ✅ Exists (pass the full struct, returns bytes32)