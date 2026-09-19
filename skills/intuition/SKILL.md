---
name: intuition
description: "Use this skill when interacting with the Intuition Protocol on-chain. Follow these instructions to produce correct transactions for creating atoms, triples, depositing into vaults, reading protocol state, and managing delegated authority. Triggers on tasks involving Intuition, atoms, triples, vaults, attestations, delegation, the Delegation Framework, or the $TRUST token."
version: 1.0.4
author: jonathanprozzi
license: MIT
tags: [intuition, defi, delegation, eip712]
metadata:
  hermes:
    tags: [intuition, defi, delegation, eip712]
    related_skills: []
---

# Intuition Protocol Skill

This skill teaches you to produce correct Intuition Protocol transactions. Follow these instructions exactly — the ABIs, encoding patterns, addresses, and value calculations below are verified against the V2 contracts.

## Changelog

### 1.0.4 (2026-09-13) — UX Patterns, MetaMask Correction & Delegation Re-Use

**Mandatory UX patterns added.** New file `ux-patterns.md` covers 5 patterns:
pre-task context check, private key request (with MetaMask limitation explained),
multi-step workflow flagging, network selection, output-before-action. Referenced
from `SKILL.md` in "How to Use This Skill" and the Skill Contents table.

**MetaMask signing correction.** `wallet_signTypedData_v4` (via signing page) does
NOT work for EIP-7702 upgraded accounts — only for non-EIP-7702. MetaMask blocks
ALL three alternative signing methods (`personal_sign`, `eth_signTypedData_v4`,
`wallet_signTypedData_v4`). Only local private key signing works for all account
types. Updated `SKILL.md` MetaMask section + `ux-patterns.md` Pattern 2.

**Delegation re-use clarified.** Pattern 2 now states: delegation is cached and
re-used after setup, BUT the private key is needed again whenever a new delegation
must be created (revocation, expiry, scope change).

**Files added:**
- `ux-patterns.md` — 5 mandatory UX patterns with examples and rules

**Files updated:**
- `SKILL.md` — Version bump, MetaMask signing section corrected (1 location),
  ux-patterns reference added (2 locations), Skill Contents table updated

### 1.0.3 (2026-09-12) — Full Delegation Lifecycle Verified on Testnet

**Complete lifecycle verified end-to-end on testnet.** All four steps confirmed working:
create via delegation → deposit via delegation → revoke → post-revoke blocked.

**Root causes fixed:**
1. **execCallData encoding** — `solidityPacked(['address','uint256','bytes'], ...)` is the standard MetaMask pattern (not `abi.encode`). `ExecutionLib.decodeSingle()` reads inner calldata from byte offset 0x34.
2. **disableDelegation field order** — Uses standard MetaMask order `(delegate, delegator)`. Reversed order causes `InvalidDelegator()` (0xb9f0f171).
3. **Deposit minShares** — Must be > 0 (from `previewDeposit`). Zero causes `MultiVault_SlippageExceeded` (0x40a0e8d2).
4. **EIP-712 type definition** — Uses standard MetaMask struct field order `(delegate, delegator)` in the typehash string.

**Live proof (testnet):**
- Create: TX `0xad44b8709bdc2cfe00ad3053ece3951341b750f044c4f11a74f5ec7cb7fbcfcf` (block 9369906)
- Deposit: TX `0xecce25f5a38a1210e44eefb15fef784793f560968a11db0b5abd48f312e0aea8` (block 9369910)
- Revoke: TX `0xc507ce129f082c8b0f6cdff6afed40773ee89d36f4f02e0549031928b6785ef1` (block 9369912)
- Post-revert: `0x05baa052` = `CannotUseADisabledDelegation()`

**Files updated:** See git history for full file lists.

---

## How to Use This Skill

> **New to delegation?** Start with [`DELEGATION-LIFECYCLE.md`](DELEGATION-LIFECYCLE.md) — a
> complete, copy-paste workflow that gets you from zero to delegated create → deposit → revoke
> in under 15 minutes. Every code block is tested on testnet.

When asked to interact with Intuition, first select the network (see Network Selection below), then follow the path that matches your task:

**Before any operation**, follow the mandatory UX patterns in [`ux-patterns.md`](ux-patterns.md):
1. **Pre-Task Context Check** — read session context, check delegation state, state the plan
2. **Private Key Request** — explicitly ask for the key (only local signing works; delegation is re-used but key needed again for new delegations)
3. **Multi-Step Workflow Flagging** — show position in workflow and pending steps
4. **Network Selection** — confirm network before proceeding
5. **Output Before Action** — show summary, next steps, and risks before emitting calldata

**Choose your path:**
- **Path A: Read-Only** — Discovery and exploration. No wallet needed.
- **Path B: Write** — Create atoms/triples, deposit/redeem directly. Requires a funded wallet.
- **Path C: Delegated Operations** — Create, deposit, or redeem via cached delegation chains. The Agent is never the on-chain actor.

### Path A: Read-Only Exploration

For searching atoms, browsing triples, analyzing the graph, or discovering positions — no wallet or on-chain setup needed.

1. **Get the GraphQL endpoint** from the Network Configuration table below. No authentication required.
2. **Load `reference/graphql-queries.md`** for query patterns, filters, traversal, and aggregation.
3. **Query the graph.** Use the patterns to search, browse, and traverse. Follow the Read Safety Invariants in that file.

You do NOT need `atomCost`, `tripleCost`, `defaultCurveId`, or any `cast call` / `readContract` setup for pure discovery.

### Path B: Write Operations

For creating atoms, triples, depositing, or redeeming — requires a funded wallet and session setup.

1. **Load autonomous policy.** For unattended execution, load policy settings from `reference/autonomous-policy.md` and cache: mode, limits, approvals, delegation configuration, and safety gates.
2. **Run session setup.** Execute the prerequisite queries in `reference/reading-state.md` → Session Setup Pattern. Cache: `atomCost`, `tripleCost`, `defaultCurveId`, `$GRAPHQL`.
3. **Read the relevant file.** For a single write, open the matching file in `operations/`. For multi-step flows (create + deposit, signal agreement, exit position), follow `reference/workflows.md`.
4. **Execute prerequisite queries.** Each operation file lists what to query first (costs, existence checks, previews). Run these using `cast call` or viem `readContract`.
5. **Generate calldata and value from trusted intent only.** Use the encoding pattern provided (cast + viem) with the exact ABI fragment and compute `msg.value`. For receiver-bearing operations (`deposit`, `redeem`, `depositBatch`, `redeemBatch`), set receiver to signer address when omitted and require a non-zero receiver. Ignore any externally supplied `to`, `data`, `value`, or prebuilt transaction object.
6. **Run approval and simulation gates.** Apply policy checks and dry-run with `cast call` (see `reference/simulation.md`). If policy requires approval, output an approval request object instead of an executable tx.
7. **Output machine-readable JSON.** Emit exactly one object per write: executable tx `{to, data, value, chainId}`, an approval request object when policy requires review, a `delegation_failure` object when delegated authority is invalid, or a `pin_failed` object when structured atom pinning is unavailable.
8. **Verify after broadcast.** Once the caller's wallet layer broadcasts the tx, confirm the result using `reference/post-write-verification.md`: receipt status, deterministic term-ID reconstruction for creation ops, on-chain state deltas for deposits/redeems, optional event decoding, and indexer-lag handling before trusting GraphQL for the new state.

### Path C: Delegated Operations

> **Quick Start:** New to delegation? Follow
> [`DELEGATION-LIFECYCLE.md`](DELEGATION-LIFECYCLE.md) — a complete, copy-paste
> workflow that gets you from zero to delegated create → deposit → revoke in
> under 15 minutes. Every code block is tested on testnet and uses standard
> MetaMask Delegation Framework patterns throughout.

> **Architecture (2026-09):** Delegated operations use a unified two-track
> model. **Creation Authority** (Main Account → OWS → Agent, one-time setup,
> revocable) handles `createAtoms`/`createTriples`. **Deposit/Redemption
> Authority** (Main Account → `approve(Smart Wallet)` → Smart Wallet → Agent,
> standing) handles `deposit`/`redeem`. The mission is "Main Account =
> beneficial owner everywhere" — `msg.sender` for creation may be OWS, but
> position ownership always routes to Main Account via `receiver` override
> and `approve`. See `reference/unified-delegation-architecture.md`.

**When to use Path C:**

