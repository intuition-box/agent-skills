# Create a Delegation

Produce a valid, signed delegation on Intuition using the SDK. Follow this file
top to bottom; it is self-contained for construction and signing.

**Status of that claim, honestly:** verified by the Mission 12 fresh-agent tests.
B1 (SKILL.md + this file only) produced a complete, syntactically valid signing
implementation and independently confirmed all five selectors against `cast sig`
— after these gaps were closed. What B1 *cannot* do here is sign: that needs
MetaMask. The gaps it found and this file now answers were (1) the `UINT256_MAX`
constant was used but never defined and its name is actively misleading — the
value is 2^255-1, not 2^256-1; (2) `pub`/`wc` were used but never constructed;
(3) the `createCaveatBuilder` subpath was ambiguous; (4) the `to`/`from` →
`delegate`/`delegator` rename was unstated; (5) mainnet constants were absent.


**Prerequisites:** the Hybrid smart account must already be deployed, approved on
MultiVault, and funded with tTRUST. The signing page does all three
(steps 2a/2b/2c). Agent wallet: `reference/delegation.md` §8.

---

## Quick Start

```bash
cd ~/.hermes/skills/intuition/templates
python3 -m http.server 8000
# open http://127.0.0.1:8000/sign-delegation.html in MetaMask's browser
#   1. Connect Wallet          → Main account 0x61A20dE8… (the Hybrid OWNER)
#   2. Deploy / Approve / Fund → once per deployment
#   3. Build fresh (SDK)       → constructs the delegation in memory
#   4. Sign with MetaMask (SDK) → approve the popup
#   5. Copy JSON               → this is the signed delegation
```

> **Switch to a browser where MetaMask is the injected provider.** The Mises
> browser injects `Mises Safe` as `window.ethereum`, shadowing MetaMask. Check
> `window.ethereum.isMetaMask` before diagnosing any signing failure.

> **Order dependency:** the atom must exist **before** you deposit into it.
> `deposit` takes a *triple* ID; that triple needs three existing atoms. Create
> the atoms first (`createAtoms`), then the triple (`createTriples`), then
> deposit. Depositing into a nonexistent triple reverts.

No textarea paste step exists in this flow. "Build fresh (SDK)" constructs the
delegation in memory via `createDelegation()`; you never paste JSON into the
page.

---

## Step 1: The delegation, with the SDK

> **Where this code runs.** In a **browser page with an injected wallet**
> (`window.ethereum`), loaded as a module — the path this skill uses. It is
> **not** runnable from a terminal: the bare specifiers below resolve through a
> bundler or an import map, and signing requires a MetaMask popup. For a local
> page, the signing page loads the SDK from a CDN via dynamic `import()`:
> `https://cdn.jsdelivr.net/npm/@metamask/smart-accounts-kit@2.0.0/+esm`
> (and `/utils/+esm` for the caveat builder). **Pin that version** — do not float it.
>
> As a standalone Node script instead: `npm i @metamask/smart-accounts-kit@2.0.0 viem`
> and supply a signer other than `window.ethereum`. Node can do step 1 but
> **cannot** do step 2 (no MetaMask).


