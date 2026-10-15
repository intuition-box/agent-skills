# Revoke a Delegation

Turning off a delegation. **Read §2 first: under the Hybrid model revocation is
currently blocked, and the reason is on-chain evidence, not opinion.**

**Prerequisites:** `reference/delegation.md` for addresses and struct anatomy.

## Reference implementation

**`templates/revoke-delegation.cjs`** — the working code for everything below.
One file, one signature, one submission. Same conventions as
`templates/redeem-delegation.cjs`: dry-run by default, structured JSON on
stdout, human text on stderr.

```bash
# 1. prepare — build the UserOp and print the exact digest Main must sign
node templates/revoke-delegation.cjs templates/signed-delegation-final.json

# 2. simulate with the signature pasted back (default; broadcasts nothing)
node templates/revoke-delegation.cjs templates/signed-delegation-final.json --sig 0x<65bytes>

# 3. submit (two flags required)
node templates/revoke-delegation.cjs templates/signed-delegation-final.json --sig 0x… --broadcast --yes

# or: the one-shot page — funds the EntryPoint AND collects the signature
node templates/revoke-delegation.cjs templates/signed-delegation-final.json --serve
```

### The one-shot page (the standard flow)

`--serve` starts a short-lived server on `http://127.0.0.1:3847` with two steps:

1. **Fund the ERC-4337 EntryPoint.** `depositTo(address)` is payable and
   **permissionless** — anyone may fund any account, so Main funds it directly
   from MetaMask. No agent key, no CLI, no bundler. The Hybrid cannot pay its own
   UserOp prefund, so this is required or `handleOps` reverts `AA21`. It is a
   one-time cost per Hybrid and is skipped if the deposit is already non-zero.
2. **Sign the revoke UserOp.** One `eth_signTypedData_v4` popup.

The two are independent — funding does not change the UserOp digest, so they may
be done in either order. The page closes itself when the signature arrives, then
the script continues on the normal submit path (simulate → `--broadcast --yes` →
assert). Re-launch with `--broadcast --yes` to make it one command end to end.

The page refuses a wrong network or a non-owner account, shows exactly what is
being signed, and never sees a private key.

The script asserts the revoke actually took: after the receipt it reads
`disabledDelegations(hash)` and then re-simulates the redemption, which must
revert with `CannotUseADisabledDelegation`. Both land in the JSON envelope as
`delegationDisabledAfter` and `redemptionBlocked`.

**Why a script and not a page feature:** revoke is a lifecycle operation, not a
setup step. It needs no connect/deploy/approve/fund UI — exactly one wallet
action (approve an EIP-712 message) plus one agent action (submit `handleOps`).
The setup page keeps its focus; this is a sibling of `redeem-delegation.cjs`.

**What the script deliberately does not do:**

- It does **not** fund the EntryPoint — that is a one-time setup step
  (`depositTo`, permissionless). It warns if the deposit is insufficient.
- It does **not** sign with the agent key. The agent has no authority here.
- It does **not** reconstruct the delegation. It consumes the signed JSON and
  fails fast if malformed or if the delegator is not the Hybrid.
- It has **no** local-key signing fallback. The Main key never touches a script.

---

## 1. The mechanism

Revocation is `disableDelegation(delegation)`. Its selector — **compute it, do
not trust this line**:

```bash
cast sig "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"
# → 0x49934047
```

It takes the **full delegation struct including salt and signature**, and sets
`disabledDelegations[getDelegationHash(delegation)] = true`.

**Who may call it:** the contract requires `msg.sender == delegation.delegator`.
Under the Hybrid model the delegator is the **Hybrid contract**, so the Main
EOA cannot call it directly — even though the Main EOA owns the Hybrid. Ownership
is not authority here. Measured, 2026-10-02:

```
from HYBRID 0x433d9b2a (delegator contract)  → NO REVERT
from MAIN   0x61A20dE8 (owner EOA)           → REVERT 0xb9f0f171 (InvalidDelegator)
```

