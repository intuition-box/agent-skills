// probe-value-lte-footgun.mjs — SINGLE-VARIABLE reproducer for the valueLte=0n footgun.
//
// ScopeType.FunctionCall normalises with `config.valueLte ?? { maxValue: 0n }`.
// There is no unlimited default, so a scope that omits valueLte silently caps
// value at ZERO: every value-bearing call reverts WHILE isValidSignature still
// returns 0x1626ba7e. That combination is the whole trap — a green signature
// check on a permanently unredeemable delegation.
//
// This proves it by holding everything constant except one caveat term:
//   A) terms untouched (ValueLte = 2^255-1)  -> expect NO REVERT
//   B) terms = 0                             -> expect revert
//
// READ-ONLY: eth_call only. It cannot broadcast, move funds, or change state.
//
// Usage (from templates/): node probe-value-lte-footgun.mjs [signed-delegation.json]

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const ethers = (await import('ethers')).default ?? (await import('ethers'));
const req = createRequire(import.meta.url);
const core = req('./node_modules/@metamask/delegation-core/dist/index.cjs');
const fs = await import('fs');

const DM   = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const MV    = '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91';
const MAIN  = '0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee';
const AGENT = '0xe9BfdEC6Fa795a24e3069292248d9d16570E050d';
const VALUE_LTE_ENFORCER = '0x92bf12322527caa612fd31a0e810472bbb106a8f';
const provider = new ethers.JsonRpcProvider('https://testnet.rpc.intuition.systems/http');

function encodeBytesArray(elements) {
  const N = elements.length;
  let head = N.toString(16).padStart(64, '0'), offsets = [], tailLen = 0;
  for (const el of elements) { offsets.push(32 * N + tailLen); tailLen += 32 + Math.ceil(el.length / 64) * 64; }
  head += offsets.map(o => o.toString(16).padStart(64, '0')).join('');
  let tail = '';
  for (const el of elements) {
    tail += (el.length / 2).toString(16).padStart(64, '0');
    tail += el.padEnd(Math.ceil(el.length / 64) * 64, '0');
  }
  return head + tail;
}

// Known-good triple used by the fixture.
const T = '88c64e37687bf17f7bc1fbc449ea700910cf7e80a92ab4d0fa3ae9d9eb15ae65';
const value = ethers.parseEther('0.001');
const inner = '2fb1d270' + MAIN.toLowerCase().replace('0x', '').padStart(64, '0') + T.padStart(64, '0') + '1'.padStart(64, '0') + '0'.repeat(64);
const execution = MV.toLowerCase().replace('0x', '') + value.toString(16).padStart(64, '0') + inner;

function calldataFor(d) {
  const pc = core.encodeDelegations([d]);
  const ctx = encodeBytesArray([pc.slice(2)]);
  const modes = '0'.repeat(63) + '1' + '0'.repeat(64);
  const ex = encodeBytesArray([execution]);
  const o1 = 96, o2 = o1 + ctx.length / 2, o3 = o2 + modes.length / 2;
  return 'cef6d209' + [o1, o2, o3].map(o => o.toString(16).padStart(64, '0')).join('') + ctx + modes + ex;
}

async function sim(d, label) {
  try {
    await provider.call({ from: AGENT, to: DM, data: '0x' + calldataFor(d) });
    console.log(label.padEnd(46), '-> NO REVERT');
    return 'pass';
  } catch (e) {
    const msg = e.info?.error?.message || e.message || String(e);
    const named = msg.match(/Error\(string\): (\w+)/)?.[1] || msg.match(/0x[0-9a-f]{8}/)?.[0];
    console.log(label.padEnd(46), '->', named || msg.slice(0, 60));
    return named || msg.slice(0, 40);
  }
}

const file = process.argv[2] || './signed-delegation-final.json';
const base = JSON.parse(fs.readFileSync(file, 'utf8'));
const variant = JSON.parse(JSON.stringify(base));
const cav = variant.caveats.find(c => c.enforcer.toLowerCase() === VALUE_LTE_ENFORCER);
if (!cav) { console.error('fixture has no ValueLte caveat — cannot run the falsifier'); process.exit(2); }
console.log('fixture ValueLte terms:', cav.terms);
console.log('');

const a = await sim(base, 'A) ValueLte = max  (2^255-1), deposit 0.001');
cav.terms = '0x' + '0'.repeat(64);
const b = await sim(variant, 'B) ValueLte = 0n                 , deposit 0.001');

console.log('');
if (a === 'pass' && b !== 'pass') {
  console.log('RESULT: FOOTGUN CONFIRMED — identical delegation, identical call,');
  console.log('        only ValueLte differs. valueLte=0n reverts value-bearing calls.');
  process.exit(0);
} else if (a === 'pass' && b === 'pass') {
  console.log('RESULT: FOOTGUN NOT REPRODUCED — ValueLte=0n did NOT block this deposit.');
  console.log('        Do not document it as a fact without a narrower reproducer.');
  process.exit(1);
} else {
  console.log('RESULT: INCONCLUSIVE — control A did not pass; the fixture/signature is stale.');
  process.exit(2);
}
