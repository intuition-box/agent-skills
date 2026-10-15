#!/usr/bin/env node
// revoke-delegation.cjs — revoke a Hybrid-issued delegation via ERC-4337.
//
// WHY 4337 AND NOT A DIRECT CALL:
//   disableDelegation requires msg.sender == delegator. The delegator is the
//   Hybrid contract. The Main EOA owns the Hybrid but is NOT it, so a direct
//   call reverts InvalidDelegator (0xb9f0f171). Ownership is not authority.
//
//   The Hybrid's execute(...) is gated onlyEntryPoint. So route the revoke
//   through the canonical v0.7 EntryPoint, which anyone may call — no bundler
//   is deployed on Intuition and none is required:
//
//     EP.handleOps([op], beneficiary)
//       -> Hybrid.execute((DelegationManager, 0, disableDelegation(delegation)))
//            -> DM.disableDelegation(...)   msg.sender == Hybrid == delegator OK
//
//   Authority comes from the Main owner's signature over the UserOp; the
//   identity at the DelegationManager is the Hybrid. That is the delegation
//   model, expressed through ERC-4337.
//
// WHAT THIS SCRIPT WILL NOT DO (by design):
//   - It will NOT fund the EntryPoint. That is a one-time setup step:
//       cast send <EP> "depositTo(address)" <HYBRID> --value 0.05ether --private-key <agentKey>
//     It only warns if the deposit is insufficient.
//   - It will NOT sign anything with the agent key. The agent has no authority
//     here; only the Main owner's signature counts.
//   - It will NOT reconstruct the delegation. It consumes the signed JSON and
//     fails fast if it is malformed.
//   - There is NO local-key signing fallback. The Main key never touches a script.
//
// USAGE
//   # 1. prepare — build the UserOp, print the exact digest Main must sign
//   node templates/revoke-delegation.cjs <signed-delegation.json>
//
//   # 2. simulate with the signature pasted back in (default; broadcasts nothing)
//   node templates/revoke-delegation.cjs <signed-delegation.json> --sig 0x<65bytes>
//
//   # 3. actually submit (two flags required)
//   node templates/revoke-delegation.cjs <signed-delegation.json> --sig 0x… --broadcast --yes
//
//   # optional: one-shot local signing page instead of copying a signature
//   node templates/revoke-delegation.cjs <signed-delegation.json> --serve

const ethers = require('ethers');
const fs = require('fs');
const path = require('path');
const http = require('http');

const RPC = process.env.RPC || 'https://testnet.rpc.intuition.systems/http';
const CHAIN_ID = 13579;
const HYBRID = '0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14';
const MAIN = '0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee';
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';   // canonical ERC-4337 v0.7
const DM = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const AGENT = '0xe9BfdEC6Fa795a24e3069292248d9d16570E050d';
const PORT = 3847;
// EntryPoint prefund deposit. Computed once at module scope so both the prepare
// step and the rendered page use the same value.
const FUND_VALUE = ethers.parseEther('0.05');
// Stamped into the served page so a stale/cached build is visible at a glance.
const BUILD_ID = 'sdk-signer-' + Date.now().toString(36);

const TUPLE = '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';

// ── args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const broadcast = flag('broadcast');
const serve = flag('serve');
const SIG = opt('sig', null);

if (!file) {
  console.error('Usage: node templates/revoke-delegation.cjs <signed-delegation.json> [--sig 0x…] [--serve] [--broadcast --yes]');
  process.exit(1);
}
if (broadcast && !flag('yes')) {
  console.error('❌ REFUSING TO BROADCAST: --broadcast requires --yes as an explicit second acknowledgement.');
  console.error('   Re-run without --broadcast to simulate only (the default).');
  process.exit(2);
}

