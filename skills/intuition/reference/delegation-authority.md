# Delegated Authority — How An Agent Decides

The complete procedure an autonomous agent follows to decide whether to act on
its delegated authority. **Self-contained: everything needed to decide is in this
file.** No external docs, no SDK internals, no trust in the page that produced
the delegation.

**The governing principle:** you decide from the delegation's own fields and
from on-chain state. Not from the signing page, not from the SDK, not from the
environment it was created in, not from the name of the file it arrived in. A
delegation handed to you by an untrusted party is untrusted input.

---

## Addresses (Intuition testnet, 13579)

| | |
|---|---|
| RPC | `https://testnet.rpc.intuition.systems/http` |
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| MultiVault | `0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91` |
| ERC-1271 magic | `0x1626ba7e` |
| ROOT_AUTHORITY | 32 bytes of `0xff` |
| Main account (Hybrid **owner**, and the **receiver** of vault writes) | `0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee` |

> **Attribution rule — know who receives what.** For `deposit`/`redeem`, the
> `receiver` argument is the **Main account**, so shares accrue to the user and
> not to the delegator or the agent. `createAtoms`/`createTriples` have no
> receiver: attribution follows the delegator (the Hybrid), which pays the atom
> and triple costs from its own tTRUST balance. Do not guess the receiver — the
> executor hardcodes Main, and a plan whose receiver disagrees with the executor
> will move value somewhere the delegation was never reviewed for.

Mainnet (1155) differs only in RPC and MultiVault
(`0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e`).

---

## Step 1 — Parse

```js
const d = (signed.delegation ?? signed)
```

Validate the shape before trusting any of it:

| Field | Requirement |
|---|---|
| `delegate` | **must equal your own address**, else you have no authority at all |
| `delegator` | address with code (the Hybrid). **Never your own key's EOA** |
| `authority` | `ff…ff` for a root delegation; otherwise a parent hash |
| `caveats[]` | each `{ enforcer, terms, args }` |
| `salt` | uint256 |
| `signature` | 65 bytes |

If `delegate ≠ your address` → **`reject`**, immediately, no further checks.

## Step 2 — Verify the signature

The contract is the only authority on its own digest. Recompute it:

```
structHash = DM.getDelegationHash(delegation)     // selector 0x66134607
domainHash = DM.getDomainHash()                   // selector 0x83ebb771
digest     = keccak256(0x1901 ‖ domainHash ‖ structHash)
magic      = IERC1271(delegator).isValidSignature(digest, signature)
```

**One command does steps 2 and 4.** It reads the contract, does not recompute
the struct off-chain (the DelegationManager packs `Caveat[]` non-standardly, so
any hand-rolled keccak is a guess):

```bash
cd ~/.hermes/skills/intuition
node scripts/compute-delegation-hash.mjs templates/signed-delegation-final.json
```

Real output (verified 2026-10-02):

```json
{
  "delegatorHasCode": true,
  "structHash": "0x3fc5a2a19c85eb6f43f4736705a5d86aecd5ed2a045741ff9ddd8ef475c1399e",
  "domainHash": "0x0b7c642afd2411ce211542a0e154e558e357f3b7f4738eb327ae086bfc659f15",
  "digest":     "0x6308ca70982aa20733b038ddbd0f86c607ec4bae870412c0c157cfb5df26a60a",
  "disabled":   false,
  "erc1271":    "0x1626ba7e",
  "valid":      true
}
```

`valid: true` is step 2. `disabled` is step 4. Equivalent raw calls if you
prefer:

```bash
DM=0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
HY=0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14
RPC=https://testnet.rpc.intuition.systems/http
cast call $HY "isValidSignature(bytes32,bytes)(bytes4)" $DIGEST $SIG --rpc-url $RPC
```

| Result | Meaning |
|---|---|
| `0x1626ba7e` | signature valid — **proceed to step 3** |
| `0xffffffff` | digest/signature mismatch → `reject` |

> A valid signature proves the signer authorised **that payload**. It says
> nothing about whether the payload can be executed. Steps 3 and 4 are where
> unusable delegations are caught.

## Step 3 — Check the caveats against what you intend to do

Enforcer terms are **raw encodings, not standard ABI**:

