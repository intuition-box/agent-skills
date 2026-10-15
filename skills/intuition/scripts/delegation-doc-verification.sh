#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# delegation-doc-verification.sh  —  ground-truth gate for the delegation docs.
#
# Before trusting ANY address / caveat / typehash / ROOT_AUTHORITY cited in a
# docs file, validate it against the LIVE Intuition L3 deployment. Run this
# whenever a doc cites an enforcer, factory, MultiVault, or DelegationManager
# selector that was "assumed from the MetaMask v1.3.0 registry" rather than
# read from chain.
# ═══════════════════════════════════════════════════════════════════════════
# Covers every acceptance criterion for the delegation deliverable:
#   (b) DelegationManager exposes the cited selectors      → bytecode grep
#   (f) every documented selector == `cast sig` recomputed → cast sig comparison
#   (c) getDomainHash matches the pinned value             → cast call (both chains)
#   (a) every cited address has deployed code              → cast code (both chains)
#   (d) ROOT_AUTHORITY constant is 0xff…ff (32 bytes)      → shape check
#   (e) Caveat EIP-712 type is 2-field (args excluded)     → on-chain getDelegationHash()
#       recompute vs off-chain 2-field vs 3-field, + ERC-1271 isValidSignature proof
#
# (f) exists because two selectors were FABRICATED during this mission —
#   deposit=0xbf9c6fcd (really 0x2fb1d270) and owner()=0x63b6e8ee (really
#   0x8da5cb5b). A fabricated selector is invisible to the signer: the
#   signature verifies green and redemption reverts method-not-allowed.
#   So every selector in the docs is RECOMPUTED from its canonical signature
#   here and compared for equality. If a doc drifts, this gate fails.
#
# Usage:
#   ./scripts/delegation-doc-verification.sh              # both chains
#   CHAINS=testnet ./scripts/delegation-doc-verification.sh  # testnet only
# Exit non-zero if any REAL contract is empty, a cited selector is absent,
# the domain hash drifts, or the Caveat type does not match the chain.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

SKILL="$(cd "$(dirname "$0")/.." && pwd)"
RPC_T="https://testnet.rpc.intuition.systems/http"
RPC_M="https://rpc.intuition.systems/http"
DM="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"          # DelegationManager (both chains)
MV_T="0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91"        # MultiVault testnet
MV_M="0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e"        # MultiVault mainnet
DOMAIN_T="0x0b7c642afd2411ce211542a0e154e558e357f3b7f4738eb327ae086bfc659f15"
DOMAIN_M="0x44653bfc83c7c3f4ecd0ab2d76a7aff5e3478def6f0a290d939437b65d6fe1d5"
ROOT_AUTHORITY="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

# ── (f) selector recomputation table ───────────────────────────────────────────
# format: documented_selector|canonical_signature
# Every one of these is cited in reference/delegation.md,
# operations/create-delegation.md, operations/revoke-delegation.md, or SKILL.md.
# The point is that NO selector is trusted: each is recomputed from its
# canonical signature string and compared for equality with what the docs say.
SELECTOR_TABLE=(
  # DelegationManager
  "0x66134607|getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"
  "0x49934047|disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"
  "0x3ed01015|enableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))"
  "0xcef6d209|redeemDelegations(bytes[],bytes32[],bytes[])"
  "0x83ebb771|getDomainHash()"
  # MultiVault operations — the AllowedMethods allowlist
  "0x2fb1d270|deposit(address,bytes32,uint256,uint256)"
  "0xa814c1fe|redeem(address,bytes32,uint256,uint256,uint256)"
  "0x61403309|createAtoms(bytes[],uint256[])"
  "0x3c6bbf45|createTriples(bytes32[],bytes32[],bytes32[],uint256[])"
  # Hybrid — owner() is 0x8da5cb5b; the fabricated 0x63b6e8ee appears NOWHERE
  # in the HybridDeleGatorImpl bytecode (verified 2026-10-02).
  "0x8da5cb5b|owner()"
  "0xd691c964|executeFromExecutor(bytes32,bytes)"
)
# Custom error selectors cited in the deliverables' error tables.
ERROR_TABLE=(
  "0x05baa052|CannotUseADisabledDelegation()"
  "0x155ff427|InvalidERC1271Signature()"
  "0xb9f0f171|InvalidDelegator()"
  "0xb5863604|InvalidDelegate()"
  "0xded4370e|InvalidAuthority()"
  "0x1a4b3a04|NotDelegationManager()"
  "0x005ecddb|AlreadyDisabled()"
  "0x1bcaf69f|BatchDataLengthMismatch()"
)