// ── the result envelope, matching redeem-delegation.cjs ──────────────────────
const result = {
  tool: 'revoke-delegation.cjs',
  mode: broadcast ? 'broadcast' : 'dry-run',
  chainId: CHAIN_ID, entryPoint: EP, hybrid: HYBRID, main: MAIN,
  delegationHash: null, delegationDisabledBefore: null,
  userOp: null, digest: null, signature: null, signerRecovered: null,
  simulation: { ok: null, errorName: null, error: null, raw: null },
  tx: null, delegationDisabledAfter: null, redemptionBlocked: null,
  decision: 'proceed', reason: '',
};
const log = (...a) => console.error(...a);
const emit = extra => { if (extra) Object.assign(result, extra); console.log(JSON.stringify(result, null, 2)); };

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);

  // ── 1. load the signed delegation; fail fast if malformed ──────────────────
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { emit({ decision: 'reject', reason: 'cannot read delegation file: ' + e.message }); process.exit(1); }
  const d = raw.delegation || raw;

  for (const k of ['delegate', 'delegator', 'authority', 'caveats', 'salt']) {
    if (d[k] === undefined) {
      emit({ decision: 'reject', reason: `malformed delegation: missing "${k}"` });
      process.exit(1);
    }
  }
  if (d.delegator.toLowerCase() !== HYBRID.toLowerCase()) {
    // This script revokes a HYBRID-issued delegation via 4337. Anything else
    // (e.g. the old Path-2 EOA delegator) is a different operation.
    emit({ decision: 'reject', reason: `delegator ${d.delegator} is not the Hybrid ${HYBRID}; this script revokes Hybrid-issued delegations only.` });
    process.exit(1);
  }
  const caveats = (d.caveats || []).map(c => [c.enforcer, c.terms, c.args ?? '0x']);

  const dm = new ethers.Contract(DM, [
    'function getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)) view returns (bytes32)',
    'function disabledDelegations(bytes32) view returns (bool)',
  ], provider);

  // ── 2. delegation hash + pre-state ──────────────────────────────────────────
  // NOTE: the tuple must be POSITIONAL under this ethers build; the named-object
  // form throws "array is wrong length".
  const delegationHash = await dm.getDelegationHash([
    d.delegate, d.delegator, d.authority, caveats, BigInt(d.salt), d.signature || '0x',
  ]);
  result.delegationHash = delegationHash;
  result.delegationDisabledBefore = await dm.disabledDelegations(delegationHash);
  log(`1. delegation hash : ${delegationHash}`);
  log(`   already disabled: ${result.delegationDisabledBefore}`);
  if (result.delegationDisabledBefore) {
    emit({ decision: 'halt', reason: 'delegation is already disabled; nothing to revoke.' });
    process.exit(0);
  }

  // ── 3. build the UserOp ─────────────────────────────────────────────────────
  const dis = new ethers.Interface([
    'function disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))',
  ]);
  const innerCall = dis.encodeFunctionData('disableDelegation', [[
    d.delegate, d.delegator, d.authority, caveats, BigInt(d.salt), d.signature || '0x',
  ]]);

  // execute() on the DEPLOYED contract takes a single TUPLE (address,uint256,bytes)
  // — selector 0x5c1c6dcd. There is no 4-arg execute; do not invent one.
  const ex = new ethers.Interface([
    'function execute((address target,uint256 value,bytes callData)) payable',
  ]);
  const callData = ex.encodeFunctionData('execute', [{ target: DM, value: 0, callData: innerCall }]);

  // accountGasLimits = verificationGasLimit (HIGH 128 bits) ‖ callGasLimit (LOW 128).
  // Packing this backwards sets verificationGasLimit = 0; validateUserOp then runs
  // out of gas and the EntryPoint reports a misleading "AA23 reverted" that is
  // indistinguishable from a genuine account rejection.
  const VERIFICATION_GAS = 1_000_000;
  const CALL_GAS = 400_000;
  const accountGasLimits = ethers.concat([
    ethers.zeroPadValue(ethers.toBeHex(BigInt(VERIFICATION_GAS)), 16),
    ethers.zeroPadValue(ethers.toBeHex(BigInt(CALL_GAS)), 16),
  ]);

  const hybrid = new ethers.Contract(HYBRID, [
    `function getNonce(uint192) view returns (uint256)`,
    `function getPackedUserOperationTypedDataHash(${TUPLE}) view returns (bytes32)`,
    `function eip712Domain() view returns (bytes1,string,string,uint256,bytes32)`,
  ], provider);

  const nonce = await hybrid.getNonce(0n);
  const op = {
    sender: HYBRID,
    nonce,
    initCode: '0x',
    callData,
    accountGasLimits,
    preVerificationGas: 60_000n,
    gasFees: ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(100_000_000n), 16), // maxPriorityFeePerGas
      ethers.zeroPadValue(ethers.toBeHex(100_000_000n), 16), // maxFeePerGas
    ]),
    paymasterAndData: '0x',
    signature: SIG ?? '0x',
  };
  result.userOp = {
    sender: op.sender, nonce: op.nonce.toString(),
    callDataSelector: op.callData.slice(0, 10),
    verificationGasLimit: VERIFICATION_GAS, callGasLimit: CALL_GAS,
    preVerificationGas: op.preVerificationGas.toString(),
    signature: op.signature === '0x' ? null : op.signature,
  };
  log(`2. UserOp built    : sender=${op.sender} nonce=${nonce} callData=${op.callData.slice(0, 10)}`);

  // ── 4. the EIP-712 digest Main must sign ────────────────────────────────────
  const digest = await hybrid.getPackedUserOperationTypedDataHash(op);
  const dom = await hybrid.eip712Domain();
  result.digest = digest;

  // eip712Domain() returns verifyingContract as a WORD-PADDED bytes32
  // (0x000…000433d9b2a…), not a 20-byte address. Passing that straight into
  // eth_signTypedData_v4 makes MetaMask reject the request with the opaque
  // "Invalid input" error — the signature never reaches the wallet.
  // Trim the 12-byte left pad, then checksum.
  // NOTE: a 20-byte address string is '0x' + 40 chars = 42 chars.
  // A word-padded bytes32 is '0x' + 64 chars = 66 chars. Test on that, not on a
  // bare '66', which would keep the padded value and reintroduce the bug.
  const vcRaw = String(dom[4]);
  const verifyingContract = vcRaw.length === 42
    ? ethers.getAddress(vcRaw)
    : ethers.getAddress('0x' + vcRaw.slice(-40));
  if (verifyingContract.toLowerCase() !== HYBRID.toLowerCase()) {
    emit({ decision: 'reject', reason: `domain verifyingContract ${verifyingContract} != Hybrid ${HYBRID}; refusing to sign a payload for the wrong account.` });
    process.exit(1);
  }
  const domain = { name: dom[1], version: dom[2], chainId: Number(dom[3]), verifyingContract };
  log(`   domain.verifyingContract trimmed from bytes32 → ${verifyingContract}`);


  // The struct hash has TEN fields, not nine. The contract appends
  // `address entryPoint` to every PackedUserOperation it hashes:
  //   keccak256(abi.encode(TYPEHASH, sender, nonce, keccak(initCode), keccak(callData),
  //                        accountGasLimits, preVerificationGas, gasFees,
  //                        keccak(paymasterAndData), entryPoint))
  // Omitting it signs a DIFFERENT payload than the contract validates: MetaMask
  // accepts the signature and the account rejects it as AA24. Verified against
  // PACKED_USER_OP_TYPEHASH() = 0xbc37962d8bd1d319c95199bdfda6d3f92baa8903a61b32d5f4ec1f4b36a3bc18
  const types = {
    PackedUserOperation: [
      { name: 'sender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'initCode', type: 'bytes' },
      { name: 'callData', type: 'bytes' },
      { name: 'accountGasLimits', type: 'bytes32' },
      { name: 'preVerificationGas', type: 'uint256' },
      { name: 'gasFees', type: 'bytes32' },
      { name: 'paymasterAndData', type: 'bytes' },
      { name: 'entryPoint', type: 'address' },
    ],
  };

  // Self-check: rebuild the EIP-712 digest locally from the payload we are about
  // to hand the wallet and compare it to the contract's own digest. If they
  // differ, the signature would be rejected downstream with a useless AA24, so
  // refuse before the user is ever asked to sign.
  {
    const wire = {
      sender: op.sender, nonce: Number(op.nonce), initCode: op.initCode, callData: op.callData,
      accountGasLimits: op.accountGasLimits, preVerificationGas: Number(op.preVerificationGas),
      gasFees: op.gasFees, paymasterAndData: op.paymasterAndData, entryPoint: EP,
    };
    const local = ethers.TypedDataEncoder.hash(domain, types, wire);
    if (local !== digest) {
      emit({ decision: 'reject', reason: `payload self-check FAILED: local EIP-712 digest ${local} != contract ${digest}. Refusing to serve a payload the account would reject.` });
      process.exit(1);
    }
    log('   payload self-check: local EIP-712 digest == contract digest ✓');
  }
  log(`3. EIP-712 digest  : ${digest}`);
  log(`   domain          : ${domain.name} v${domain.version} chainId=${domain.chainId}`);
  log(`   verifyingContract: ${domain.verifyingContract}`);
  log(`   signer must be  : ${MAIN} (the Hybrid OWNER — not the delegator)`);

  // ── 5. EntryPoint deposit — the page can fund this; the script only checks ──
  // depositTo(address) is payable and permissionless: anyone may fund any account.
  // The Hybrid cannot pay its own prefund from its balance without a deposit, so
  // handleOps reverts AA21 "did not pay prefund" until this is non-zero.
  const depositToData = new ethers.Interface(['function depositTo(address) payable'])
    .encodeFunctionData('depositTo', [HYBRID]);
  // Funding amount is computed, never hardcoded as a hex literal — a mistyped
  // literal silently sends the wrong amount of real value. See FUND_VALUE above.
  const fundValueHex = '0x' + FUND_VALUE.toString(16);
  let epDeposit = 0n;
  try {
    const epC = new ethers.Contract(EP, [
      'function balanceOf(address) view returns (uint256)',
      'function getDeposit(address) view returns (uint256)',
    ], provider);
    try { epDeposit = await epC.getDeposit(HYBRID); }
    catch { epDeposit = await epC.balanceOf(HYBRID); }
    log(`4. EntryPoint deposit for Hybrid: ${ethers.formatEther(epDeposit)} TRUST`);
    if (epDeposit === 0n) {
      log('   deposit is 0 — handleOps reverts AA21 (did not pay prefund) until funded.');
      log('   The --serve page can fund it in step 1 (permissionless).');
      log(`   Or by hand: cast send ${EP} "depositTo(address)" ${HYBRID} --value 0.05ether --private-key <agentKey>`);
    }
  } catch { log('4. could not read EntryPoint deposit (non-fatal)'); }

  // ── 6. serve a one-shot signing page (opt-in) ───────────────────────────────
  if (serve) {
    await serveOnce({ domain, types, op, digest, depositToData, epDeposit, fundValueHex });
    return;
  }

  if (SIG) {
    // A signature is exactly 65 bytes. Malformed input must fail with a clear
    // message, not deep inside an ABI coder.
    const sigOk = /^0x[0-9a-fA-F]{130}$/.test(SIG);
    const v = sigOk ? SIG.slice(130, 132) : null;
    if (!sigOk) {
      emit({ decision: 'reject', reason: `--sig must be 65 bytes (0x + 130 hex chars). Got ${(SIG.length - 2) / 2} bytes.` });
      process.exit(1);
    }
    if (!['1b', '1c'].includes(v)) {
      emit({ decision: 'reject', reason: `--sig has v=${v}; expected 1b or 1c.` });
      process.exit(1);
    }
  }

  if (!SIG) {
    emit({
      decision: 'halt',
      reason: 'UserOp built and simulated inputs computed. Nothing sent. '
        + 'Have ' + MAIN + ' sign the digest above, then re-run with --sig 0x<signature>. '
        + 'Or use --serve for a one-shot local signing page.',
    });
    log('\n--- prepare complete; no transaction sent ---');
    log('   Message to sign (EIP-712):');
    log(JSON.stringify({ domain, primaryType: 'PackedUserOperation', types, message: {
      sender: op.sender, nonce: Number(op.nonce), initCode: op.initCode, callData: op.callData,
      accountGasLimits: op.accountGasLimits, preVerificationGas: Number(op.preVerificationGas),
      gasFees: op.gasFees, paymasterAndData: op.paymasterAndData, entryPoint: EP,
    } }, null, 2));
    return;
  }

  // ── 6b. who actually signed? ───────────────────────────────────────────────
  // The page checks accounts[0] at connect time, but the account selected in
  // MetaMask can change afterwards, and the wallet may sign with a different
  // one than requested. Recover the signer from the exact digest the account
  // will check, and refuse anything that is not the Hybrid owner. This catches a
  // wrong-account signature BEFORE it becomes an opaque AA24.
  {
    let recovered = null;
    try { recovered = ethers.recoverAddress(digest, op.signature); }
    catch (e) { /* malformed */ }
    const ownerOk = recovered && recovered.toLowerCase() === MAIN.toLowerCase();
    result.signerRecovered = recovered;
    if (!ownerOk) {
      emit({
        decision: 'reject',
        reason: recovered
          ? `signature is from ${recovered}, but the Hybrid owner is ${MAIN}. `
            + 'Switch MetaMask to the owner account and sign again — a signature from any '
            + 'other account is rejected downstream as AA24 with no explanation.'
          : 'could not recover a signer from this signature (malformed).',
      });
      process.exit(1);
    }
    log(`6. signer         : ${recovered} == Hybrid owner ✓`);
  }

  // ── 7. simulate ─────────────────────────────────────────────────────────────
  const epIface = new ethers.Interface([`function handleOps(${TUPLE}[],address)`]);
  const data = epIface.encodeFunctionData('handleOps', [[op], MAIN]);
  const errIface = new ethers.Interface([
    'error FailedOp(uint256 opCode,string reason)',
    'error FailedOpWithRevert(uint256 opCode,string reason,bytes inner)',
  ]);

  // raw eth_call: the error wrapper mangles the revert bytes we need to read.
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ from: MAIN, to: EP, data }, 'latest'] });
  const res = await (await fetch(RPC, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body })).json();

  let reason = null, opCode = null, inner = null;
  const hex = res?.error?.data ?? null;
  if (hex) {
    try { const p = errIface.parseError(hex); opCode = String(p.args[0]); reason = p.args[1];
          inner = p.args[2] !== undefined ? p.args[2] : null; } catch {}
  }
  const simOk = !res.error;
  result.simulation = { ok: simOk, errorName: reason, error: reason ? `FailedOp(${opCode})` : null,
    raw: reason ? `AA — ${reason}` : (simOk ? null : 'reverted without data') };
  log(`5. simulation     : ${simOk ? '✅ NO REVERT' : '❌ ' + reason}`);

  if (!simOk) {
    let decision = 'halt', why = `simulation reverted: ${reason}`;
    if (/AA21|AA22/.test(reason || '')) { why = `EntryPoint deposit too low (${reason}). Fund it with depositTo as shown above.`; }
    else if (/AA24/.test(reason || '')) { why = 'AA24 signature error — the signature is still wrong. Re-sign the exact digest above.'; decision = 'reject'; }
    else if (/AA23/.test(reason || '')) {
      // The inner revert distinguishes two very different situations.
      const innerSel = inner && inner !== '0x' ? inner.slice(0, 10) : null;
      if (innerSel === '0xf645eedf') {
        // Hybrid.ECDSAInvalidSignature() — OpenZeppelin's ECDSA.recover() rejected
        // the r/s values themselves. A genuine signature never lands here; this is
        // what a PLACEHOLDER signature looks like. NOT a route failure.
        why = 'AA23 / ECDSAInvalidSignature — the signature is a placeholder, not a real one. '
          + 'Have ' + MAIN + ' sign the digest above and re-run. The revoke route is unaffected.';
        decision = 'reject';
      } else if (innerSel === '0xd663742a') {
        why = 'AA23 / NotEntryPoint — the account rejected the call. The UserOp callData must be execute(...); the EntryPoint is the only accepted caller.';
        decision = 'reject';
      } else {
        why = `AA23 — the account reverted during validation${inner && inner !== '0x' ? ': ' + inner.slice(0, 74) : ' (empty inner revert)'}. Check the callData and gas limits.`;
      }
    }
    else if (/AA25|AA26/.test(reason || '')) { why = `account validation failed (${reason}) — signature does not match sender or deps.`; decision = 'reject'; }
    emit({ decision, reason: why });
    process.exit(1);
  }

  if (!broadcast) {
    emit({ decision: 'proceed', reason: 'Simulation passed. Nothing broadcast (dry-run default). Re-run with --broadcast --yes to submit.' });
    log('--- dry-run: simulation passed, no transaction sent ---');
    return;
  }

  // ── 8. broadcast ────────────────────────────────────────────────────────────
  const key = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '/.intuition/agent-wallet.json'), 'utf8')).privateKey;
  const agent = new ethers.Wallet(key, provider);
  if (agent.address.toLowerCase() !== AGENT.toLowerCase()) {
    emit({ decision: 'halt', reason: 'agent wallet mismatch: ~/.intuition/agent-wallet.json is not ' + AGENT });
    process.exit(1);
  }
  const tx = await agent.sendTransaction({ to: EP, data, gasLimit: 2_000_000, chainId: CHAIN_ID });
  log(`6. tx sent        : ${tx.hash}`);
  const receipt = await tx.wait();
  log(`7. status         : ${receipt.status === 1 ? '✅ SUCCESS' : '❌ FAILED'} block=${receipt.blockNumber} gas=${receipt.gasUsed}`);

  // ── 9. assert the revoke actually took ──────────────────────────────────────
  const after = await dm.disabledDelegations(delegationHash);
  result.tx = { hash: tx.hash, status: receipt.status, blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString() };
  result.delegationDisabledAfter = after;

  let redemptionBlocked = null;
  if (after) {
    // The real proof: the delegation can no longer be redeemed.
    try {
      const core = require(path.join(__dirname, 'node_modules/@metamask/delegation-core/dist/index.cjs'));
      const dm2 = new ethers.Contract(DM, [
        'function getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)) view returns (bytes32)',
        'function getDomainHash() view returns (bytes32)',
      ], provider);
      const sh = await dm2.getDelegationHash([d.delegate, d.delegator, d.authority, caveats, BigInt(d.salt), d.signature || '0x']);
      const dh = await dm2.getDomainHash();
      const dg = ethers.keccak256(ethers.concat(['0x1901', dh, sh]));
      const mv = '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91';
      const value = ethers.parseEther('0.001');
      const term = '88c64e37687bf17f7bc1fbc449ea700910cf7e80a92ab4d0fa3ae9d9eb15ae65';
      const inner2 = '2fb1d270' + MAIN.toLowerCase().replace('0x', '').padStart(64, '0')
        + term.padStart(64, '0') + '1'.padStart(64, '0') + '0'.repeat(64);
      const execution = mv.toLowerCase().replace('0x', '') + value.toString(16).padStart(64, '0') + inner2;
      const pc = core.encodeDelegations([d]);
      const enc = els => {
        const N = els.length; let head = N.toString(16).padStart(64, '0'); const offs = []; let tl = 0;
        for (const el of els) { offs.push(32 * N + tl); tl += 32 + Math.ceil(el.length / 64) * 64; }
        head += offs.map(o => o.toString(16).padStart(64, '0')).join('');
        let t = '';
        for (const el of els) { t += (el.length / 2).toString(16).padStart(64, '0'); t += el.padEnd(Math.ceil(el.length / 64) * 64, '0'); }
        return head + t;
      };
      const ctx = enc([pc.slice(2)]);
      const modes = '0'.repeat(63) + '1' + '0'.repeat(64);
      const exs = enc([execution]);
      const o1 = 96, o2 = o1 + ctx.length / 2, o3 = o2 + modes.length / 2;
      const cd2 = 'cef6d209' + [o1, o2, o3].map(o => o.toString(16).padStart(64, '0')).join('') + ctx + modes + exs;
      await provider.call({ from: AGENT, to: DM, data: '0x' + cd2 });
      redemptionBlocked = false;
    } catch (e) {
      const m = String(e?.info?.error?.message || e?.message || '');
      redemptionBlocked = /05baa052|CannotUseADisabledDelegation/.test(m + (e?.data || '')) ? true : 'unknown: ' + m.slice(0, 90);
    }
    result.redemptionBlocked = redemptionBlocked;
  }

  const ok = receipt.status === 1 && after === true;
  emit({
    decision: ok ? 'proceed' : 'halt',
    reason: ok
      ? (redemptionBlocked === true
          ? 'Revoked on-chain and redemption is now blocked by CannotUseADisabledDelegation.'
          : 'Revoked on-chain (disabledDelegations = true). Redemption-block check inconclusive.')
      : 'Transaction did not confirm the revoke.',
  });
}