### Revoke vs expiry

| | Mechanism | Timing |
|---|---|---|
| **Revoke** | `disableDelegation` → `disabledDelegations[hash] = true` | immediate, permanent |
| **Expiry** | `TimestampEnforcer` caveat with a `before` bound | at the timestamp, no tx needed |

Expiry is enforced at redemption by the enforcer; revocation is enforced by the
DelegationManager. Both independently stop redemption; a delegation with a
future `before` but no expiry caveat does **not** self-expire.

### Confirming revocation took effect

```bash
HASH=$(cast call $DM "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" "($DELEGATE,$DELEGATOR,$AUTHORITY,[$CAVEATS],$SALT,$SIG)" --rpc-url $RPC)
cast call $DM "disabledDelegations(bytes32)(bool)" $HASH --rpc-url $RPC   # true
```

---

## 2. The Hybrid revoke path — SOLVED via ERC-4337

> **Retraction.** An earlier version of this file concluded the revoke path was
> **blocked**. That was wrong, and it was wrong in the exact way this skill
> documents as its signature failure mode: I grepped minified bytecode for
> **four hand-guessed selector strings** and generalised from the absence. The
> real surface was larger, and a live path existed that I had dismissed.
> Corrected 2026-10-02.

### What the verified ABI actually says

Pull the ABI rather than guessing (45 functions on the Hybrid):

```
0x5c1c6dcd  execute((address,uint256,bytes))            ← NOT 0xb61d27f6
0xe9ae5c53  execute(bytes32,bytes)
0xd691c964  executeFromExecutor(bytes32,bytes)
0x49934047  disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))
```

**Route A — direct owner-execute: FALSIFIED.**
`execute` takes a **tuple**, not positional args, so its selector is
`0x5c1c6dcd`, not the `0xb61d27f6` I tested. It does exist — and it reverts:

```
execute((address,uint256,bytes)) from owner -> REVERT 0xd663742a = NotEntryPoint
```

There is **no** 4-arg authorized-execute in the verified ABI at all
(`execute((address,uint256,bytes,bytes))` = `0x451a404d` is not present, and
probing it returns an empty `0x` identical to a genuinely absent function).
The owner has no direct execute path. **This part of the original finding
survives** — for a reason I had not actually checked.

### Route B — ERC-4337 UserOp: **OPEN** — confirmed 2026-10-02

The original note said "no bundler is deployed on Intuition." True, and
**irrelevant**: `handleOps` is permissionless. No bundler is needed.

```bash
# the script below does this for you     # read-only diagnostic
```

```
selector: 0x220266b6 — FailedOp(uint256,string)
  opCode  = 0
  reason  = "AA24 signature error"
```

**Read that carefully — it is a pass, not a failure.** EntryPoint v0.7 runs
`validateUserOp` *before* checking the signature, and the Hybrid's
`_validateUserOpSignature` does not revert on a bad signature: from the verified
source,

```solidity
// DeleGatorCore.sol
function validateUserOp(...) external onlyEntryPoint onlyProxy returns (uint256 validationData_) {
    validationData_ = _validateUserOpSignature(_userOp, getPackedUserOperationTypedDataHash(_userOp));
    _payPrefund(_missingAccountFunds);
}
// HybridDeleGator.sol — returns a magic value, never reverts
function _isValidSignature(bytes32 _hash, bytes calldata _signature) internal view returns (bytes4) {
    if (_signature.length == 65) {
        if (ECDSA.recover(_hash, _signature) == owner()) return 0x1626ba7e;  // valid
        return 0xffffffff;                                                    // invalid
    }
    ...
}
```

So `AA24` means `validationData == 1` — **the account evaluated the UserOp and
accepted it.** The only missing element is Main's signature. Had the account
refused the op, the revert would have been `AA23` from inside `validateUserOp`
instead.