```js
import {
  getSmartAccountsEnvironment, createDelegation, toMetaMaskSmartAccount,
  Implementation, ScopeType,
} from '@metamask/smart-accounts-kit'      // root: everything EXCEPT createCaveatBuilder
import { createCaveatBuilder } from '@metamask/smart-accounts-kit/utils'   // /utils subpath ONLY
import { createPublicClient, createWalletClient, custom, parseEther } from 'viem'

// ── addresses first: everything below references them, and `const` is NOT
//    hoisted, so declaring a client before its account is a ReferenceError.
const OWNER_EOA  = '0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee'  // Hybrid's owner; THIS signs
const AGENT      = '0xe9BfdEC6Fa795a24e3069292248d9d16570E050d'  // the delegate
const HYBRID     = '0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14'  // the delegator
const MULTIVAULT = '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91'
const CHAIN_ID   = 13579   // 1155 = mainnet; see "Mainnet" below

// 2^255-1. The signing page calls this UINT256_MAX, but that NAME IS WRONG —
// 2^256-1 is 0xffff…ff, 2^255-1 is 0x7fff…ff. Copy the value, not the name.
const MAX_VALUE  = 57896044618658097711785492504343953926634992332820282019728792003956564819967n

const chain = {
  id: CHAIN_ID, name: 'Intuition Testnet',
  nativeCurrency: { name: 'TRUST', symbol: 'TRUST', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet.rpc.intuition.systems/http'] } },
}

const env = getSmartAccountsEnvironment(CHAIN_ID)
const cb = createCaveatBuilder(env)
cb.addCaveat('limitedCalls', { limit: 100 })

// `pub` = read-only client, `wc` = signing client. Both need the injected provider.
const pub = createPublicClient({ chain, transport: custom(window.ethereum) })
const wc  = createWalletClient({ account: OWNER_EOA, chain, transport: custom(window.ethereum) })

const delegation = createDelegation({
  to:      AGENT,           // 0xe9BfdEC6Fa795a24e3069292248d9d16570E050d
  from:    HYBRID,          // 0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14
  environment: env,
  salt: '0x' + (BigInt(Date.now()) * 1000n).toString(16).padStart(64, '0'),
  scope: {
    type: ScopeType.FunctionCall,
    targets: [MULTIVAULT],  // 0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91
    selectors: [
      'deposit(address,bytes32,uint256,uint256)',
      'redeem(address,bytes32,uint256,uint256,uint256)',
      'createAtoms(bytes[],uint256[])',
      'createTriples(bytes32[],bytes32[],bytes32[],uint256[])',
    ],
    valueLte: { maxValue: MAX_VALUE },            // ← MANDATORY. See the box below.
  },
  caveats: cb,
})
```

> ### ⚠️ FOOTGUN 1 — `valueLte` silently defaults to **zero**
>
> The builder normalises the scope with `config.valueLte ?? { maxValue: 0n }`.
> There is **no unlimited default**. Omit it and the delegation carries a
> `ValueLte = 0` caveat: every value-bearing call reverts, **while
> `isValidSignature` keeps returning `0x1626ba7e`.**
>
> This is the single most valuable finding in this skill, because the failure is
> *invisible from the signing side* and the revert is generic.
>
> **Wrong:**
> ```js
> scope: { type: ScopeType.FunctionCall, targets: [MULTIVAULT], selectors: [...] }
> // → valueLte = 0n → every deposit/createAtoms/createTriples reverts
> ```
> **Right** — with the constant **defined**, because the name is a trap:
> ```js
> // 2^255-1. The signing page calls this UINT256_MAX, but that name is WRONG:
> // 2^256-1 is 0xffff…ff, and 2^255-1 is 0x7fff…ff. The page's value is 2^255-1.
> // Copy the value below rather than trusting the name.
> const MAX_VALUE = 57896044618658097711785492504343953926634992332820282019728792003956564819967n;
>
> scope: {
>   type: ScopeType.FunctionCall,
>   targets: [MULTIVAULT],
>   selectors: [ /* canonical signature strings */ ],
>   valueLte: { maxValue: MAX_VALUE },
> }
> ```
> Check it before you use it:
> ```bash
> node -e 'console.log((57896044618658097711785492504343953926634992332820282019728792003956564819967n).toString(16))'
> # → 7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff   (2^255-1 ✅)
> ```
> Any finite cap also works, e.g. `parseEther('1')` from `viem`. What matters
> is that `valueLte` is **present and non-zero** for value-bearing calls.
>
> The `terms` you will then see in the signed delegation is
> `0x7fff…ff` — that is the 2^255-1 value above, **not** `0xffff…ff`. If your
> output shows `0x0000…00`, you have the footgun.
>
> **Reproduce it, read-only:**
> ```
> $ node templates/probe-value-lte-footgun.mjs
> A) ValueLte = max (2^255-1), deposit 0.001  -> NO REVERT
> B) ValueLte = 0n,                deposit 0.001 -> execution reverted
> RESULT: FOOTGUN CONFIRMED
> ```