// ── the one-shot page: fund the EntryPoint, then sign the UserOp ────────────
// Two steps because they are independent: funding does NOT change the UserOp
// digest, so it can happen before or after signing. depositTo(address) is
// payable and permissionless — the Main account may fund it directly from
// MetaMask; no bundler, no agent key, no separate transaction from the CLI.
//
// This page never sees a private key. It only calls window.ethereum.
async function serveOnce({ domain, types, op, digest, depositToData, epDeposit, fundValueHex }) {
  const payload = JSON.stringify({
    domain, types, digest,
    ep: EP, hybrid: HYBRID, owner: MAIN, chainId: CHAIN_ID,
    depositToData, fundValueHex, fundValueEth: ethers.formatEther(FUND_VALUE),
    deposit: ethers.formatEther(epDeposit ?? 0n),
    message: {
      sender: op.sender, nonce: Number(op.nonce), initCode: op.initCode, callData: op.callData,
      accountGasLimits: op.accountGasLimits, preVerificationGas: Number(op.preVerificationGas),
      gasFees: op.gasFees, paymasterAndData: op.paymasterAndData, entryPoint: EP,
    },
  });

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revoke delegation — sign</title><style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1.5rem;line-height:1.5;max-width:46rem}
h2{font-size:1.25rem;margin:0 0 .25rem} h3{font-size:1rem;margin:1.5rem 0 .5rem}
.sub{opacity:.7;font-size:.85rem;margin:0 0 1rem}
pre{background:rgba(127,127,127,.12);padding:.7rem;border-radius:.4rem;overflow:auto;font-size:.78rem;margin:.5rem 0}
button{padding:.6rem 1.1rem;font-size:.95rem;margin:.25rem .35rem .25rem 0;border-radius:.35rem;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
.ok{color:#0a7;font-weight:600} .bad{color:#d33;font-weight:600} .warn{color:#b60;font-weight:600}
ol{padding-left:1.2rem} .kv{display:grid;grid-template-columns:11rem 1fr;gap:.15rem .6rem;font-size:.82rem}
.kv div:nth-child(odd){opacity:.65}
code{font-size:.78rem;word-break:break-all}
</style></head><body>
<h2>Revoke delegation</h2>
<p class="sub">One Hybrid-issued delegation, revoked in two steps. No keys leave MetaMask. <span id="build">build …</span></p>

<h3>1 · Connect</h3>
<button id="connect">Connect wallet</button>
<span id="who" class="sub"></span>

<h3>2 · Fund the ERC-4337 EntryPoint <span class="sub">(one-time, optional if already funded)</span></h3>
<p class="sub">The Hybrid cannot pay its own UserOp prefund, so the EntryPoint needs a
deposit. <code>depositTo</code> is payable and permissionless — anyone may fund any account,
so this costs you a few cents of testnet TRUST and is done once per Hybrid.</p>
<button id="fund" disabled>Fund EntryPoint (${ethers.formatEther(FUND_VALUE)} TRUST)</button>
<span id="fundstate" class="sub"></span>

<h3>3 · Sign the revoke UserOp</h3>
<p class="sub">This signature is the authority. It authorises the Hybrid to call
<code>DelegationManager.disableDelegation()</code> — i.e. it makes the delegation
unusable.</p>
<pre id="preview"></pre>
<button id="sign" disabled>Sign revoke UserOp in MetaMask</button>
<pre id="out"></pre>

<script>
const BUILD = '${BUILD_ID}';
const P = ${payload};
const $ = id => document.getElementById(id);
const say = (id, msg, cls) => { const e = $(id); e.textContent = msg; e.className = cls || 'sub'; };
let acct = null, viemMod = null;

// The SDK / viem path. Manual eth_signTypedData_v4 did not attribute the signer
// correctly (MetaMask signed with whichever account was active, not the one we
// asked for), which surfaced as an unrecoverable AA24. The SDK pins the account
// on the wallet client and the flow re-reads it immediately before signing.
const VIEM_URL = 'https://cdn.jsdelivr.net/npm/viem@2.55.13/+esm';
async function loadViem() {
  if (viemMod) return viemMod;
  say('out', 'Loading SDK (viem)…', 'warn');
  viemMod = await import(VIEM_URL);
  return viemMod;
}

$('build').textContent = 'build ' + BUILD;
$('preview').textContent =
  'verifyingContract  ' + P.domain.verifyingContract + '\\n' +
  'sender   (Hybrid)  ' + P.message.sender + '\\n' +
  'nonce               ' + P.message.nonce + '\\n' +
  'callData            ' + P.message.callData.slice(0,10) + '…\\n' +
  '                    = execute((DelegationManager, 0, disableDelegation(…)))\\n' +
  'EIP-712 digest      ' + P.digest;

const chain = {
  id: P.chainId, name: 'Intuition Testnet',
  nativeCurrency: { name: 'TRUST', symbol: 'TRUST', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet.rpc.intuition.systems/http'] } },
};

$('connect').onclick = async () => {
  try {
    if (!window.ethereum) return say('who', 'No injected wallet.', 'bad');
    // Deliberately does NOT load the SDK: connecting must work even if the CDN
    // is unreachable. The SDK is only needed at sign time.
    const accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    acct = accts[0];
    const cid = parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
    if (cid !== P.chainId) return say('who', 'WRONG NETWORK: chainId ' + cid + ', need ' + P.chainId + '.', 'bad');
    if (acct.toLowerCase() !== P.owner.toLowerCase())
      return say('who', 'MetaMask is on ' + acct + '. Switch to the Hybrid owner ' + P.owner + ' first.', 'bad');
    say('who', 'Connected ' + acct + ' on ' + cid + ' ✓', 'ok');
    $('fund').disabled = false; $('sign').disabled = false;
  } catch (e) { say('who', 'Error: ' + (e.message || e), 'bad'); }
};

$('fund').onclick = async () => {
  try {
    const viem = await loadViem();
    const accts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accts[0].toLowerCase() !== P.owner.toLowerCase())
      return say('fundstate', 'MetaMask switched to ' + accts[0] + '. Switch back to ' + P.owner + '.', 'bad');
    const wc = viem.createWalletClient({ account: accts[0], chain, transport: viem.custom(window.ethereum) });
    say('fundstate', 'Approve the MetaMask popup…', 'warn');
    const h = await wc.sendTransaction({ account: accts[0], to: P.ep,
      data: P.depositToData, value: P.fundValueHex, chain });
    say('fundstate', 'Funding: ' + h + ' — waiting…', 'warn');
    for (;;) {
      const r = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [h] });
      if (r && r.status === '0x1') break;
      await new Promise(res => setTimeout(res, 2500));
    }
    say('fundstate', 'EntryPoint funded ✓ (' + h + ').', 'ok');
  } catch (e) { say('fundstate', 'Funding failed: ' + (e.message || e), 'bad'); }
};