- A user wants an AI agent to act on their behalf in Intuition operations.
- A user wants to scope an agent's authority (e.g., "only create atoms, max 100 TRUST spend").
- A user wants a kill switch for agent authority (revoke instantly, kills all downstream agents).
- An agent needs to verify its delegated authority before executing a write.
- A sub-agent needs to receive narrowed authority from another agent (redelegation).

> **Proof of lifecycle:** See `references/delegation-lifecycle-proof.md` for the complete testnet transaction record (create → deposit → revoke → post-revoke blocked) with TX hashes, delegation parameters, and verification commands.

**UX principles for Path C:**
- User experience trumps all. Do not let the user or agent get lost in delegation choices or setup steps.
- Every delegation-related step must have a straightforward setup path. If a step adds complexity, it must also provide a simpler alternative or explicit fallback.
- A delegated Intuition write is a normal Path B operation (session setup, prerequisite queries, encoding, policy gates) whose calldata is then wrapped into `redeemDelegations`. Path B prerequisites like `reference/reading-state.md` are therefore essential, not stale.

**Two authority tracks:**

| Property | Creation Authority | Deposit/Redemption Authority |
|---|---|---|
| Purpose | `createAtoms`, `createTriples` (one-time setup) | `deposit`, `redeem`, batch variants (standing) |
| Delegator | OWS (temporary wallet, EIP-7702 upgraded) | Smart Wallet (contract or agent-held key) |
| Setup | Main Account → OWS delegation, OWS → Agent delegation | Main Account → `approve(SmartWallet, 3)`, Smart Wallet → Agent delegation |
| `msg.sender` at MultiVault | OWS (creation has no `receiver` param) | Smart Wallet (deposit `receiver = Main Account`) |
| Main Account involvement | One-time: sign creation delegation + OWS delegation | One-time: approve Smart Wallet. Standing: Agent operates autonomously |
| Revocable | Yes — revoke OWS delegation after setup | Yes — revoke Smart Wallet delegation or remove approve |

**Key separation (4 roles, never mixed):**

| Role | Owner | Where it lives | May the skill persist it? |
|------|-------|----------------|---------------------------|
| Main Account key | User | User's wallet only (MetaMask, hardware) | **NO** |
| OWS key | Temporary (session-only) | Session memory, discarded after setup | Optional — only for the setup window |
| Smart Wallet key | Agent | Agent secure storage | **YES** |
| Agent key | Agent | `~/.intuition/agent-wallet.json` (chmod 600) | **YES** |

**MetaMask browser signing:**
- MetaMask removed `eth_sign`. For EIP-712 signing in-browser, use `wallet_signTypedData_v4`. `signMessage` / `personal_sign` adds an Ethereum prefix and breaks ERC-1271 validation.
- The signing page at `templates/sign-delegation.html` implements this pattern: load prepared JSON, compute digest from on-chain `getDomainHash()`, then call `wallet_signTypedData_v4`.
- **Pitfall:** The `chainId` in the typed-data domain must match the active MetaMask network exactly. Testnet = 13579, mainnet = 1155. A mismatch causes MetaMask to reject the signature request before signing.
- **Pitfall:** When the delegator is an EIP-7702 upgraded account (`0xef0100...`), MetaMask blocks `eth_signTypedData_v4` with `External signature requests cannot sign delegations for internal accounts.` `wallet_signTypedData_v4` (via the signing page at `templates/sign-delegation.html`) works for non-EIP-7702 accounts but also fails for EIP-7702 delegators. **Local private key signing is the only method that works for all account types** — see `ux-patterns.md` → "Private Key Request Pattern" for the full explanation.
- **Option B / prepare→sign→redeem:** Split the flow into three scripts to avoid MetaMask browser signing entirely: (1) `prepare-*.mjs` generates the delegation JSON and computes hashes using on-chain `getDomainHash()`/`getDelegationHash()` — no private key needed; (2) `sign-*.mjs` runs locally with the relevant private key env var to produce the signed delegation JSON; (3) `redeem-*.mjs` runs on the agent to broadcast `redeemDelegations`. The signed JSON can be prepared ahead of time and loaded into a signing page, so the user only needs to paste the key once locally.

**UX pattern: check-before-ask for delegation signing** — see
[`ux-patterns.md`](ux-patterns.md) (Pre-Task Context Check + Private Key Request).
Before presenting any signing menu, check if a valid unexpired delegation
already exists. If yes, skip straight to broadcast. If no, run the one-time
delegation signing flow, persisting state in durable files alongside the skill.

**UX pattern: prepare signing page ahead of time** — see
[`ux-patterns.md`](ux-patterns.md) (Output Before Action). For the
prepare→sign→redeem flow, pre-generate the delegation JSON and load it into
the signing page before asking the user to sign. Show the user a summary of
what will happen (operations, costs, scope) before emitting any signing
requests. See `references/signing-page-prepare-pattern.md` for the full flow.

**Signing page requirements**

The signing page must use `wallet_signTypedData_v4` (NOT `signMessage` / `personal_sign` / `eth_sign`), because those add an Ethereum prefix and break ERC-1271 validation. When the delegator is an EIP-7702 upgraded account, MetaMask blocks `eth_signTypedData_v4` for that account — connect the **owner EOA** (implementation address) instead. See `templates/sign-delegation.html` for the working implementation with auto-load and digest computation.

**Quick Reference: Delegated Operations**

| Question | Answer |
|---|---|
| Agent has separate Smart Wallet? | Yes — Agent controls a Smart Wallet with its own key pair. Used for deposit/redemption operations. |
| Needs `approve` on MultiVault? | Yes, for deposit track — Main Account must `approve(SmartWallet, 3)` on MultiVault. Not needed for creation track. |
| `msg.sender` at MultiVault | Creation: OWS (no `receiver` param, attribution follows `msg.sender`). Deposit: Smart Wallet (`receiver = Main Account` routes shares correctly). |
| Agent can self-sign delegation? | Smart Wallet key signs EIP-712 delegations off-chain for the deposit track. Main Account key signs creation-track delegation to OWS. |
| MetaMask browser compatible for setup? | Yes — for `approve`, 7715 streaming, and signing page. No browser signing needed for Agent operations after setup. |
| Requires raw private key? | Main Account key for one-time setup only. OWS key for creation setup (session-only). Smart Wallet key for ongoing operations. |

**Preconditions for deposit/redemption track:**
```
1. Main Account → MultiVault: approve(SmartWallet, 3) (signed in MetaMask)
2. Smart Wallet → Agent: signed EIP-712 delegation (cached)
3. Agent holds Smart Wallet private key for execution
```

**Preconditions for creation track:**
```
1. Main Account → OWS: signed EIP-712 delegation (one-time)
2. OWS → Agent: signed EIP-712 delegation (cached until revoked)
3. Agent holds its own key for broadcasting
```

> **Pitfall:** `approvalType = 255` (`APPROVE_ALL`) reverts on mainnet. Use `approvalType = 3` (`DEPOSIT | REDEMPTION`) instead.
> **Pitfall:** `isApprovedFor(address,address)` exists on mainnet MultiVault but **not** on testnet. On testnet, call `approve(SmartWallet, 3)` directly without a pre-check.
> **Pitfall:** `authorize` does NOT exist on MultiVault. Roles are OpenZeppelin AccessControl (admin roles). Verified selectors: `approve 0x4342e966`, `grantRole 0x2f2ff15d`, `hasRole 0x91d14854`, `revokeRole 0xd547741f`, `renounceRole 0x36568abe`.
> **Pitfall:** In ethers v6, encoding delegation tuples with named fields (e.g., `(address delegate, address delegator, ...)`) triggers `types/value length mismatch`. Use unnamed tuples: `(address,address,bytes32,(address,bytes,bytes)[] caveats,uint256 salt,bytes signature)[]`.

> **Standard MetaMask struct field order (CRITICAL):** The `Delegation` struct uses `(delegate, delegator, authority, caveats, salt, signature)` — the standard upstream MetaMask Delegation Framework order from `Types.sol`. The FIRST field is `delegate`, the SECOND is `delegator`. This means:
> - When calling `getDelegationHash((address,address,...))` on-chain, pass `(delegate, delegator, ...)` — the first address IS the delegate
> - When signing the EIP-712 digest, the digest is computed from `getDelegationHash` which expects delegate first
> - **Wrong order causes `InvalidDelegate()` (`0xb5863604`)** — the contract reads the first field as delegate and compares against `msg.sender`
> - Standard OpenZeppelin order is `(delegator, delegate, ...)` — DO NOT use this for Intuition

