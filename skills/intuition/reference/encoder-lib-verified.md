# EncoderLib: Verified Intuition Fork Source

This reference contains the verified `EncoderLib.sol` source from the Intuition
fork (mainnet MultiVault implementation `0xc6f28a5ffe30eee3fade5080b8930c58187f4903`).
It explains why `getDelegationHash(delegation)` does NOT match standard ABI encoding
and documents the exact algorithm so future agents can reproduce it off-chain
when needed.

## Source

Fetched from the Intuition block explorer (verified sourcecode API) on 2026-08-10.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library EncoderLib {
    bytes32 internal constant _DELEGATION_TYPEHASH = keccak256(
        "Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)"
    );
    bytes32 internal constant _CAVEAT_TYPEHASH = keccak256(
        "Caveat(address enforcer,bytes terms)"
    );

    function _getCaveatPacketHash(address enforcer_, bytes calldata terms_) internal pure returns (bytes32) {
        return keccak256(abi.encode(_CAVEAT_TYPEHASH, enforcer_, keccak256(terms_)));
    }

    function _getCaveatArrayPacketHash(Caveat[] calldata caveats_) internal pure returns (bytes32) {
        if (caveats_.length == 0) {
            return keccak256("");
        }
        bytes32[] memory caveatPacketHashes = new bytes32[](caveats_.length);
        for (uint256 i; i < caveats_.length; ) {
            caveatPacketHashes[i] = _getCaveatPacketHash(caveats_[i].enforcer, caveats_[i].terms);
            unchecked { ++i; }
        }
        return keccak256(abi.encodePacked(caveatPacketHashes));
    }

    function _getDelegationHash(
        Delegation calldata delegation_
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _DELEGATION_TYPEHASH,
                delegation_.delegate,
                delegation_.delegator,
                delegation_.authority,
                _getCaveatArrayPacketHash(delegation_.caveats),
                delegation_.salt
            )
        );
    }
}
```

## Why standard ABI fails

Standard `keccak256(abi.encode(delegation_struct))` includes:
- `signature` field
- Standard tuple encoding for caveats array
- All caveat fields including `args`

`EncoderLib._getDelegationHash`:
1. Excludes `signature` entirely
2. Hashes caveats with `abi.encodePacked(bytes32[])`, not `abi.encode((address,bytes,bytes)[])`
3. Hashes each caveat as `keccak256(abi.encode(CAVEAT_TYPEHASH, enforcer, keccak256(terms)))` — `args` excluded
4. Uses non-standard field order: `delegate, delegator, authority, caveats_hash, salt`

These differences mean any off-chain hash built with standard ABI will NOT match
the on-chain `getDelegationHash` return value. Always read the hash from-chain.

## Off-chain reproduction (Node.js + ethers v6)

```js
const { ethers } = require('ethers');

const DELEGATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes('Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)')
);
const CAVEAT_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes('Caveat(address enforcer,bytes terms)')
);

function getCaveatPacketHash(enforcer, terms) {
  const termsHash = ethers.keccak256(terms);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'bytes32'],
    [CAVEAT_TYPEHASH, enforcer, termsHash]
  );
  return ethers.keccak256(encoded);
}

function getCaveatArrayPacketHash(caveats) {
  if (caveats.length === 0) return ethers.keccak256('0x');
  const hashes = caveats.map(c => getCaveatPacketHash(c.enforcer, c.terms));
  let concatenated = '0x';
  for (const h of hashes) concatenated += h.slice(2);
  return ethers.keccak256(concatenated);
}

function getDelegationHash(delegate, delegator, authority, caveats, salt) {
  const caveatsHash = getCaveatArrayPacketHash(caveats);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
    [DELEGATION_TYPEHASH, delegate, delegator, authority, caveatsHash, salt]
  );
  return ethers.keccak256(encoded);
}
```

## Common mistake: getDelegationHash with signature

The on-chain `getDelegationHash` accepts the full struct including `signature`, but
strips the signature before hashing. The `disabledDelegations(bytes32)` function
expects the hash of the struct **without** the signature.

When checking `disabledDelegations` off-chain via `cast call`, compute the hash
without the signature, matching the same custom encoder.
