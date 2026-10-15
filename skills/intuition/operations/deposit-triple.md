# depositTriple

Deposit $TRUST into an existing triple vault, minting shares to the receiver. This signals agreement with the claim. Follow these steps in order.

**Requires:** `$RPC`, `$MULTIVAULT`, `$CURVE_ID` from session setup (`reference/reading-state.md`).

**Function:** `deposit(address receiver, bytes32 termId, uint256 curveId, uint256 minShares) payable returns (uint256)`

The `termId` must be an existing positive triple vault. Use `isTermCreated(termId)` and `getVaultType(termId) == 1` to confirm before depositing.

To signal disagreement, deposit into the counter-triple returned by `getCounterIdFromTripleId(tripleId)` instead.

## Step 1: Query Prerequisites

```bash
# Verify the triple exists and is a positive triple (not counter-triple)
TRIPLE_ID=0x<tripleTermId>
cast call $MULTIVAULT "isTermCreated(bytes32)(bool)" $TRIPLE_ID --rpc-url $RPC
cast call $MULTIVAULT "getVaultType(bytes32)(uint8)" $TRIPLE_ID --rpc-url $RPC
# Must return 1 (TRIPLE), not 2 (COUNTER_TRIPLE)

# If you only have the (subject, predicate, object) components, compute the ID:
SUBJECT_ID=0x...
PREDICATE_ID=0x...
OBJECT_ID=0x...
TRIPLE_ID=$(cast call $MULTIVAULT "calculateTripleId(bytes32,bytes32,bytes32)(bytes32)" \
  $SUBJECT_ID $PREDICATE_ID $OBJECT_ID --rpc-url $RPC)

# Get default curve ID (use cached value if already queried this session)
CURVE_ID=$(cast call $MULTIVAULT "getBondingCurveConfig()((address,uint256))" --rpc-url $RPC | awk -F', ' '{print $2}' | tr -d ')')

# Preview the deposit to see expected shares and fees
DEPOSIT_WEI=$(cast --to-wei 0.01)
cast call $MULTIVAULT "previewDeposit(bytes32,uint256,uint256)(uint256,uint256)" \
  $TRIPLE_ID $CURVE_ID $DEPOSIT_WEI --rpc-url $RPC
# Returns (expectedShares, assetsAfterFees)
```

If the triple does not exist, create it first using `operations/create-triples.md`.

## Step 2: Encode the Calldata

### Using cast

```bash
DEPOSIT_WEI=$(cast --to-wei 0.01)
SENDER=0x<signer>
RECEIVER=${RECEIVER:-$SENDER}
CALLDATA=$(cast calldata "deposit(address,bytes32,uint256,uint256)" \
  $RECEIVER $TRIPLE_ID $CURVE_ID 0)
```

### Using viem

```typescript
// Default receiver to signer when not explicitly provided.
const receiver = providedReceiver ?? account.address

const data = encodeFunctionData({
  abi: parseAbi(['function deposit(address receiver, bytes32 termId, uint256 curveId, uint256 minShares) payable returns (uint256)']),
  functionName: 'deposit',
  args: [
    receiver,          // who gets the shares
    tripleId,           // bytes32 triple vault ID
    defaultCurveId,     // from getBondingCurveConfig()
    0n,                 // minShares (0 = no slippage protection)
  ],
})
```

## Step 3: Calculate msg.value

```
msg.value = deposit amount in wei-units of $TRUST
```

This is the deposit amount itself — the TRUST going into the triple vault.

```bash
VALUE=$(cast --to-wei 0.01)
```

## Step 4: Output the Unsigned Transaction JSON

Output one unsigned transaction object with resolved values from this session:

```json
{
  "to": "0x<multivault-address>",
  "data": "0x<calldata>",
  "value": "<msg.value in wei as base-10 string>",
  "chainId": "<chain ID as base-10 string>"
}
```

Set `to` to `$MULTIVAULT`, `value` to the Step 3 result, and `chainId` to `$CHAIN_ID`.

## Signaling Disagreement

Depositing into a triple's counter-triple signals disagreement with the claim. Get the counter-triple ID and deposit into it the same way:

```bash
COUNTER_TRIPLE_ID=$(cast call $MULTIVAULT "getCounterIdFromTripleId(bytes32)(bytes32)" $TRIPLE_ID --rpc-url $RPC)
```

Then use `$COUNTER_TRIPLE_ID` as the `termId` in the deposit calldata above.

## Slippage Protection

For production use, set `minShares` from the preview result with a tolerance:

```typescript
const [expectedShares] = await client.readContract({
  address: MULTIVAULT, abi: readAbi,
  functionName: 'previewDeposit',
  args: [tripleId, curveId, depositAmount],
})
// 5% slippage tolerance
const minShares = expectedShares * 95n / 100n
```

## Important

- The `termId` must be an existing positive triple. Confirm with `isTermCreated(termId)` and `getVaultType(termId) == 1`. Do not use `isTriple(termId)` alone — it returns `true` for counter-triples too.
- For receiver defaults, curve selection, payable semantics, and the output contract, see [Protocol Invariants](../SKILL.md#protocol-invariants).
- Check `getGeneralConfig().minDeposit` before building calldata, then derive `minShares` from `previewDeposit` with a tolerance. A zero `minShares` is for isolated debugging only. See [reference/config-fields.md](../reference/config-fields.md).
- When receiver differs from sender, the receiver must first grant the sender `DEPOSIT` approval via `operations/approve.md` (`approve(senderAddress, 1)`; enum: 0=NONE, 1=DEPOSIT, 2=REDEMPTION, 3=BOTH). That approval tx must mine before this deposit broadcasts.

## Post-Broadcast Verification

After the wallet layer broadcasts the tx, verify per `reference/post-write-verification.md`:

- Receipt `status = success`.
- `getShares(receiver, tripleId, curveId)` delta satisfies `delta >= minShares` and is close to the `previewDeposit` expected shares.
- Event `Deposited(sender, receiver, termId, curveId, assets, assetsAfterFees, shares, totalShares, vaultType)` is emitted (optional, for event-driven consumers).
