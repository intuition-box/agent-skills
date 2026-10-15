# UX Patterns for Intuition Operations

> **Status:** MANDATORY — these patterns apply to every Intuition operation
> (read or write, any path). They prevent users from getting stuck,
> rebuilding already-completed steps, or missing documented requirements.

---

## 1. Pre-Task Context Check (MANDATORY)

Before executing ANY Intuition operation, run these checks **in order**:

### Step 1: Read Session Context

Check for setup notes, prior session state, and planned workflows:

- Read `reference/operator-supplied session notes` if it exists (session-specific constants, agent wallet, planned workflow)
- Use `session_search` to find prior Intuition work if no setup notes exist
- **Report what you found to the user BEFORE building anything**

### Step 2: Check Delegation State

For Path C operations, check if a valid delegation already exists:

- Read `~/.intuition/agent-wallet.json` (mode 0600) and any signed-delegation JSON files
- Check `disabledDelegations(hash)` on-chain for any cached delegation hashes
- **If a valid unexpired delegation exists, SKIP straight to execution** — do not ask the user to re-sign

### Step 3: State the Plan

Tell the user:
- What you found in prior session context (planned steps, addresses, constants)
- What's already done vs. what remains
- Which path (A/B/C) and why
- What you need from them (network choice, browser MetaMask for one-time signing, confirmation)

### Skipping these checks causes:
- Missing prior context
- Rebuilding already-completed steps
- Skipping documented requirements
- Asking the user to sign when a valid delegation already exists

---

## 2. Browser Signing Pattern (MANDATORY for Path C)

When Path C requires a new delegation, **guide the user to sign in their browser
via MetaMask**. Never ask for or accept the Main Account private key.

### Why Browser MetaMask Signing Is Correct (not a fallback)

The Path C delegator is a **Hybrid Smart Account** (a contract deployed via
CREATE2 from SimpleFactory), NOT an EIP-7702 upgraded EOA. The Main Account
(owned by the user in MetaMask) is an ordinary EOA that signs EIP-712 typed
data via the MetaMask `eth_signTypedData_v4` popup in the browser.

| Method | Works for Path C? | Notes |
| `eth_signTypedData_v4` (MetaMask browser popup) | YES | Canonical. Works on desktop + mobile. The demo (tx `0x56c6d3e0`) proves MetaMask mobile signs correctly. |
| `eth_sign` / `personal_sign` | NO | Deprecated or adds wrong prefix. |
| Local `ethers.SigningKey` with exported key | NO | Debugging/verification only (TESTING.md §B). NEVER export the Main key. |

The `0xffffffff` ERC-1271 result is NOT evidence that MetaMask corrupts
digests — it means the typed-data construction has a typehash/encoding mismatch
(B1: 2-field vs 3-field Caveat). Fix the page, not the signing path. See
the signing-bug notes (not shipped) and the signing-bug notes (not shipped).

### Delegation Re-Use After Setup

After the one-time browser signing, the delegation is **cached and re-used by
the agent** for all subsequent operations until revoked. The user never needs
to sign again unless:
- The delegation expires (if an expiry caveat was set)
- The delegation is revoked
- The operation scope changes (new methods, higher spend cap)

### Browser Signing Steps

1. Open `templates/sign-delegation.html` in a browser (serve via
   `python3 -m http.server 8000` from the `templates/` dir if needed).
2. Connect MetaMask → select the Main Account EOA (owner of the Hybrid).
3. The page deploys/approves/funds the Hybrid via MetaMask popups (if not
   already done).
4. Click "Sign Delegation" → MetaMask `eth_signTypedData_v4` popup appears.
5. The page verifies on-chain (`isValidSignature → 0x1626ba7e`) before
   accepting and emits the signed-delegation JSON.
6. Save the JSON to `~/.intuition/agent-wallet.json` (chmod 600).

### Rules

- **NEVER** ask the user for their private key — guide them to the browser
  signing page (`templates/sign-delegation.html`) and have them click through
  the MetaMask popup.
