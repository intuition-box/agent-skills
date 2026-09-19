# Off-Chain Delegation Hashing

Complete reference for computing delegation hashes and EIP-712 digests off-chain. The DelegationManager does not expose these functions on-chain — all hashing must be done in your agent runtime or signing environment.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Core Concepts](#core-concepts)
- [Compute Delegation Hash](#compute-delegation-hash)
  - [Using MetaMask SDK (Recommended)](#using-metamask-sdk-recommended)
  - [Using viem (Manual)](#using-viem-manual)
  - [Using ethers v6](#using-ethers-v6)
- [Compute EIP-712 Digest](#compute-eip-712-digest)
  - [Using MetaMask SDK (Recommended)](#using-metamask-sdk-recommended-1)
  - [Using viem (Manual)](#using-viem-manual-1)
  - [Manual Digest Construction](#manual-digest-construction)
- [Compute Caveats Hash](#compute-caveats-hash)
- [Compute Domain Separator](#compute-domain-separator)
- [Verification](#verification)
- [TypeScript Type Definitions](#typescript-type-definitions)
- [Command-Line Utilities](#command-line-utilities)
- [Error Patterns](#error-patterns)
- [Protocol Invariants](#protocol-invariants)
- [Quick Reference](#quick-reference)

---

## Prerequisites

| Tool | Purpose | Installation |
|---|---|---|
| `@metamask/smart-accounts-kit` | Delegation hashing utilities | `npm install @metamask/smart-accounts-kit` |
| `viem` | Low-level encoding and hashing | `npm install viem` |
| `ethers v6` | Alternative encoding | `npm install ethers` |
| `cast` (Foundry) | CLI encoding/decoding | `foundryup` |

---

## Core Concepts

The DelegationManager uses a fixed EIP-712 domain. **Read the domain
separator from-chain via `getDomainHash()` and use that value directly in
the signing digest. Do not reconstruct the domain separator from guessed
`name`/`version` literals.**

```typescript
const DOMAIN = {
  name: 'DelegationManager',
  version: '1',
  chainId: CHAIN_ID,        // 1155 (mainnet) or 13579 (testnet)
  verifyingContract: DELEGATION_MANAGER_ADDRESS, // 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
}
```

```bash
# Read the real domain separator
cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC
```

```typescript
const domainHash = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function getDomainHash() view returns (bytes32)']),
  functionName: 'getDomainHash',
})
```

> **Standard MetaMask pattern:** The Delegation struct uses `(delegate, delegator,
> authority, caveats, salt)` — the canonical upstream MetaMask Delegation
> Framework order from `Types.sol`. All typehash strings, EIP-712 types, and
> on-chain calls MUST use this order:
> `Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)`.
>
> **Important:** The signature field is excluded from the hash. The signed message includes all fields except the signature itself.

---

## Compute Delegation Hash

The delegation hash is the EIP-712 struct hash of the delegation fields
excluding `signature`. **Prefer reading it from-chain via `getDelegationHash()`**
to avoid encoding mismatches. If you must compute it off-chain, follow the
standard EIP-712 algorithm below exactly.

### Using MetaMask SDK (Recommended)

```typescript
import { getDelegationHash } from '@metamask/smart-accounts-kit'

function computeDelegationHash(delegation: Delegation): `0x${string}` {
  return getDelegationHash(delegation)
}

// Usage
const delegationHash = computeDelegationHash({
  delegator: '0x1234...',
  delegate: '0x5678...',
  authority: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  caveats: [
    { enforcer: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5', terms: '0x...', args: '0x' }
  ],
  salt: 123n,  // uint256
  signature: '0x...', // excluded from hash
})
```

### Using viem (Manual — Standard EIP-712)

```typescript
import { keccak256, encodeAbiParameters, parseAbiParameters, concat, toBytes } from 'viem'

// EIP-712 type hashes
const DELEGATION_TYPE_HASH = keccak256(
  encodeAbiParameters(parseAbiParameters('string'), [
    'Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)',
  ])
)
const CAVEAT_TYPE_HASH = keccak256(
  encodeAbiParameters(parseAbiParameters('string'), [
    'Caveat(address enforcer,bytes terms,bytes args)',
  ])
)

function hashCaveat(caveat: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, address, bytes32, bytes32'),
      [
        CAVEAT_TYPE_HASH,
        keccak256(encodeAbiParameters(parseAbiParameters('address'), [caveat.enforcer])),
        keccak256(caveat.terms),
        keccak256(caveat.args),
      ]
    )
  )
}

function hashCaveatsArray(caveats: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }[]): `0x${string}` {
  if (caveats.length === 0) {
    // EIP-712 empty array = keccak256(empty bytes)
    return keccak256('0x')
  }
  const encoded = concat(caveats.map(c => hashCaveat(c)))
  return keccak256(encoded)
}

function computeDelegationHash(delegation: {
  delegate: `0x${string}`
  delegator: `0x${string}`
  authority: `0x${string}`
  caveats: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }[]
  salt: bigint
}): `0x${string}` {
  const structHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, address, address, bytes32, bytes32, uint256'),
      [
        DELEGATION_TYPE_HASH,
        delegation.delegate,
        delegation.delegator,
        delegation.authority,
        hashCaveatsArray(delegation.caveats),
        delegation.salt,
      ]
    )
  )
  return structHash
}
```

> **Warning:** Do NOT use `keccak256(abi.encode(delegation))` or
> `keccak256(abi.encode((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)))`.
> Standard ABI tuple encoding includes `signature` and uses raw tuple encoding
> for `caveats[]`, neither of which matches EIP-712 struct hashing. The
> result will NOT match on-chain `getDelegationHash()`.

### Using ethers v6

```typescript
import { keccak256, defaultAbiCoder, toUtf8Bytes } from 'ethers'

const DELEGATION_TYPE_HASH = keccak256(toUtf8Bytes('Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)'))
const CAVEAT_TYPE_HASH = keccak256(toUtf8Bytes('Caveat(address enforcer,bytes terms,bytes args)'))

function hashCaveat(caveat: { enforcer: string; terms: string; args: string }): string {
  return keccak256(
    defaultAbiCoder.encode(
      ['bytes32', 'address', 'bytes32', 'bytes32'],
      [
        CAVEAT_TYPE_HASH,
        keccak256(defaultAbiCoder.encode(['address'], [caveat.enforcer])),
        keccak256(caveat.terms),
        keccak256(caveat.args),
      ]
    )
  )
}

function hashCaveatsArray(caveats: { enforcer: string; terms: string; args: string }[]): string {
  if (caveats.length === 0) {
    // EIP-712 empty array = keccak256(empty bytes)
    return keccak256('0x')
  }
  const concatenated = caveats.map(c => hashCaveat(c)).join('').slice(2)
  return keccak256('0x' + concatenated)
}

function computeDelegationHash(delegation: {
  delegate: string
  delegator: string
  authority: string
  caveats: { enforcer: string; terms: string; args: string }[]
  salt: bigint
}): string {
  return keccak256(
    defaultAbiCoder.encode(
      ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
      [
        DELEGATION_TYPE_HASH,
        delegation.delegate,
        delegation.delegator,
        delegation.authority,
        hashCaveatsArray(delegation.caveats),
        delegation.salt,
      ]
    )
  )
}
```

---

## Compute EIP-712 Digest

### Using MetaMask SDK (Recommended)

```typescript
import { hashTypedDataForDelegation } from '@metamask/smart-accounts-kit'

function computeEIP712Digest(
  delegation: Delegation,
  chainId: number,
  delegationManagerAddress: `0x${string}`
): `0x${string}` {
  return hashTypedDataForDelegation(
    delegation,
    chainId,
    delegationManagerAddress
  )
}

// Usage
const digest = computeEIP712Digest(delegation, 13579, '0xdb9B1e94...')
```

### Using viem (Manual)

```typescript
import { hashTypedData } from 'viem'

function computeEIP712Digest(
  delegation: {
    delegator: `0x${string}`
    delegate: `0x${string}`
    authority: `0x${string}`
    caveats: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }[]
    salt: bigint
  },
  chainId: number,
  delegationManagerAddress: `0x${string}`
): `0x${string}` {
  return hashTypedData({
    domain: {
      name: 'DelegationManager',
      version: '1',
      chainId,
      verifyingContract: delegationManagerAddress,
    },
    types: {
      Delegation: [
        { name: 'delegate', type: 'address' },
        { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' },
        { name: 'caveats', type: 'Caveat[]' },
        { name: 'salt', type: 'uint256' },
      ],
      Caveat: [
        { name: 'enforcer', type: 'address' },
        { name: 'terms', type: 'bytes' },
        { name: 'args', type: 'bytes' },
      ],
    },
    primaryType: 'Delegation',
    message: {
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      authority: delegation.authority,
      caveats: delegation.caveats,
      salt: delegation.salt,
    },
  })
}
```

### Manual Digest Construction

If you need the raw components, read the domain separator from-chain and compute the struct hash off-chain using standard EIP-712:

```typescript
import { keccak256, encodeAbiParameters, parseAbiParameters, concat, toBytes } from 'viem'

function computeStructHash(delegation: {
  delegate: `0x${string}`
  delegator: `0x${string}`
  authority: `0x${string}`
  caveats: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }[]
  salt: bigint
}): `0x${string}` {
  const DELEGATION_TYPE_HASH = keccak256(
    encodeAbiParameters(parseAbiParameters('string'), [
      'Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)',
    ])
  )

  const CAVEAT_TYPE_HASH = keccak256(
    encodeAbiParameters(parseAbiParameters('string'), [
      'Caveat(address enforcer,bytes terms,bytes args)',
    ])
  )

  function hashCaveat(caveat: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }): `0x${string}` {
    return keccak256(
      encodeAbiParameters(
        parseAbiParameters('bytes32, address, bytes32, bytes32'),
        [
          CAVEAT_TYPE_HASH,
          keccak256(encodeAbiParameters(parseAbiParameters('address'), [caveat.enforcer])),
          keccak256(caveat.terms),
          keccak256(caveat.args),
        ]
      )
    )
  }

  function hashCaveatsArray(caveats: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }[]): `0x${string}` {
    if (caveats.length === 0) {
      return keccak256(encodeAbiParameters(parseAbiParameters('uint256'), [0n]))
    }
    const encoded = concat(caveats.map(c => hashCaveat(c)))
    return keccak256(encoded)
  }

  const structHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, address, address, bytes32, bytes32, uint256'),
      [
        DELEGATION_TYPE_HASH,
        delegation.delegate,
        delegation.delegator,
        delegation.authority,
        hashCaveatsArray(delegation.caveats),
        delegation.salt,
      ]
    )
  )

  return structHash
}

function computeEIP712DigestManual(
  delegation: {
    delegate: `0x${string}`
    delegator: `0x${string}`
    authority: `0x${string}`
    caveats: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }[]
    salt: bigint
  },
  chainId: number,
  delegationManagerAddress: `0x${string}`
): `0x${string}` {
  // Read domain separator from-chain — do not guess it
  const DOMAIN_HASH = await client.readContract({
    address: delegationManagerAddress,
    abi: parseAbi(['function getDomainHash() view returns (bytes32)']),
    functionName: 'getDomainHash',
  })

  const structHash = computeStructHash(delegation)

  // EIP-712: 0x1901 || domainSeparator || structHash
  return keccak256(concat([toBytes('0x1901'), DOMAIN_HASH, structHash]))
}
```

---

## Compute Caveats Hash

The caveats array is hashed using standard EIP-712 rules: each caveat is
`hashStruct`'d individually, then the results are concatenated and keccak256'd.

> Do NOT use standard ABI tuple encoding for the caveats array — EIP-712
> requires per-element `hashStruct` then `abi.encodePacked` of the results,
> not `abi.encode((... )[])`.

### Using viem

```typescript
const CAVEAT_TYPE_HASH = keccak256(
  encodeAbiParameters(parseAbiParameters('string'), [
    'Caveat(address enforcer,bytes terms,bytes args)',
  ])
)

function hashCaveat(caveat: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, address, bytes32, bytes32'),
      [
        CAVEAT_TYPE_HASH,
        keccak256(encodeAbiParameters(parseAbiParameters('address'), [caveat.enforcer])),
        keccak256(caveat.terms),
        keccak256(caveat.args),
      ]
    )
  )
}

function hashCaveatsArray(caveats: { enforcer: `0x${string}`; terms: `0x${string}`; args: `0x${string}` }[]): `0x${string}` {
  if (caveats.length === 0) {
    return keccak256(encodeAbiParameters(parseAbiParameters('uint256'), [0n]))
  }
  const encoded = concat(caveats.map(c => hashCaveat(c)))
  return keccak256(encoded)
}
```

### Using ethers v6

```typescript
import { keccak256, defaultAbiCoder, toUtf8Bytes } from 'ethers'

const CAVEAT_TYPE_HASH = keccak256(toUtf8Bytes('Caveat(address enforcer,bytes terms,bytes args)'))

function hashCaveat(caveat: { enforcer: string; terms: string; args: string }): string {
  return keccak256(
    defaultAbiCoder.encode(
      ['bytes32', 'address', 'bytes32', 'bytes32'],
      [
        CAVEAT_TYPE_HASH,
        keccak256(defaultAbiCoder.encode(['address'], [caveat.enforcer])),
        keccak256(caveat.terms),
        keccak256(caveat.args),
      ]
    )
  )
}

function hashCaveatsArray(caveats: { enforcer: string; terms: string; args: string }[]): string {
  if (caveats.length === 0) {
    // EIP-712 empty array = keccak256(empty bytes)
    return keccak256('0x')
  }
  const concatenated = caveats.map(c => hashCaveat(c)).join('').slice(2)
  return keccak256('0x' + concatenated)
}
```

---

## Compute Domain Separator

The domain separator must be read from the contract — do not compute it from guessed `name`/`version` literals.

### Using viem

```typescript
async function readDomainHash(delegationManagerAddress: `0x${string}`): `0x${string}` {
  const DOMAIN_HASH = await client.readContract({
    address: delegationManagerAddress,
    abi: parseAbi(['function getDomainHash() view returns (bytes32)']),
    functionName: 'getDomainHash',
  })
  return DOMAIN_HASH as `0x${string}`
}
```

### Precomputed Values

| Chain | Chain ID | DelegationManager | Domain Separator |
|---|---|---|---|
| Intuition Testnet | 13579 | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | Read from-chain via `getDomainHash()` |
| Intuition Mainnet | 1155 | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | Read from-chain via `getDomainHash()` |

---

## Verification

After computing the delegation hash, verify it by calling `getDelegationHash()`
on-chain and comparing:

```typescript
// 1. Compute the delegation hash off-chain (or skip this and just use on-chain)
const offChainHash = computeDelegationHash({
  delegate: delegation.delegate,
  delegator: delegation.delegator,
  authority: delegation.authority,
  caveats: delegation.caveats,
  salt: BigInt(delegation.salt),
})

// 2. Read the canonical hash from-chain
const onChainHash = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation) view returns (bytes32)']),
  functionName: 'getDelegationHash',
  args: [{
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats,
    salt: BigInt(delegation.salt),
    signature: delegation.signature,
  }],
})

if (offChainHash !== onChainHash) {
  throw new Error(`hash_mismatch: off-chain ${offChainHash} != on-chain ${onChainHash}`)
}

// 3. Check if the delegation is disabled on-chain
const disabled = await client.readContract({
  address: DELEGATION_MANAGER,
  abi: parseAbi(['function disabledDelegations(bytes32) view returns (bool)']),
  functionName: 'disabledDelegations',
  args: [onChainHash],
})

if (disabled) {
  console.log('Delegation is disabled/revoked.')
} else {
  console.log('Delegation is active. Hash:', onChainHash)
}
```

> **Note:** Prefer using `onChainHash` directly as `permissionContext` in
> `redeemDelegations`. Signature and caveat validation happen inside
> `redeemDelegations` at redemption time. The `disabledDelegations` function
> only checks revocation status.

---

## TypeScript Type Definitions

```typescript
// Complete type definitions for delegation operations

type Address = `0x${string}`
type Bytes32 = `0x${string}`

interface Caveat {
  enforcer: Address
  terms: Bytes32
  args: Bytes32
}

interface Delegation {
  delegate: Address
  delegator: Address
  authority: Bytes32
  caveats: Caveat[]
  salt: bigint  // uint256
  signature: Bytes32
}

interface SignedDelegation {
  delegation: Delegation
  delegationHash: Bytes32
  path: 'creation_only' | 'deposit_only' | 'both'
  mainAccount: Address
}

// Constants
const ROOT_AUTHORITY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as Bytes32
const MODE_SINGLE_DEFAULT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Bytes32
const ERC1271_MAGIC_VALUE = '0x1626ba7e' as const

// EIP-712 domain
const DOMAIN = {
  name: 'DelegationManager',
  version: '1',
} as const

function buildDomain(chainId: number, verifyingContract: Address) {
  return {
    ...DOMAIN,
    chainId,
    verifyingContract,
  }
}
```

---

## Command-Line Utilities

### Using cast and jq

```bash
# Compute delegation hash using getDelegationHash on-chain (recommended)
DELEGATION_HASH=$(cast call $DELEGATION_MANAGER "getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)" "$DELEGATOR" "$DELEGATE" "$AUTHORITY" "[($ENFORCER,\"$TERMS\",\"$ARGS\")]" "$SALT" "$SIGNATURE" --rpc-url $RPC)

# Compute EIP-712 digest (requires the full struct including signature)
# This is complex in pure bash. Use node or Python instead.
```

### Using Node.js (CLI)

Create a helper script `hash-delegation.js`:

```javascript
// hash-delegation.js
import { getDelegationHash, hashTypedDataForDelegation } from '@metamask/smart-accounts-kit'

const delegation = JSON.parse(process.argv[2])
const chainId = parseInt(process.argv[3] || '13579')
const dmAddress = process.argv[4] || '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'

console.log(JSON.stringify({
  hash: getDelegationHash(delegation),
  digest: hashTypedDataForDelegation(delegation, chainId, dmAddress),
}))
```

Usage:

```bash
node hash-delegation.js '{"delegator":"0x...","delegate":"0x...","salt":123,...}' 13579 0xdb9B1e94...
```

### Using cast to verify on-chain

```bash
# Read the canonical delegation hash from-chain
cast call $DELEGATION_MANAGER "getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)" \
  "$DELEGATOR" "$DELEGATE" "$AUTHORITY" "[($ENFORCER,$TERMS,$ARGS)]" "$SALT" "$SIGNATURE" \
  --rpc-url $RPC

# Check if delegation is disabled
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" \
  "$(cast call $DELEGATION_MANAGER \"getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature))(bytes32)\" \"$DELEGATOR\" \"$DELEGATE\" \"$AUTHORITY\" \"[($ENFORCER,$TERMS,$ARGS)]\" \"$SALT\" \"$SIGNATURE\" --rpc-url $RPC)" \
  --rpc-url $RPC
```

---

## Error Patterns

| Error | Cause | Fix |
|---|---|---|
| `TypeError: Cannot read property 'encode' of undefined` | Missing or incorrect ABI | Verify the tuple types match the Delegation struct exactly |
| `Invalid signature: recovered address does not match` | EIP-712 digest computed incorrectly | Read `getDomainHash()` on-chain and use that value directly. Verify the struct hash uses `uint256 salt` (not `bytes32 salt`). |
| `keccak256: invalid value` | Non-hex string passed to keccak | Ensure all values are hex-encoded with `0x` prefix |
| ABI encoding mismatch | Wrong field order or type | Verify: `delegator` (address), `delegate` (address), `authority` (bytes32), `caveats` (array), `salt` (`uint256`) — in that exact order |
| `disabledDelegations` returns `false` but `redeemDelegations` reverts | Signature invalid or caveat violated | Signature verification and caveats are checked inside `redeemDelegations`. Re-check signing flow and caveat encoding. |

---

## Protocol Invariants

1. **Read the domain separator from `getDomainHash()`.** The DelegationManager exposes `getDomainHash()` (`0x83ebb771`). Call it first and use the returned value directly in the signing digest. Do not reconstruct the domain separator from guessed `name`/`version` literals.
2. **The signature is excluded from the hash.** When computing the delegation hash, use only: `(delegator, delegate, authority, caveats, salt)` — not the signature field.
3. **Fixed domain name/version.** The EIP-712 domain uses `name = "DelegationManager"` and `version = "1"`, but the domain separator value must be read from-chain, not manually recomputed.
4. **Chain-specific domain separator.** The domain separator includes `chainId` and `verifyingContract`, so it differs between mainnet and testnet.
5. **Caveats array hashing.** The caveats array is hashed using standard EIP-712 rules: per-element `hashStruct` then `keccak256(concat(...))`. Empty arrays hash to `keccak256(abi.encode(uint256(0)))`.
6. **Verification on-chain uses `disabledDelegations(bytes32)`.** Call `getDelegationHash()` on-chain and pass the returned bytes32 to `disabledDelegations(bytes32)`. Signature and caveat validation happen inside `redeemDelegations` at redemption time.
7. **Use the SDK when possible.** `@metamask/smart-accounts-kit` provides the most reliable and up-to-date hashing functions.
8. **`permissionContext` for `redeemDelegations` is the delegation struct hash.** Read it from `getDelegationHash()` on-chain. Do not use `keccak256(abi.encode(delegation_struct))` — standard ABI encoding includes `signature` and uses raw tuple encoding for `caveats[]`, neither of which matches on-chain EIP-712 struct hashing.

---

## Quick Reference

### Constants

```typescript
const ROOT_AUTHORITY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const MODE_SINGLE_DEFAULT = '0x0000000000000000000000000000000000000000000000000000000000000000'
const ERC1271_MAGIC_VALUE = '0x1626ba7e'
const DELEGATION_MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'
```

### Hashing Summary

| What to Compute | Function | On-Chain? |
|---|---|---|
| Delegation Hash | `getDelegationHash(delegation)` | ✅ On-chain (`0x66134607`) |
| EIP-712 Digest | `hashTypedDataForDelegation(delegation, chainId, dmAddress)` | ❌ Off-chain only |
| Domain Separator | `getDomainHash()` | ✅ On-chain (`0x83ebb771`) |
| Disabled Check | `disabledDelegations(bytes32)` | ✅ On-chain |

### Minimal Working Example

```typescript
import { getDelegationHash, hashTypedDataForDelegation } from '@metamask/smart-accounts-kit'

const chainId = 13579
const dmAddress = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'

const delegation = {
  delegate: '0xAgentAddress...',
  delegator: '0xMainAccount...',
  authority:'0xffff...ffff',
  caveats: [
    {
      enforcer: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5',
      terms: '0x0000000000000000000000000000000000000000000000000000000000000020...',
      args: '0x',
    }
  ],
  salt: BigInt('0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')), // uint256
  signature: '0x', // Will be filled after signing
}

const hash = getDelegationHash(delegation)
const digest = hashTypedDataForDelegation(delegation, chainId, dmAddress)

console.log('Delegation Hash:', hash)
console.log('EIP-712 Digest:', digest)
```