**⇒ The ERC-4337 revoke path exists. The mission acceptance test
(`create → write → revoke → blocked`) is satisfiable.**

#### Why this works

`disableDelegation` requires `msg.sender == delegator` (the Hybrid). A direct
call from Main gets `InvalidDelegator`. But `DeleGatorCore.execute(...)` is
gated `onlyEntryPoint`, and inside it the Hybrid is the caller:

```
EntryPoint.handleOps
  └─ Hybrid.execute((target=DelegationManager, 0, disableDelegation(...)))
       └─ DelegationManager.disableDelegation(...)   msg.sender = Hybrid ✓
```

The authority is the owner's signature over the UserOp; the *identity* at
MultiVault is the Hybrid. Exactly the delegation model, routed through 4337.

#### Steps to execute it

1. Fund the EntryPoint (permissionless — anyone may):
   ```bash
   cast send 0x0000000071727De22E5E9d8BAf0edAc6f37da032 "depositTo(address)" \
     0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14 --value 0.05ether --private-key <agentKey>
   ```
2. Main signs the EIP-712 digest (from `eip712Domain()` on the Hybrid itself):
   ```
   domain  : { name:"HybridDeleGator", version:"1", chainId:13579,
               verifyingContract: 0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14 }
   message : PackedUserOperation (sender, nonce, initCode, callData,
             accountGasLimits, preVerificationGas, gasFees, paymasterAndData, signature)
   ```
   A 65-byte ECDSA sig from `owner()` is accepted (`ECDSA.recover(...) == owner()`).
3. Submit: `EP.handleOps([op], beneficiary)` from any funded account.
4. Confirm the revoke, then re-run the redemption probe:
   ```bash
   node templates/redeem-delegation.cjs signed.json --op deposit --term 0x… --amount 0.001
   # expect CannotUseADisabledDelegation (0x05baa052)
   ```

> **Signing trap:** the signer is the **owner** (`0x61A20dE8…`), not the
> delegator. This is the same internal-account confusion as the delegation
> signing itself, inverted.

> **A gas gotcha that fakes a failure:** `accountGasLimits` is
> `verificationGasLimit (HIGH 128 bits) ‖ callGasLimit (LOW 128 bits)`. Pack it
> backwards and `verificationGasLimit = 0`, so `validateUserOp` runs out of gas
> and the EntryPoint reports a misleading `AA23 reverted` with an empty inner
> revert — indistinguishable from a real account rejection unless you know this.

#### Status

Route A (direct owner-execute): **falsified** — `execute` is `onlyEntryPoint`.
Route B (ERC-4337): **open**, proven to the signature gate. The remaining work is
mechanical, not investigative: fund, sign, submit.

### Re-verify

```bash
# see §2 — Route A, already falsified     # read-only; no state change
```

---

## 3. Output contract — revoke transaction

When a working path exists, the transaction is:

| Field | Value |
|---|---|
| `to` | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` (DelegationManager) |
| `data` | `0x49934047` ‖ abi.encode(delegation) |
| `from` | must equal `delegation.delegator` |
| `value` | `0` |

Success is `status: 0x1` and `disabledDelegations[hash] == true`.

### Blocked-write confirmation

After a successful revoke, redeeming reverts with
`CannotUseADisabledDelegation()` = `0x05baa052`:

```bash
node templates/redeem-delegation.cjs signed.json --op create-atom
# → decision: "halt", CannotUseADisabledDelegation
```

This is the read-only proof that revocation actually bites — simulate, do not
broadcast a transaction you expect to revert.

---

## 4. Verify the selectors and errors cited here

```bash
cast sig "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"  # 0x49934047
cast sig "enableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"  # 0x3ed01015
cast sig "CannotUseADisabledDelegation()"   # 0x05baa052
cast sig "InvalidDelegator()"                # 0xb9f0f171
cast sig "NotDelegationManager()"            # 0x1a4b3a04