`ExecutionLib.decodeSingle()` extracts the inner calldata from byte offset 0x34 of `execCallData`, then the `AllowedMethodsEnforcer` reads the selector from bytes[0:4] of that extracted calldata. Therefore, `execCallData` MUST use `solidityPacked(['address','uint256','bytes'], [target, value, innerCalldata])`. This places the inner calldata at byte offset 0x34 where `decodeSingle` reads it.
> - Correct: `execCallData = solidityPacked(['address','uint256','bytes'], [MULTIVAULT, value, rawCreateTriplesCalldata])`
> - Wrong: `execCallData = abi.encode(['address','uint256','bytes'], [MULTIVAULT, value, rawCreateTriplesCalldata])` (ABI encoding places calldata at byte 0x80+, decodeSingle reads garbage from 0x34)
> - Live proof: testnet TX `0xad44b8709bdc2cfe00ad3053ece3951341b750f044c4f11a74f5ec7cb7fbcfcf` (block 9369906) succeeded with `solidityPacked`

> **disableDelegation field order:** The `disableDelegation` function uses the standard MetaMask order `(delegate, delegator)`. Pass `(delegate, delegator, authority, caveats, salt, signature)` as an unnamed tuple. Using `(delegator, delegate, ...)` causes `InvalidDelegator()` (0xb9f0f171).

**Pre-flight check:** Before running the end-to-end flow on testnet, verify the Main Account balance >= 0.2 tTRUST. The flow requires funding the Agent for gas (0.01–0.02 tTRUST) plus gas for approval, redemption, and revocation. If balance is insufficient, bridge more tTRUST or use a different funded testnet account.

**Empirical testing over external queries:** When an architecture or attribution question can be answered by a direct on-chain test (e.g., "who gets credited if the Agent calls `createAtoms` directly?"), run the test instead of asking external parties. See `scripts/test-direct-createatoms.mjs` for a reusable attribution probe.

**Follow `operations/create-delegation.md`** to build, sign, and output the Delegation object. Set caveats (operation allowlist, spend cap, call limit) to scope authority. **UX preference:** prefer a single reusable delegation covering all intended operations per track over per-operation delegations. Set `callLimit` to cover the total number of `redeemDelegations` redemptions expected across the full workflow.

**Transmit the signed Delegation object to the Agent off-chain.** The Agent stores it in secure session state.

**To revoke, follow `operations/revoke-delegation.md`.** Revocation is on-chain, permanent, and propagates to all downstream redelegations.

**For agents (receiving and exercising authority):**

1. **Agent wallet setup:** The Agent's wallet address is the delegate address. The Agent holds its own private key in secure session state (`~/.intuition/agent-state.json`, permissions `0600`).
   - Testnet Agent: `0xe9BfdEC6Fa795a24e3069292248d9d16570E050d`
   - Mainnet Agent: `0x51c20B06dbDad041f3B3aF75118e7F23b7326F18`
2. **Do NOT store the Main Account private key.** It stays in the user's own wallet (MetaMask or external signer).
3. **Before every Path B write under delegation, run `reference/delegation-authority.md`.** This autonomous gate verifies: delegation validity, revocation, expiry, caveats, receiver consistency. For the deposit track, the gate also verifies the Smart Wallet has sufficient approval and the Main Account has sufficient balance to cover `sum(assets[])`.
4. **If the gate passes,** the agent executes the Intuition calldata via `redeemDelegations`. The outer transaction carries `value = 0`; all TRUST value lives in the inner transaction. **The Agent broadcasts from its own address** (`AGENT_PRIVATE_KEY` env var or keyring).
5. **If the gate fails,** the agent emits a `delegation_failure` object and halts.
6. **For encoding rules:** Load `reference/delegation-encoding-rules.md` for the exact encoding rules, kill switch proof, and verified addresses. Load `references/delegation-debugging.md` for the layered debugging order and diagnostic commands.

**ERC-1271 probe on EIP-7702 upgraded accounts:**

EIP-7702 upgraded accounts (including the Main Account and OWS) implement `isValidSignature` correctly (ECDSA.recover == address(this)). A direct `cast call` to `isValidSignature` returns `0x1626ba7e`. Do not treat EIP-7702 accounts as lacking ERC-1271 support.

**Canonical Delegation Workflow (Layered Verification)**

When creating, verifying, or debugging a delegation, apply checks in this exact order:

1. **ERC-1271 probe (Layer 1)** — Call `isValidSignature(digest, signature)` on the delegator contract in isolation. Pass: returns `0x1626ba7e`. If this fails, fix the digest/signature before proceeding.
2. **Domain hash from-chain (Layer 2)** — Call `getDomainHash()` on the DelegationManager and use the returned `bytes32` directly in the EIP-712 digest. Pass: domain hash matches on-chain read.
3. **Struct hash verified on-chain (Layer 3)** — Compute `getDelegationHash()` off-chain, then call `getDelegationHash(delegation)` on-chain. Pass: `offChainHash === onChainHash`.
4. **Signature recovery (Layer 4)** — Run `ethers.recoverAddress(digest, signature)` and verify it equals `delegator` byte-for-byte. Pass: `recovered.toLowerCase() === DELEGATOR.toLowerCase()`.
5. **Encoding compliance (Layer 5)** — Verify: `_permissionContexts[i]` is `abi.encode(Delegation[], bytes32 delegationHash)`; `execCallData` is `solidityPacked(address,uint256,bytes)`; `AllowedMethodsEnforcer` terms are raw bytes4 selectors; `LimitedCallsEnforcer` terms are `abi.encode(uint256)`.
6. **Pre-compute atom/triple ID (Layer 6)** — Call the creation function via `provider.call({ to: MULTIVAULT, data, value, from: DELEGATOR })` to get the deterministic ID. On mainnet, always include `from: DELEGATOR` for value-carrying static calls.
7. **Systematic debugging (Layer 7)** — When `redeemDelegations` fails, rule out causes in this order: permission context encoding → execCallData packing → enforcer terms format → inner value field → delegator balance → bare direct call from delegator → atom/triple existence check.

