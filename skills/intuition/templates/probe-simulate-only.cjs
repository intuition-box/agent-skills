#!/usr/bin/env node
// redeem-delegation.cjs — Redeem a SIGNED delegation using the AGENT'S OWN OWS WALLET KEY.
//
// The delegation JSON comes from the signing page (Main Account signed via MetaMask popup;
// the page verified the signature on-chain before accepting). This script NEVER touches
// the Main Account key — it only sends redeemDelegations from ~/.intuition/agent-wallet.json.
//
// Usage:
//   node probe-simulate-only.cjs <signed-delegation.json> --op deposit [--amount 0.001] [--term 0xTRIPLE_ID]
//   node probe-simulate-only.cjs <signed-delegation.json> --op create-atom  [--atom-data <string>]
//   node probe-simulate-only.cjs <signed-delegation.json> --op create-triple --subject 0x.. --predicate 0x.. --object 0x..
//
// Ops:
//   deposit       — deposit tTRUST into a triple's vault (termId = triple ID), receiver = Main Account
//   create-atom   — create a new atom via the Hybrid (Hybrid pays atomCost from its balance)
//   create-triple — create a triple from (subject, predicate, object) atom IDs (Hybrid pays tripleCost)
//
// Steps: load JSON → validate signature on-chain (abort if invalid) → build calldata →
//        simulate → send from agent wallet → verify receipt → print created IDs from logs.
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
  if (!jsonPath) { console.error('Usage: node probe-simulate-only.cjs <signed-delegation.json> --op <deposit|create-atom|create-triple> [options]'); process.exit(1); }
  const getOpt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
  const op = getOpt('op', 'deposit');

  const provider = new ethers.JsonRpcProvider(RPC);
  const signed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const delegation = signed.delegation || signed;
  const hybrid = delegation.delegator;
  console.log('1. delegation loaded — delegator:', hybrid, '| op:', op);

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
  console.log('2. on-chain signature check:', check, check === '0x1626ba7e' ? '✅ VALID' : '❌ INVALID');
  if (check !== '0x1626ba7e') {
    console.error('   Re-sign via the signing page — it verifies before accepting.');
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
  console.log('3. calldata built:', calldata.length / 2, 'bytes | value:', ethers.formatEther(value), 'tTRUST from Hybrid');

  // 5. Simulate
  try {
    await provider.call({ from: AGENT, to: DELEGATION_MANAGER, data: '0x' + calldata });
    console.log('4. simulate: ✅ NO REVERT');
  } catch (e) {
    console.error('4. simulate: ❌ REVERTS —', (e.info?.error?.message || e.message).slice(0, 120));
    process.exit(1);
  }

  console.log('--- probe stopped before step 6 (no broadcast) ---');
}
main().catch(e=>{console.error('ERR', e.message.slice(0,200));});