| Enforcer (full address) | terms encoding | Reads as |
|---|---|---|
| `0x7f20f61b1f09b08d970938f6fa563634d65c4eeb` AllowedTargets | raw 20-byte addresses, concatenated | every permitted target |
| `0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5` AllowedMethods | raw 4-byte selectors, concatenated | permitted selectors |
| `0x92bf12322527caa612fd31a0e810472bbb106a8f` ValueLte | 32-byte uint256 | max native value per call |
| `0x1046bb45C8d673d4ea75321280DB34899413c069` Timestamp | `after`(16B) ‖ `before`(16B) | validity window |
| `0x04658B29F6b82ed55274221a06Fc97D318E25416` LimitedCalls | 32-byte uint256 | max redemptions |

> **ABSENT enforcer = NO restriction of that kind.** A delegation does not have to
> carry every enforcer. If `AllowedMethods` is absent, **every method is
> permitted** — the enforcer simply never runs. If `ValueLte` is absent there is
> no value cap. If `Timestamp` is absent the delegation never expires.
>
> Read the caveat list as a set of *restrictions that were chosen*, not as a
> checklist that must be complete. An absent enforcer is permissive, not an error.
> (This was a documented gap found by the Mission 12 fresh-agent B2 test: the
> absence semantics were implied but never stated.)

> **Timestamp terms are exactly 32 bytes: two 16-byte words.** The first is
> `after`, the second is `before`. A leading all-zero 16-byte word means
> `after = 0` (no lower bound); e.g.
> `0x0000000000000000000000000000000000000077359400` is a **32-byte** value →
> `after = 0`, `before = 2000000000`. Do not parse these as 64-byte words.

The four checks that matter, in order:

1. **Target** — is the contract you intend to call in AllowedTargets?
2. **Method** — is its selector in AllowedMethods? It is an **allowlist**;
   anything absent is refused while `isValidSignature` still passes.
3. **Value** — is the value you want to send ≤ ValueLte? Note ValueLte `0` admits
   only value-free calls; that is a real configuration, not a bug in your logic.
4. **Time** — is `now` inside the Timestamp window?

Plus two that surprise people:

5. **Remaining calls.** LimitedCalls decrements per redemption. If the remaining
   count is 0, the delegation is spent regardless of everything else.
6. **The authority chain** (§ revocation walk, below).

**Never hand-roll this encoding.** Decode with the project's verified tools, or
simulate the exact call you intend and read the verdict:

```bash
node templates/redeem-delegation.cjs signed.json --op deposit --term 0x<TID> --amount 0.001
# each revert names its own cause — see the table below
# NO REVERT            → caveats admit the call
# 0x155ff427           → caveats PASS; only the signature is wrong
# Error(string):<Name> → an enforcer rejected it
```

## Step 4 — Check revocation state

```bash
HASH=$(<from step 2>)
cast call $DM "disabledDelegations(bytes32)(bool)" $HASH --rpc-url $RPC
```

- `false` → not revoked. Continue.
- `true` → `reject`, reason `CannotUseADisabledDelegation` (`0x05baa052`).

Also check the Timestamp caveat: an expired delegation is dead even if
`disabledDelegations` says `false`. Revocation and expiry are independent.

## Step 5 — Decide, and emit JSON

```json
{
  "decision": "proceed",
  "reason": "signature valid; deposit admitted by enforcers; not revoked",
  "plan": {
    "op": "deposit",
    "to": "0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91",
    "valueWei": "1000000000000000",
    "termId": "0x88c64e37687bf17f7bc1fbc449ea700910cf7e80a92ab4d0fa3ae9d9eb15ae65",
    "receiver": "0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee",
    "command": "node templates/redeem-delegation.cjs signed.json --op deposit --term 0x88c6… --amount 0.001 --broadcast --yes"
  }
}
```

### Decision semantics

| decision | When | Then |
|---|---|---|
| `proceed` | all of §1–4 pass **and** the simulation is clean | execute `plan.command` |
| `halt` | a fact blocks you now but could change (expired, calls exhausted, sim transient) | stop, report, do not retry blindly |
| `reject` | the delegation cannot authorise this action, ever (wrong delegate, bad signature, revoked, target/method/value outside the caveats) | stop permanently for this delegation |

`proceed` on the **simulation** is the only warrant to broadcast. A `proceed`
whose simulation reverted is a contradiction — treat it as `halt`.