> ### ⚠️ FOOTGUN 2 — selectors must be computed, never assumed
>
> Pass **canonical signature strings** (as above) and let the SDK derive the hex.
> Do not hand-write `0x…` selectors.
>
> Two were fabricated during this mission, both undetected by the signer:
> `deposit = 0xbf9c6fcd` (really `0x2fb1d270`) and `owner() = 0x63b6e8ee`
> (really `0x8da5cb5b` — `63b6e8ee` appears nowhere in the Hybrid bytecode).
>
> A fabricated selector inside `AllowedMethods` is the worst case: the signature
> verifies, then redemption reverts `method-not-allowed`.
>
> ```bash
> cast sig "deposit(address,bytes32,uint256,uint256)"    # 0x2fb1d270
> cast sig "redeem(address,bytes32,uint256,uint256,uint256)"  # 0xa814c1fe
> cast sig "createAtoms(bytes[],uint256[])"              # 0x61403309
> cast sig "createTriples(bytes32[],bytes32[],bytes32[],uint256[])"  # 0x3c6bbf45
> ```

`AllowedMethods` is an **allowlist**. Anything not named is refused at redeem
with `method-not-allowed` while `isValidSignature` still passes. If you want an
operation to work later, name it now.

> **Field-name mapping — the SDK renames two fields.** You pass `to` and
> `from`; the resulting struct uses **`delegate`** and **`delegator`**
> respectively. `createDelegation` does this for you, so never hand-construct the
> output object — take the returned object as-is. If you are reading a delegation
> that is already built, its fields are `delegate`/`delegator`.

## Step 2: Sign

```js
const sa = await toMetaMaskSmartAccount({
  client: pub,
  implementation: Implementation.Hybrid,
  address: HYBRID,                    // MANDATORY — omitting it derives the wrong delegator
  signer: { walletClient: wc },
})
if (sa.address.toLowerCase() !== HYBRID.toLowerCase())
  throw new Error('SDK returned a different delegator: ' + sa.address)

const signature = await sa.signDelegation({ delegation })
const signed = { ...delegation, signature }
```

The signer is the **owner EOA** (`0x61A20dE8…`); the delegator is the **Hybrid**
(`0x433d9b2a…`). The page refuses to sign if the connected account is the
delegator itself — that is the "external signature requests cannot sign
delegations for internal accounts" trap.

Never `<script type="module">` here: inline `onclick=` handlers cannot see
module-scope bindings, and every button dies silently.

## Mainnet (1155)

Same code, different chain constants. The environment and the domain separator
both follow `CHAIN_ID`, so a hardcoded 13579 is the usual bug here (it surfaces
as `0xffffffff`, with no other symptom).

| | testnet | mainnet |
|---|---|---|
| `CHAIN_ID` | `13579` | `1155` |
| RPC | `https://testnet.rpc.intuition.systems/http` | `https://rpc.intuition.systems/http` |
| MultiVault | `0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91` | `0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e` |
| SimpleFactory | `0x54c68ad35b082546a1e2e3e1a7542Ce9d3A2e756` | not deployed — deploy your own |

DelegationManager is `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` on **both**.
Confirm the domain hash for a chain before trusting a signature:

```bash
cast call 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3 "getDomainHash()(bytes32)" --rpc-url <rpc>
```

## Manual cast + viem patterns (the mechanism, not the build path)

> The SDK path above is **canonical**. This section exists because the rest of
> the skill's operations files are cast/viem-shaped, and because seeing the
> mechanism is how you debug it. Do not build new delegations this way —
> `scripts/compute-delegation-hash.mjs` recomputes it from the contract.

### Read the state you depend on (cast)

