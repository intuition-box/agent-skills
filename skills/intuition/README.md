# Intuition Skill

Canonical skill for producing correct Intuition Protocol transaction parameters. The skill emits unsigned `{to,data,value,chainId}` objects; your wallet or backend handles signing and broadcast.

## Prerequisites

- `cast` (Foundry): query costs, previews, and build calldata.
- `curl`: call the public GraphQL API for read-only discovery.
- `jq`: extract `term_id`, `uri`, and unsigned tx fields.
- `bc`: do uint256-safe 5% tolerance math in shell quickstarts.
- RPC access: public Intuition L3 endpoints, no API keys.
- A host-provided pinning capability for structured atoms. The reference path is
  `@0xintuition/sdk` 3.0.1 or newer, configured in a trusted server or CLI
  runtime with an Intuition pinning API key.
- Funded wallet: tTRUST on testnet or $TRUST on mainnet. Bridge via https://app.intuition.systems/bridge.
- **For delegation:** An agent wallet (separate from the delegator's wallet) and
  secure storage for the signed Delegation object (`~/.intuition/agent-state.json`,
  permissions `0600`). See `reference/delegation.md` for wallet setup.

## Installation

```bash
npx skills add 0xIntuition/agent-skills --skill intuition
```

To pin a published release instead of tracking `main`, install from a tag or SHA:

```bash
npx skills add 0xIntuition/agent-skills#<tag-or-sha> --skill intuition
```

## Network Selection

Use the session values in [reference/network-config.md](./reference/network-config.md). The quickstarts below use testnet.

## Pinning API Key Storage

The key authenticates Intuition's hosted metadata-pinning service. It is not an
RPC key, wallet secret, or part of the skill configuration.

- For agent-driven workflows, prefer a server-side tool or capability whose
  implementation owns the secret, so the model never receives the key.
- For local application development, store it as `INTUITION_PIN_API_KEY` in the
  consuming application's gitignored `.env.local` or `.env` file. Keep that
  file outside the installed skill directory, confirm Git ignores it, and
  restrict it to the local user (for example, mode `0600` on Unix systems).
- For CI and deployed services, store it in the platform's encrypted secret
  manager and inject it only into the trusted process that performs pinning.
- Never put it in a prompt, manifest, committed file, browser bundle,
  `NEXT_PUBLIC_*` / `VITE_*` variable, command-line argument, logs, or unsigned
  transaction output.

The application initializes the SDK; the skill never obtains or persists the
key:

```typescript
import { configureSdk } from '@0xintuition/sdk'

const pinApiKey = process.env.INTUITION_PIN_API_KEY
if (!pinApiKey) throw new Error('pinning_configuration_required')

configureSdk({ pinApiKey })
```

If the execution environment has no configured pinning capability, stop before
making a request and return the `pin_failed` output from
[reference/schemas.md](./reference/schemas.md) with a reason beginning
`pinning_configuration_required`.

## Quickstart A: Discovery -> Deposit

```bash
NETWORK="Intuition Testnet"
CHAIN_ID=13579
RPC="https://testnet.rpc.intuition.systems/http"
MULTIVAULT="0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91"
GRAPHQL="https://testnet.intuition.sh/v1/graphql"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RECEIVER="0x<share-recipient>"

SEARCH_BODY=$(jq -cn --arg searchTerm "%ethereum%" '{"query":"query SearchAtoms($searchTerm: String!, $limit: Int!) { atoms(where: { label: { _ilike: $searchTerm } }, limit: $limit, order_by: { created_at: desc }) { term_id label } }","variables":{"searchTerm":$searchTerm,"limit":1}}')
TERM_ID=$(curl -fsS -X POST "$GRAPHQL" -H "Content-Type: application/json" -d "$SEARCH_BODY" | jq -r '.data.atoms[0].term_id // empty')
test -n "$TERM_ID" || { echo "No matching atom found"; exit 1; }

CURVE_ID=$(cast call $MULTIVAULT "getBondingCurveConfig()((address,uint256))" --rpc-url $RPC | awk -F', ' '{print $2}' | tr -d ')')
MIN_DEPOSIT=$(cast call $MULTIVAULT "getGeneralConfig()((address,address,uint256,address,uint256,uint256,uint256,uint256))" --rpc-url $RPC | awk -F', ' '{print $5}' | awk '{print $1}')
DEPOSIT_WEI=$(cast --to-wei 0.002)
test "$DEPOSIT_WEI" -ge "$MIN_DEPOSIT" || { echo "Deposit is below minDeposit"; exit 1; }

EXPECTED_SHARES=$(cast call $MULTIVAULT "previewDeposit(bytes32,uint256,uint256)(uint256,uint256)" "$TERM_ID" "$CURVE_ID" "$DEPOSIT_WEI" --rpc-url $RPC | awk 'NR == 1 { print $1 }')
MIN_SHARES=$(printf '%s * 95 / 100
' "$EXPECTED_SHARES" | bc)
CALLDATA=$(cast calldata "deposit(address,bytes32,uint256,uint256)" "$RECEIVER" "$TERM_ID" "$CURVE_ID" "$MIN_SHARES")

jq -n --arg to "$MULTIVAULT" --arg data "$CALLDATA" --arg value "$DEPOSIT_WEI" --arg chainId "$CHAIN_ID" '{to:$to,data:$data,value:$value,chainId:$chainId}'
```

## Quickstart B: Pin -> Encode -> Create

Pin through the trusted runtime's configured SDK first. SDK 3.0.1 and newer automatically
uses the gated pinning endpoint and attaches the key only to pinning requests:

```typescript
import { configureSdk, pinThing } from '@0xintuition/sdk'

const pinApiKey = process.env.INTUITION_PIN_API_KEY
if (!pinApiKey) throw new Error('pinning_configuration_required')

configureSdk({ pinApiKey })

const uri = await pinThing({
  name: 'README quickstart atom',
  description: 'Pinned from the Intuition skill README quickstart',
  image: '',
  url: '',
})

if (!uri.startsWith('ipfs://')) throw new Error('pin_failed: invalid URI')
console.log(uri)
```

Use the returned URI in the unsigned transaction flow:

```bash
NETWORK="Intuition Testnet"
CHAIN_ID=13579
RPC="https://testnet.rpc.intuition.systems/http"
MULTIVAULT="0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
URI="ipfs://<uri-returned-by-pinThing>"
test -n "$URI" && [[ "$URI" == ipfs://* ]] || { echo "Pin failed"; exit 1; }

ATOM_DATA=$(cast --from-utf8 "$URI")
ATOM_ID=$(cast call $MULTIVAULT "calculateAtomId(bytes)(bytes32)" "$ATOM_DATA" --rpc-url $RPC)
ATOM_COST=$(cast call $MULTIVAULT "getAtomCost()(uint256)" --rpc-url $RPC | awk '{print $1}')
cast call $MULTIVAULT "previewAtomCreate(bytes32,uint256)(uint256,uint256,uint256)" "$ATOM_ID" "$ATOM_COST" --rpc-url $RPC >/dev/null
CALLDATA=$(cast calldata "createAtoms(bytes[],uint256[])" "[$ATOM_DATA]" "[$ATOM_COST]")

jq -n --arg to "$MULTIVAULT" --arg data "$CALLDATA" --arg value "$ATOM_COST" --arg chainId "$CHAIN_ID" '{to:$to,data:$data,value:$value,chainId:$chainId}'
```

## Quickstart C: Delegate -> Encode -> Create

Grant an agent scoped authority to create atoms on your behalf. The agent will
verify its delegation before every write and wrap the Intuition calldata in
`redeemDelegations()` targeting the DelegationManager.

**Architecture:** This quickstart uses the Creation Authority track (OWS).
The Main Account delegates to a temporary OWS, which delegates to the Agent.
After setup, the Main Account key goes back in the vault. The delegation is
cached and re-used for all future operations — the key is needed again only
when creating a new delegation (revocation, expiry, or scope change).

> **MetaMask cannot sign EIP-7702 delegations.** MetaMask blocks all three
> alternative signing methods (`personal_sign`, `eth_signTypedData_v4`,
> `wallet_signTypedData_v4`) for EIP-7702 upgraded accounts. Only local private
> key signing works for all account types. See `ux-patterns.md` → "Private Key
> Request Pattern" for the full explanation.

**Step 1 — Delegator: Generate and sign the delegation.**

```bash
NETWORK="Intuition Testnet"
CHAIN_ID=13579
RPC="https://testnet.rpc.intuition.systems/http"
DELEGATION_MANAGER="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
DELEGATOR="0x<main-account>"
DELEGATE="0x<agent-address>"
DELEGATOR_PRIVATE_KEY="0x<private-key>"

> **Security Warning:** `DELEGATOR_PRIVATE_KEY` controls the user's account. This key must **never** be written to disk by the agent or skill. It exists only as an in-memory session variable. The user is responsible for keeping it in their own wallet (MetaMask, hardware wallet, etc.). The agent must not persist, log, or transmit the delegator's private key. Only the **agent's** private key may be written to `~/.intuition/agent-wallet.json`.

# Encode caveats: allow createAtoms only, cap at 50 TRUST cumulative
SELECTOR_CREATE_ATOMS=$(cast sig "createAtoms(bytes[],uint256[])")
# AllowedMethodsEnforcer expects raw concatenated bytes4 selectors, NOT abi-encoded bytes4[]
ALLOWED_METHODS_TERMS="0x${SELECTOR_CREATE_ATOMS#0x}"
SPEND_CAP_TERMS=$(cast abi-encode "uint256" $(cast --to-wei 50))

# Enforcer addresses: see reference/network-config.md
ALLOWED_METHODS_ENFORCER="0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5"
NATIVE_TOKEN_ENFORCER="0xA9BC5458E3eD352Df2eA4AbE9e0bBA41173513B9"
# Salt must be uint256 — use Python or openssl with hex output (bash can't do 256-bit arithmetic)
SALT=$(python3 -c "import secrets; print(secrets.randbits(256))")
# ROOT_AUTHORITY = bytes32(-1) = 64 Fs for a fresh root delegation
AUTHORITY="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

# Read the real domain separator from-chain
DOMAIN_HASH=$(cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC)

# EIP-712 signing must be done off-chain using the domain hash above.
# For the complete signing flow, see operations/create-delegation.md.
# The signed delegation object (with signature) is transmitted to the agent off-chain.

# Output the signed delegation object (transmit to agent off-chain)
# CRITICAL: struct field order is (delegate, delegator, ...) — delegate FIRST
jq -n   --arg delegator "$DELEGATOR"   --arg delegate "$DELEGATE"   --arg authority "$AUTHORITY"   --arg salt "$SALT"   --arg signature "$SIGNATURE"   '{
    delegation: {
      delegate: $delegate,
      delegator: $delegator,
      authority: $authority,
      caveats: [
        {enforcer: "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5", terms: "0x<allowed-methods-terms>", args: "0x"},
        {enforcer: "0xA9BC5458E3eD352Df2eA4AbE9e0bBA41173513B9", terms: "0x<spend-cap-terms>", args: "0x"}
      ],
      salt: $salt,
      signature: $signature
    }
  }'
```

**Step 2 — Agent: Receive delegation, verify authority, and execute.**

The agent stores the delegation in `~/.intuition/agent-state.json` and runs
the authority verification gate from `reference/delegation-authority.md` before
every write. If the gate passes, the agent wraps the Intuition calldata in
`redeemDelegations()` and outputs the nested transaction.

See `reference/delegation-authority.md` for the full autonomous verification
flow and `operations/create-delegation.md` for the complete delegator workflow.
For the full tested lifecycle (create → deposit → revoke in under 15 min),
see `DELEGATION-LIFECYCLE.md`.

## What the Skill Installs

- `SKILL.md`: canonical machine-facing contract, invariants, output shapes, and delegation routing.
- `ux-patterns.md`: mandatory UX patterns — pre-task context check, private key request (with MetaMask limitation), multi-step workflow flagging, network selection, output-before-action.
- `DELEGATION-LIFECYCLE.md`: quick start — full delegation lifecycle (create -> deposit -> revoke) in under 15 min. Every code block tested on testnet.
- `operations/`: write-specific encoding flows for create, deposit, redeem, batch, approvals, and delegation.
- `reference/`: read queries, network config, GraphQL, pinning, config semantics, verification, nested-triple composition, delegation concepts, and autonomous policy.
- `templates/`: signing page (MetaMask HTML), CLI signer, redeem/revoke scripts for both tracks.
- `scripts/`: reusable attribution probes and test harnesses.

### Operations

| File | Purpose |
|------|---------|
| `operations/create-atoms.md` | Create atom vaults from URI data |
| `operations/create-triples.md` | Create triple vaults linking three terms |
| `operations/deposit.md` | Deposit $TRUST into a vault, mint shares |
| `operations/redeem.md` | Redeem shares from a vault, receive $TRUST |
| `operations/batch-deposit.md` | Deposit into multiple vaults in one transaction |
| `operations/batch-redeem.md` | Redeem from multiple vaults in one transaction |
| `operations/approve.md` | Grant/revoke deposit or redemption approval for delegated flows |
| `operations/create-delegation.md` | Build, sign, and output a Delegation object (off-chain) |
| `operations/revoke-delegation.md` | Revoke a delegation on-chain (permanent, propagates downstream) |

### Reference

| File | Purpose |
|------|---------|
| `reference/network-config.md` | Canonical network metadata, session env values, and viem chain defs |
| `reference/graphql-queries.md` | GraphQL discovery — search, traverse, aggregate |
| `reference/schemas.md` | Schema types, IPFS pinning, and structured atom creation |
| `reference/reading-state.md` | On-chain reads and session setup |
| `reference/workflows.md` | Multi-step recipes (create+deposit, signal agreement, exit) |
| `reference/simulation.md` | Dry run / simulate writes before executing |
| `reference/autonomous-policy.md` | Approval modes, policy schema, execution gates, delegation policy |
|| `reference/delegation.md` | Two-track delegation model (Creation Authority via OWS + Deposit Authority via Smart Wallet), agent wallet setup, encoding rules. |
| `reference/delegation-authority.md` | Autonomous verification gate for delegated agents — signature, revocation, expiry, caveat compliance, MultiVault approval simulation, receiver binding |
| `reference/post-write-verification.md` | Receipt confirmation, deterministic ID reconstruction, state deltas |

The skill also supports creating nested triples: triples whose subject,
predicate, or object reuses another triple's `term_id`. See
`reference/nested-triples.md`.

## Autonomous Mode

For unattended execution, policy guardrails and runtime validation live in
[reference/autonomous-policy.md](./reference/autonomous-policy.md).

The policy now includes delegation configuration:
- `delegation.mode`: `direct` (no delegation), `creation_only` (OWS creation track), `deposit_only` (Smart Wallet deposit track), or `both` (full agent).
- `delegation.mainAccountAddress`: The ultimate beneficiary for all receiver-bearing operations.
- `delegation.dailyBudgetWei`: Agent-side self-enforced daily TRUST spend limit.

When delegation mode is active, the agent runs the authority verification gate
from `reference/delegation-authority.md` before every write. If the gate fails,
the agent emits a `delegation_failure` object and halts.

## Design Philosophy

- Canonical correctness over convenience shortcuts.
- On-chain reads and previews for safety-critical decisions; GraphQL for discovery.
- Wallet-agnostic output so the same skill works with local, hosted, and agentic signers.
- Delegation makes agent authority composable, revocable, and auditable on-chain.
  The Agent is never the on-chain actor — `msg.sender` at MultiVault is always
  the delegator's address.

## References

- [ux-patterns.md](./ux-patterns.md) — mandatory UX patterns for all operations
- [DELEGATION-LIFECYCLE.md](./DELEGATION-LIFECYCLE.md) — quick start: full lifecycle in 15 min
- [reference/network-config.md](./reference/network-config.md)
- [reference/schemas.md](./reference/schemas.md)
- [reference/post-write-verification.md](./reference/post-write-verification.md)
- [reference/delegation.md](./reference/delegation.md)
- [reference/delegation-authority.md](./reference/delegation-authority.md)
- [operations/create-delegation.md](./operations/create-delegation.md)
- [operations/revoke-delegation.md](./operations/revoke-delegation.md)
- [Intuition V2 Contracts](https://github.com/0xIntuition/intuition-v2/tree/main/contracts/core)

## License

MIT