# shared address inventory (identical on both chains); per-chain MultiVault added inside run_chain.
# tag REAL = live contract expected; EMPTY = expected absent (registry-only).
ADDRS=(
  "$DM|DelegationManager|REAL"
  "0x54c68ad35b082546a1e2e3e1a7542Ce9d3A2e756|SimpleFactory_intuition|REAL_TESTNET_ONLY"
  "0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c|SimpleFactory_canonical|REAL"
  "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5|AllowedMethodsEnforcer|REAL"
  "0x7f20f61b1f09b08d970938f6fa563634d65c4eeb|AllowedTargetsEnforcer|REAL"
  "0x92bf12322527caa612fd31a0e810472bbb106a8f|ValueLteEnforcer|REAL"
  "0x1046bb45C8d673d4ea75321280DB34899413c069|TimestampEnforcer|REAL"
  "0x04658B29F6b82ed55274221a06Fc97D318E25416|LimitedCallsEnforcer|REAL"
  "0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc|ERC20TransferAmountEnforcer|REAL"
  "0x24ff2AA430D53a8CD6788018E902E098083dcCd2|DeployedEnforcer|REAL"
  "0xA9BC5458E3eD352Df2eA4AbE9e0bBA41173513B9|NativeTokenTransferAmountEnforcer|EMPTY"
  "0x48dbe696a4d990079e039489ba2053b36e8ffec4|HybridDeleGatorImpl|REAL"
  "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B|EIP7702DeleGatorImpl|REAL"
)
# NOTE — CORRECTED 2026-10-02. The census previously asserted the opposite of the
#   truth, and SKILL.md was right. Measured directly:
#     0x69Aa2f9f (MetaMask canonical)  751 bytes on BOTH 13579 and 1155, computeAddress answers
#     0x54c68ad3 (Intuition)           751 bytes on 13579, EMPTY on 1155
#   Both are 751 bytes but return DIFFERENT addresses for the same (initCodeHash, salt):
#     0x69Aa -> 0x99D9ca38b68a3cD6981ed466285E383eda7cdBDf
#     0x54c6 -> 0xFEc573E35c5706B29B0f0eE07e1864f1AF8adF05
#   => distinct factories => distinct CREATE2 deployments for identical initCode.
#   Use 0x69Aa2f9f on mainnet; 0x54c68ad3 is testnet-only. Never assume one works
#   on both chains.

