# revoke-delegation

Disable a MetaMask Delegation Framework delegation on-chain. Disabled
delegations fail when later redeemed through the DelegationManager.

**Requires:** `$RPC`, `$CHAIN_ID`, and Delegation Framework addresses from
`reference/delegation.md`.

**Function:** `disableDelegation(Delegation calldata delegation)`

## Semantics

- The signer must be the delegation's `delegator`.
- Revocation is keyed by the canonical delegation hash.
- Revoking a root delegation invalidates all downstream sub-delegations whose
  authority chain depends on that root.
- Expiry caveats are cheaper when a delegation can simply age out. Use on-chain
  revocation when authority must stop before the caveat expiry or when a
  leaked/broad delegation must be killed immediately.

## Step 1: Parse and Hash the Delegation

Start from the exact signed `Delegation` object:

```json
{
  "delegate": "0x...",
  "delegator": "0x...",
  "authority": "0x...",
  "caveats": [],
  "salt": "123",
  "signature": "0x..."
}
```

Compute the hash using the deployed DelegationManager:

```bash
DELEGATION_MANAGER=0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3

cast call $DELEGATION_MANAGER \
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "($DELEGATE,$DELEGATOR,$AUTHORITY,$CAVEATS,$SALT,$SIGNATURE)" \
  --rpc-url $RPC
```

The hash is the value to check in `disabledDelegations`.

## Step 2: Check Current Revocation State

```bash
cast call $DELEGATION_MANAGER \
  "disabledDelegations(bytes32)(bool)" \
  $DELEGATION_HASH \
  --rpc-url $RPC
```

If it returns `true`, the delegation is already disabled. Return a
`delegation_already_disabled` status and do not create a new tx.

## Step 3: Encode the Calldata

### Using cast

```bash
CALLDATA=$(cast calldata \
  "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))" \
  "($DELEGATE,$DELEGATOR,$AUTHORITY,$CAVEATS,$SALT,$SIGNATURE)")
```

### Using viem

```typescript
const delegationManagerAbi = parseAbi([
  'function disableDelegation((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation)',
])

const data = encodeFunctionData({
  abi: delegationManagerAbi,
  functionName: 'disableDelegation',
  args: [delegation],
})
```

## Step 4: msg.value

```
msg.value = 0
```

Revocation is non-payable.

## Step 5: Output the Unsigned Transaction JSON

Output one unsigned transaction object:

```json
{
  "to": "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  "data": "0x<calldata>",
  "value": "0",
  "chainId": "<chain ID as base-10 string>"
}
```

The wallet layer must broadcast this from `delegation.delegator`. If the signer
is not the delegator, the contract reverts with `InvalidDelegator`.

## Optional: Re-enable

The same contract exposes `enableDelegation(Delegation calldata delegation)`.
Only use it when explicitly requested by the delegator. Re-enabling restores a
previously disabled delegation if its signatures and caveats still validate.

## Post-Broadcast Verification

After the wallet layer broadcasts the tx:

1. Confirm receipt `status = success`.
2. Re-read `disabledDelegations(delegationHash)` and require `true`.
3. Decode logs and verify one `DisabledDelegation` event where:
   - `delegationHash` matches the computed hash;
   - `delegator` matches `delegation.delegator`;
   - `delegate` matches `delegation.delegate`.
4. If the revoked delegation was the root of a chain, mark all known descendant
   delegations as unusable in local state.

## Error Table

| Error | Cause | Fix |
|---|---|---|
| `InvalidDelegator` | Revocation tx was not signed by `delegation.delegator` | Broadcast from the delegator account |
| `AlreadyDisabled` | Delegation hash is already disabled | Treat as successful revocation state; do not retry |
| `InvalidEOASignature` / `InvalidERC1271Signature` during later redemption | Revocation is not the issue; the delegation signature no longer validates | Request a fresh delegation |
| Delegation still redeemable after tx | Wrong chain, wrong manager, or hash was computed from a different struct | Recompute with `getDelegationHash` on the same chain and manager |

## Security Notes

- On-chain revocation does not erase copies of the signed delegation object.
  It only makes the hash unusable on that DelegationManager.
- Revoking the root is the fastest way to halt a full delegation tree.
- Use short timestamp caveats for routine automation so emergency revocation is
  not the only control.