- **NEVER** store the Main Account key to disk. Only `~/.intuition/agent-wallet.json`
  (the agent's OWS wallet) may persist a private key — and only the delegate key.
- **ALWAYS** explain that the Main key stays in MetaMask — the signing page
  constructs typed-data, MetaMask hashes and signs it internally, and the
  page verifies the result on-chain before accepting.
- **ALWAYS** confirm: "Delegation signed via MetaMask popup. The Main key
  never left your browser. The signed delegation JSON is cached for future
  operations. A new browser signing will be needed if this delegation is
  revoked, expires, or needs a scope change."

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

---

## 6. Common Roadblocks & Solutions (MANDATORY)

These issues were encountered during real validation of this skill. Check this section before debugging any failed operation.

### 6.1 Private Key Masking in Execution Environments

**Problem:** Some execution environments (Hermes, certain CI systems) mask private keys with `***` in output, logs, and sometimes in files. This causes "invalid BytesLike value" or "Failed to decode private key" errors.

**Solutions:**
- Pass private keys via environment variables at runtime: `PRIVATE_KEY="0x..." node script.js`
- Read private keys from files at runtime (write the file immediately before use, delete after)
- Never hardcode private keys in scripts that may be logged or stored
- Use `cast wallet import` to create a keystore file instead of raw private keys

### 6.2 Address Checksum Errors

**Problem:** ethers.js requires EIP-55 checksummed addresses. Using lowercase or incorrectly checksummed addresses causes "bad address checksum" errors.

**Solution:** Always use `ethers.getAddress(address)` to checksum addresses before use:
```javascript
const checksummed = ethers.getAddress('0x2c21fd0cb9dc8445cb3fb0dc5e7bb0aca01842b5');
// Returns: 0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5
```

**Common addresses (pre-checksummed):**
- AllowedMethodsEnforcer: `0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5`
- LimitedCallsEnforcer: `0x04658B29F6b82ed55274221a06Fc97D318E25416`
- ValueLteEnforcer: `0x92bf12322527caa612fd31a0e810472bbb106a8f` (NOT `0xA9BC…` — that is NativeTokenTransferAmountEnforcer, undeployed)
- DelegationManager: `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`

### 6.3 `isApprovedFor` Not on Testnet

**Problem:** Calling `isApprovedFor(address,address)` on testnet MultiVault reverts with `require(false)` because the function doesn't exist on testnet.

**Solution:** On testnet, always call `approve(SmartWallet, 3)` directly without a pre-check. The call is idempotent — if approval already exists, it succeeds silently.

### 6.4 ROOT_AUTHORITY and MODE_DEFAULT Byte Length

**Problem:** `ROOT_AUTHORITY` and `MODE_DEFAULT` must be exactly 32 bytes (64 hex chars). Using a shorter or longer value causes silent reverts in `redeemDelegations`.

**Correct values:**
```javascript
const ROOT_AUTHORITY=*** + "f".repeat(64); // 0x + 64 Fs = 66 chars
const MODE_DEFAULT = "0x" + "0".repeat(64); // 0x + 64 zeros = 66 chars
```

**Verification:** Both values must have `.length === 66` (including `0x` prefix).

### 6.5 Array Length Mismatch in `createTriples`

**Problem:** `createTriples` takes 4 parallel arrays: `subjectIds[]`, `predicateIds[]`, `objectIds[]`, `assets[]`. All must have the same length. A mismatch causes `MultiVault_ArraysNotSameLength`.

**Solution:** Always verify array lengths match before calling:
```javascript
if (subjectIds.length !== predicateIds.length || 
    subjectIds.length !== objectIds.length || 
    subjectIds.length !== assets.length) {
  throw new Error('Array length mismatch');
}
```

### 6.6 Different Costs for Atoms vs Triples

**Problem:** `getAtomCost()` and `getTripleCost()` return different values. Using the wrong cost causes `MultiVault_InsufficientBalance`.

**Solution:** Always query the correct cost function for the operation:
```javascript
const atomCost = await provider.call(MULTIVAULT, "getAtomCost()(uint256)");
const tripleCost = await provider.call(MULTIVAULT, "getTripleCost()(uint256)");
```

**Typical values (query on-chain to confirm):**
- Atom cost: ~1.000000001 tTRUST
- Triple cost: ~1.000000002 tTRUST

### 6.7 `enableDelegation` Is Optional

**Problem:** Calling `enableDelegation` is NOT required for the standard signature-based flow. It's an optional caching alternative.

**Solution:** Skip `enableDelegation` entirely. The delegation is validated by signature at redemption time.

### 6.8 EIP-7702 Upgrade Commands

**Problem:** Upgrading a wallet to EIP-7702 requires the implementation address directly, NOT the `0xef0100...` prefix.

**Correct command:**
```bash
cast send $OWS_ADDRESS --auth $EIP7702_IMPLEMENTATION --private-key $OWS_PK
```

**Verification:**
```bash
cast code $OWS_ADDRESS
# Should return: 0xef0100<implementation-address>
```

### 6.9 Funding Requirements for OWS

**Problem:** The OWS needs sufficient tTRUST for both creation costs AND gas. Running out of tTRUST causes reverts mid-operation.

**Funding guidelines:**
- Per atom creation: ~1 tTRUST (creation cost) + gas
- Per triple creation: ~1 tTRUST (creation cost) + gas
- Per deposit: deposit amount + gas
- Recommended minimum: 2-3 tTRUST for a full creation session

### 6.10 Revocation vs Expiry

**Problem:** Revoked delegations cannot be re-enabled. They are permanently dead.

**Solution:** Use expiry caveats instead of revocation when possible. If revocation is needed, create a new delegation with a new salt afterward.

### 6.11 Triple Already Exists

**Problem:** `createTriples` reverts with `MultiVault_TripleExists` if the triple already exists (same subject+predicate+object combination).

**Solution:** Check existence before creating:
```javascript
const tripleId = await provider.call(MULTIVAULT, "calculateTripleId(bytes32,bytes32,bytes32)...", [s, p, o]);
const exists = await provider.call(MULTIVAULT, "isTermCreated(bytes32)...", [tripleId]);
if (exists) {
  // Triple already exists, use existing ID
}
```

### 6.12 `execCallData` Encoding

**Problem:** `execCallData` must use `solidityPacked(['address','uint256','bytes'], ...)`, NOT `abi.encode`. Using `abi.encode` places the inner calldata at byte 0x80+ where `decodeSingle` reads garbage, causing `method-not-allowed` errors even with correct caveat terms.

**Correct encoding:**
```javascript
const execCallData = ethers.solidityPacked(
  ['address', 'uint256', 'bytes'],
  [MULTIVAULT, value, innerCalldata]
);
```

### 6.13 `disableDelegation` Field Order

**Problem:** `disableDelegation` uses the standard MetaMask struct field order `(delegate, delegator, ...)`. Using reversed order causes `InvalidDelegator()`.

**Correct order:**
```javascript
// disableDelegation takes: (delegate, delegator, authority, caveats, salt, signature)
const calldata = iface.encodeFunctionData("disableDelegation", [[
  delegation.delegate,    // FIRST
  delegation.delegator,   // SECOND
  delegation.authority,
  delegation.caveats,
  BigInt(delegation.salt),
  delegation.signature
]]);
```

---

## 7. Pre-Flight Checklist (Before Every Delegated Write)

1. ✓ Network selected (mainnet 1155 / testnet 13579)
2. ✓ Domain hash read from-chain via `getDomainHash()`
3. ✓ Delegation signature verified (recovered address === delegator)
4. ✓ `ROOT_AUTHORITY` is exactly 66 chars (0x + 64 Fs)
5. ✓ `MODE_DEFAULT` is exactly 66 chars (0x + 64 zeros)
6. ✓ Array lengths match (for batch/triple operations)
7. ✓ Correct cost queried (`getAtomCost` vs `getTripleCost`)
8. ✓ Sufficient tTRUST balance for operation + gas
9. ✓ `execCallData` uses `solidityPacked` (not `abi.encode`)
10. ✓ Caveat terms use correct encoding (raw bytes4 for methods, `abi.encode(uint256)` for limits)