```bash
export RPC=https://testnet.rpc.intuition.systems/http
export DM=0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3

# domain separator — NEVER guess this; it is part of the digest
cast call $DM "getDomainHash()(bytes32)" --rpc-url $RPC
# 0x0b7c642afd2411ce211542a0e154e558e357f3b7f4738eb327ae086bfc659f15

# struct hash for a given delegation (delegate FIRST)
cast call $DM \
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "($DELEGATE,$DELEGATOR,$ROOT_AUTHORITY,[$CAVEATS],$SALT,$SIG)" --rpc-url $RPC

# revoked?
cast call $DM "disabledDelegations(bytes32)(bool)" $HASH --rpc-url $RPC

# ERC-1271 — the Layer 1 probe, before anything else
cast call $HYBRID "isValidSignature(bytes32,bytes)(bytes4)" $DIGEST $SIG --rpc-url $RPC
# must be 0x1626ba7e
```

**`$CAVEATS` takes 3-field tuples** `(enforcer,terms,args)` — that is the ABI
view. The EIP-712 *signing* type is 2-field. See `reference/delegation.md` §3.

### `ROOT_AUTHORITY` vs a parent hash

```bash
ROOT_AUTHORITY=0x'$(printf 'ff%.0s' {1..32})'   # 32 bytes of 0xff — a ROOT grant
# A chained delegation instead carries a parent delegation HASH here.
# See reference/delegation.md §7b before accepting one.
```

### Read via viem

```ts
import { createPublicClient, http, parseAbi } from 'viem'

const pub = createPublicClient({ chain, transport: http(RPC) })
const abi = parseAbi([
  'function getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes) d) view returns (bytes32)',
  'function getDomainHash() view returns (bytes32)',
  'function disabledDelegations(bytes32) view returns (bool)',
])

const structHash = await pub.readContract({ address: DM, abi, functionName: 'getDelegationHash', args: [d] })
const domainHash = await pub.readContract({ address: DM, abi, functionName: 'getDomainHash' })
const disabled  = await pub.readContract({ address: DM, abi, functionName: 'disabledDelegations', args: [structHash] })
```

> The `getDelegationHash` tuple must be passed **positionally** as a single
> object under this viem/ethers build; a named-field array throws
> `array is wrong length`. `templates/redeem-delegation.cjs` shows the working
> form.

### Compute selectors the way the docs require

```bash
cast sig "deposit(address,bytes32,uint256,uint256)"    # 0x2fb1d270
cast sig "owner()"                                     # 0x8da5cb5b
```

---

## Step 3: Verify before you trust it

```bash
DM=0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
HY=0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14
RPC=https://testnet.rpc.intuition.systems/http

cast call $DM "getDomainHash()(bytes32)" --rpc-url $RPC
cast call $HY "isValidSignature(bytes32,bytes)(bytes4)" $DIGEST $SIG --rpc-url $RPC
# must be 0x1626ba7e
```

A valid signature proves the signer authorised that payload. It says **nothing**
about whether the payload can be executed. Carry a falsifier for the good news:

```bash
node templates/redeem-delegation.cjs signed.json --op deposit --term 0x<TID> --amount 0.001
# simulates, never broadcasts
```

The page does this itself after signing: it simulates every enabled operation
and reports which are admitted. Trust that line, not the signature line.

## Step 4: Output contract

`signDelegation` returns the signature; the deliverable is the **whole
delegation object plus that signature**. Hand this to the agent verbatim:

```json
{
  "network": "testnet",
  "chainId": 13579,
  "delegation": {
    "delegate":  "0xe9BfdEC6Fa795a24e3069292248d9d16570E050d",
    "delegator": "0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14",
    "authority": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "caveats": [
      { "enforcer": "0x7f20f61b1f09b08d970938f6fa563634d65c4eeb",
        "terms":   "0x2ece8d4dedcb9918a398528f3fa4688b1d2cab91",
        "args":    "0x" },
      { "enforcer": "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5",
        "terms":   "0x2fb1d270a814c1fe614033093c6bbf45",
        "args":    "0x" },
      { "enforcer": "0x92bf12322527caa612fd31a0e810472bbb106a8f",
        "terms":   "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "args":    "0x" },
      { "enforcer": "0x04658B29F6b82ed55274221a06Fc97D318E25416",
        "terms":   "0x0000000000000000000000000000000000000000000000000000000000000064",
        "args":    "0x" }
    ],
    "salt":      "0x0ca17e0e0af5d096241cb196de2d8802044b3e8082cc64f06015e73907c8a49c",
    "signature": "0x…65 bytes…"
  }
}
```

