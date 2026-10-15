# Delegation (SDK-first)

How delegations actually work on Intuition, written against the code that runs.
Every claim below carries the command that re-verifies it.

**Canonical path:** `@metamask/smart-accounts-kit` 2.0.0 in the browser
(`templates/sign-delegation.html`), with `@metamask/delegation-core` 3.0.0 for
struct normalisation. The manual EIP-712 construction path is documented in
the digest-forensics notes in `operations/create-delegation.md` §3 — **it is not the
flow you should build on.** The manual path was byte-correct, but it required the
reader to know things the SDK knows for you (environment resolution per chain,
address normalisation, builder defaults). Those defaults are where the bugs live.

Chain IDs and RPCs are listed in §6 below.

---

## Table of Contents

- [1. Architecture: the three SDK calls](#1-architecture-the-three-sdk-calls)
- [2. What the SDK does internally](#2-what-the-sdk-does-internally)
- [3. THE 2-FIELD vs 3-FIELD SPLIT](#3-the-2-field-vs-3-field-split)
- [4. The fabricated-selector trap](#4-the-fabricated-selector-trap)
- [5. Constants](#5-constants)
- [6. Contract addresses](#6-contract-addresses)
- [7. The caveats-as-authority model](#7-the-caveats-as-authority-model)
- [7b. Chained / redelegated authority](#7b-chained--redelegated-authority)
- [8. Agent wallet setup (OpenWallet)](#8-agent-wallet-setup-openwallet)
- [9. Chain-keyed environment resolution](#9-chain-keyed-environment-resolution)
- [10. Verification commands](#10-verification-commands)

---

## 1. Architecture: the three SDK calls

```
toMetaMaskSmartAccount({ implementation: Hybrid, address, signer })
  → createDelegation({ to, from, environment, scope, caveats, salt })
  → signDelegation({ delegation })          // pops MetaMask, returns 65-byte sig
```

Full working source is `templates/sign-delegation.html` (`buildFresh()` and
`signDelegation()`). It is the reference implementation; the excerpts below are
copied from it.

### 1a. Environment

```js
import {
  getSmartAccountsEnvironment, toMetaMaskSmartAccount, createDelegation,
  createCaveatBuilder, Implementation, ScopeType,
} from '@metamask/smart-accounts-kit'
import { createCaveatBuilder } from '@metamask/smart-accounts-kit/utils'
//                                     ^^^^^^ the /utils subpath ONLY. See §3.

const env = getSmartAccountsEnvironment(13579)   // Intuition testnet
```

### 1b. Create the delegation

```js
const cb = createCaveatBuilder(env)
cb.addCaveat('limitedCalls', { limit: 100 })

const delegation = createDelegation({
  to: AGENT,            // 0xe9BfdEC6Fa795a24e3069292248d9d16570E050d
  from: HYBRID,         // 0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14
  environment: env,
  salt: '0x' + (BigInt(Date.now()) * 1000n).toString(16).padStart(64, '0'),
  scope: {
    type: ScopeType.FunctionCall,
    targets: [MULTIVAULT],
    selectors: [                                  // CANONICAL SIGNATURES, not hex
      'deposit(address,bytes32,uint256,uint256)',
      'redeem(address,bytes32,uint256,uint256,uint256)',
      'createAtoms(bytes[],uint256[])',
      'createTriples(bytes32[],bytes32[],bytes32[],uint256[])',
    ],
    valueLte: { maxValue: UINT256_MAX },          // ← MANDATORY. See the box below.
  },
  caveats: cb,
})
```

> ### ⚠️ FOOTGUN 1 of 2 — `valueLte` defaults to **zero**, not unlimited
>
> `ScopeType.FunctionCall` normalises its config with
> `config.valueLte ?? { maxValue: 0n }`. There is **no** "unlimited" default.
> A scope that omits `valueLte` silently gets a **zero** cap, which admits only
> value-free calls. Every value-bearing call then reverts — **while
> `isValidSignature` still returns `0x1626ba7e`.** A green signature check on a
> permanently unredeemable delegation is the exact failure this documents.
>
> The revert is generic, so it looks like a protocol bug rather than a config bug.
>
> **Falsifier (re-runnable, read-only).** Take a known-good delegation, change
> exactly one variable, and simulate the same call twice:
>
> ```
> A) ValueLte = max (2^255-1), deposit 0.001  -> NO REVERT
> B) ValueLte = 0n,                deposit 0.001 -> execution reverted
> RESULT: FOOTGUN CONFIRMED
> ```
>
> Same delegation, same call, same signature, one caveat term changed. Verified
> 2026-10-02. Note the order: caveat evaluation runs **before** signature
> validation, so B reverts on ValueLte even when the signature no longer matches.

### 1c. Sign

```js
const sa = await toMetaMaskSmartAccount({
  client: pub,
  implementation: Implementation.Hybrid,
  address: HYBRID,                    // ← MANDATORY. Omit it and the SDK
  signer: { walletClient: wc },       //   derives the WRONG delegator.
})
if (sa.address.toLowerCase() !== HYBRID.toLowerCase())
  throw new Error('SDK returned a different delegator: ' + sa.address)

const signature = await sa.signDelegation({ delegation })   // MetaMask popup
const signed = { ...delegation, signature }
```

Three traps here, each of which produces a page that *looks* fine:

1. **`address:` is mandatory.** Without it the SDK derives a delegator that is
   not your Hybrid. Root cause of a long `0xffffffff` hunt.
2. **Never `<script type="module">`.** The page's handlers are inline
   `onclick=`, which cannot see module-scope bindings — every button dies
   silently with no visible error on a phone. Use a classic `<script>` and
   `await import()` inside `loadSdk()`.
3. **`createCaveatBuilder` lives on `/utils`**, not the package root.

---

## 2. What the SDK does internally

So you can debug it rather than guess at it:

1. `signDelegation` calls **`toDelegationStruct`**, which normalises every
   address with `getAddress` (checksummed) and sets `signature: '0x'`.
2. It then calls **`signer.signTypedData`** with:

```js
domain = {
  name: 'DelegationManager',
  version: '1',
  chainId,
  verifyingContract: environment.DelegationManager,   // resolved per chain
}
types = SIGNABLE_DELEGATION_TYPED_DATA               // exported constant — do not hand-write
```

3. The signature is grafted back onto your original object.

**Digest for verification:** the contract is authoritative — recompute it, never
trust a local reimplementation:

```
structHash = DM.getDelegationHash(delegation)      // 0x66134607
domainHash = DM.getDomainHash()                     // 0x83ebb771
digest     = keccak256(0x1901 ‖ domainHash ‖ structHash)
```

---

## 3. THE 2-FIELD vs 3-FIELD SPLIT

**This is the single most-confused thing in the entire system.** One struct, two
representations, and collapsing them is a recurring bug.

| | Representation | Used by |
|---|---|---|
| **2-field** | `Caveat(address enforcer,bytes terms)` | **EIP-712 typed-data signing** |
| **3-field** | `(address,bytes,bytes)[]` = enforcer, terms, **args** | **`getDelegationHash` / `disableDelegation` ABI** |

Both are correct. Both are mandatory. They are not interchangeable.

```
CAVEAT_TYPEHASH (2-field) = 0x80ad7e1b04ee6d994a125f4714ca0720908bd80ed16063ec8aee4b88e9253e2d
```

```bash
cast keccak "Caveat(address enforcer,bytes terms)"        # → 0x80ad7e1b…  ✅ the one that counts
cast keccak "Caveat(address enforcer,bytes terms,bytes args)"  # → 0x0ac12fd0…  ❌ NOT used
```

The 3-field version is *not* a wrong guess about a newer format — it is simply
the **ABI view**, which carries `args` because the Solidity struct has the field,
while the **EIP-712 view** excludes it because `args` is not hashed. Using the
ABI tuple in typed data produces a digest the contract will never accept.

`scripts/delegation-doc-verification.sh` asserts both halves of this against the
live chain as part of the keeper gate.

**Where each surface is reached:**

```bash
# 3-field ABI surface — the function selector encodes the 3-field tuple
cast sig "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"
# → 0x66134607
```

---

## 4. The fabricated-selector trap

**Never write a selector from memory, from another chain, or from a doc you have
not run.** Two selectors were fabricated during this mission and both cost
debugging time:

| Claimed | Actually | Reality |
|---|---|---|
| deposit = `0xbf9c6fcd` | `0x2fb1d270` | **fabricated** |
| owner() = `0x63b6e8ee` | `0x8da5cb5b` | **fabricated** — `63b6e8ee` appears nowhere in the Hybrid implementation |

A fabricated selector in an `AllowedMethods` allowlist is the worst of both
worlds: the signature verifies, and redemption reverts with
`method-not-allowed`. Nothing in the signing path objects.

**Always compute, never assume:**

```bash
cast sig "deposit(address,bytes32,uint256,uint256)"                       # 0x2fb1d270
cast sig "redeem(address,bytes32,uint256,uint256,uint256)"                # 0xa814c1fe
cast sig "createAtoms(bytes[],uint256[])"                                 # 0x61403309
cast sig "createTriples(bytes32[],bytes32[],bytes32[],uint256[])"        # 0x3c6bbf45
cast sig "owner()"                                                       # 0x8da5cb5b
```

The signing page does this too: it passes **canonical signature strings** to
`selectors:` and derives the hex with `toFunctionSelector`. That is the reason
the SDK page is the canonical path — it makes the fabrication impossible.

---

## 5. Constants

```typescript
const ERC1271_MAGIC_VALUE   = '0x1626ba7e'
const MODE_SINGLE_DEFAULT   = '0x' + '00'.repeat(32)
const ROOT_AUTHORITY='0x' + 'ff'.repeat(32)   // 32 bytes, ALL 0xff
// = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
```

> **`ROOT_AUTHORITY` is `0xff…ff`, never `0x00…00`.** A zero authority is a
> different, meaningful value (a parent delegation reference) and will not
> validate. The keeper gate asserts the shape.

### Struct field order: delegate FIRST

```solidity
struct Delegation {
  address delegate;    // Agent
  address delegator;   // Hybrid Smart Account
  bytes32 authority;   // ROOT_AUTHORITY
  Caveat[] caveats;
  uint256 salt;
  bytes signature;
}
```

`(delegate, delegator, authority, caveats, salt, signature)` — delegate first.
Reversing the first two silently produces a different hash.

---

## 6. Contract addresses

| Contract | Address | Notes |
|---|---|---|
| **DelegationManager** | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | live on 13579 **and** 1155 |
| **HybridDeleGatorImpl** | `0x48dbe696a4d990079e039489ba2053b36e8ffec4` | Hybrid logic (20204 bytes) |
| **SimpleFactory (Intuition testnet)** | `0x54c68ad35b082546a1e2e3e1a7542Ce9d3A2e756` | **use this on 13579** |
| SimpleFactory (MetaMask canonical) | `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c` | registry address; see caveat below |
| **MultiVault (testnet)** | `0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91` | chain 13579 |
| **MultiVault (mainnet)** | `0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e` | chain 1155 |
| **SimpleFactory (mainnet)** | `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c` | the ONLY factory live on 1155 |
| **AllowedMethodsEnforcer** | `0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5` | |
| **ValueLteEnforcer** | `0x92bf12322527caa612fd31a0e810472bbb106a8f` | the enforcer in use |
| **LimitedCallsEnforcer** | `0x04658B29F6b82ed55274221a06Fc97D318E25416` | |
| **AllowedTargetsEnforcer** | `0x7f20f61b1f09b08d970938f6fa563634d65c4eeb` | |
| **TimestampEnforcer** | `0x1046bb45C8d673d4ea75321280DB34899413c069` | |

> ### Which SimpleFactory on which chain (measured 2026-10-02)
>
> | Factory | 13579 | 1155 |
> |---|---|---|
> | `0x54c68ad3…` (Intuition) | 751 bytes | **EMPTY** |
> | `0x69Aa2f9f…` (MetaMask canonical) | 751 bytes | 751 bytes |
>
> Both exist on testnet, but they are **different contracts** returning
> **different CREATE2 addresses for the same (initCodeHash, salt)**:
> `0x54c6…` → `0xFEc573E35c5706B29B0f0eE07e1864f1AF8adF05`,
> `0x69Aa…` → `0x99D9ca38b68a3cD6981ed466285E383eda7cdBDf`.
>
> ⇒ **testnet: `0x54c68ad3…`; mainnet: `0x69Aa2f9f…`.** An earlier version of
> this file and of the keeper gate both claimed `0x69Aa…` was undeployed
> everywhere; that was wrong, and SKILL.md was right. This is the same
> don't-trust-a-registry-address rule the file is about.

### Hybrid deploy params

```js
deployParams = [owner, [], [], []]   // [owner, signers[], guardians[], fallbacks[]]
```

The Hybrid is an **ERC-1967 proxy** (164 bytes on-chain). Deploy the ~2.0KB proxy
pointing at `0x48dbe696…`, not the 44KB `HybridDeleGator` implementation
bytecode — that exceeds MetaMask's ~43KB limit and contains an unresolved
library placeholder. Constant is in `sign-delegation.html` as `PROXY_BYTECODE`.

---

## 7. The caveats-as-authority model

**A delegation is a standing authorization, not a one-shot token.**

- **Salt is NOT replay protection.** The salt only distinguishes one delegation
  from another so two identical delegations are not the same delegation. What
  actually bounds a delegation is its **caveats**.
- The caveats are the authority. `LimitedCalls`, `Timestamp`, `ValueLte`,
  `AllowedTargets`, `AllowedMethods` are what make a delegation safe to hand to
  an autonomous agent.
- **`AllowedMethods` is an ALLOWLIST.** Anything not named is refused at redeem
  with `method-not-allowed`, while `isValidSignature` still passes. This is the
  second trap the mission exists to document — see §4.

Term encodings (verified 2026-09-24, **not** standard ABI):

| Enforcer | terms encoding |
|---|---|
| AllowedMethods | raw concatenated 4-byte selectors, no ABI framing |
| AllowedTargets | raw concatenated 20-byte addresses |
| ValueLte | 32-byte uint256 |
| LimitedCalls | 32-byte uint256 |
| Timestamp | `after` (16B) ‖ `before` (16B) |

---

## 7b. Chained / redelegated authority (`authority` ≠ ROOT_AUTHORITY)

`authority` has two meanings. Read which one applies before assuming.

| `authority` value | Meaning | Parent check |
|---|---|---|
| `***` (32 × `0xff`) | **ROOT.** This delegation is granted directly by the delegator. No parent. | none |
| anything else | **A PARENT DELEGATION HASH** (`bytes32`). This delegation was granted *under* a parent delegation. | **required** |

A child delegation does not stand alone: it is only valid while its parent is
valid, and its authority derives from the parent's authority.

```
leaf.delegation ──authority──▶ parent delegation hash ──▶ … ──▶ ROOT_AUTHORITY
```

**The walk (this is the revocation check, not a formality):**

```bash
DM=0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
# 1. hash the leaf
HASH=$(cast call $DM "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "($DELEGATE,$DELEGATOR,$AUTHORITY,[$CAVEATS],$SALT,$SIG)" --rpc-url $RPC)
# 2. is it disabled?
cast call $DM "disabledDelegations(bytes32)(bool)" $HASH --rpc-url $RPC
# 3. if authority != ROOT: recurse from step 1 with the parent hash
```

**Revocation propagates down the tree.** Disabling a parent kills every
descendant, so a leaf reading `false` proves nothing if an ancestor is disabled.
Always walk to a root.

> **Unresolvable link ⇒ reject.** A chain that cannot be traced to a
> `ROOT_AUTHORITY` is not an authority, no matter how the signature verifies.

**Practical note:** the entire working setup in this skill uses a **ROOT**
delegation (`authority = ff…ff`), so the chain-walk is the path you need only
when someone hands you a delegation from an untrusted source — which is exactly
when you should not trust it.

---

## 8. Agent wallet setup (OpenWallet)

The agent holds its **own** key and signs redemptions with it. The main account
key is never involved after the Hybrid is deployed and funded.

```bash
# One-time, agent-side. Generates a fresh key; writes 0600.
mkdir -p ~/.intuition && chmod 700 ~/.intuition
node -e '
  const {ethers}=require("ethers"); const fs=require("fs");
  const w=ethers.Wallet.createRandom();
  fs.writeFileSync(process.env.HOME+"/.intuition/agent-wallet.json",
    JSON.stringify({address:w.address,privateKey:w.privateKey},null,2),{mode:0o600});
  console.log("agent delegate address:", w.address);
'
```

| Role | Address (this deployment) |
|---|---|
| Main account (Hybrid **owner**) | `0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee` |
| Hybrid (the **delegator**) | `0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14` |
| Agent / OWS (the **delegate**) | `0xe9BfdEC6Fa795a24e3069292248d9d16570E050d` |

**Chain of authority:** `Main (owner of Hybrid) → Hybrid (delegator) → Agent (delegate)`.
The signer is the Main EOA; the delegator is the Hybrid. Those are different
addresses and conflating them produces the internal-account rejection.

**Deriving the delegate address from the key:**

```bash
cast wallet address --private-key "$(jq -r .privateKey ~/.intuition/agent-wallet.json)"
```

The agent can therefore sign redemptions on its own, forever, without the main
key existing on the agent's machine at all.

---

## 9. Chain-keyed environment resolution

The SDK resolves contract addresses per chain; you do not hardcode them.

```js
const env = getSmartAccountsEnvironment(13579)
```

Returns the environment object consumed by `createDelegation` and by
`signDelegation`'s EIP-712 domain (`env.DelegationManager` is
`verifyingContract`). Verified structure:

```
{ chainId, DelegationManager, SimpleFactory, implementations: { Hybrid, ECDSAOwnership4337,
  ECDSAOwnershipWebAuthn, WebAuthnKey, ... }, entryPoint, caveatEnforcers: { ... } }
```

Because the domain separator's `verifyingContract` comes from here, a
wrong-environment bug reproduces as a digest mismatch, i.e. `0xffffffff` — with
no other symptom.

---

## 10. Verification commands

Every selector and constant in this file, re-runnable:

```bash
# selectors — computed from canonical signatures, never assumed
cast sig "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"  # 0x66134607
cast sig "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"  # 0x49934047
cast sig "redeemDelegations(bytes[],bytes32[],bytes[])"                                        # 0xcef6d209
cast sig "getDomainHash()"                                                                    # 0x83ebb771
cast sig "enableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"  # 0x3ed01015

# Caveat typehash — the 2-field form is the one that matters
cast keccak "Caveat(address enforcer,bytes terms)"

# custom errors
cast sig "CannotUseADisabledDelegation()"   # 0x05baa052
cast sig "InvalidERC1271Signature()"         # 0x155ff427
cast sig "InvalidDelegator()"                # 0xb9f0f171
cast sig "NotDelegationManager()"            # 0x1a4b3a04

# addresses live?
cast code 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3 --rpc-url $RPC   # DelegationManager
cast code 0x54c68ad35b082546a1e2e3e1a7542Ce9d3A2e756 --rpc-url $RPC   # testnet factory
cast call 0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14 "owner()(address)" --rpc-url $RPC
```

Whole-skill ground-truth gate (selectors, addresses, domain hashes, ROOT_AUTHORITY
shape, Caveat type, ERC-1271 proof):

```bash
./scripts/delegation-doc-verification.sh
```

---

## Next

You now have the model. To create a delegation from it, go to
**`operations/create-delegation.md`** — it carries the SDK flow, both footguns,
and the output contract.