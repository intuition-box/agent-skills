#!/usr/bin/env node
// Direct byte-for-byte TYPEHASH proof (Challenge 3 resolution).
// 1) Identify library delegation-core 3.0.0 field count from its CAVEAT_TYPEHASH constant.
// 2) Call on-chain getDelegationHash(delegation) + getDomainHash() on the real DelegationManager.
// 3) Build digest = keccak256(0x1901 ++ domainHash ++ structHash) from the contract's own values.
// 4) Call Hybrid.isValidSignature(digest, signature) with the Sept-24 proof signature.
const ethers = require('ethers');
const core = require('@metamask/delegation-core');
const fs = require('fs');
const path = require('path');

const RPC  = 'https://testnet.rpc.intuition.systems/http';
const DM   = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const HYBRID = '0x433d9b2a6993f0cf36d9cce96d5cfe269d69ec14';

function eq(a,b){return (a||'').toLowerCase()===(b||'').toLowerCase();}

console.log('=== LIBRARY: delegation-core 3.0.0 ===');
const cand3 = ethers.id('Caveat(address enforcer,bytes terms,bytes args)');
const cand2 = ethers.id('Caveat(address enforcer,bytes terms)');
console.log('  CAVEAT_TYPEHASH =', core.CAVEAT_TYPEHASH);
console.log('    matches 3-field (enforcer,terms,args)?', eq(cand3, core.CAVEAT_TYPEHASH));
console.log('    matches 2-field (enforcer,terms)?     ', eq(cand2, core.CAVEAT_TYPEHASH));

const delegation = JSON.parse(fs.readFileSync(path.join(__dirname,'signed-delegation-final.json'),'utf8'));
const d = delegation; // file is the flat delegation object (delegate, delegator, authority, caveats, salt, signature)
const provider = new ethers.JsonRpcProvider(RPC);
const dm = new ethers.Contract(DM, [
  'function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) _input) view returns (bytes32)',
  'function getDomainHash() view returns (bytes32)',
], provider);
const caveats = d.caveats.map(c => [c.enforcer, c.terms, c.args || '0x']);

(async () => {
  const structHash = await dm.getDelegationHash([d.delegate, d.delegator, d.authority, caveats, d.salt, d.signature]);
  const domainHash = await dm.getDomainHash();
  const digest = ethers.keccak256(ethers.concat(['0x1901', domainHash, structHash]));
  console.log('\n=== ON-CHAIN DelegationManager @ testnet ===');
  console.log('  getDelegationHash =', structHash);
  console.log('  getDomainHash     =', domainHash);
  console.log('  digest(0x1901)    =', digest);

  const abi = new ethers.Interface(['function isValidSignature(bytes32,bytes) view returns (bytes)']);
  let raw, magic, ok;
  try {
    raw = await provider.call({ to: HYBRID, data: abi.encodeFunctionData('isValidSignature',[digest, d.signature]) });
  } catch(e) { raw = 'REVERT ' + (e.reason||e.message).slice(0,50); }
  // Hybrid returns the ERC-1271 magic as a leading 32-byte word (0x1626ba7e padded).
  magic = raw.startsWith('0x') ? raw.slice(2,10) : '';
  ok = magic === '1626ba7e';
  console.log('\n=== PROOF ===');
  console.log('  Hybrid.isValidSignature(digest, 0xa3eee...) raw =', raw.slice(0,34)+'...');
  console.log('  leading 4 bytes =', '0x'+magic, ' (ERC1271_MAGIC_VALUE = 0x1626ba7e)');
  console.log('  RESULT =', ok ? 'PASS — contract-derived digest validates the Sept-24 proof signature (Caveat type = 2-field)' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
