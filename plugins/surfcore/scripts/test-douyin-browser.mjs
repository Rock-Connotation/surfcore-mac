import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDouyinBrowser } from '../lib/douyin-browser.mjs';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'douyin-browser-test-'));
const executable = path.join(root, 'fake-browser');
const fakeJs = path.join(root, 'fake-browser.cjs');
fs.writeFileSync(fakeJs, `const fs = require('node:fs');
const read = fs.createReadStream(null, { fd: 3 });
const write = fs.createWriteStream(null, { fd: 4 });
fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify({args:process.argv.slice(2), electron:process.env.ELECTRON_RUN_AS_NODE}));
let buf=Buffer.alloc(0);
function send(o,split=false) { const b=Buffer.from(JSON.stringify(o)+'\\0'); if(split) { const i=b.indexOf(Buffer.from('中'))+1; write.write(b.subarray(0,i)); write.write(b.subarray(i)); } else write.write(b); }
read.on('data', c => { buf=Buffer.concat([buf,c]); let n; while ((n=buf.indexOf(0))>=0) { let m=JSON.parse(buf.subarray(0,n)); buf=buf.subarray(n+1); let result={};
if(m.method==='Target.createTarget') result={targetId:'target'};
if(m.method==='Target.attachToTarget') result={sessionId:'session'};
if(m.method==='Runtime.evaluate') result={result:{value:JSON.stringify({title:'中文',url:'https://www.douyin.com/?secret=hidden',text:'正文'})}};
if(m.method==='Page.captureScreenshot') result={data:'cG5n'};
if(m.method==='Network.getResponseBody') result={body:JSON.stringify({item:'中文'})};
if(m.method==='Page.navigate') { fs.writeFileSync(process.env.FAKE_URL,m.params.url); setTimeout(()=>{ for(const [id,url,size] of [['good','https://www.douyin.com/aweme/v1/web/tab/feed/?secret=hidden',10],['bad','https://evil.example/aweme/v1/web/tab/feed/',10],['large','https://www.douyin.com/aweme/v1/web/tab/feed/',3000000],['other','https://www.douyin.com/private',10]]) { send({sessionId:'session',method:'Network.requestWillBeSent',params:{requestId:id,request:{url}}}); send({sessionId:'session',method:'Network.responseReceived',params:{requestId:id,response:{url,status:200,mimeType:'application/json'}}}); send({sessionId:'session',method:'Network.loadingFinished',params:{requestId:id,encodedDataLength:size}}); } const url='https://www.douyin.com/aweme/v1/web/tab/feed/'; for (const id of ['missing','redirect','wrong-session']) { if(id!=='missing') send({sessionId:id==='wrong-session'?'other':'session',method:'Network.requestWillBeSent',params:{requestId:id,request:{url}}}); if(id==='redirect') send({sessionId:'session',method:'Network.requestWillBeSent',params:{requestId:id,request:{url},redirectResponse:{}}}); send({sessionId:'session',method:'Network.responseReceived',params:{requestId:id,response:{url,status:200,mimeType:'application/json'}}}); send({sessionId:'session',method:'Network.loadingFinished',params:{requestId:id,encodedDataLength:10}}); } }, 10); }
if(m.method==='Browser.close') { send({id:m.id,result}); setTimeout(()=>process.exit(0),20); continue; }
if(process.env.FAKE_TIMEOUT && m.method==='Page.captureScreenshot') continue;
if(process.env.FAKE_ERROR && m.method==='Page.captureScreenshot') { send({id:m.id,error:{code:-1,message:'private'}}); continue; }
send({id:m.id,result},m.method==='Runtime.evaluate');
} });
`);
fs.writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${fakeJs}' "$@"\n`);
fs.chmodSync(executable, 0o700);
process.env.FAKE_ARGS = path.join(root, 'args'); process.env.FAKE_URL = path.join(root, 'url'); process.env.ELECTRON_RUN_AS_NODE = '1';
const profile = path.join(root, 'profile');
const received = [], requests = [];
const browser = createDouyinBrowser({ profileDir: profile, browserPath: executable, onResponse: (body, meta) => received.push({ body, meta }), onRequest: meta => requests.push(meta), timeouts: { command: 2000, close: 1000 } });
const started = await browser.start(); if (!started.ok) console.error(started); assert.equal(started.ok, true);
assert.equal(fs.readFileSync(process.env.FAKE_URL, 'utf8'), 'https://www.douyin.com/');
const args = JSON.parse(fs.readFileSync(process.env.FAKE_ARGS));
assert(args.args.includes('--remote-debugging-pipe')); assert(!args.args.some(x => x.includes('remote-debugging-port'))); assert.equal(args.electron, undefined);
assert.equal(fs.statSync(profile).mode & 0o077, 0);
const duplicate = createDouyinBrowser({ profileDir: profile, browserPath: executable });
const locked = await duplicate.start(); assert.equal(locked.code, 'PROFILE_LOCKED'); assert(locked.hint);
await new Promise(resolve => setTimeout(resolve, 70));
assert.equal(received.length, 1); assert(browser.status().requestSeq >= received[0].meta.requestSeq); assert.equal(received[0].body.item, '中文'); assert.equal(received[0].meta.requestId, 'good'); assert.equal(received[0].meta.sessionId, 'session'); assert(received[0].meta.requestSeq > 0 && received[0].meta.requestStartedAt > 0); assert(!JSON.stringify(requests).includes('secret'));
const snap = await browser.snapshot(); assert.equal(snap.title, '中文'); assert.equal(snap.url, 'https://www.douyin.com/');
assert.equal((await browser.screenshot()).png, 'cG5n'); assert((await browser.reload()).ok);
fs.writeFileSync(path.join(profile, 'login-data'), 'keep');
const closed = await browser.close(); if (!closed.ok) console.error(closed); assert(closed.ok); assert(fs.existsSync(path.join(profile, 'login-data'))); assert(!fs.existsSync(path.join(profile, '.surfcore-douyin.lock')));
const absent = await browser.snapshot(); assert.equal(absent.code, 'BROWSER_NOT_RUNNING'); assert(absent.error && absent.hint);
const foreign = path.join(root, 'foreign'); fs.mkdirSync(foreign, {mode: 0o700}); fs.writeFileSync(path.join(foreign, 'existing'), 'keep');
const rejected = await createDouyinBrowser({profileDir: foreign, browserPath: executable}).start(); assert.equal(rejected.code, 'PROFILE_FOREIGN'); assert(rejected.hint); assert.equal(fs.readFileSync(path.join(foreign, 'existing'), 'utf8'), 'keep');
const unsafe = path.join(root, 'link'); fs.symlinkSync(profile, unsafe); assert.equal((await createDouyinBrowser({profileDir: unsafe, browserPath: executable}).start()).code, 'PROFILE_UNSAFE');
process.env.FAKE_TIMEOUT = '1';
const timeoutBrowser = createDouyinBrowser({profileDir: profile, browserPath: executable, timeouts: {command: 500, close: 1000}});
assert((await timeoutBrowser.start()).ok); const timed = await timeoutBrowser.screenshot(); assert.equal(timed.code, 'CDP_TIMEOUT'); assert(timed.hint); assert((await timeoutBrowser.close()).ok);
delete process.env.FAKE_TIMEOUT; process.env.FAKE_ERROR = '1';
const errorBrowser = createDouyinBrowser({profileDir: profile, browserPath: executable, timeouts: {command: 2000, close: 1000}});
assert((await errorBrowser.start()).ok); const failed = await errorBrowser.screenshot(); assert.equal(failed.code, 'CDP_ERROR'); assert(failed.hint && !failed.error.includes('private')); assert((await errorBrowser.close()).ok);
console.log('douyin browser mock tests passed');
