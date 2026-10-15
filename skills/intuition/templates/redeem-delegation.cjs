#!/usr/bin/env node
// redeem-delegation.cjs — Redeem a SIGNED delegation using the AGENT'S OWN OWS WALLET KEY.
//
// The delegation JSON comes from the signing page (Main Account signed via MetaMask popup;
// the page verified the signature on-chain before accepting). This script NEVER touches
// the Main Account key — it only sends redeemDelegations from ~/.intuition/agent-wallet.json.
//
// ⚠️ DEFAULT IS DRY-RUN. This script SIMULATES unless you pass --broadcast.
//    A bare `node redeem-delegation.cjs ...` sends a real transaction (spends Hybrid tTRUST).
//
// Usage:
//   node redeem-delegation.cjs <signed-delegation.json> --op deposit [--amount 0.001] [--term 0xTRIPLE_ID]
//   node redeem-delegation.cjs <signed-delegation.json> --op create-atom  [--atom-data <string>]
//   node redeem-delegation.cjs <signed-delegation.json> --op create-triple --subject 0x.. --predicate 0x.. --object 0x..
//
// Modes:
//   --dry-run     (DEFAULT) simulate only, emit JSON, broadcast nothing
//   --broadcast   opt in to the real send; requires --yes as a second acknowledgement
//
// Output: a single JSON object on stdout (see RESULT_SCHEMA below) so an agent never
// has to parse prose. RESULT_SCHEMA:
//   { tool, mode, op, decision:'proceed'|'halt', reason, chainId, agent, delegator,
//     delegate, calldataBytes, valueTuthwei, simulation:{ok,error,errorName,raw},
//     tx:{hash,status,blockNumber,gasUsed}|null }
//
// Ops:
//   deposit       — deposit tTRUST into a triple's vault (termId = triple ID), receiver = Main Account
//   create-atom   — create a new atom via the Hybrid (Hybrid pays atomCost from its balance)
//   create-triple — create a triple from (subject, predicate, object) atom IDs (Hybrid pays tripleCost)
//
// Steps: load JSON → validate signature on-chain (abort if invalid) → build calldata →
//        simulate → (STOP, default) → send from agent wallet → verify receipt → print created IDs.
const ethers = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = 'https://testnet.rpc.intuition.systems/http';
const DELEGATION_MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const MULTIVAULT = '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91';
const AGENT = '0xe9BfdEC6Fa795a24e3069292248d9d16570E050d';
const MAIN = '0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee';
const ATOM_COST = 1000000001000000n;
const TRIPLE_COST = 1000000002000000n;
const CURVE_ID = 1n;

