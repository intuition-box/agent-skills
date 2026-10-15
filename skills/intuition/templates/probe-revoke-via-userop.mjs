// probe-revoke-via-userop.mjs — READ-ONLY diagnostic for the ERC-4337 revoke path.
//
// Answers ONE question: if the Main account signs the UserOp, would the Hybrid
// actually call DelegationManager.disableDelegation and succeed?
//
// It answers it WITHOUT the signature and WITHOUT broadcasting, by exploiting
// the order of operations inside EntryPoint v0.7:
//
//   _validateAccountPrepayment -> sender.validateUserOp(op, hash, missingFunds)
//   _validateSignature        -> reads validationData; reverts AA24 if != 0
//   _validatePaymasterPrepayment
//   _executeUserOp
//
// validateUserOp returns validationData (0 = ok, 1 = bad signature). It does NOT
// revert on a bad signature — the Hybrid's _isValidSignature returns
// SIG_VALIDATION_FAILED (0xffffffff) and _validateUserOpSignature maps that to 1.
// So if we simulate with a DUMMY signature and the revert is AA24, we have proof
// that:
//   * the account ACCEPTED the UserOp (validateUserOp did not reject it), and
//   * the ONLY missing element is a real signature.
// If instead it reverts AA23, the account refused the op itself and the route is
// closed.
//
// Everything here is eth_call. Nothing is broadcast.
//
// Usage: node probe-revoke-via-userop.mjs

import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { ethers } = require('ethers');

const RPC = 'https://testnet.rpc.intuition.systems/http';
const HYBRID = '0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14';
const MAIN = '0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee';
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const DM = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';

const TUPLE = '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
// accountGasLimits = verificationGasLimit(HIGH 128) | callGasLimit(LOW 128).
// Getting this backwards sets verificationGasLimit = 0 and the account reverts on
// out-of-gas, which surfaces as a MISLEADING AA23.
const gasLimits = (ver, call) => ethers.concat([
  ethers.zeroPadValue(ethers.toBeHex(BigInt(ver)), 16),
  ethers.zeroPadValue(ethers.toBeHex(BigInt(call)), 16),
]);

// ── the inner revoke call, wrapped so the Hybrid is msg.sender ───────────────
const raw = JSON.parse(fs.readFileSync('./signed-delegation-final.json', 'utf8'));
const d = raw.delegation || raw;
const dis = new ethers.Interface([
  'function disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))',
]);
const innerCall = dis.encodeFunctionData('disableDelegation', [[
  d.delegate, d.delegator, d.authority,
  d.caveats.map(c => [c.enforcer, c.terms, c.args ?? '0x']),
  BigInt(d.salt), d.signature,
]]);
const ex = new ethers.Interface([
  'function execute((address target,uint256 value,bytes callData)) payable',
]);
const callData = ex.encodeFunctionData('execute', [{ target: DM, value: 0, callData: innerCall }]);

const op = {
  sender: HYBRID,
  nonce: 0n,
  initCode: '0x',
  callData,
  accountGasLimits: gasLimits(1_000_000, 400_000),
  preVerificationGas: 60_000n,
  gasFees: ethers.concat([
    ethers.zeroPadValue(ethers.toBeHex(100_000_000n), 16), // maxPriorityFeePerGas
    ethers.zeroPadValue(ethers.toBeHex(100_000_000n), 16), // maxFeePerGas
  ]),
  paymasterAndData: '0x',
  signature: '0x',   // deliberate dummy
};

const epIface = new ethers.Interface(['function handleOps(' + TUPLE + '[],address)']);
const calldata = epIface.encodeFunctionData('handleOps', [[op], MAIN]);

// ── raw eth_call so the revert bytes are not mangled by an error wrapper ────
function rawEthCall() {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ from: MAIN, to: EP, data: calldata }, 'latest'],
  });
  const out = execFileSync('curl', ['-s', '--max-time', '45', '-X', 'POST',
    '-H', 'Content-Type: application/json', '-d', body, RPC], { encoding: 'utf8' });
  return JSON.parse(out);
}