cast code $DM --rpc-url $RPC | grep -i 49934047   # present on both chains
```

---

---

## Proven on-chain (2026-10-02) — the full lifecycle

```
revoke tx      : 0x800ea966438dc15829c7e4314bd3725b7e98c21327d417363d3c7e34b4a7c5dd  (64 chars)
block          : 9370929        status: 0x1        gas: 165,896
from           : 0xe9BfdEC6Fa795a24e3069292248d9d16570E050d   (agent — pays gas, holds no authority)
to             : 0x0000000071727De22E5E9d8BAf0edAc6f37da032   (canonical ERC-4337 v0.7 EntryPoint)
owner signature: 0xd3188725…1f21c  recovered signer 0x61A20dE8… == Hybrid owner
EIP-712 digest : 0x6885c254ff6f132b66140f98bf955e8268e41bfa82b306d8f7794124fed5876a
delegationHash : 0x3fc5a2a19c85eb6f43f4736705a5d86aecd5ed2a045741ff9ddd8ef475c1399e
```

Independently re-verified after the fact (not read from the script's own report):

| Check | Result |
|---|---|
| `cast receipt <tx> status` | `true` |
| `disabledDelegations(0x3fc5a2a1…)` on the DelegationManager | **`true`** |
| `Hybrid.isDelegationDisabled(0x3fc5a2a1…)` | **`true`** |
| `Hybrid.getNonce(0)` | `1` (was `0` — the UserOp was consumed) |
| redemption attempt against the revoked delegation | **reverts `0x05baa052`** = `CannotUseADisabledDelegation()` |

**This closes the mission acceptance test** — `create delegation → submit write as
delegate → revoke → confirm the write is blocked` — on the Hybrid architecture,
for the first time. The Sept-24 proof was Path 2 and does not establish this.

### The route, in one line

```
Main (owner) signs a UserOp
  → EP.handleOps (permissionless, no bundler)
    → Hybrid.execute((DelegationManager, 0, disableDelegation(delegation)))
      → DM sees msg.sender == delegator  ✓
```

Authority is the owner's signature; the on-chain identity is the Hybrid. That is
the delegation model expressed through ERC-4337, and it is why "ownership is not
authority" is not a dead end — it just needs the 4337 route.

---

## Two corrections to the obvious first design

Both were caught against the deployed contract, not assumed.

**1. `execute` takes a TUPLE, not positional args.**

```bash
cast sig "execute((address,uint256,bytes))"        # → 0x5c1c6dcd   ← this one
cast sig "execute(address,uint256,bytes,bytes)"   # → 0x451a404d   ← NOT on this contract
```

There is **no 4-arg `execute`** in the deployed ABI, so
`execute(DM, 0, disableDelegation(...), '0x')` is a fabricated selector — it
hits the fallback and reverts with no reason. Use
`execute({ target, value, callData })`.

**2. The nonce comes from the Hybrid, not the EntryPoint.**

```bash
cast call $HYBRID "getNonce(uint192)(uint256)" 0    # ← correct
```

`entryPoint.getNonce(Hybrid, 0)` is a v0.6 signature; the v0.7 EntryPoint does
not expose it that way.

---

## Related

- `reference/delegation.md` — the model and the struct anatomy
- `operations/create-delegation.md` — producing the delegation being revoked
- `reference/delegation-authority.md` — checking revocation as part of a decision
- `templates/redeem-delegation.cjs` — the redemption executor

## The loop closes here

Once the delegation is revoked, a redemption reverts with
**`0x05baa052` = `CannotUseADisabledDelegation()`**:

```bash
node templates/redeem-delegation.cjs <signed.json> --op deposit --term 0x… --amount 0.001
# decision: "halt" — CannotUseADisabledDelegation
```

That is the fourth step of the check in `reference/delegation-authority.md`
(step 4, *check revocation*): the agent now sees the delegation is dead and
returns `reject`. Revocation is complete when redemption is blocked.