$('sign').onclick = async () => {
  try {
    const viem = await loadViem();
    // Re-read the wallet's CURRENT account at signing time. The account can be
    // switched in MetaMask between connect and sign, which is exactly how a
    // signature from the wrong key gets produced.
    const accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const signer = accts[0];
    if (signer.toLowerCase() !== P.owner.toLowerCase())
      return say('out', 'STOP: MetaMask is on ' + signer + ', not the owner ' + P.owner + '. Switch accounts, then sign again.', 'bad');
    const cid = parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
    if (cid !== P.chainId) return say('out', 'STOP: wrong network ' + cid + '.', 'bad');

    const typed = { domain: P.domain, types: P.types,
                    primaryType: 'PackedUserOperation', message: P.message };
    const digest = await viem.hashTypedData(typed);
    if (digest.toLowerCase() !== P.digest.toLowerCase())
      return say('out', 'STOP: digest ' + digest + ' != the contract digest ' + P.digest + '.', 'bad');

    const wc = viem.createWalletClient({ account: signer, chain, transport: viem.custom(window.ethereum) });
    say('out', 'Approve the MetaMask popup…', 'warn');
    const sig = await wc.signTypedData(typed);

    // Attribute the signature BEFORE handing it over. If the wallet signed with
    // a different account, catch it here instead of returning a useless AA24.
    const recovered = await viem.recoverAddress({ hash: digest, signature: sig });
    if (recovered.toLowerCase() !== P.owner.toLowerCase()) {
      say('out', 'STOP: MetaMask signed as ' + recovered + ', not ' + P.owner + '. Nothing was sent. Switch accounts and sign again.', 'bad');
      return;
    }
    say('out', 'Signed by ' + recovered + ' ✓ — delivering…', 'warn');
    const r = await fetch('/signature', { method: 'POST', body: sig });
    say('out', r.ok ? 'Signature delivered ✓ Return to the terminal.' : 'POST failed.', r.ok ? 'ok' : 'bad');
  } catch (e) { say('out', 'Error: ' + (e.message || e), 'bad'); }
};
</script></body></html>`;

  // Never serve a page whose inline script does not parse — a syntax error in a
  // <script> silently kills every button with no visible message. `node --check`
  // on this file does NOT cover the template literal's contents, so check here.
  {
    const inline = html.match(/<script>([\s\S]*?)<\/script>/);
    if (inline) {
      try { new (require('vm').Script)(inline[1]); }
      catch (e) {
        console.error('❌ REFUSING TO SERVE: the inline script does not parse —');
        console.error('   ' + e.message);
        console.error('   Every button would be dead with no visible error.');
        process.exit(1);
      }
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // A cached build silently bypasses the signer/digest guards, which is how
        // a wrong-account signature got accepted twice. Always serve fresh.
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
      });
      return res.end(html);
    }
    if (req.method === 'POST' && req.url === '/signature') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', async () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        log(`\n   signature received: ${body}`);
        server.close();
        // splice the signature in and continue down the normal submit path
        args[args.indexOf('--serve')] = '--sig';
        args.push(body);
        await main();
        process.exit(0);
      });
    }
    res.writeHead(404); res.end();
  });

  server.listen(PORT, '127.0.0.1', () => {
    log('');
    log(`   Two steps in the browser:`);
    log(`     1. Fund the EntryPoint   (one-time, permissionless, ~0.05 TRUST)`);
    log(`     2. Sign the revoke UserOp (the authority)`);
    log('');
    log(`   Open:  http://127.0.0.1:${PORT}`);
    log(`   Connect as the Hybrid OWNER: ${MAIN}`);
    log(`   The page closes itself once the signature arrives.\n`);
  });
}

main().catch(e => {
  log('ERR', (e.message || String(e)).slice(0, 250));
  emit({ decision: 'halt', reason: (e.message || String(e)).slice(0, 250), tx: null });
  process.exit(1);
});

