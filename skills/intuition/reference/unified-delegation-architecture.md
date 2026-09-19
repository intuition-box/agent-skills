# Unified Delegation Architecture

> **Model (2026-09):** "Main Account = beneficial owner everywhere." The old
> "Path 1 vs Path 2" dichotomy is retired. This document describes the
> unified two-track model that replaces it.

## Core Principle

**Creation attribution doesn't carry semantic weight — position ownership does.**

The mission is NOT "Main Account must be msg.sender everywhere." The mission
is "Main Account must be the beneficial owner of all positions everywhere."

This means:
- `createAtoms`/`createTriples` can have OWS as `msg.sender` (no `receiver` param)
- `deposit`/`redeem` use `receiver = Main Account` to route shares correctly
- Both tracks compose: creation for setup, deposits for ongoing operations

## Two Authority Tracks

### Creation Authority Track

**Purpose:** `createAtoms`, `createTriples` (one-time setup operations)

**Chain:** Main Account → OWS → Agent

```
Main Account --(EIP-7702 delegation)--> OWS
OWS --(EIP-712 delegation)--> Agent
```

**Characteristics:**
- OWS is a temporary EIP-7702 upgraded wallet (session-only key)
- Main Account key used once for setup, then shelved
- `msg.sender` at MultiVault = OWS
- Revocable: revoke OWS delegation after creation setup complete
- No `approve` needed on MultiVault

**Setup flow:**
1. Generate OWS keypair (temporary)
2. Upgrade OWS to EIP-7702 via `cast send $OWS --auth $IMPL`
3. Main Account signs EIP-7702 delegation to OWS (creation-scoped)
4. OWS signs EIP-712 delegation to Agent (cached)
5. Optional: revoke Main Account → OWS delegation after creation complete

**Agent execution:**
```
Agent calls:
  redeemDelegations(
    [Main Account → OWS, OWS → Agent],
    createAtoms(...)
  )
Result: msg.sender = OWS, atom created, attribution = OWS (acceptable)
```

### Deposit/Redemption Authority Track

**Purpose:** `deposit`, `redeem`, batch variants (standing operations)

**Chain:** Main Account → approve(Smart Wallet) + Smart Wallet → Agent

```
Main Account --(approve)--> Smart Wallet (on MultiVault)
Smart Wallet --(EIP-712 delegation)--> Agent
```

**Characteristics:**
- Smart Wallet is a persistent contract or agent-held key
- Main Account key used once for `approve`, then shelved
- `msg.sender` at MultiVault = Smart Wallet
- `receiver = Main Account` routes shares correctly
- Revocable: revoke Smart Wallet delegation or remove `approve`

**Setup flow:**
1. Main Account calls `approve(SmartWallet, 3)` on MultiVault (signed in MetaMask)
2. Smart Wallet signs EIP-712 delegation to Agent (cached)
3. Optional: Main Account grants ERC-7715 stream to Smart Wallet for funding

**Agent execution:**
```
Agent calls:
  redeemDelegations(
    [Smart Wallet → Agent],
    deposit(receiver: Main Account, ...)
  )
Result: msg.sender = Smart Wallet, receiver = Main Account, shares minted to Main Account
```

## Composition (Full Agent)

For a complete agent that both creates and deposits:

```
Phase 1 — Setup (one-time, Main Account key):
  Main Account → OWS (creation delegation)
  OWS → Agent (creation delegation, cached)
  Main Account → approve(Smart Wallet) on MultiVault
  Smart Wallet → Agent (deposit delegation, cached)
  [Main Account key goes back in vault]

Phase 2 — Operations (Agent autonomous):
  Create atoms:  redeemDelegations([MainAcc→OWS, OWS→Agent], createAtoms(...))
  Deposit:        redeemDelegations([SmartWallet→Agent], deposit(receiver: MainAcc, ...))

Phase 3 — Management (optional):
  Revoke OWS→Main Account delegation (creation setup complete)
  Revoke Smart Wallet delegation (kill switch for deposits)
```

## Key Separation (4 roles)

| Role | Owner | Persisted? |
|------|-------|------------|
| Main Account key | User | Never |
| OWS key | Session-only | Optional (setup window only) |
| Smart Wallet key | Agent | Yes |
| Agent key | Agent | Yes (`~/.intuition/agent-wallet.json`) |

## Comparison with Old Model

| Concept | Old (Path 1/Path 2) | New (Two Tracks) |
|---|---|---|
| Architecture | Mutually exclusive choice | Complementary composition |
| Main Account involvement | Ongoing (Path 1) or one-time (Path 2) | One-time setup only |
| Creation attribution | Path 1: via Smart Wallet, Path 2: via Main Account | OWS (acceptable) |
| Deposit attribution | Path 1: Main Account, Path 2: Main Account | Main Account (via receiver) |
| Approve needed? | Path 1: yes, Path 2: no | Deposit track: yes, Creation track: no |
| MetaMask compatible? | Path 1: yes, Path 2: no | Both tracks: yes (for setup) |

## Verified Addresses (mainnet chain 1155)

```
DELEGATION_MANAGER = 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
MULTIVAULT = 0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e
ALLOWED_METHODS_ENFORCER = 0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5
LIMITED_CALLS_ENFORCER = 0x04658B29F6b82ed55274221a06Fc97D318E25416
EIP7702_DELEGATOR_IMPL = 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B
AGENT = 0x51c20B06dbDad041f3B3aF75118e7F23b7326F18
CHAIN_ID = 1155
RPC = https://rpc.intuition.systems/http
```

## See Also

- `reference/delegation.md` — Core delegation concepts, signing flow, struct anatomy
- `reference/delegation-authority.md` — Agent-side authority verification gate
- `references/delegation-encoding-rules.md` — Exact encoding rules for calldata
- `references/delegation-debugging.md` — Layered debugging procedures
- `references/delegation-chain-attribution.md` — Why multi-hop chains don't preserve root