run_chain() {
  local lbl="$1" rpc="$2" dom="$3" mv="$4"
  echo "──────────────────────────────────────────────────────────────────"
  echo "CHAIN $lbl   RPC=$rpc   DM=$DM  MultiVault=$mv"
  echo "──────────────────────────────────────────────────────────────────"

  echo "[selectors] DelegationManager live bytecode:"
  local code
  code=$(cast code "$DM" --rpc-url "$rpc" 2>/dev/null || true)
  local sel fail_s=0
  for sel in "getDelegationHash:66134607" "getDomainHash:83ebb771" \
             "redeemDelegations:cef6d209" "disableDelegation:49934047" \
             "enableDelegation:3ed01015"; do
    local name="${sel%%:*}" want="${sel##*:}"
    if echo "$code" | grep -qi "$want"; then
      printf '    %-20s PRESENT\n' "$name"
    else
      printf '    %-20s ABSENT  <<< DOCS CITING THIS ARE WRONG\n' "$name"
      fail_s=1
    fi
  done

  echo "[domainHash] pinned=$dom"
  local gh
  gh=$(cast call "$DM" "getDomainHash()(bytes32)" --rpc-url "$rpc" 2>&1 | head -1 || true)
  local gh_clean="${gh# }"
  echo "    on-chain  = $gh_clean"
  [ "$gh_clean" = "$dom" ] && echo "    matches pinned value" || { echo "    <<< DOMAIN HASH DRIFT"; fail_s=1; }

  echo "[addresses] cast code census (bytes>0 = contract):"
  local fail_a=0 addr name tag sz bytes st
  while IFS='|' read -r addr name tag; do
    [ -z "$addr" ] && continue
    sz=$(cast code "$addr" --rpc-url "$rpc" 2>/dev/null || printf 'x')
    bytes=${#sz}
    case "$tag" in
      REAL_TESTNET_ONLY)
        # deployed on testnet only; empty on mainnet is expected, not a failure
        if [ "$lbl" = "testnet(13579)" ]; then
          [ "$bytes" -le 2 ] && { st="EMPTY <<< EXPECTED CONTRACT"; fail_a=1; } || st="contract($bytes)"
        else
          [ "$bytes" -le 2 ] && st="empty(testnet-only, OK)" || st="contract($bytes)"
        fi
        ;;
      REAL)        [ "$bytes" -le 2 ] && { st="EMPTY <<< EXPECTED CONTRACT"; fail_a=1; } || st="contract($bytes)" ;;
      EMPTY)       [ "$bytes" -le 2 ] && st="empty(correct: not deployed on Intuition)" || { st="UNEXPECTED-CONTRACT"; fail_a=1; } ;;
    esac
    printf '    %-30s %-42s %s\n' "$name" "$addr" "$st"
  done < <(printf '%s\n' "${ADDRS[@]}")
  # per-chain MultiVault
  sz=$(cast code "$mv" --rpc-url "$rpc" 2>/dev/null || printf 'x'); bytes=${#sz}
  [ "$bytes" -le 2 ] && { printf '    %-30s %-42s EMPTY <<< EXPECTED CONTRACT\n' "MultiVault($lbl)" "$mv"; fail_a=1; } || printf '    %-30s %-42s contract(%s)\n' "MultiVault($lbl)" "$mv" "$bytes"

  [ "$fail_s" -ne 0 -o "$fail_a" -ne 0 ] && return 1
  return 0
}

# ── (f) selector recomputation: cast sig on the canonical signature, compared
#         for equality against the selector the docs publish. No doc selector is
#         trusted; each is recomputed here. This is the anti-fabrication gate.
check_selectors() {
  echo "──────────────────────────────────────────────────────────────────"
  echo "[selectors] RECOMPUTING every documented selector with 'cast sig'"
  local fail=0 entry want sig got
  for entry in "${SELECTOR_TABLE[@]}"; do
    want="${entry%%|*}"
    sig="${entry#*|}"
    got="$(cast sig "$sig" 2>/dev/null || printf 'ERR')"
    if [ "$got" = "$want" ]; then
      printf '    %-12s OK   %s\n' "$want" "$sig"
    else
      printf '    %-12s DRIFT (cast sig = %s)  %s  <<< FIX THE DOC\n' "$want" "$got" "$sig"
      fail=1
    fi
  done
  echo "[selectors] custom error selectors:"
  for entry in "${ERROR_TABLE[@]}"; do
    want="${entry%%|*}"
    sig="${entry#*|}"
    got="$(cast sig "$sig" 2>/dev/null || printf 'ERR')"
    if [ "$got" = "$want" ]; then
      printf '    %-12s OK   %s\n' "$want" "$sig"
    else
      printf '    %-12s DRIFT (cast sig = %s)  %s  <<< FIX THE DOC\n' "$want" "$got" "$sig"
      fail=1
    fi
  done
  # The two selectors FABRICATED during this mission. They are allowed ONLY as
  # explicit counter-examples (the docs teach them as such), so the check is
  # "does it appear as a live claim?" — i.e. flag it only when it is NOT adjacent
  # to one of the counter-example markers.
  echo "[selectors] fabricated-selector regression check:"
  local b ctx
  for b in bf9c6fcd 63b6e8ee; do
    ctx="$(grep -rin -B2 -A2 "$b" "$SKILL/SKILL.md" "$SKILL/reference/delegation.md" \
             "$SKILL/operations/create-delegation.md" "$SKILL/operations/revoke-delegation.md" \
             "$SKILL/reference/delegation-authority.md" 2>/dev/null | tr 'A-Z' 'a-z')"
    if [ -z "$ctx" ]; then
      printf '    %s  not present  OK\n' "$b"
    elif echo "$ctx" | grep -qE 'fabricat|wrong|absent|counter-example|nowhere|really'; then
      printf '    %s  present but marked as a counter-example  OK\n' "$b"
    else
      printf '    %s  PRESENT AS A LIVE CLAIM <<< it was fabricated; remove or mark it\n' "$b"
      fail=1
    fi
  done
  return $fail
}