| Field | Notes |
|---|---|
| `delegate` | the agent address — first field, do not reorder |
| `delegator` | the **Hybrid**, not the signing EOA |
| `authority` | `ROOT_AUTHORITY` = 32 bytes of `0xff`, **never zeros** |
| `caveats[]` | `enforcer`, `terms`, `args` (3-field ABI view) |
| `salt` | uint256, distinguishes delegations — **not** replay protection |
| `signature` | 65 bytes from `signDelegation` |

This is exactly what `templates/redeem-delegation.cjs` reads
(`signed.delegation || signed`).

## Step 5: Optional — cache on-chain

`enableDelegation(delegation)` caches the delegation on-chain without a
signature. **Not required** for the sign → `redeemDelegations` flow; the caller
must be the delegator. The Hybrid has no owner-callable entrypoint, so under
the Hybrid model this is effectively unavailable to the Main EOA — see
`operations/revoke-delegation.md`.

---

## Error table

| Symptom | Selector | Meaning | Fix |
|---|---|---|---|
| `isValidSignature` returns `0xffffffff` | — | **digest/signature mismatch** — nothing to do with caveats | verify `address:` was passed to `toMetaMaskSmartAccount`; confirm signer ≠ delegator; recompute the digest from `getDelegationHash` + `getDomainHash` |
| simulation reverts, no name | `0x` empty | caveats rejected the call, unnamed | read the enforcer below; check `valueLte` and the allowlist |
| `CannotUseADisabledDelegation()` | `0x05baa052` | delegation was revoked | re-issue a fresh delegation |
| `InvalidERC1271Signature()` | `0x155ff427` | all caveats passed, only the signature is wrong | digest mismatch — see row 1 |
| `InvalidDelegator()` | `0xb9f0f171` | `msg.sender` is not the delegator | the caller must be the Hybrid |
| `InvalidDelegate()` | `0xb5863604` | delegate does not match the expected address | check the agent address |
| `InvalidAuthority()` | `0xded4370e` | `authority` is not a valid parent | use `ROOT_AUTHORITY` (`ff…ff`) for a root delegation |
| `NotDelegationManager()` | `0x1a4b3a04` | called `executeFromExecutor` directly | only DelegationManager may |
| method-not-allowed | — | `AllowedMethods` allowlist excludes the selector | compute it with `cast sig`, add the signature string |
| every deposit reverts, signature valid | — | **`valueLte` = 0** | set `valueLte: { maxValue: … }` in the scope |
| wallet refuses: "cannot sign delegations for internal accounts" | — | connected account *is* the delegator | switch to the owner EOA |
| buttons dead, no visible error | — | `<script type="module">` with inline `onclick` | use a classic `<script>` + `await import()` |
| wrong delegator in output | — | `address:` omitted from `toMetaMaskSmartAccount` | add it and assert `sa.address` |

Distinguishing "caveats wrong" from "signature wrong" mechanically:

```bash
# see the error table above — each revert names its own cause
# NO REVERT             → caveats admit the call
# 0x155ff427            → caveats PASS, only the signature is wrong
# Error(string):<Name>  → an enforcer rejected it (caveat problem)
```

---

## Related

- `reference/delegation.md` — the model: roles, tracks, the 2-field/3-field split, addresses
- `templates/sign-delegation.html` — the canonical signing page
- `templates/redeem-delegation.cjs` — dry-run is the canonical pre-broadcast check

## Next

You now hold a **signed delegation**: the JSON object in §4, with `delegate`,
`delegator`, `authority`, `caveats[]`, `salt` and `signature`.

To act on it — parse, verify, check caveats and revocation, and emit a
proceed/halt/reject decision — go to **`reference/delegation-authority.md`**.
That is the agent-side consumption contract for the artifact this procedure
produces.
