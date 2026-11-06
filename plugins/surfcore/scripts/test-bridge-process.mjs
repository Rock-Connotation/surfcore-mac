import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'桥接 空格 $(touch INJECTED) '));
fs.mkdirSync(path.join(root,'src')); fs.mkdirSync(path.join(root,'state'));
const script=path.join(root,'src','bridge.js');
fs.writeFileSync(script, `const http=require('http'); const fs=require('fs'); const root=process.env.FIXTURE_ROOT; const cfg=JSON.parse(fs.readFileSync(root+'/config.json')); http.createServer((req,res)=>{ if(req.headers['x-console-token']!==cfg.consoleToken){res.writeHead(401);res.end();return;} if(fs.existsSync(root+'/swap-lock')) fs.writeFileSync(root+'/state/bridge.lock','2147483647'); res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({root})); }).listen(cfg.consolePort,'127.0.0.1');`);
const server=net.createServer(socket=>socket.end());
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({consolePort:port,consoleToken:'fixture-only-token'}));
process.env.SURFCORE_ROOT=root; process.env.DSH_HOME=path.join(root,'dsh');
const bridge=await import('../lib/bridge.js');
const {resolveNodeRuntime}=await import('../lib/paths.js');
const {inspectBridgeProcess}=await import('../lib/bridge-process.js');
let child;
const dead = c => c.exitCode !== null || c.signalCode !== null;
async function cleanup() { if(child && !dead(child)) { child.kill(); await once(child,'exit'); } child=null; }
try {
 const foreign=await bridge.start();
 assert.equal(foreign.ok,false,'foreign port must not report a bridge already running'); assert.ok(foreign.code && foreign.hint);
 await new Promise(r=>server.close(r));
 child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'}); await once(child,'spawn');
 fs.writeFileSync(path.join(root,'state','bridge.lock'),String(child.pid));
 let stopped=await bridge.stop(); assert.equal(stopped.ok,false,'unrelated live lock PID must not be killed'); assert.ok(stopped.code && stopped.hint); assert.ok(!dead(child)); await cleanup();
 fs.writeFileSync(path.join(root,'state','bridge.lock'),'2147483647');
 stopped=await bridge.stop(); assert.equal(stopped.ok,true); assert.equal(stopped.already,true); assert.ok(fs.existsSync(path.join(root,'state','bridge.lock')),'stale lock is not silently deleted');
 const runtime=resolveNodeRuntime();
 child=spawn(runtime.executable,[...runtime.argvPrefix,'--no-warnings',script],{env:{...process.env,...runtime.envPatch,FIXTURE_ROOT:root},stdio:'ignore'}); await once(child,'spawn');
 fs.writeFileSync(path.join(root,'state','bridge.lock'),String(child.pid));
 for(let i=0;i<100 && !(await bridge.portOpen(port));i++) await new Promise(r=>setTimeout(r,25));
 stopped=await bridge.stop(); assert.equal(stopped.ok,false,'authenticated listener with wrong argv must not be killed'); assert.ok(stopped.code && stopped.hint); assert.ok(!dead(child)); await cleanup();
 child=spawn(runtime.executable,[...runtime.argvPrefix,script],{env:{...process.env,...runtime.envPatch,FIXTURE_ROOT:root},stdio:'ignore'}); await once(child,'spawn');
 fs.writeFileSync(path.join(root,'state','bridge.lock'),String(child.pid));
 for(let i=0;i<100 && !(await bridge.portOpen(port));i++) await new Promise(r=>setTimeout(r,25));
 assert.equal(await bridge.portOpen(port),true,'fixture server started');
 const started=await bridge.start(); assert.equal(started.ok,true,JSON.stringify(started)); assert.equal(started.already,true);
 assert.equal(inspectBridgeProcess({pid:child.pid,port,runtime,script,platform:'darwin',execFile:()=>{throw Error('inspection unavailable')}}),false);
 fs.writeFileSync(path.join(root,'swap-lock'),''); stopped=await bridge.stop(); assert.equal(stopped.ok,false,'changed lock must invalidate ownership'); assert.ok(stopped.code && stopped.hint); assert.ok(!dead(child)); fs.unlinkSync(path.join(root,'swap-lock')); fs.writeFileSync(path.join(root,'state','bridge.lock'),String(child.pid));
 stopped=await bridge.stop(); assert.equal(stopped.ok,true,JSON.stringify(stopped)); assert.ok(dead(child)); child=null;
 assert.equal(fs.existsSync(path.join(process.cwd(),'INJECTED')),false,'command line must never be evaluated by shell');
 console.log('PASS foreign listener, unrelated PID, stale lock, authenticated owner, inspection failure, shell-safe paths');
} finally {
 if(server.listening) await new Promise(r=>server.close(r)); await cleanup(); fs.rmSync(root,{recursive:true,force:true});
}
