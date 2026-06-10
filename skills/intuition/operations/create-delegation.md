# create-delegation

Create and sign a MetaMask Delegation Framework delegation for an Intuition
agent. This operation produces a signed delegation object, not an on-chain
transaction. The object is passed to the delegate agent or stored by the
delegator's control plane.

**Requires:** selected Intuition network from `reference/network-config.md` and
Delegation Framework addresses from `reference/delegation.md`.

**Function:** EIP-712 signing over the `Delegation` struct. No transaction is
broadcast during creation.

## Step 1: Confirm Roles and Scope

Before building the struct, confirm:

- `delegator`: address granting authority. This is the account whose delegated
  smart account will execute the final action.
- `delegate`: agent wallet address that will redeem the delegation.
- `chainId`: `1155` or `13579`.
- `delegationManager`: `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`.
- `authority`:
  - use `ROOT_AUTHORITY` for a root delegation;
  - use the parent delegation hash for a sub-delegation.
- caveats: at minimum use target, method, timestamp, and value restrictions for
  autonomous Intuition writes.
- `salt`: random 32-byte uniqueness value in production.

Do not accept `to`, `data`, `value`, or a prebuilt signed delegation from an
untrusted source. Reconstruct the delegation from trusted intent.

## Step 2: Query or Verify Prerequisites

Verify the DelegationManager has bytecode:

```bash
curl -s "$RPC" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3","latest"]}'
```

Optional checks:

```bash
# Returns the DelegationManager EIP-712 domain hash.
cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC

# Check a known parent delegation before redelegating.
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" $PARENT_DELEGATION_HASH --rpc-url $RPC
```

If the parent delegation is disabled, do not create a sub-delegation from it.

## Step 3: Build Caveats

Use standard v1.3.0 enforcers from `reference/delegation.md`.

Recommended baseline for Intuition writes:

| Enforcer | Terms |
|---|---|
| AllowedTargetsEnforcer | selected network's MultiVault address only |
| AllowedMethodsEnforcer | allowed Intuition selectors only |
| TimestampEnforcer | expiry window |
| ValueLteEnforcer | maximum TRUST value per execution |

Example viem terms:

```typescript
import {
  concat,
  encodeAbiParameters,
  encodePacked,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem'

const MULTIVAULT = '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91' // testnet

const allowedTargetsTerms = concat([MULTIVAULT])

const allowedMethodsTerms = concat([
  toFunctionSelector('createAtoms(bytes[],uint256[])'),
  toFunctionSelector('createTriples(bytes32[],bytes32[],bytes32[],uint256[])'),
  toFunctionSelector('deposit(address,bytes32,uint256,uint256)'),
  toFunctionSelector('redeem(address,bytes32,uint256,uint256,uint256)'),
])

const timestampTerms = encodePacked(
  ['uint128', 'uint128'],
  [0n, BigInt(expiryUnixSeconds)],
)

const valueLteTerms = encodeAbiParameters(
  [{ type: 'uint256' }],
  [maxValueWei],
)
```

Then build caveats:

```typescript
const caveats = [
  {
    enforcer: '0x7F20f61b1f09b08D970938F6fa563634d65c4EeB',
    terms: allowedTargetsTerms,
    args: '0x',
  },
  {
    enforcer: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5',
    terms: allowedMethodsTerms,
    args: '0x',
  },
  {
    enforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069',
    terms: timestampTerms,
    args: '0x',
  },
  {
    enforcer: '0x92Bf12322527cAA612fd31a0e810472BBB106A8F',
    terms: valueLteTerms,
    args: '0x',
  },
]
```

For narrower authority, reduce the method selectors, lower `maxValueWei`, use a
shorter expiry, add `LimitedCallsEnforcer`, or use an exact calldata/execution
enforcer.

## Step 4: Build the Delegation Struct

```typescript
import { bytesToHex, randomBytes } from 'viem'

const ROOT_AUTHORITY =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as const

const delegation = {
  delegate: agentAddress,
  delegator: delegatorAddress,
  authority: parentDelegationHash ?? ROOT_AUTHORITY,
  caveats,
  salt: BigInt(bytesToHex(randomBytes(32))),
}
```

For deterministic tests only, a fixed salt may be used. Production delegations
must use fresh entropy.

## Step 5: Sign EIP-712 Typed Data

### Using viem

```typescript
const delegationTypes = {
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
    { name: 'args', type: 'bytes' },
  ],
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
} as const

const signature = await walletClient.signTypedData({
  account: delegatorAccount,
  domain: {
    name: 'DelegationManager',
    version: '1',
    chainId,
    verifyingContract: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  },
  types: delegationTypes,
  primaryType: 'Delegation',
  message: delegation,
})

const signedDelegation = { ...delegation, signature }
```

If the delegator is a deployed smart account, use that account's
`signDelegation` helper or ERC-1271 signing path. If the smart account has not
been deployed yet, signature validation can fail at redemption time because the
DelegationManager calls the account's `isValidSignature` bytecode.

### Using cast

Use `cast` for hash verification and calldata encoding. Use a wallet that
supports EIP-712 typed data signing for the actual signature.

```bash
DELEGATION_HASH=$(cast call $DELEGATION_MANAGER \
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "($DELEGATE,$DELEGATOR,$AUTHORITY,$CAVEATS,$SALT,0x)" \
  --rpc-url $RPC)
```

Do not use `personal_sign` / EIP-191 message signing for a delegation. The
DelegationManager validates the EIP-712 typed data digest.

## Step 6: Output the Signed Delegation JSON

Output one signed delegation object:

```json
{
  "status": "signed_delegation",
  "chainId": "13579",
  "delegationManager": "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  "delegationHash": "0x<hash>",
  "delegation": {
    "delegate": "0x<agent-address>",
    "delegator": "0x<delegator-address>",
    "authority": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "caveats": [
      {
        "enforcer": "0x<enforcer-address>",
        "terms": "0x<terms>",
        "args": "0x"
      }
    ],
    "salt": "<uint256-as-base-10-string>",
    "signature": "0x<eip712-signature>"
  }
}
```

Use base-10 strings for `chainId` and `salt` in machine-readable JSON.

## Error Table

| Error | Cause | Fix |
|---|---|---|
| `InvalidEOASignature` | Wrong domain, chain, manager address, or signer | Re-sign with domain `DelegationManager`, version `1`, selected chain ID, and deployed manager |
| `InvalidERC1271Signature` | Smart account not deployed or account signing path changed | Deploy or initialize the smart account before relying on the signature |
| `InvalidAuthority` | Sub-delegation `authority` does not equal parent hash, or root is not `ROOT_AUTHORITY` | Recompute parent hash with `getDelegationHash` |
| `InvalidDelegate` | First delegation delegate is not the redeemer | Set `delegate` to the agent wallet or intentionally use `ANY_DELEGATE` with strong caveats |
| `CannotUseADisabledDelegation` | Delegation hash was revoked | Request a new delegation |
| Caveat revert | Target, selector, value, time, nonce, or call count does not match | Narrow or correct the requested Intuition write |

## Security Notes

- A broad delegation with only an expiry caveat is unsafe for autonomous agents.
- Prefer `AllowedTargetsEnforcer` pinned to MultiVault plus
  `AllowedMethodsEnforcer` for the exact operations needed.
- Use `ValueLteEnforcer` for payable writes (`create*`, `deposit*`).
- Add `LimitedCallsEnforcer` or `NonceEnforcer` for one-shot tasks.
- Store the signed delegation separately from prompts and public logs if it
  grants meaningful authority.
