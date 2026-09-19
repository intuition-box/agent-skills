# UX Patterns for Intuition Operations

> **Status:** MANDATORY — these patterns apply to every Intuition operation
> (read or write, any path). They prevent users from getting stuck,
> rebuilding already-completed steps, or missing documented requirements.

---

## 1. Pre-Task Context Check (MANDATORY)

Before executing ANY Intuition operation, run these checks **in order**:

### Step 1: Read Session Context

Check for setup notes, prior session state, and planned workflows:

- Read `reference/intuition-setup-notes.md` if it exists (session-specific constants, agent wallet, planned workflow)
- Use `session_search` to find prior Intuition work if no setup notes exist
- **Report what you found to the user BEFORE building anything**

### Step 2: Check Delegation State

For Path C operations, check if a valid delegation already exists:

- Read `~/.intuition/agent-state.json` and any `delegation-signed.json` files
- Check `disabledDelegations(hash)` on-chain for any cached delegation hashes
- **If a valid unexpired delegation exists, SKIP straight to execution** — do not ask the user to re-sign

### Step 3: State the Plan

Tell the user:
- What you found in prior session context (planned steps, addresses, constants)
- What's already done vs. what remains
- Which path (A/B/C) and why
- What you need from them (network choice, key for one-time signing, confirmation)

### Skipping these checks causes:
- Missing prior context
- Rebuilding already-completed steps
- Skipping documented requirements
- Asking the user to sign when a valid delegation already exists

---

## 2. Private Key Request Pattern (MANDATORY for Path C)

When Path C requires a new delegation, you **MUST** explicitly ask the user for their private key. Do not assume they know to provide it.

### Why Private Key Signing Is Recommended

MetaMask does **not** support the three alternative signing methods:

- **`personal_sign` / `eth_sign`** — MetaMask removed these. They also add an Ethereum prefix that breaks ERC-1271 validation.
- **`eth_signTypedData_v4`** — MetaMask blocks this for EIP-7702 upgraded accounts with: `External signature requests cannot sign delegations for internal accounts.`
- **`wallet_signTypedData_v4` (signing page)** — Works for non-EIP-7702 accounts via `templates/sign-delegation.html`, but fails for EIP-7702 delegators (the common case for the creation track).

**Private key signing (via local script or `cast`) is the only method that works in all cases** — EOA, EIP-7702, mainnet, testnet. It produces a standard EIP-712 signature with no prefix issues and no MetaMask restrictions.

### Delegation Re-Use After Setup

After the one-time signing, the delegation is **cached and re-used by the agent** for all subsequent operations until revoked. The user never needs to sign again unless:
- The delegation expires (if an expiry caveat was set)
- The delegation is revoked
- The operation scope changes (new methods, higher spend cap)

**Important:** the private key will be needed again whenever a **new delegation** must be created (revocation, expiry, or scope change). The cached delegation is re-used — it does not eliminate the key for future setup events.

### The Pattern

```
To set up the delegation, I need your Main Account private key for one-time off-chain signing.

Why: MetaMask blocks custom ERC-7702 signing, so local signing is the only method that works for all account types.

The key is used ONLY to sign the EIP-712 delegation digest — it is never stored, logged, or transmitted.
After setup, the delegation is cached and re-used for all future operations under this scope. You won't need to sign again — unless a new delegation is required (revocation, expiry, or scope change).

Paste your private key now (I'll use it in memory only, never write to disk):
```

### Rules

- **NEVER** proceed without explicitly asking for the key
- **NEVER** store the delegator's key to disk — use env vars or in-memory variables only
- **ALWAYS** explain what the key is used for (one-time EIP-712 signing) and that it won't be persisted
- **ALWAYS** state that the delegation is re-used after setup — the key is needed once, not per-operation
- After signing, the key goes "back in the vault" — **confirm this to the user**: `"Key used for signing. It is now back in the vault — not stored, not logged. Delegation cached for future operations. Note: a new key signing will be needed if this delegation is revoked, expires, or needs a scope change."`

---

## 3. Multi-Step Workflow Flagging (MANDATORY)

When the user asks for a single operation that is part of a documented multi-step workflow:

1. Identify the full workflow from setup notes or `reference/workflows.md`
2. Show the user where they are in the workflow
3. Flag any prerequisites that haven't been completed yet
4. Ask whether they want to do just this step or the full remaining workflow

### Example

```
This is step 3 of 5 in your planned workflow:

  ✅ 1. Create delegation (done)
  ✅ 2. Create atom (done)
  ⬜ 3. Deposit 2 TRUST into atom (what you're asking for)
  ⬜ 4. Create triple
  ⬜ 5. Deposit 2 TRUST into triple

Steps 4-5 are still pending. Do you want me to continue through the full remaining workflow after this step?
```

---

## 4. Network Selection (MANDATORY)

On first invocation (or when network is unknown), ask:

```
Which network?
1. Intuition Mainnet  -- chain 1155
2. Intuition Testnet  -- chain 13579
```

Do not assume the network. If the user previously selected a network in setup notes, confirm it's still correct before proceeding.

---

## 5. Output Before Action

Before emitting transaction calldata or signing requests, always show:

- **A summary of what will happen** — operations, costs, addresses
- **What the user needs to do next** — sign, broadcast, provide signatures
- **Any risks or irreversible actions** — delegation scope, spend caps, permanent revocation

### Example

```
SUMMARY:
  Operation: Deposit 2.0 tTRUST into atom 0xabcd...
  Vault: AtomVault (curveId: 1)
  Expected shares: ~18.5 shares (after fees)
  Delegation: Uses existing valid delegation (expires in 6h)

NEXT STEPS:
  1. I'll generate the redeemDelegations calldata
  2. Agent broadcasts from 0xe9Bf...050d
  3. Confirm result via post-write verification

RISKS:
  - Bonding curve slippage if vault state changed (will use minShares from preview)
  - Estimated entry fee: 2% (query previewDeposit for exact)

Proceed? (yes/no)
```