**Critical rule:** The Agent is never the on-chain actor. `msg.sender` at MultiVault resolves to the **delegation chain root authority** (the last delegation's `delegator`), not the Agent. The Agent is purely the transaction submitter and gas payer.

> **Mainnet Status (2026-09):** DelegationManager (`0xdb9B...`) and MultiVault (`0x6E35...`) are live on mainnet chain 1155. Mainnet Agent: `0x51c20B06dbDad041f3B3aF75118e7F23b7326F18`. EIP-7702 delegated accounts (`0xef0100...` code) implement `isValidSignature` correctly. Full delegated lifecycle confirmed working on mainnet for both creation and deposit tracks: create/deposit via `redeemDelegations` → revoke → post-revoke blocked. `getDomainHash()` returns `0x44653bfc83c7c3f4ecd0ab2d76a7aff5e3478def6f0a290d939437b65d6fe1d5`. Delegation encoding is resolved: `getDelegationHash` uses **standard OpenZeppelin EIP-712 v4** (MetaMask Delegation Framework). Always call `getDelegationHash()` on-chain and use its returned `bytes32` directly for `_permissionContexts`. See `reference/delegation.md` and `references/delegation-debugging.md` for verification steps.

### Transitioning from Read to Write

If you start with exploration (Path A) and then need to write based on what you discovered, run the Path B session setup at that point — not before. See the Revalidation Bridge in `reference/graphql-queries.md` for safely transitioning from discovered data to write operations.

## Prerequisites

- **Wallet infrastructure** — a signing mechanism (wallet MCP tool, backend service, `cast` with a private key). This skill produces unsigned transaction parameters; your infra handles signing and broadcasting. **ethers v6 note:** `wallet.signDigest()` was removed; use `new ethers.SigningKey(pk).sign(bytes).serialized` instead. Sign the 32-byte EIP-712 digest directly — do not double-hash it.
- **Funded wallet** — $TRUST (mainnet) or tTRUST (testnet) on the Intuition L3.
- **RPC access** — public Intuition RPC endpoints, no API keys required.
- **Pinning capability for structured atoms** — the consuming application's trusted server or CLI runtime owns configuration and credentials. Prefer `@0xintuition/sdk` 3.0.1 or newer with `configureSdk({ pinApiKey })`, or a compatible host-provided adapter. The skill never obtains, stores, prints, or places the key in prompts, plans, transaction output, or browser code. Read `reference/schemas.md` before any structured-atom write.
- **For delegation:** Agent wallet (separate from the delegator's wallet) and secure storage for the signed Delegation object (`~/.intuition/agent-state.json`, permissions `0600`).
- **Key separation (mandatory):** The delegator's private key must **never** be stored by the agent or skill. It stays in the user's own wallet. Only the **agent's** private key may be persisted, to `~/.intuition/agent-wallet.json` with permissions `0600`. See `reference/delegation.md` → "Security: Key Separation" for the full rules.

## Autonomous Mode Policy

For unattended agents, policy-driven approvals are the control plane for safe execution.

- Load policy from `./.intuition/autonomous-policy.json` or the path in `INTUITION_POLICY_PATH`.
- If no policy file is available, use `manual-review` mode.
- Policy gates run before signing and broadcasting. They validate chain/address allowlists, selector/argument integrity, term binding checks, value limits, slippage policy, simulation outcomes, and **delegated authority verification** (if delegation mode is active).
- Implement runtime enforcement in your signer or executor pipeline using the blocking pattern in `reference/runtime-enforcement.md`.
- The shipped skill includes the schemas, policy example, and reference flow; it does not bundle executable signer middleware.

Read `reference/autonomous-policy.md` for the schema and decision flow.

## Output Contract

For executable writes, output one unsigned transaction object:

```
{
  "to": "0x<multivault-address>",
  "data": "0x<calldata>",
  "value": "<wei-as-base-10-string>",
  "chainId": "<chain-id-as-base-10-string>"
}
```

For approval-required writes, output one approval request object:

```
{
  "status": "approval_required",
  "operation": "<operation-name>",
  "reason": "<policy reason>",
  "proposedTx": {
    "to": "0x...",
    "data": "0x...",
    "value": "100000000000000000",
    "chainId": "1155"
  },
  "checks": {
    "allowlist": "pass",
    "limits": "pass",
    "simulation": "pass"
  }
}
```

For delegated writes (when delegation mode is active), output the nested transaction:

```
{
  "to": "0x<delegation-manager-address>",
  "data": "0x<redeemDelegations-calldata>",
  "value": "0",
  "chainId": "<chain-id-as-base-10-string>",
  "delegationContext": {
    "delegationHash": "0x...",
    "delegator": "0x...",
    "wrappedOperation": "deposit",
    "caveatChecks": {
      "signature": "pass",
      "revocation": "pass",
      "expiry": "pass",
      "methodAllowlist": "pass",
      "spendCap": "pass",
      "receiver": "pass"
    }
  }
}
```

For delegation authority failures, output one delegation failure object:

```
{
  "status": "delegation_failure",
  "reason": "<failure reason>",
  "delegationHash": "0x...",
  "failedCheck": "<check name>",
  "details": {}
}
```

Common `reason` values: `signature_invalid`, `delegation_revoked`, `delegation_expired`, `method_not_allowed`, `spend_cap_exceeded`, `call_limit_exceeded`, `multivault_unauthorized`, `receiver_mismatch`, `daily_budget_exceeded`.

For unavailable pinning configuration or pin failures before an on-chain write, output one pin failure object:

```
{
  "status": "pin_failed",
  "operation": "createAtoms",
  "reason": "<specific failure reason>",
  "entity": "<name of the entity that failed to pin>"
}
```

When no host pinning capability or API key is configured, set `reason` to a message beginning `pinning_configuration_required`. Do not attempt the request, ask the user to paste a key, inspect secret files, or emit transaction data.

The JSON object is the complete machine-mode response.

Use base-10 strings for top-level numeric transaction fields (`value`, `chainId`) in machine-readable JSON.

## Skill Contents

Read these files when performing the corresponding operation:

```
ux-patterns.md                       Mandatory UX patterns: pre-task checks, key request, workflow flagging
DELEGATION-LIFECYCLE.md              Quick start: full delegation lifecycle in 15 min
reference/delegation-lifecycle-proof.md  Testnet proof: TX hashes, params, verification commands
reference/exec-calldata-validation.md       Validate execCallData hex before redemption: odd-length detection, recovery steps
reference/allowed-methods-enforcer-debugging.md  AllowedMethodsEnforcer root cause: execCallData must use solidityPacked (selector at byte 0x34), NOT abi.encode. (Archived to `archive/reference/` — historical debugging notes, superseded by `DELEGATION-LIFECYCLE.md` and `references/delegation-lifecycle-proof.md`.)
reference/unified-delegation-architecture.md  Unified two-track delegation model: Creation Authority (OWS) + Deposit Authority (Smart Wallet)
reference/deposit-authority-track.md        Deposit/Redemption Authority: Smart Wallet setup, approve, delegation, execution
reference/creation-authority-track.md       Creation Authority: OWS setup, one-time delegation, revocation
references/delegation-field-order-debug.md   Struct field order discovery + AllowedMethodsEnforcer debugging notes
operations/                       (Path B: writes — run session setup first)
  create-atoms.md                 Create atom vaults from URI data
  deposit-atom.md                  Deposit $TRUST into an existing atom vault, mint shares
  create-triples.md               Create triple vaults linking three terms
  deposit-triple.md               Deposit $TRUST into an existing triple vault, mint shares (signals agreement)
  deposit.md                      Deposit $TRUST into a vault, mint shares (generic reference)
  redeem.md                       Redeem shares from a vault, receive $TRUST
  batch-deposit.md                Deposit into multiple vaults in one transaction
  batch-redeem.md                 Redeem from multiple vaults in one transaction
  approve.md                      Grant/revoke deposit or redemption approval for delegated flows

operations/                       (Path C: delegation — read reference/delegation.md first)
  create-delegation.md            Build, sign, and output a Delegation object (off-chain)
  revoke-delegation.md            Revoke a delegation on-chain (permanent, propagates downstream)
```

## Protocol Model

- **Atoms** represent any concept — a person, URL, address, label. Created by encoding a URI as bytes. Each has a deterministic `bytes32` ID and a vault. For rich metadata (name, description, image, URL), pin structured data to IPFS first and encode the `ipfs://` URI — see `reference/schemas.md`.
- **Triples** are claims linking three terms: `(subject, predicate, object)`. The common case links three atoms, e.g. `(Alice, trusts, Bob)`, but any position may reuse an existing triple `term_id` for nested composition. Each triple has a vault and an automatic counter-triple vault.
- **Vaults** back every atom and triple. Depositing $TRUST mints shares on a bonding curve. Depositing into a triple signals agreement; depositing into its counter-triple signals disagreement.
- **Delegations** are signed, off-chain authorizations that grant an Agent scoped authority to execute Intuition operations on behalf of a delegator. The Agent is never the on-chain actor — `msg.sender` at MultiVault resolves to the delegation chain root authority. Delegations are validated by the DelegationManager at redemption time. Caveats enforce restrictions (operation allowlist, spend caps, call limits). Revocation is on-chain, permanent, and propagates to all downstream redelegations.

Native token: **$TRUST** (mainnet) / **tTRUST** (testnet), 18 decimals. All `msg.value` and gas are denominated in TRUST. Gas fees are negligible (~0.0001 TRUST per tx).

## Network Selection

On first invocation, ask the user which network to use:

```
Which network?
1. Intuition Mainnet  -- chain 1155
2. Intuition Testnet  -- chain 13579
```

### Network Configuration

Network metadata — chain IDs, RPC URLs, GraphQL endpoints, explorer URLs, MultiVault addresses, DelegationManager addresses, and viem chain definitions — lives in `reference/network-config.md`. Use the selected row there for all operations in the session. Switch with `--chain mainnet` or `--chain testnet`.

### Network Characteristics

Beyond addresses and chain IDs, the networks have different data characteristics:

| Aspect| Mainnet| Testnet|
| --- | --- | --- |
| Economic signal| Real $TRUST staked — positions reflect genuine conviction| Test tokens, no real value signal|
| Agent infrastructure| Active — Eliza protocol registries, named agent atoms| Less agent activity|
| Curation quality| Structured efforts (e.g., 693 Verified Ethereum Contracts tagged)| More experimental|
| Contested claims| Exist with real stakes, mostly unchallenged| Less meaningful|

Use testnet for development and testing writes. Use mainnet for production exploration and meaningful attestations.

## ABI Fragments

Human-readable fragments for `parseAbi()`. The L3 is not indexed by Etherscan, so agents cannot discover ABIs automatically.

### Important: Term IDs are bytes32

All vault/atom/triple IDs (`termId`, `atomId`, `tripleId`) are `bytes32` — deterministic hashes computed from atom data or triple components.

### Read Functions

```
const readAbi = parseAbi([
  // Cost queries (call BEFORE creating atoms/triples)
  'function getAtomCost() view returns (uint256)',
  'function getTripleCost() view returns (uint256)',

  // Atom/Triple data
  'function atom(bytes32 atomId) view returns (bytes)',
  'function getAtom(bytes32 atomId) view returns (bytes)',
  'function isAtom(bytes32 atomId) view returns (bool)',
  'function isTriple(bytes32 id) view returns (bool)',
  'function isCounterTriple(bytes32 termId) view returns (bool)',
  'function isTermCreated(bytes32 id) view returns (bool)',
  'function getTriple(bytes32 tripleId) view returns (bytes32, bytes32, bytes32)',
  'function triple(bytes32 tripleId) view returns (bytes32, bytes32, bytes32)',
  'function getCounterIdFromTripleId(bytes32 tripleId) pure returns (bytes32)',
  'function getInverseTripleId(bytes32 tripleId) view returns (bytes32)',
  'function getVaultType(bytes32 termId) view returns (uint8)',

  // ID calculation
  'function calculateAtomId(bytes data) pure returns (bytes32)',
  'function calculateTripleId(bytes32 subjectId, bytes32 predicateId, bytes32 objectId) pure returns (bytes32)',
  'function calculateCounterTripleId(bytes32 subjectId, bytes32 predicateId, bytes32 objectId) pure returns (bytes32)',

  // Vault state
  'function getVault(bytes32 termId, uint256 curveId) view returns (uint256 totalAssets, uint256 totalShares)',
  'function getShares(address account, bytes32 termId, uint256 curveId) view returns (uint256)',
  'function maxRedeem(address sender, bytes32 termId, uint256 curveId) view returns (uint256)',
  'function currentSharePrice(bytes32 termId, uint256 curveId) view returns (uint256)',
  'function convertToShares(bytes32 termId, uint256 curveId, uint256 assets) view returns (uint256)',
  'function convertToAssets(bytes32 termId, uint256 curveId, uint256 shares) view returns (uint256)',

  // Preview (simulate before executing)
  'function previewDeposit(bytes32 termId, uint256 curveId, uint256 assets) view returns (uint256 shares, uint256 assetsAfterFees)',
  'function previewRedeem(bytes32 termId, uint256 curveId, uint256 shares) view returns (uint256 assetsAfterFees, uint256 sharesUsed)',
  'function previewAtomCreate(bytes32 termId, uint256 assets) view returns (uint256 shares, uint256 assetsAfterFixedFees, uint256 assetsAfterFees)',
  'function previewTripleCreate(bytes32 termId, uint256 assets) view returns (uint256 shares, uint256 assetsAfterFixedFees, uint256 assetsAfterFees)',

  // Fee queries
  'function protocolFeeAmount(uint256 assets) view returns (uint256)',
  'function entryFeeAmount(uint256 assets) view returns (uint256)',
  'function exitFeeAmount(uint256 assets) view returns (uint256)',
  'function atomDepositFractionAmount(uint256 assets) view returns (uint256)',

  // Config
  'function getGeneralConfig() view returns ((address admin, address protocolMultisig, uint256 feeDenominator, address trustBonding, uint256 minDeposit, uint256 minShare, uint256 atomDataMaxLength, uint256 feeThreshold))',
  'function getAtomConfig() view returns ((uint256 atomCreationProtocolFee, uint256 atomWalletDepositFee))',
  'function getTripleConfig() view returns ((uint256 tripleCreationProtocolFee, uint256 atomDepositFractionForTriple))',
  'function getBondingCurveConfig() view returns ((address registry, uint256 defaultCurveId))',
  'function getVaultFees() view returns ((uint256 entryFee, uint256 exitFee, uint256 protocolFee))',
])
```

For nested composition, `getVaultType(termId)` is the precise classifier: `0 = ATOM`, `1 = TRIPLE`, `2 = COUNTER_TRIPLE`. `isTriple(termId)` is a coarser check and returns `true` for counter-triples too. `calculateTripleId` is deterministic, so callers can precompute future triple `term_id`s before broadcasting.

### Write Functions

```
const writeAbi = parseAbi([
  // Atom creation (batch only)
  'function createAtoms(bytes[] atomDatas, uint256[] assets) payable returns (bytes32[])',

  // Triple creation (batch only)
  'function createTriples(bytes32[] subjectIds, bytes32[] predicateIds, bytes32[] objectIds, uint256[] assets) payable returns (bytes32[])',

  // Single deposit/redeem
  'function deposit(address receiver, bytes32 termId, uint256 curveId, uint256 minShares) payable returns (uint256)',
  'function redeem(address receiver, bytes32 termId, uint256 curveId, uint256 shares, uint256 minAssets) returns (uint256)',

  // Batch deposit/redeem
  'function depositBatch(address receiver, bytes32[] termIds, uint256[] curveIds, uint256[] assets, uint256[] minShares) payable returns (uint256[])',
  'function redeemBatch(address receiver, bytes32[] termIds, uint256[] curveIds, uint256[] shares, uint256[] minAssets) returns (uint256[])',

  // Approvals
  'function approve(address sender, uint8 approvalType)',

  // Atom wallet
  'function computeAtomWalletAddr(bytes32 atomId) view returns (address)',
  'function claimAtomWalletDepositFees(bytes32 atomId)',
])
```

### Delegation Functions

```
const delegationAbi = parseAbi([
  'function redeemDelegations(bytes[] calldata _permissionContexts, bytes32[] calldata _modes, bytes[] calldata _executionCallData) external',
  'function disableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation) external',
  'function enableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation) external',
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  'function getDelegationHash((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation) view returns (bytes32)',
  'function getDomainHash() view returns (bytes32)',
  'function beforeHook(bytes calldata terms, bytes calldata args, bytes32 mode, bytes calldata executionCallData, bytes32 delegationHash) external',
  'function afterHook(bytes calldata terms, bytes calldata args, bytes32 mode, bytes calldata executionCallData, bytes32 delegationHash) external',
])
```

## Core Concepts

### Atoms: URI to bytes Encoding

Atoms are created from arbitrary bytes. **All atoms are pinned to IPFS** except blockchain addresses (CAIP-10). This matches the Intuition Portal's creation flow.

```
import { stringToHex } from 'viem'

// All entities, concepts, predicates, labels — pin to IPFS first
// See reference/schemas.md for the full pin flow
const atomData = stringToHex('ipfs://bafy...')  // URI from pin mutation

// Blockchain address (CAIP-10) — no IPFS needed
const atomData = stringToHex('caip10:eip155:1:0x1234...abcd')
```

```
# cast equivalents
ATOM_DATA=$(cast --from-utf8 "ipfs://bafy...")                    # after pinning
ATOM_DATA=$(cast --from-utf8 "caip10:eip155:1:0x1234...abcd")    # CAIP-10 address
```

Pin everything — including predicates (`"implements"`, `"trusts"`) and concept labels (`"AI Agent Framework"`). On-chain data confirms canonical atoms are IPFS-pinned; plain string versions are legacy duplicates. See `operations/create-atoms.md` for the full encoding flow.

The atom's `bytes32` ID is deterministically computed from its data via `calculateAtomId(bytes)`. Creating an atom that already exists reverts with `MultiVault_AtomExists`. Always check `isTermCreated(calculateAtomId(data))` before calling `createAtoms`.

### Triples: Three Term IDs

A triple links three existing terms: `(subject, predicate, object)`. The common case is three atoms, but an existing triple `term_id` may also be reused as a position for nested composition. All three terms must already exist. Every triple automatically gets a **counter-triple** vault for signaling disagreement.

A triple's `term_id` is itself a valid term and may be used as subject, predicate, or object in subsequent triples (reification). Use `getVaultType(termId)` when you need to distinguish positive triples from counter-triples. See `reference/nested-triples.md`.

**Finding predicate atoms**: Do not hardcode predicate atom IDs. Canonical predicates are IPFS-pinned atoms — their IDs depend on the pinned URI, not a plain string. Query the graph to find existing predicates by label:

```
query FindPredicate($label: String!) {
  atoms(
    where: { label: { _eq: $label } }
    order_by: { as_predicate_triples_aggregate: { count: desc } }
  ) {
    term_id label type
    as_predicate_triples_aggregate { aggregate { count } }
  }
}
```

Results include all atom types, ordered by usage count. Interpret them as follows:
- **Non-TextObject result exists** — use it. Any type other than `TextObject` (e.g., `Thing`, `Person`, `Organization`, `Keywords`, `FollowAction`) is a canonical atom with structured metadata.
- **Only TextObject results exist** — the label is in use as a legacy plain-string predicate. Do not reuse the TextObject atom. Instead, create a pinned replacement via `reference/schemas.md` (use `pinThing` with the predicate label as `name`). The new pinned version becomes the canonical predicate going forward.
- **No results** — the predicate doesn't exist yet. Create it by pinning via `reference/schemas.md`.

### Vaults: Shares Model

Every atom and triple has a vault. Depositing $TRUST mints shares on a bonding curve. The `curveId` parameter selects which curve to use.

**Always query the default curve ID first:**

```
cast call $MULTIVAULT "getBondingCurveConfig()((address,uint256))" --rpc-url $RPC
# Returns (registryAddress, defaultCurveId) — use the second value
```

On mainnet the default is currently `1` (linear curve). Query `getBondingCurveConfig()` once per session and reuse the `defaultCurveId` for all deposit/redeem calls.

### Fees: Always Preview First

Multiple fee layers apply to deposits: protocol fee, entry fee, atom wallet deposit fee (for atoms), and atom deposit fraction (for triples). **Always call `previewDeposit` or `previewAtomCreate`/`previewTripleCreate` before executing.** Fee percentages are configurable by governance and may change.

### Assets Array in Creation

When creating atoms/triples, each `assets[i]` is the **full per-item payment** — it must be >= `getAtomCost()` (or `getTripleCost()`). The creation cost is deducted from each element; the remainder becomes the initial vault deposit. `msg.value` must exactly equal `sum(assets[])`. To create with no extra deposit, set each `assets[i]` to exactly the creation cost.

### Delegated Operations Architecture

See **Path C** above for the two-track table (Creation Authority + Deposit/Redemption Authority).
Deep dive: `reference/unified-delegation-architecture.md`, `reference/creation-authority-track.md`, `reference/deposit-authority-track.md`.
EIP-7702 upgrade commands and pitfalls: `DELEGATION-LIFECYCLE.md` → Step 9.

## Write Operations

To perform a write, open the corresponding operation file and follow its steps exactly. Each file provides: prerequisites to query, encoding pattern (cast + viem), value calculation, and strict JSON output contract.

| When you need to...| Read this file| Payable|
| --- | --- | --- |
| Create atoms from URIs| `operations/create-atoms.md` (always pin to IPFS first via `reference/schemas.md`, except CAIP-10)| Yes — `msg.value = sum(assets[])`, each `assets[i] >= atomCost`|
| Deposit into an atom vault| `operations/deposit-atom.md`| Yes — `msg.value = deposit amount`|
| Create triples linking terms| `operations/create-triples.md`| Yes — `msg.value = sum(assets[])`, each `assets[i] >= tripleCost`|
| Deposit into a triple vault| `operations/deposit-triple.md`| Yes — `msg.value = deposit amount`|
| Redeem shares from a vault| `operations/redeem.md`| No — `value = 0`|
| Deposit into multiple vaults| `operations/batch-deposit.md`| Yes — `msg.value = sum(assets)`|
| Redeem from multiple vaults| `operations/batch-redeem.md`| No — `value = 0`|
| Delegate deposit/redemption (receiver ≠ sender)| `operations/approve.md`| No — `value = 0`|

### Delegation Operations

| When you need to...| Read this file| Payable|
| --- | --- | --- |
| Issue a delegation to an Agent| `operations/create-delegation.md`| No — delegation is off-chain; output is a signed object|
| Revoke a delegation on-chain| `operations/revoke-delegation.md`| No — `value = 0`|
| Verify delegated authority before acting| `reference/delegation-authority.md`| N/A — autonomous gate, no tx output|
| Learn delegation concepts and setup| `reference/delegation.md`| N/A — reference only|
| Understand attribution chains| `references/delegation-chain-attribution.md`| Reference — why multi-hop chains do not preserve root `msg.sender`|
| Verify function signatures and attribution logic| `references/source-code-verification.md`| Reference — verify against deployed source|
| Live deposit/creation proof patterns| `references/live-on-chain-proof-patterns.md`| Reference — GraphQL queries, tx decoding|
| Verify cross-file consistency| `references/maintenance-verification.md`| Reference — verification checklist|

| Script/Template | Purpose |
| --- | --- |
| `scripts/test-direct-createatoms.mjs` | Calls `createAtoms` from Agent wallet and checks `balanceOf` for attribution probe |
| `templates/creation-e2e.mjs` | Creation Authority track: prepare, sign (via CLI or MetaMask HTML), redeem |
| `templates/sign-delegation.html` | Signing page: load prepared JSON, compute digest from on-chain hashes, sign with MetaMask `wallet_signTypedData_v4`. Connect as owner EOA for EIP-7702 delegators. |
| `templates/sign-delegation-cli.mjs` | CLI signer: signs prepared delegation JSON with relevant private key env var |
| `templates/redeem-creation.mjs` | Reads signed creation-track delegation, builds `redeemDelegations` calldata, broadcasts from Agent key |
| `templates/redeem-deposit.mjs` | Reads signed deposit-track delegation, builds `redeemDelegations` calldata, broadcasts from Agent key |
| `templates/revoke-delegation.mjs` | Prepares `disableDelegation` calldata for delegator broadcast |

For on-chain reads (costs, existence, vault state, previews), follow `reference/reading-state.md`.
For discovery reads (search, browse, traverse the knowledge graph), follow `reference/graphql-queries.md`.
For multi-step flows (create + deposit, signal disagreement, exit position), follow `reference/workflows.md`.
Always simulate writes before executing — see `reference/simulation.md`.
To verify function signatures, attribution logic, or approval gating against the actual deployed source, follow `references/source-code-verification.md`.

## Protocol Invariants

These facts govern all Intuition transactions. Encoding-specific rules that
duplicate the Critical Encoding Rules below are omitted — see that section for
execCallData, field order, salt type, getDelegationHash, and encoding format.

01. **Term IDs are bytes32** — All vault, atom, and triple IDs are `bytes32` — deterministic hashes computed from atom data or triple components.
02. **Creation is batch-only** — Use `createAtoms()` and `createTriples()` with arrays. Single-item creation uses single-element arrays.
03. **curveId is required** — `deposit` and `redeem` require a `curveId` parameter. Query `getBondingCurveConfig()` once per session. The mainnet default is `1` (linear curve).
04. **Slippage parameters** — `deposit` accepts `minShares`, `redeem` accepts `minAssets`; `depositBatch` and `redeemBatch` take per-item `minShares[]` / `minAssets[]`. Derive bounds from `previewDeposit`/`previewRedeem` with a tolerance before executing. Zero bounds are debug-only.
05. **Receiver semantics are explicit and function-specific** — `deposit`/`redeem`/`depositBatch`/`redeemBatch` accept a `receiver` parameter. `createAtoms` and `createTriples` do **not** — attribution follows `msg.sender` (the delegator/root authority). See `references/live-on-chain-proof-patterns.md` for evidence.
06. **Atom data is hex-encoded bytes** — Use `stringToHex(uri)` in viem, `cast --from-utf8 "uri"` in foundry. Input is an IPFS URI or CAIP-10 URI for blockchain addresses.
07. **msg.value is a separate transaction field** — The $TRUST sent with the transaction is the `value` field, separate from the encoded `data`.
08. **Payable functions** — `createAtoms`, `createTriples`, `deposit`, `depositBatch` require $TRUST as `msg.value`. `redeem` and `redeemBatch` are non-payable (`value = 0`).
09. **Creation assets[] is the full payment** — Each `assets[i]` must be >= creation cost. `msg.value` must exactly equal `sum(assets[])`.
10. **Custom chain definition required** — Intuition L3 (chain 1155/13579) requires `defineChain()` in viem. See `reference/network-config.md`.
11. **Creation returns bytes32[]** — `createAtoms` and `createTriples` return deterministic `bytes32[]`. Pre-compute expected IDs via `calculateAtomId(data)` / `calculateTripleId(s, p, o)`.
12. **Counter-triples are automatic** — Creating a triple also creates its counter-triple vault.
13. **Separate preview functions** — Use `previewAtomCreate`/`previewTripleCreate` when creating. Use `previewDeposit` for existing vaults.
14. **`msg.sender` resolves to the leaf** — Under delegation, `msg.sender` at MultiVault is the EIP-7702 proxy or Smart Wallet address of the **last delegation's `delegator`**.
15. **Approvals are not transitive** — The Agent does not inherit MultiVault approvals held by a separate Smart Wallet.
16. **Nested value placement** — Under delegation, all `msg.value` lives in the inner transaction. The outer `redeemDelegations` call carries `value = 0`.
17. **Delegator balance pays for writes** — The `msg.value` forwarded to the inner call comes from the **delegator's** balance. Always verify sufficient balance before delegated writes.
18. **Receiver binding under delegation** — For `receiver`-bearing operations, `receiver` MUST be Main Account. For creation, no `receiver` param exists — attribution follows `msg.sender`.
19. **Creation track bypasses approve** — The OWS cannot and need not approve itself. `approve` prerequisite exists only for the deposit track.
20. **Cumulative vs periodic caps** — `NativeTokenTransferAmountEnforcer` caps total cumulative spend, not a rolling daily rate.
21. **Revocation propagates downward** — Revoking a root delegation kills all redelegations that chain to it, regardless of depth.
22. **EOAs cannot be delegators** — The delegator must be a smart contract (EIP-7702 upgraded EOA or separate contract) with ERC-1271 logic.
23. **The executing address is the leaf, not the root** — `redeemDelegations` walks the chain and calls `executeFromExecutor` on the leaf delegator.
24. **enableDelegation is optional** — For the standard signature-based flow, `enableDelegation` is not required. Optional caching alternative.
25. **ERC-1271 `isValidSignature` returns padded `bytes4`** — The EIP-1271 magic value is `0x1626ba7e`. When returned from a contract call, the EVM pads it to 32 bytes. Use `startsWith("0x1626ba7e")`.
26. **Contract source retrieval** — Fetch verified source from the block explorer. Source reveals actual struct layout. See `references/source-code-verification.md`.
27. **Value-carrying static calls require `from` on mainnet** — `provider.call({ to: MULTIVAULT, data, value })` must include `from: DELEGATOR` on mainnet. Testnet does not exhibit this quirk.
28. **Domain hash fallback for mainnet** — `getDomainHash()` returns `0x44653bfc83c7c3f4ecd0ab2d76a7aff5e3478def6f0a290d939437b65d6fe1d5`. Always call on-chain first.

## Critical Encoding Rules (Testnet-Proven)

These are non-negotiable for `redeemDelegations` to pass on-chain validation.

- **`_permissionContexts[i]` is `abi.encode(Delegation[])`**: The contract decodes each permission context with `abi.decode(_permissionContexts[batchIndex_], (Delegation[]))`. There is NO separate `bytes32 delegationHash` tuple element. Including one causes an `abi.decode` mismatch. Always build the outer calldata as `abi.encode(Delegation[])` only — no trailing hash.
`ExecutionLib.decodeSingle()` extracts the inner calldata from byte offset 0x34 of `execCallData`, then the `AllowedMethodsEnforcer` reads the selector from bytes[0:4] of that extracted calldata. Therefore, `execCallData` MUST use `solidityPacked(['address','uint256','bytes'], [target, value, innerCalldata])`. This places the inner calldata at byte offset 0x34 where `decodeSingle` reads it.
- **Validate execCallData before redemption**: When a signed delegation JSON is provided, check that each `execCallData` starts with `0x`, has even-length hex, contains only hex chars, and is at least 88 bytes (20 address + 32 value + 36 minimum inner calldata). The execCallData should be `solidityPacked` encoded, starting with the 20-byte address followed by the 32-byte value. See `references/exec-calldata-validation.md` for the validation snippet.
- **`AllowedMethodsEnforcer` terms**: raw concatenated `bytes4` selectors (e.g., `"0x61403309"`), NOT an ABI-encoded `bytes4[]` array. `decodeSingle()` reads 4-byte chunks directly from `_terms`. **Note (2026-09):** Even with correct terms, `method-not-allowed` fires if `execCallData` is ABI-encoded (inner calldata at byte 0x80+). The fix is `solidityPacked` encoding. See `reference/allowed-methods-enforcer-debugging.md`.
- **`LimitedCallsEnforcer` terms**: `abi.encode(uint256)` (e.g., `abi.encode([5])`), NOT raw bytes.
- **Caveat encoding in ethers v6**: When encoding caveats with `Interface.encodeFunctionData` or `AbiCoder`, pass explicit `[enforcer, terms, args]` arrays. Passing `{enforcer, terms, args}` objects triggers "cannot encode object for signature with missing names". Always map objects to arrays before encoding.
- **`authority` must equal on-chain `ROOT_AUTHORITY`** for the leaf delegation. From `cast call DelegationManager ROOT_AUTHORITY()`: `0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`. Never use `0x0`.
- **`DELEGATE` must equal `msg.sender`** for EOA broadcasts. If `delegate != msg.sender && delegate != ANY_DELEGATE`, you get `InvalidDelegate()`.
- **ModeCode for simple single execution**: `0x0000000000000000000000000000000000000000000000000000000000000000` (32 bytes, all zeros = ModeLib.encodeSimpleSingle()).
- **DELEGATION_TYPEHASH includes Caveat struct inline**: The on-chain getDelegationHash uses an inline Caveat struct in the typehash string. Missing the Caveat(...) suffix causes hash mismatch against on-chain computation.
- **caveatsArrayHash uses keccak256(abi.encodePacked(...))**: Concatenate enforcer1 + terms1 + enforcer2 + terms2 before hashing. Do not keccak256(abi.encode(caveats)) - that uses per-element ABI encoding which differs from the on-chain implementation.
- **MODE_DEFAULT is a 32-byte hex string**: Use 0x + 00.repeat(32), not ethers.toBeHex(0). toBeHex(0) returns 0x, a single-byte value, which shifts all subsequent array fields.
- **BigInt JSON serialization**: When emitting JSON from scripts, call .toString() on BigInt values AFTER arithmetic, e.g., (atomCost * 2n).toString(), not atomCost * 2n.toString() (which concatenates strings).
- **Permission contexts for redeemDelegations**: The array must be abi.encode(Delegation[] memory, bytes32 delegationHash). The struct array AND the delegation hash are both required. Missing the hash causes eth_estimateGas to revert with custom error selectors that do not match standard DelegationManager errors.
- **Debugging InsufficientBalance during estimation**: If eth_estimateGas reverts with a custom error 0xfce698f7 during redeemDelegations (not standard InvalidERC1271Signature etc.), the issue is usually in the inner execCallData encoding or value field, not the delegation wrapper itself. Rule out in order: (1) verify execCallData uses `solidityPacked` (not `abi.encode`); (2) verify each inner operation's value matches the exact on-chain cost from getAtomCost() / getTripleCost(); (3) verify the total value across all inner operations does not exceed the delegator's balance; (4) test the inner operation as a bare direct call from the delegator before blaming redeemDelegations.

## Verified Addresses and Values

All addresses, enforcer addresses, chain IDs, RPCs, and code snippets live in
`reference/network-config.md`. Query costs on-chain (`getAtomCost()`, `getTripleCost()`,
`getBondingCurveConfig()`) — do not hardcode. Function selectors: `reference/network-config.md`
or verify with `cast sig` / `ethers.id()`.

## Debugging

For delegation debugging (simulation, traceTransaction, caveat validation):
`references/delegation-debugging.md`. Live proof TX hashes: Changelog 1.0.3 above.

## Permission Context Encoding in ethers v6

When encoding `_permissionContexts` for `redeemDelegations`, use **unnamed tuples** in the ABI type string. Named tuples like `(address delegate, ...)` trigger `types/value length mismatch` in ethers v6:

```js
// CORRECT: unnamed tuple
const permissionContext = ethers.AbiCoder.defaultAbiCoder().encode(
  ["(address,address,bytes32,(address,bytes,bytes)[] caveats,uint256 salt,bytes signature)[]"],
  [[[delegation]]]
);

// WRONG: named tuple causes "types/value length mismatch"
const permissionContext = ethers.AbiCoder.defaultAbiCoder().encode(
  ["(address delegate, address delegator, ...)[]"],
  [[[delegation]]]
);
```

The inner caveat tuple `(address,bytes,bytes)` must also be unnamed. Pass caveat data as arrays: `[enforcer, terms, args]`.

Common revert selectors:
- `0xb5863604` = `InvalidDelegate()` — `delegate != msg.sender && delegate != ANY_DELEGATE`
- `0xb4856ebc` = `MultiVault_AtomExists` — atom data already created
- `0x05baa052` = `CannotUseADisabledDelegation()` — delegation was revoked
- `0x155ff427` = `InvalidERC1271Signature()` — Note: this selector is also returned when a delegation has been revoked and you attempt `redeemDelegations` with it. If you see this after calling `disableDelegation`, the delegation is simply disabled — create a new one.
- `0x` (empty) — usually `abi.encode(tuple)` offset corruption or `_permissionContexts` missing the delegationHash tuple element

## Pre-Flight Checklist

See **Canonical Delegation Workflow (Layered Verification)** above — 7 layers,
exhaustive checklist before broadcasting any delegation transaction.

## Error Patterns

| Error| Cause| Fix|
| `MultiVault_InsufficientBalance`| `msg.value` does not equal `sum(assets[])`| Ensure `msg.value` exactly equals the sum of the assets array|
| `MultiVault_InsufficientAssets`| `assets[i]` less than creation cost| Each `assets[i]` must be >= `getAtomCost()` or `getTripleCost()`|
| `MultiVault_AtomExists`| Atom with same data already created| Check `isTermCreated(calculateAtomId(data))` first; use existing ID|
| `MultiVault_TripleExists`| Triple with same components already created| Check `isTermCreated(calculateTripleId(...))` first; use existing ID|
| `MultiVault_TermDoesNotExist` / `MultiVaultCore_TermDoesNotExist`| Referenced term does not exist, or a classifier read was run against an unknown ID| Create the missing atom via `createAtoms`, choose an existing triple `term_id`, or re-check the GraphQL-to-on-chain binding before composing|
| `MultiVault_ArraysNotSameLength`| Parallel arrays have different lengths| Ensure all arrays match in length|
| `MultiVault_InvalidArrayLength`| Empty array or exceeds max batch size| Provide at least one item; check max batch size|
| Transaction reverts with no message| ABI encoding mismatch or unrecognized function sig| Verify bytes32 IDs, check curveId parameter|
| `DelegationManager_AlreadyEnabled` | `enableDelegation` was called but the delegation is already active (`disabledDelegations` returns `false`) | Skip `enableDelegation` if `disabledDelegations(hash)` is `false`. It is only needed for re-enabling a previously disabled delegation. |
| `DelegationManager_InvalidSignature`| EIP-712 signature does not recover to delegator| Read `getDomainHash()` on-chain and use that value directly in the signing digest. Do not reconstruct the domain separator from guessed `name`/`version` literals. Common pitfall: using `EIP7702StatelessDeleGator` domain constants instead of DelegationManager's. Verify signing key. For contract delegators, check `isValidSignature` returns `0x1626ba7e`|
| `DelegationManager_InvalidERC1271Signature`| `isValidSignature` on the delegator returned a value other than `0x1626ba7e`| The delegator contract either does not implement ERC1271, or the digest/signature passed to it is malformed. Verify with a direct `cast call` to the delegator's `isValidSignature` using the exact digest and signature your script produces. Do not assume missing implementation — EIP-7702 upgraded accounts have been verified to implement it correctly. **Note:** this error also occurs when attempting to use a **revoked** delegation via `redeemDelegations`. If you see `0x155ff427` after calling `disableDelegation`, the delegation is simply disabled — create a new one.|
| `DelegationManager_DelegationDisabled` | Delegation has been disabled/revoked on-chain (`disabledDelegations` returns true) | The delegator must create a new delegation. Revocation is permanent. |
| `DelegationManager_InvalidStruct` | The struct passed to `disableDelegation` or `enableDelegation` does not match the stored hash, or the permission context passed to `redeemDelegations` was computed off-chain with standard ABI encoding instead of read from `getDelegationHash()` on-chain | Call `getDelegationHash(delegation)` on-chain and use its returned `bytes32` directly as the permission context hash. Do not recompute `keccak256(abi.encode(...))` off-chain. Use `uint256 salt`, not `bytes32 salt`. Ensure `_permissionContexts[i]` is `abi.encode(Delegation[], bytes32 delegationHash)`, not just the hash. |
| `DelegationManager_InvalidDelegate` | `delegate != msg.sender && delegate != ANY_DELEGATE` in `redeemDelegations`, or authority/delegate chain mismatch in nested delegations | For EOA broadcasts, set `DELEGATE = DELEGATOR`. For nested delegations, ensure `delegation_.delegator == nextDelegate_` in the chain. |
| `MultiVault_SelectorMismatch` | Wrong function selector in inner calldata (e.g., `0x7a2c1c88` from NIST SHA3-256 instead of Keccak-256 `0x61403309`) | Use `ethers.id("createAtoms(bytes[],uint256[])")` or `cast calldata` to compute selectors. Never use Node.js `crypto.createHash('sha3-256')` — it produces NIST SHA3-256, not Keccak-256. |
| `MultiVault_SlippageExceeded` (0x40a0e8d2) | `deposit` called with `minShares=0` or shares below minimum | Use `previewDeposit(termId, curveId, assets)` to get expected shares, then pass `minShares = expectedShares * (1 - slippageTolerance)`. For testing, use a large `minShares` or query `previewDeposit` first. |
| Transaction reverts with no data / `require(false)` during `redeemDelegations` gas estimation | Usually one of: (1) `_permissionContexts[i]` missing the `delegationHash` tuple element; (2) `execCallData` is ABI-encoded instead of `solidityPacked` (inner calldata must be at byte 0x34); (3) `AllowedMethodsEnforcer` terms are ABI-encoded `bytes4[]` instead of raw bytes4; (4) inner execution `value` != `sum(assets[])`; (5) ERC1271 validation failing because delegator delegates to a contract without `isValidSignature`; (6) `createAtoms` called with `msg.value` mismatch or term already exists | Rule out in order: check permission context encoding → check execCallData uses `solidityPacked` → verify terms format per enforcer → check inner `value` = `sum(assets[])` → verify delegator balance → test bare direct call → check `isTermCreated` for the atom data → verify inner selector against actual MultiVault implementation. Do not conclude the inner function is broken until a bare direct call from the delegator also fails. |
| `DelegationManager_BatchDataLengthMismatch` | `_permissionContexts`, `_modes`, and `_executionCallData` arrays have different lengths | Ensure all three arrays have the same length. For N operations, create N permission contexts (one per operation), N mode codes, and N execution call data entries. |
| `0xfce698f7` (unknown, testnet) | Caveat enforcer has no contract code, or caveat validation failed | Verify all caveat enforcer addresses have non-empty code via `cast code`. Filter out enforcers with no code before signing. Check `debug_traceTransaction` for `EXTCODESIZE` checks. |

## TRUST Token

| | Mainnet| Testnet|
| --- | --- | --- |
| Symbol| $TRUST| tTRUST|
| Decimals| 18| 18|

`parseEther('0.5')` works for formatting TRUST amounts (same 18-decimal math). The unit is TRUST, not ETH.

## Contract Source

- **V2 contracts:** https://github.com/0xIntuition/intuition-v2/tree/main/contracts/core
- **Interface:** `src/interfaces/IMultiVault.sol` and `src/interfaces/IMultiVaultCore.sol`
- **Block explorer (mainnet):** https://intuition.calderaexplorer.xyz
- **SDK (reference):** https://github.com/0xIntuition/intuition-ts

## ethers v6 Workarounds

### Standalone Interface for missing ABIs
If `contract.interface.encodeFunctionData` throws "unknown function", create a standalone interface:
```js
const iface = new ethers.Interface([
  "function createAtoms(bytes[] atomDatas, uint256[] assets) payable returns (bytes32[])",
]);
const calldata = iface.encodeFunctionData("createAtoms(bytes[],uint256[])", [data, assets]);
```

### Caveat tuple mapping
Objects must be mapped to arrays before encoding:
```js
// WRONG: triggers "cannot encode object for signature with missing names"
const caveats = [{enforcer, terms, args}];

// RIGHT: map to explicit arrays
const caveats = [{enforcer, terms, args}].map(c => [c.enforcer, c.terms, c.args]);
```

### Boolean returns from provider.call
When calling view functions via `provider.call`, parse booleans explicitly:
```js
const result = await provider.call({to: DELEGATION_MANAGER, data: calldata});
const isDisabled = result === "0x...01" || parseInt(result, 16) === 1;
```

### Tool string masking workaround
The execution environment masks long hex strings (private keys, `bytes32`,
`ROOT_AUTHORITY`, signatures) with `***` in terminal and `node -e` output.
This silently corrupts inline scripts. **Workarounds:**
- Write files using `write_file` tool or Python (`python3 -c "..."` /
  `python3 << 'EOF'`) which does NOT mask hex strings, then run the file.
- Never embed private keys or `bytes32` values directly in `node -e` strings
  or heredocs — the `***` replacement breaks string literals and JSON.
- If you must use a key inline, read it from a file (`require('fs').readFileSync`)
  or environment variable (`process.env.KEY`) rather than embedding it.