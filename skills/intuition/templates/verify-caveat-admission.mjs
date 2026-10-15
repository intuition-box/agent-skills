// verify-caveat-admission.mjs — does a caveat set ADMIT the deposit, independent of signature?
// Simulates redeemDelegations and reports WHERE each delegation fails:
//   NO REVERT  -> fully redeemable
//   0x155ff427 -> InvalidERC1271Signature: all enforcers PASSED, only the signature is wrong
//   0x08c379a0+Error(string):<Name> -> an ENFORCER rejected it (caveat problem)
// This separates "the caveats are wrong" from "the signature is wrong" — the two look
// identical from the page, where isValidSignature only covers the second.
// Usage (from templates/): node verify-caveat-admission.mjs

import { readFileSync } from 'fs';
const ethers=(await import('ethers')).default ?? (await import('ethers'));
const path=await import('path');
const fs=await import('fs');
const DM='0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const MV='0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91';
const MAIN='0x61A20dE84D7E5C422Af323D47497ED3bf43Fa5ee';
const AGENT='0xe9BfdEC6Fa795a24e3069292248d9d16570E050d';
const RPC='https://testnet.rpc.intuition.systems/http';
const provider=new ethers.JsonRpcProvider(RPC);
const { createRequire } = await import('module');
const req = createRequire(import.meta.url);
const core = req('./node_modules/@metamask/delegation-core/dist/index.cjs');
function encodeBytesArray(elements){const N=elements.length;let head=N.toString(16).padStart(64,'0');let offsets=[],tailLen=0;
 for(const el of elements){offsets.push(32*N+tailLen);tailLen+=32+Math.ceil(el.length/64)*64;}
 head+=offsets.map(o=>o.toString(16).padStart(64,'0')).join('');let tail='';
 for(const el of elements){tail+=(el.length/2).toString(16).padStart(64,'0');tail+=el.padEnd(Math.ceil(el.length/64)*64,'0');}
 return head+tail;}
const T='88c64e37687bf17f7bc1fbc449ea700910cf7e80a92ab4d0fa3ae9d9eb15ae65';
async function sim(file,label){
 const d=JSON.parse(fs.readFileSync(file,'utf8'));
 const value=ethers.parseEther('0.001');
 const inner='2fb1d270'+MAIN.toLowerCase().replace('0x','').padStart(64,'0')+T.padStart(64,'0')+'1'.padStart(64,'0')+'0'.repeat(64);
 const execution=MV.toLowerCase().replace('0x','')+value.toString(16).padStart(64,'0')+inner;
 const pc=core.encodeDelegations([d]);
 const ctx=encodeBytesArray([pc.slice(2)]);
 const modes='0'.repeat(63)+'1'+'0'.repeat(64);
 const ex=encodeBytesArray([execution]);
 const o1=96,o2=o1+ctx.length/2,o3=o2+modes.length/2;
 const calldata='cef6d209'+[o1,o2,o3].map(o=>o.toString(16).padStart(64,'0')).join('')+ctx+modes+ex;
 try{ await provider.call({from:AGENT,to:DM,data:'0x'+calldata});
   console.log(label.padEnd(34),'-> NO REVERT ✓ (caveats admit deposit)');
 }catch(e){
   const dt=e.info?.error?.data;
   const msg=e.info?.error?.message||e.message;
   const named=msg.match(/Error\(string\): (\w+)/)?.[1]|| (dt?String(dt).slice(0,10):'');
   console.log(label.padEnd(34),'->', named||msg.slice(0,40));
 }
}
await sim('./caveat-probe.json','FIXED caveats (ValueLte=max)');
await sim('./signed-sdk-in.json','USER caveats (ValueLte=0)');
await sim('./signed-delegation-final.json','FIXTURE (known-good)');
