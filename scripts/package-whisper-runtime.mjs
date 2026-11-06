#!/usr/bin/env node
// Build a relocatable copy of the already-built runtime; never modify the source tree.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const names=['whisper-cli','libwhisper.1.dylib','libggml.0.dylib','libggml-cpu.0.dylib','libggml-blas.0.dylib','libggml-metal.0.dylib','libggml-base.0.dylib'];
const commit='d1be6fde11ac6e0407606b4e42fe72d34add8037';
const tarDigest='645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4';
const args=process.argv.slice(2), get=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const fail=(code,message,hint)=>Object.assign(new Error(message),{code,hint});
const command=(cmd,argv,options={})=>execFileSync(cmd,argv,{encoding:'utf8',...options});
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inside=(parent,child)=>{const rel=path.relative(parent,child);return rel==='' || (rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel));};
const rpaths=file=>[...command('/usr/bin/otool',['-l',file]).matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map(m=>m[1]);
const deps=file=>command('/usr/bin/otool',['-L',file]).split('\n').slice(1).filter(Boolean).map(line=>line.trim().split(' (compatibility version')[0]);
const allowedDependency=(value)=>value.startsWith('/usr/lib/')||value.startsWith('/System/Library/')||(value.startsWith('@rpath/')&&names.includes(value.slice('@rpath/'.length)));
function main(){
 if(process.platform!=='darwin'||process.arch!=='arm64') throw fail('PLATFORM_UNSUPPORTED','This packaging operation requires macOS arm64.','Run on the supported build Mac.');
 const sourceBin=get('--source-bin'), sourceDir=get('--source-dir'), out=get('--out');
 if(![sourceBin,sourceDir,out].every(x=>x&&path.isAbsolute(x)) || args.length!==6 || new Set(args.filter((_,i)=>i%2===0)).size!==3 || !['--source-bin','--source-dir','--out'].every(x=>args.includes(x))) throw fail('ARGUMENT_INVALID','Specify --source-bin, --source-dir, and --out as absolute paths.','Provide the existing build/bin, extracted source directory, and a new output directory.');
 const bin=fs.realpathSync(sourceBin), source=fs.realpathSync(sourceDir), outParent=fs.realpathSync(path.dirname(out)), target=path.join(outParent,path.basename(out));
 if(inside(bin,target)||inside(source,target)||inside(target,bin)||inside(target,source)) throw fail('OUTPUT_INVALID','The output overlaps an input directory.','Choose a new output outside the source and build directories.');
 if(fs.existsSync(target)) throw fail('OUTPUT_EXISTS','The output already exists and was not modified.','Choose another new --out directory.');
 const assetRoot=path.dirname(source), archive=path.join(assetRoot,'whisper.tar.gz'), record=JSON.parse(fs.readFileSync(path.join(assetRoot,'asset-record.json'),'utf8'));
 if(record.sourceCommit!==commit||record.reportedVersion!=='1.9.5-dev'||sha(archive)!==tarDigest) throw fail('SOURCE_INTEGRITY_FAILED','The source record or archive digest does not match the selected baseline.','Provide the verified WP0 source assets and retry.');
 const license=path.join(source,'LICENSE'); if(!fs.statSync(license).isFile()) throw fail('LICENSE_MISSING','The upstream MIT notice is missing.','Provide the extracted verified whisper.cpp source directory.');
 const archivedLicense=command('/usr/bin/tar',['-xOf',archive,`whisper.cpp-${commit}/LICENSE`]);
 if(fs.readFileSync(license,'utf8')!==archivedLicense) throw fail('LICENSE_MISMATCH','The source notice does not match the verified archive.','Restore the upstream LICENSE from the verified source archive.');
 const cacheFile=path.join(path.dirname(bin),'CMakeCache.txt'), cache=fs.readFileSync(cacheFile,'utf8'), keys=['BUILD_SHARED_LIBS','CMAKE_BUILD_TYPE','CMAKE_OSX_ARCHITECTURES','GGML_BLAS','GGML_BLAS_VENDOR','GGML_CPU','GGML_METAL','GGML_METAL_EMBED_LIBRARY','GGML_NATIVE','WHISPER_BUILD_IS_DEV'];
 const settings=Object.fromEntries(keys.map(key=>{const m=cache.match(new RegExp(`^${key}:[^=]+=(.*)$`,'m'));return [key,m?m[1]:null];}));
 if(settings.GGML_METAL_EMBED_LIBRARY!=='ON') throw fail('METAL_NOT_EMBEDDED','The build does not record embedded Metal resources.','Use the verified embedded-Metal build or package its required resources separately.');
 for(const name of names){const file=path.join(bin,name);if(!fs.statSync(file).isFile() || command('/usr/bin/lipo',['-archs',file]).trim()!=='arm64')throw fail('BINARY_INVALID',`Runtime component ${name} is not a thin arm64 file.`,'Use the verified darwin-arm64 build.');for(const dep of deps(file)) if(!allowedDependency(dep)) throw fail('DEPENDENCY_UNSUPPORTED',`Runtime component ${name} has an unapproved dependency.`,'Rebuild with approved system libraries and local runtime dependencies.');}
 fs.mkdirSync(target,{mode:0o700}); const targetBin=path.join(target,'bin');fs.mkdirSync(targetBin,{mode:0o755});
 fs.copyFileSync(license,path.join(target,'LICENSE.whisper.cpp'),fs.constants.COPYFILE_EXCL);
 for(const name of names){const from=path.join(bin,name),file=path.join(targetBin,name);fs.copyFileSync(fs.realpathSync(from),file,fs.constants.COPYFILE_EXCL);fs.chmodSync(file,0o755);
  const original=rpaths(file);for(const rpath of original)if(!['@loader_path','@executable_path'].includes(rpath))command('/usr/bin/install_name_tool',['-delete_rpath',rpath,file]);
  for(const rpath of ['@loader_path','@executable_path'])if(!original.includes(rpath))command('/usr/bin/install_name_tool',['-add_rpath',rpath,file]);
  command('/usr/bin/codesign',['--force','--sign','-',file],{stdio:['ignore','pipe','pipe']});command('/usr/bin/codesign',['--verify','--strict',file],{stdio:['ignore','pipe','pipe']});
  if(rpaths(file).some(x=>!['@loader_path','@executable_path'].includes(x))||deps(file).some(dep=>!allowedDependency(dep)))throw fail('DEPENDENCY_UNSUPPORTED',`Packaged component ${name} retains an unapproved load path.`,'Inspect the preserved output and rebuild from a compatible baseline.');
 }
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('DYLD_'))delete env[key];
 const version=command(path.join(targetBin,'whisper-cli'),['--version'],{env}).trim();if(!/\b1\.9\.5-dev\b/.test(version))throw fail('VERSION_MISMATCH','The copied runtime reports an unexpected version.','Inspect the preserved output and use the verified 1.9.5-dev build.');
 const files=Object.fromEntries(names.map(name=>{const file=path.join(targetBin,name);return [name,{sha256:sha(file),mode:(fs.statSync(file).mode & 0o777).toString(8),architecture:command('/usr/bin/lipo',['-archs',file]).trim(),rpaths:rpaths(file),dependencies:deps(file),codeSignature:'ad-hoc; codesign --verify --strict passed'}];}));
 fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({schemaVersion:1,sourceCommit:commit,sourceArchiveSha256:tarDigest,sourceRecord:record.sourceCommit,version,platform:'darwin-arm64',buildSettings:settings,files,license:{file:'LICENSE.whisper.cpp',sha256:sha(path.join(target,'LICENSE.whisper.cpp'))},validation:{codesign:'ad-hoc verified',metalEmbedded:'build configuration only; requires inference verification',relocation:'requires inference verification'}},null,2)+'\n',{flag:'wx',mode:0o644});
 console.log(JSON.stringify({ok:true,output:target,files:names.length,version,notice:'Run relocated CPU and Metal inference before treating this copy as verified.'}));
}
try{main();}catch(error){console.error(JSON.stringify({ok:false,code:error.code||'PACKAGE_FAILED',error:error.message,hint:error.hint||'Inspect the retained output and input assets; no source assets were modified.'}));process.exitCode=1;}