function encodeBytesArray(elements) {
  const N = elements.length;
  let head = N.toString(16).padStart(64, '0');
  let offsets = [], tailLen = 0;
  for (const el of elements) {
    offsets.push(32 * N + tailLen); // relative to after-length
    tailLen += 32 + Math.ceil(el.length / 64) * 64;
  }
  head += offsets.map(o => o.toString(16).padStart(64, '0')).join('');
  let tail = '';
  for (const el of elements) {
    tail += (el.length / 2).toString(16).padStart(64, '0');
    tail += el.padEnd(Math.ceil(el.length / 64) * 64, '0');
  }
  return head + tail;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonPath = args.find(a => !a.startsWith('--'));
  if (!jsonPath) { console.error('Usage: node redeem-delegation.cjs <signed-delegation.json> --op <deposit|create-atom|create-triple> [options]'); process.exit(1); }
  const getOpt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
  const hasFlag = (name) => args.includes('--' + name);
  const op = getOpt('op', 'deposit');

  // ── BROADCAST GATE ────────────────────────────────────────────────────────────
  // Default is dry-run. Two independent flags are required to move real value,
  // so a single stray flag in a script or a shell-history paste cannot send.
  const broadcast = hasFlag('broadcast');
  const acknowledged = hasFlag('yes');
  const mode = broadcast ? 'broadcast' : 'dry-run';
  if (broadcast && !acknowledged) {
    console.error('❌ REFUSING TO BROADCAST: --broadcast requires --yes as an explicit second acknowledgement.');
    console.error('   Re-run with --dry-run to simulate only (the default).');
    process.exit(2);
  }
  const result = {
    tool: 'redeem-delegation.cjs', mode, op, chainId: 13579,
    agent: AGENT, main: MAIN, delegator: null, delegate: null,
    calldataBytes: 0, valueTuthwei: '0', valueTrusted: '0',
    decision: 'proceed', reason: '',
    simulation: { ok: null, error: null, errorName: null, raw: null },
    signatureCheck: null, tx: null, createdIds: [],
  };
  // Emit JSON on every exit path so a caller can parse without reading prose.
  const emit = (extra) => {
    if (extra) Object.assign(result, extra);
    console.log(JSON.stringify(result, null, 2));
  };

  const provider = new ethers.JsonRpcProvider(RPC);
  const signed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const delegation = signed.delegation || signed;
  const hybrid = delegation.delegator;
  result.delegator = hybrid; result.delegate = delegation.delegate;
  const log = (...a) => console.error(...a);   // human output → stderr, JSON stays clean on stdout
  log(`1. delegation loaded — delegator: ${hybrid} | op: ${op} | mode: ${mode}`);

  // 2. Validate the signature ON-CHAIN (the same check the page did before accepting)
  const dm = new ethers.Contract(DELEGATION_MANAGER, [
    'function getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes) _input) view returns (bytes32)',
    'function getDomainHash() view returns (bytes32)',
  ], provider);
  const structHash = await dm.getDelegationHash([
    delegation.delegate, delegation.delegator, delegation.authority,
    delegation.caveats.map(c => [c.enforcer, c.terms, c.args || '0x']),
    delegation.salt, delegation.signature,
  ]);
  const domainHash = await dm.getDomainHash();
  const digest = ethers.keccak256(ethers.concat(['0x1901', domainHash, structHash]));
  const hybridC = new ethers.Contract(hybrid, ['function isValidSignature(bytes32,bytes) view returns (bytes4)'], provider);
  const check = await hybridC.isValidSignature(digest, delegation.signature);
  const sigValid = check === '0x1626ba7e';
  result.signatureCheck = { magic: check, valid: sigValid, digest, structHash };
  log(`2. on-chain signature check: ${check} ${sigValid ? '✅ VALID' : '❌ INVALID'}`);
  if (!sigValid) {
    // 0xffffffff here = the SIGNATURE/DIGEST is wrong, not the caveats. Different failure
    // class from a caveat revert — see operations/create-delegation.md error table.
    emit({ decision: 'reject', reason: 'InvalidERC1271Signature: digest/signature mismatch. isValidSignature returned ' + check + ' instead of 0x1626ba7e.' });
    log('   Re-sign via the signing page — it verifies before accepting.');
    process.exit(1);
  }

  // 3. Build the inner execution (to + value + calldata, raw concat — proven format)
  let value, innerCalldata;
  if (op === 'deposit') {
    value = ethers.parseEther(getOpt('amount', '0.001'));
    const term = getOpt('term', '').replace('0x', '').toLowerCase();
    if (!term || term.length !== 64) { console.error('   --term 0x<tripleId> required for deposit'); process.exit(1); }
    // deposit(address receiver, bytes32 termId, uint256 curveId, uint256 minShares) — minShares=0 (proven on-chain)
    innerCalldata = '2fb1d270' +
      MAIN.toLowerCase().replace('0x', '').padStart(64, '0') +
      term.padStart(64, '0') +
      CURVE_ID.toString(16).padStart(64, '0') +
      '0000000000000000000000000000000000000000000000000000000000000000';
  } else if (op === 'create-atom') {
    value = ATOM_COST;
    const atomData = ethers.hexlify(ethers.toUtf8Bytes(getOpt('atom-data', 'agent-atom-' + Date.now())));
    const iface = new ethers.Interface(['function createAtoms(bytes[],uint256[]) payable']);
    const encoded = iface.encodeFunctionData('createAtoms', [[atomData], [ATOM_COST]]).slice(2);
    // strip the selector from encodeFunctionData output? No — keep it: it IS the calldata
    innerCalldata = encoded;
  } else if (op === 'create-triple') {
    value = TRIPLE_COST;
    const s = getOpt('subject', ''), p = getOpt('predicate', ''), o = getOpt('object', '');
    for (const [name, v] of [['subject', s], ['predicate', p], ['object', o]]) {
      if (!v.startsWith('0x') || v.length !== 66) { console.error('   --' + name + ' 0x<64-hex> required'); process.exit(1); }
    }
    const iface = new ethers.Interface(['function createTriples(bytes32[],bytes32[],bytes32[],uint256[]) payable']);
    innerCalldata = iface.encodeFunctionData('createTriples', [[s], [p], [o], [TRIPLE_COST]]).slice(2);
  } else { console.error('   unknown op:', op); process.exit(1); }

  result.valueTuthwei = value.toString();
  result.valueTrusted = ethers.formatEther(value);

  const execution = MULTIVAULT.toLowerCase().replace('0x', '') + value.toString(16).padStart(64, '0') + innerCalldata;

  // 4. Assemble redeemDelegations calldata (proven framing)
  const core = require(path.join(__dirname, 'node_modules/@metamask/delegation-core/dist/index.cjs'));
  const permissionContext = core.encodeDelegations([delegation]);
  const ctxArray = encodeBytesArray([permissionContext.slice(2)]);
  const modesArray = '0000000000000000000000000000000000000000000000000000000000000001' +
                     '0000000000000000000000000000000000000000000000000000000000000000';
  const execArray = encodeBytesArray([execution]);
  const offCtx = 96, offModes = offCtx + ctxArray.length / 2, offExecs = offModes + modesArray.length / 2;
  const calldata = 'cef6d209' +
    offCtx.toString(16).padStart(64, '0') + offModes.toString(16).padStart(64, '0') + offExecs.toString(16).padStart(64, '0') +
    ctxArray + modesArray + execArray;
  result.calldataBytes = calldata.length / 2;
  log(`3. calldata built: ${result.calldataBytes} bytes | value: ${result.valueTrusted} tTRUST from Hybrid`);

  // 5. Simulate — this is the authoritative gate. A simulation that reverts here would
  //    revert on-chain too, so dry-run and broadcast reach the same verdict.
  let simOk = false, simErr = null, simName = null;
  try {
    await provider.call({ from: AGENT, to: DELEGATION_MANAGER, data: '0x' + calldata });
    simOk = true;
    log('4. simulate: ✅ NO REVERT');
  } catch (e) {
    const msg = e.info?.error?.message || e.message || String(e);
    simErr = msg.slice(0, 300);
    simName = msg.match(/Error\(string\): (\w+)/)?.[1] || msg.match(/0x[0-9a-f]{8}/)?.[0] || null;
    log(`4. simulate: ❌ REVERTS — ${simName || simErr.slice(0, 80)}`);
  }
  result.simulation = { ok: simOk, error: simErr, errorName: simName, raw: calldata.slice(0, 10) };

  if (!simOk) {
    // A revert here is a CAVEAT/authority rejection (the enforcer's own selector, e.g.
    // CannotUseADisabledDelegation 0x05baa052), distinct from the signature failure above.
    emit({ decision: 'halt', reason: `Simulation reverted (${simName || 'unknown'}): ${simErr}` });
    process.exit(1);
  }

  // ── DRY-RUN STOP ──────────────────────────────────────────────────────────────
  // Everything above this line is read-only. Nothing below runs unless the caller
  // explicitly passed BOTH --broadcast and --yes.
  if (!broadcast) {
    emit({ decision: 'proceed', reason: 'Simulation passed. Nothing broadcast (dry-run default). Re-run with --broadcast --yes to send.' });
    log('--- dry-run: simulation passed, no transaction sent ---');
    return;
  }

  // 6. Send from the AGENT'S OWS WALLET (the only key this script uses)
  const agentWallet = new ethers.Wallet(JSON.parse(fs.readFileSync(process.env.HOME + '/.intuition/agent-wallet.json', 'utf8')).privateKey, provider);
  if (agentWallet.address.toLowerCase() !== AGENT.toLowerCase()) {
    emit({ decision: 'halt', reason: 'agent wallet mismatch: ~/.intuition/agent-wallet.json does not hold ' + AGENT });
    process.exit(1);
  }
  const tx = await agentWallet.sendTransaction({ to: DELEGATION_MANAGER, data: '0x' + calldata, gasLimit: 800000, gasPrice: 100000000n, chainId: 13579 });
  log(`5. tx sent (agent OWS wallet): ${tx.hash}`);
  const receipt = await tx.wait();
  log(`6. status: ${receipt.status === 1 ? '✅ SUCCESS' : '❌ FAILED'} | block: ${receipt.blockNumber} | gas: ${receipt.gasUsed}`);

  // 7. Extract created IDs from logs (bytes32 candidates)
  const known = new Set([delegation.salt.toLowerCase(), structHash.toLowerCase(), digest.toLowerCase()]);
  const ids = [];
  for (const entry of receipt.logs) {
    log(`   log: ${entry.address} ${entry.topics[0].slice(0, 22)}...`);
    for (const t of entry.topics.slice(1)) {
      if (t.length === 66 && !known.has(t.toLowerCase())) ids.push(t);
    }
    if (entry.data !== '0x' && entry.data.length >= 66) {
      for (let i = 2; i + 64 <= entry.data.length; i += 64) {
        const w = '0x' + entry.data.slice(i, i + 64);
        if (!known.has(w.toLowerCase()) && !/^0x0+$/.test(w) && BigInt(w) !== CURVE_ID) ids.push(w);
      }
    }
  }
  const ok = receipt.status === 1;
  emit({
    decision: ok ? 'proceed' : 'halt',
    reason: ok ? 'Broadcast succeeded.' : 'Broadcast transaction reverted on-chain.',
    tx: { hash: tx.hash, status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() },
    createdIds: ids,
  });
}
main().catch(e => {
  console.error('❌', (e.message || String(e)).slice(0, 250));
  console.log(JSON.stringify({ tool: 'redeem-delegation.cjs', decision: 'halt', reason: (e.message || String(e)).slice(0, 250), tx: null }, null, 2));
  process.exit(1);
});
