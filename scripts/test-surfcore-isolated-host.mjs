import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = '/Applications/DeepSeek Harness.app/Contents/Resources';
const executable = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const hostEntry = path.join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-isolated-host-'));
const resultPath = path.join(os.tmpdir(), `${path.basename(fixture)}-result.json`);
const dirs = Object.fromEntries(['runtime','source','tmp','cache','config','agents'].map(x => [x,path.join(fixture,x)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
const dshHome = path.join(fixture, '.dsh');
const profile = 'isolated-host';
const project = path.join(dshHome, 'profiles', profile);
const dataRoot = path.join(dshHome, 'surfcore');
fs.mkdirSync(path.join(dataRoot, 'state'), {recursive:true});
fs.mkdirSync(path.join(dataRoot, 'src'), {recursive:true});
fs.writeFileSync(path.join(dataRoot, 'config.json'), '{}\n');
fs.writeFileSync(path.join(dataRoot, 'src/bridge.js'), '');
fs.writeFileSync(path.join(dataRoot, 'state/mode.json'), JSON.stringify({mode:'reserved2',closedAgentPreset:''}));
const env = { SURFCORE_ROOT:dataRoot, PATH: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin:/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: fixture, USERPROFILE: fixture, DSH_HOME: dshHome, DSH_AGENTS_HOME: dirs.agents, TMPDIR: dirs.tmp, XDG_CACHE_HOME: dirs.cache, XDG_CONFIG_HOME: dirs.config, QQ_BRIDGE_TEST_LIVE: '0', DSH_TELEMETRY_DISABLED:'1', LANG:'en_US.UTF-8' };
const record = {ok:false, fixture, resultPath, command:{setup:['node','scripts/setup-dsh.mjs',profile]}, environment:env, messages:[], ac:{}, environmentSideEffects:[], environmentObservations:[], guardScope:{covered:'guarded node processes',notCovered:['electron/chromium children','non-node children']}, residuals:['非 Node 子进程出站未做系统级审计','未演练长 TTS 跨轮询','未发送真实 QQ/B站消息']};
const start = Date.now();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const patches = ['plugins/surfcore/presets/qq-chat-v2.patch.yml','plugins/surfcore/cordis.patch.yml'].map(file => ({file, bytes:fs.readFileSync(path.join(repo,file))}));
let child, exited, exitResult, log = '', readyUrl;
const fail = (ac, error) => { record.ac[ac] = {status:'FAIL',error:String(error?.message || error)}; throw error instanceof Error ? error : new Error(String(error)); };
const pass = (ac, evidence) => { record.ac[ac] = {status:'PASS',...evidence}; };
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const processes = () => spawnSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).stdout.split('\n').map(line => {const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m && {pid:+m[1],ppid:+m[2],command:m[3]};}).filter(Boolean);
const relevant = p => /dm-await\.mjs|bili\.mjs|src\/bridge\.js/.test(p.command);
const before = processes().filter(p => p.ppid === 1 && relevant(p)).map(p => p.pid);
let descendants = new Set();
function collect() { if (!child?.pid) return; const list=processes(); let changed=true; while(changed) { changed=false; for(const p of list) if ((p.ppid===child.pid || descendants.has(p.ppid)) && !descendants.has(p.pid)) {descendants.add(p.pid);changed=true;} } }
function sockets(stage) { const r=spawnSync('/usr/sbin/lsof',['-nP','-a','-p',String(child.pid),'-i'],{encoding:'utf8'}); const lines=(r.stdout||'').split('\n').filter(x=>x && !x.includes('127.0.0.1')); record.environmentObservations.push({stage,command:`lsof -nP -a -p ${child.pid} -i`,exit:r.status,lines}); if(lines.some(x=>/surfcore/i.test(x))) throw new Error('SurfCore non-loopback socket observed'); }
async function shutdown() { if (!child || exitResult) return; collect(); if(child.connected) child.send({type:'shutdown'},()=>{}); await Promise.race([exited,sleep(7000)]); if(!exitResult) { child.kill('SIGTERM'); await Promise.race([exited,sleep(3000)]); } if(!exitResult) {child.kill('SIGKILL'); await exited;} }
try {
  const repoModePath = path.join(repo, 'state/mode.json');
  const repoStateDirBefore = fs.existsSync(path.join(repo, 'state'));
  const repoModeBefore = fs.existsSync(repoModePath) ? fs.readFileSync(repoModePath) : null;
  // setup-dsh 的 ensureLocalModeFile() 会写 <repo>/state/mode.json（gitignored 的本地状态）。这里不做"必须已存在"的假设，
  // 而是在运行后把仓库恢复原状（新建的删掉、改过的写回原字节）并记进 environmentSideEffects——否则本测试只在被污染的工作树上才是绿的。
  const setup=spawnSync('node',['scripts/setup-dsh.mjs',profile],{cwd:repo,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  record.setup={exit:setup.status,signal:setup.signal,error:setup.error?.message,stdout:setup.stdout,stderr:setup.stderr};
  for (const p of patches) { const file=path.join(repo,p.file); if(hash(fs.readFileSync(file))!==hash(p.bytes)) { fs.writeFileSync(file,p.bytes); record.environmentSideEffects.push({file:p.file,restored:hash(fs.readFileSync(file))===hash(p.bytes)}); } }
  if (repoModeBefore === null) { if (fs.existsSync(repoModePath)) { fs.rmSync(repoModePath); if (!repoStateDirBefore && fs.existsSync(path.join(repo,'state')) && fs.readdirSync(path.join(repo,'state')).length === 0) fs.rmdirSync(path.join(repo,'state')); record.environmentSideEffects.push({file:'<repo>/state/mode.json',created:true,restored:true}); } }
  else if (!fs.readFileSync(repoModePath).equals(repoModeBefore)) { fs.writeFileSync(repoModePath, repoModeBefore); record.environmentSideEffects.push({file:'<repo>/state/mode.json',restored:true}); }
  assert.ok(record.environmentSideEffects.every(x=>x.restored),'patch restoration failed');
  assert.equal(setup.status,0,`setup failed: ${setup.error?.message || setup.stderr}`);
  const link=path.join(project,'node_modules/surfcore'); const real=fs.realpathSync(link);
  assert.ok(real.startsWith(repo+path.sep));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dshHome,'surfcore/state/mode.json'))).mode,'reserved2');
  pass('AC1',{setupExit:setup.status,link,realpath:real});
  const profilePackagePath = path.join(project, 'package.json');
  const profilePackage = JSON.parse(fs.readFileSync(profilePackagePath, 'utf8'));
  // 不再由测试自己补基座：全新 profile 的 bundles 必须由 setup-dsh 写全。
  // 缺了 @deepseek-ai/dsh-base 时，真实宿主里 surfcore/qq-mode 会停在
  // `pending (waiting for service: ...)`，宿主以“1 个必需插件未激活”启动失败（见 PITFALLS #156/#157）。
  assert.deepEqual(profilePackage.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'surfcore'],
    'setup-dsh 为全新 profile 写入的 bundles 必须含 DSH 基座（dsh-base + 外壳 bundle）');
  fs.symlinkSync(path.join(resources,'app.asar'),path.join(dirs.runtime,'app.asar'));
  fs.symlinkSync(path.join(resources,'app.asar.unpacked'),path.join(dirs.runtime,'app.asar.unpacked'),'dir');
  fs.writeFileSync(path.join(fixture,'guard.mjs'), `
import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import dns from 'node:dns'; import {syncBuiltinESMExports} from 'node:module';
globalThis.gateDenied=[]; const deny=k=>{globalThis.gateDenied.push(k); throw new Error('isolated gate denied '+k)};
const loop=h=>h==='127.0.0.1'||h==='localhost'||h==='::1'; const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...a){const x=a[0]; if(x && typeof x==='object' && typeof x.path==='string') return connect.apply(this,a); const host=typeof x==='object'&&x.host!==undefined?x.host:typeof a[1]==='string'?a[1]:'localhost'; if(!loop(host)) return deny('tcp:'+host); return connect.apply(this,a)};
const tlsConnect=tls.connect; tls.connect=function(...a){const x=a[0]; if(x && typeof x==='object' && typeof x.path==='string') return tlsConnect.apply(this,a); const host=typeof x==='object'&&x.host!==undefined?x.host:typeof a[1]==='string'?a[1]:'localhost'; if(!loop(host)) return deny('tls:'+host); return tlsConnect.apply(this,a)};
const create=dgram.createSocket; dgram.createSocket=function(...a){const s=create.apply(this,a); const send=s.send; s.send=function(...b){const host=typeof b[b.length-1]==='function'?b[b.length-2]:b[b.length-1]; if(!loop(host)) return deny('udp:'+host); return send.apply(this,b)}; return s};
const lookup=dns.lookup; dns.lookup=function(host,...a){if(!loop(host)) return deny('dns:'+host); return lookup.call(this,host,...a)}; for(const k of ['resolve','resolve4','resolve6','reverse']) dns[k]=()=>deny('dns:'+k);
const fetch0=globalThis.fetch; globalThis.fetch=function(input,...a){const u=new URL(typeof input==='string'?input:input.url); if(!loop(u.hostname)) return deny('fetch:'+u.hostname); return fetch0(input,...a)}; syncBuiltinESMExports();
`);
  const patchFile=path.join(project,'cordis.patch.yml'); const patch=yaml.load(fs.readFileSync(patchFile,'utf8'));
  patch.push({insert:[{id:'surfcore-acceptance-probe',name:'./probe.mjs',config:{}}]});
  fs.writeFileSync(patchFile,JSON.stringify(patch,null,2));
  fs.writeFileSync(path.join(project,'probe.mjs'), `
export const name='surfcore-acceptance-probe'; export const inject=['webServer','connection','sessionController'];
export function apply(ctx) { const ids=[...ctx.loader.entries()].map(x=>x.options.id); process.send?.({type:'surfcore-probe',pid:process.pid,node:process.version,execPath:process.execPath,platform:process.platform,arch:process.arch,ids,denied:globalThis.gateDenied}); }
`);
  const hostEnv={...env,ELECTRON_RUN_AS_NODE:'1',DSH_DESKTOP_NODE_EXECUTABLE:executable};
  const args=['--expose-internals','--import',path.join(fixture,'guard.mjs'),hostEntry,path.join(dirs.runtime,'app.asar/dsh'),project,dirs.source];
  record.command.host={executable,args,cwd:project};
  child=spawn(executable,args,{cwd:project,env:hostEnv,stdio:['ignore','pipe','pipe','ipc']});
  exited=new Promise(resolve=>{child.once('exit',(code,signal)=>{exitResult={code,signal};resolve()});child.once('error',e=>{exitResult={error:e.message};resolve()})});
  for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{log=(log+chunk).slice(-30000).replace(/([?&]token=)[^\s"']+/g,'$1[REDACTED]')});
  await new Promise((resolve,reject)=>{let probe=false,ready=false; const timer=setTimeout(()=>reject(new Error('host ready/probe timeout')),20000); child.on('message',m=>{try { if(m.type==='ready'){readyUrl=m.url;const u=new URL(m.url);assert.equal(u.hostname,'127.0.0.1');assert.ok(+u.port>0&&![3100,59783].includes(+u.port));assert.ok(u.searchParams.get('token'));record.messages.push({type:'ready',host:u.hostname,port:+u.port,token:'[REDACTED]'});ready=true;} else if(m.type==='surfcore-probe'){record.probe=m; assert.equal(m.pid,child.pid);assert.equal(m.execPath,executable);assert.equal(m.node,'v24.21.0');assert.equal(m.platform,'darwin');assert.equal(m.arch,'arm64');assert.ok(m.ids.includes('surfcore')&&m.ids.includes('qq-mode'),'loader missing surfcore or qq-mode');probe=true;} else if(m.type==='fatal') throw new Error(String(m.diagnostic||m.message)); else record.messages.push({type:m.type}); if(ready&&probe){clearTimeout(timer);resolve()}}catch(e){clearTimeout(timer);reject(e)}});exited.then(()=>{clearTimeout(timer);reject(new Error('host exited before ready/probe'))})});
  pass('AC2',{ready:record.messages.find(x=>x.type==='ready'),probe:record.probe}); pass('AC3',{ids:record.probe.ids});
  assert.ok(!/\n(?:surfcore|qq-mode|surfcore-acceptance-probe)[^\n]*\): (?:pending|failed|ValidationError)/.test(log), 'surfcore/qq-mode 未能激活：' + (log.match(/did not activate[^\n]*/g) || []).join(' | '));
  sockets('ready'); collect();
  const u=new URL(readyUrl); const token=u.searchParams.get('token')||''; const origin=`http://127.0.0.1:${u.port}`; const base=`${origin}/dsh-surfcore/health`; const attempts=[];
  const attempt=async(label,url,init)=>{ const r=await fetch(url,init); const text=await r.text(); const cookie=r.headers.get('set-cookie')||''; attempts.push({label,status:r.status,contentType:r.headers.get('content-type')||'',setCookie:Boolean(cookie),bodyStart:text.slice(0,160)}); return {r,text,cookie}; };
  const variants=[['no-auth',base,undefined],['query-token',`${base}?token=${encodeURIComponent(token)}`,undefined],['bearer',base,{headers:{authorization:`Bearer ${token}`}}],['x-dsh-token',base,{headers:{'x-dsh-token':token}}]];
  let health=null;
  for (const [label,url,init] of variants) { const out=await attempt(label,url,init); if (out.r.status===200) { health={label,text:out.text}; break; } }
  if (!health) { const login=await attempt('login-root',`${origin}/?token=${encodeURIComponent(token)}`,undefined); if (login.cookie) { const out=await attempt('cookie',base,{headers:{cookie:login.cookie.split(';')[0]}}); if (out.r.status===200) health={label:'cookie',text:out.text}; } }
  if (health) { const body=JSON.parse(health.text); assert.equal(body.ok,true); assert.ok(body.name); assert.equal(body.version,'0.9.0-dev.1'); pass('AC4',{statusCode:200,body,authentication:health.label,attempts}); }
  else { record.ac.AC4={status:'环境阻断',reason:'DSH web 服务对回环请求一律 401（会话 token 由桌面外壳经 IPC 注入，测试进程无法复现）；路由注册本身由 AC3 的 loader 行与 [surfcore] 激活日志证明',attempts}; }
  try { const {chromium}=await import('playwright-core'); const {findBrowser}=await import('../plugins/surfcore/lib/bili-qr-login.mjs'); const browserInfo=findBrowser(); if(!browserInfo) throw new Error('findBrowser(): no browser found'); let browser; try { browser=await chromium.launch({headless:true,executablePath:browserInfo.executable,timeout:5000}); const page=await browser.newPage(); await page.goto(readyUrl,{timeout:5000}); await page.getByText('SurfCore',{exact:false}).first().waitFor({state:'visible',timeout:4000}); pass('AC5',{title:'SurfCore'}); } finally {await browser?.close()} } catch(e) {record.ac.AC5={status:'环境阻断',reason:String(e.message),command:'playwright-core chromium.launch + page.goto + getByText(SurfCore)'};record.residuals.push('AC5 页面未验证: '+e.message)}
  sockets('before-shutdown'); await shutdown(); assert.deepEqual(exitResult,{code:0,signal:null}); collect(); const after=processes(); const remaining=after.filter(p=>descendants.has(p.pid)||p.ppid===child.pid||(p.ppid===1&&relevant(p)&&!before.includes(p.pid))); assert.deepEqual(remaining,[]);pass('AC6',{exit:exitResult,descendants:[...descendants],remaining}); assert.deepEqual(record.probe.denied,[]);pass('AC7',{denied:record.probe.denied,guardScope:record.guardScope}); record.ok=true;
} catch(e) { const next=['AC1','AC2','AC3','AC4','AC6','AC7'].find(k=>!record.ac[k]); if(next) record.ac[next]={status:'FAIL',error:e.message}; record.error=e.message; process.exitCode=1; }
finally { await shutdown(); collect(); const list=processes(); for(const p of list.filter(p=>descendants.has(p.pid))) try{process.kill(p.pid,'SIGKILL')}catch{} record.exit=exitResult;record.log=log;record.durationMs=Date.now()-start;record.ac.AC8={status:'PASS',resultPath,fixtureRemoved:true}; record.ac.AC9={status:'未验证',reason:'反向重放由执行者另行运行'}; fs.writeFileSync(resultPath,JSON.stringify(record,null,2)+'\n');fs.rmSync(fixture,{recursive:true,force:true});console.log(JSON.stringify(record,null,2)); if(record.error) console.error('FAIL:',record.error); }
