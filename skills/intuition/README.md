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
  secure storage for the signed Delegation object (`~/.intuition/agent-wallet.json`,
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

**Architecture:** The delegator is a **deployed Hybrid smart account**, not the
Main EOA. The chain of authority is:

```
Main Account (owner of Hybrid) -> Hybrid (delegator) -> Agent (delegate)
```

The Main Account signs the delegation via a MetaMask popup; the Hybrid is the
on-chain delegator; the agent is the delegate. The Main Account key is used once
for setup (deploy + approve) and is never stored by the agent or skill. Creation
of atoms/triples is a separate track in which the agent's own wallet acts
directly — see `reference/delegation.md` for why those two tracks differ.

**Revoking:** the Main account cannot call `disableDelegation` directly — it is
not the delegator — so revocation goes through an ERC-4337 UserOp in which the
Hybrid is `msg.sender`. See `operations/revoke-delegation.md`.

> **Canonical signing path:** The Main Account signs EIP-712 typed data via
> MetaMask `eth_signTypedData_v4` popup in the browser (`templates/sign-delegation.html`).
> The private key NEVER leaves MetaMask — it is not exported to scripts, pages, or the agent.
> The page constructs typed-data with the correct 2-field `Caveat(address enforcer,bytes terms)`
> typehash (matching the contract's CAVEAT_TYPEHASH `0x80ad7e1b…`), derives the digest on-chain
> via `getDelegationHash()` + `getDomainHash()`, and verifies the signature before accepting
> (`isValidSignature → 0x1626ba7e`). See `reference/delegation.md` and
> `operations/revoke-delegation.md`.
>
> **Do NOT export the Main Account private key.** Local `ethers.SigningKey` signing over an
> on-chain digest is a gas-free VERIFICATION recipe only (see `operations/create-delegation.md`) —
> never the production signing path. The demo proves MetaMask signs correctly on both
> desktop and mobile (proof tx `0x56c6d3e0`).

**Step 1 — Delegator: Generate and sign the delegation (browser + MetaMask popup).**

Open `templates/sign-delegation.html` in a browser on Intuition Testnet (serve via
`python3 -m http.server 8000` from the templates/ dir if needed — MetaMask requires
`http://localhost` or `https://`). The page handles the entire flow:

```bash
# Variables the page uses (fill in the browser UI):
NETWORK="Intuition Testnet"
CHAIN_ID=13579
RPC="https://testnet.rpc.intuition.systems/http"
DELEGATION_MANAGER="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
DELEGATOR="0x<hybrid-smart-account>"      # Hybrid (contract); owner = your MetaMask EOA
DELEGATE="0x<agent-address>"             # Agent wallet (e.g. 0xe9BfdE…)
AUTHORITY="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"  # ROOT_AUTHORITY

# Enforcer addresses: see reference/network-config.md for the full canonical set
ALLOWED_METHODS_ENFORCER="0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5"
VALUE_LTE_ENFORCER="0x92bf12322527caa612fd31a0e810472bbb106a8f"   # NOT 0xA9BC… (not deployed)
TIMESTAMP_ENFORCER="0x1046bb45c8d673d4ea75321280db34899413c069"
LIMITED_CALLS_ENFORCER="0x04658b29f6b82ed55274221a06fc97d318e25416"
```

1. **Connect MetaMask** → select your Main Account EOA (owner of Hybrid).
2. **Deploy Hybrid** → MetaMask popup sends `deploy()` to SimpleFactory (predicted address via CREATE2).
3. **Approve MultiVault** (`approve(hybrid, 3)`) → MetaMask popup.
4. **Fund Hybrid** (0.002 tTRUST) → MetaMask popup.
5. **Sign Delegation** → MetaMask `eth_signTypedData_v4` popup. The page verifies on-chain
   before accepting — only emits output if `isValidSignature → 0x1626ba7e`.

The Output panel shows a JSON blob (no `digest` field — the redeem re-derives it on-chain):
```json
{ "delegate": "0x<agent>", "delegator": "0x<hybrid>", "authority": "0xff…",
  "caveats": [{"enforcer":"0x<enf>","terms":"0x<terms>"}], "salt": "0x<32B>", "signature": "0x<65B>" }
```
```

**Step 2 — Agent: Receive delegation, verify authority, and execute.**

The agent stores the delegation alongside its wallet key in
`~/.intuition/agent-wallet.json` (mode `0600`) and runs
the authority verification gate from `reference/delegation-authority.md` before
every write. If the gate passes, the agent wraps the Intuition calldata in
`redeemDelegations()` and outputs the nested transaction.

See `reference/delegation-authority.md` for the full autonomous verification
flow and `operations/create-delegation.md` for the complete delegator workflow.
For the full tested lifecycle (create → deposit → revoke in under 15 min),

## What the Skill Installs

- `SKILL.md`: canonical machine-facing contract, invariants, output shapes, and delegation routing.
- `ux-patterns.md`: mandatory UX patterns — pre-task context check, private key request (with MetaMask limitation), multi-step workflow flagging, network selection, output-before-action.
- `reference/delegation.md` + `operations/`: the delegation model and its three procedures
  (create -> authority check -> revoke). Superseded quick start retained as
  the four delegation deliverables above supersede the old quick start.
- `operations/`: write-specific encoding flows for create, deposit, redeem, batch, approvals, and delegation.
- `reference/`: read queries, network config, GraphQL, pinning, config semantics, verification, nested-triple composition, delegation concepts, and autonomous policy.
- `templates/`: signing page (MetaMask HTML), CLI signer, redeem/revoke scripts for both tracks.
- `scripts/`: reusable attribution probes and test harnesses.

### Operations

| File | Purpose |
|------|---------|
| `operations/create-atoms.md` | Create atom vaults from URI data |
| `operations/create-triples.md` | Create triple vaults linking three terms |
| `operations/deposit-atom.md` | Deposit $TRUST into an existing atom vault, mint shares |
| `operations/deposit-triple.md` | Deposit $TRUST into an existing triple vault, mint shares (signals agreement) |
| `operations/deposit.md` | Deposit $TRUST into a vault, mint shares (generic reference) |
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
| `reference/delegation.md` | Two-track delegation model (Creation Authority via OWS + Deposit Authority via Smart Wallet), agent wallet setup |
| `reference/delegation-authority.md` | Autonomous verification gate for delegated agents — signature, revocation, expiry, caveat compliance, MultiVault approval simulation, receiver binding |
| `reference/delegation-debugging.md` | Layered debugging order and diagnostic commands |
| `reference/unified-delegation-architecture.md` | Two-track model: Creation Authority (OWS) + Deposit Authority (Smart Wallet) |
| `reference/graphql-queries.md` | GraphQL discovery — search, traverse, aggregate |
| `reference/schemas.md` | Schema types, IPFS pinning, and structured atom creation |
| `reference/reading-state.md` | On-chain reads and session setup |
| `reference/workflows.md` | Multi-step recipes (create+deposit, signal agreement, exit) |
| `reference/simulation.md` | Dry run / simulate writes before executing |
| `reference/autonomous-policy.md` | Approval modes, policy schema, execution gates, delegation policy |
| `reference/post-write-verification.md` | Receipt confirmation, deterministic ID reconstruction, state deltas |

The skill also supports creating nested triples:
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