const errIface = new ethers.Interface([
  'error FailedOp(uint256 opCode,string reason)',
  'error FailedOpWithRevert(uint256 opCode,string reason,bytes inner)',
]);

console.log('=== the UserOp that would revoke (dummy signature, read-only) ===\n');
console.log('  sender   ', op.sender, ' (the Hybrid == the delegator)');
console.log('  nonce    ', op.nonce.toString());
console.log('  callData ', op.callData.slice(0, 10), '= execute((DelegationManager, 0, disableDelegation(...)))');
console.log('  verGas   ', (BigInt(op.accountGasLimits) >> 128n).toString());
console.log('  callGas  ', (BigInt(op.accountGasLimits) & ((1n << 128n) - 1n)).toString());
console.log('  signature', '(none — diagnostic)');
console.log('');

const res = rawEthCall();
const hex = res?.error?.data ?? null;

if (!res.error) {
  console.log('  RESULT: no revert. Simulation SUCCEEDED with a dummy signature.');
  console.log('  Report this; do not assume it means the signature is skipped.');
} else {
  console.log('  selector:', hex ? hex.slice(0, 10) : '(none)', '—', res.error.message.split('\n')[0].slice(0, 60));
  let reason = null, opCode = null, inner = null;
  if (hex) {
    try {
      const p = errIface.parseError(hex);
      opCode = String(p.args[0]); reason = p.args[1];
      inner = p.args[2] !== undefined ? p.args[2] : null;
    } catch { /* leave null */ }
  }
  if (reason) {
    console.log('  FailedOp opCode =', opCode, '| reason =', JSON.stringify(reason));
    if (inner !== null) console.log('  inner revert     =', inner === '0x' ? '<empty>' : inner);
    console.log('');
    if (/AA24/.test(reason)) {
      console.log('  >>> GATE REACHED: signature validation.');
      console.log('  >>> validateUserOp RETURNED validationData=1 — it did NOT reject the op.');
      console.log('  >>> The account ACCEPTED this UserOp. Only Main\'s signature is missing.');
      console.log('  >>> CONCLUSION: the ERC-4337 revoke path is OPEN.');
    } else if (/AA23/.test(reason)) {
      console.log('  >>> the Account REVERTED inside validateUserOp (or execution reverted).');
      console.log('  >>> Account did not accept the op. Revoke via UserOp is CLOSED.');
    } else if (/AA21|AA22|deposit|prefund/i.test(reason)) {
      console.log('  >>> funding/deposit gate only — fund the EntryPoint deposit and retry.');
    } else {
      console.log('  >>> INCONCLUSIVE — inspect before drawing a conclusion.');
    }
  }
}

console.log('');
console.log('=== to actually settle it: what Main must sign ===\n');
const hybridC = new ethers.Contract(HYBRID, [
  'function getPackedUserOperationTypedDataHash(' + TUPLE + ') view returns (bytes32)',
  'function eip712Domain() view returns (bytes1,string,string,uint256,bytes32)',
], new ethers.JsonRpcProvider(RPC));
const digest = await hybridC.getPackedUserOperationTypedDataHash(op);
const dom = await hybridC.eip712Domain();
console.log('  domain : { name:', JSON.stringify(dom[1]) + ', version:', JSON.stringify(dom[2]) + ',');
console.log('            chainId:', dom[3].toString() + ', verifyingContract:', HYBRID + ' }');
console.log('  message: PackedUserOperation (sender, nonce, initCode, callData,');
console.log('           accountGasLimits, preVerificationGas, gasFees, paymasterAndData, signature)');
console.log('  digest :', digest);
console.log('  signer :', MAIN, '(the Hybrid OWNER — NOT the delegator)');
console.log('');
console.log('  Fund the EntryPoint first, or the op cannot pay prefund:');
console.log('    cast send $EP "depositTo(address)" ' + HYBRID + ' --value 0.05ether --private-key <agentKey>');
console.log('');
console.log('  Then re-run this script with the signature appended and read the gate.');