# ── (f2) the CAVEAT_TYPEHASH split: 2-field is the one that counts, and the
#         3-field form must NOT equal it. This is the most-confused thing in
#         the whole system, so it is asserted rather than described.
check_caveat_typehash() {
  echo "──────────────────────────────────────────────────────────────────"
  echo "[typehash] 2-field (signing) vs 3-field (ABI) Caveat typehash"
  local two three expect
  two="$(cast keccak 'Caveat(address enforcer,bytes terms)' 2>/dev/null || printf 'ERR')"
  three="$(cast keccak 'Caveat(address enforcer,bytes terms,bytes args)' 2>/dev/null || printf 'ERR')"
  expect="0x80ad7e1b04ee6d994a125f4714ca0720908bd80ed16063ec8aee4b88e9253e2d"
  local fail=0
  if [ "$two" = "$expect" ]; then
    printf '    2-field (EIP-712)      %s  OK\n' "$two"
  else
    printf '    2-field (EIP-712)      %s  DRIFT (expected %s)\n' "$two" "$expect"; fail=1
  fi
  if [ "$three" != "$two" ]; then
    printf '    3-field (ABI)          %s  correctly DIFFERENT from the signing typehash\n' "$three"
  else
    printf '    3-field equals 2-field <<< the split has collapsed; this is the recurring bug\n'; fail=1
  fi
  return $fail
}

# (g) closure check — every outbound reference in the five deliverables must
#     resolve inside the shipped set. Run its selftest first so a gate that
#     cannot fail never reports PASS.
check_closure() {
  echo "──────────────────────────────────────────────────────────────────"
  echo "[closure] outbound references from the five deliverables"
  if ! node "$SKILL/scripts/audit-deliverable-refs.mjs" --selftest >/dev/null 2>&1; then
    echo "    SELFTEST FAILED — the closure gate cannot detect a planted bogus reference."
    echo "    Treating as FAIL; do not trust a PASS from a gate that cannot fail."
    return 1
  fi
  echo "    selftest: planted bogus reference correctly detected ✓"
  node "$SKILL/scripts/audit-deliverable-refs.mjs" || return 1
  return 0
}

FAIL=0
check_closure || FAIL=1
check_selectors || FAIL=1
check_caveat_typehash || FAIL=1
run_chain "testnet(13579)" "$RPC_T" "$DOMAIN_T" "$MV_T" || FAIL=1
[ "${CHAINS:-both}" = "testnet" ] || run_chain "mainnet(1155)" "$RPC_M" "$DOMAIN_M" "$MV_M" || FAIL=1

# (d) ROOT_AUTHORITY constant shape
echo "──────────────────────────────────────────────────────────────────"
echo "[rootAuthority] ROOT_AUTHORITY = $ROOT_AUTHORITY"
python3 - "$ROOT_AUTHORITY" <<'PY' || FAIL=1
import sys
v = sys.argv[1].replace('0x','')
ok = (len(v)==64) and (v == 'f'*64)
print('    32-byte all-0xff ?', 'PASS' if ok else 'FAIL <<< must be 0xff*32, never 0x00')
sys.exit(0 if ok else 1)
PY

# (e) Caveat type + ERC-1271 signature proof (direct: on-chain getDelegationHash + isValidSignature)
echo "──────────────────────────────────────────────────────────────────"
echo "[caveatType] 2-field Caveat type vs on-chain getDelegationHash + ERC-1271 isValidSignature"
node "$SKILL/templates/proof-typehash.cjs" || FAIL=1

echo "──────────────────────────────────────────────────────────────────"
if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: FAIL — on-chain evidence disagrees with the docs. See markers above."
  exit 1
fi
echo "RESULT: PASS — selectors present; domainHash pinned; all cited addresses live; ROOT_AUTHORITY=***; Caveat type=2-field; proof signature validates (ERC-1271 MAGIC 1626ba7e)."