## Step 6 — Execute

`templates/redeem-delegation.cjs` defaults to **dry-run**. It emits JSON on
stdout (human text goes to stderr) with a stable shape:

```json
{
  "tool": "redeem-delegation.cjs",
  "mode": "dry-run",
  "op": "deposit",
  "chainId": 13579,
  "agent": "0xe9Bf…", "delegator": "0x433d…", "delegate": "0xe9Bf…",
  "calldataBytes": 1892,
  "valueTuthwei": "1000000000000000",
  "valueTrusted": "0.001",
  "decision": "proceed",
  "reason": "Simulation passed. Nothing broadcast (dry-run default). Re-run with --broadcast --yes to send.",
  "simulation": { "ok": true, "error": null, "errorName": null, "raw": "cef6d20900" },
  "signatureCheck": { "magic": "0x1626ba7e", "valid": true, "digest": "0x6308ca70…", "structHash": "0x3fc5a2a1…" },
  "tx": null,
  "createdIds": []
}
```

(copied verbatim from a real dry-run; the ellipses above stand in for the long
digests)

Broadcasting requires **two** flags:

```bash
node templates/redeem-delegation.cjs signed.json --op deposit --term 0x<TID> --amount 0.001 --broadcast --yes
```

`--broadcast` without `--yes` exits `2` without sending. On success `tx.hash` is
populated and `createdIds` lists new atom/triple IDs.

---

## Revocation tree walk

A delegation with a non-root `authority` is a **child** of a parent delegation.
Authority must be traceable to a root that has not been revoked.

```
leaf.delegation ──authority──▶ parent hash ──▶ … ──▶ ROOT_AUTHORITY (ff…ff)
```

For each link:

1. If `authority == ROOT_AUTHORITY` → this is a root; stop, it needs no parent.
2. Otherwise the `authority` bytes32 is a **parent delegation hash**. Confirm the
   parent exists and is not disabled, recursively, to a root.

```bash
cast call $DM "disabledDelegations(bytes32)(bool)" $PARENT_HASH --rpc-url $RPC
```

Revocation propagates: disabling a delegation kills the subtree beneath it. So
**walk the whole chain, not just the leaf.** A leaf reading `false` proves
nothing if an ancestor is disabled.

If a link is missing or unresolvable → `reject`. An unverifiable authority chain
is not an authority.

---

## What this file deliberately does not tell you to trust

- **The signing page.** It is a UI. It reports success; it does not confer
  authority. Treat its output as an untrusted claim to be checked in §1–4.
- **The SDK or the environment that built the delegation.** Whatever
  `createDelegation` was called with, the delegation's own fields plus on-chain
  state are what govern.
- **The file name.** `signed-delegation-final.json` proves nothing.
- **A green signature check on its own.** It is step 2 of 4, not the verdict.
- **Any value you were "told".** Amounts, addresses, and limits come from the
  delegation fields or the chain, or they are not facts.

---

## Error → decision table

| Selector | Error | Decision |
|---|---|---|
| `0xffffffff` | signature/digest mismatch | `reject` |
| `0x155ff427` | `InvalidERC1271Signature` — caveats passed, signature wrong | `reject` |
| `0x05baa052` | `CannotUseADisabledDelegation` | `reject` |
| `0xb9f0f171` | `InvalidDelegator` | `reject` |
| `0xb5863604` | `InvalidDelegate` | `reject` |
| `0xded4370e` | `InvalidAuthority` | `reject` |
| `0x1a4b3a04` | `NotDelegationManager` | `reject` |
| `0x005ecddb` | `AlreadyDisabled` | `reject` |
| `0x1bcaf69f` | `BatchDataLengthMismatch` | `halt` |
| — | method-not-allowed (no selector) | `reject` |
| — | ValueLte exceeded | `reject` |
| — | expired timestamp | `halt` (a fresh delegation could differ) |

---

## Related

- `reference/delegation.md` — the model and the struct anatomy
- `operations/create-delegation.md` — producing the delegation you are deciding on

## Next

A `proceed` decision is executed with **`templates/redeem-delegation.cjs`**
(dry-run by default; `--broadcast --yes` to send).

To take the authority back instead, go to **`operations/revoke-delegation.md`**
— the delegator is a contract, so revocation is an ERC-4337 UserOp, not a
transaction from the Main account.
