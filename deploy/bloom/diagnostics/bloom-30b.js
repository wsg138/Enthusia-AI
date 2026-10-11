'use strict';
// Enthusia AI-only, non-root telemetry wrapper. Never modifies CPU affinity or other containers.
// Requires original verified cached-only 4-thread benchmark renamed bloom-30b-bench.cjs.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const ROOT = process.cwd();
const BENCH = path.join(ROOT, 'bloom-30b-bench.cjs');
const LIMIT = 1200;
let child, stream, timer, samples = 0, finished = false, stopping = false, last = null, previousPid = null;
const read = p => { try { return fs.readFileSync(p,'utf8').trim(); } catch { return null; } };
function pairs(p) {
  const s = read(p), out = {};
  if (!s) return null;
  for (const line of s.split('\n')) { const a=line.match(/^([\w.]+)\s+(\d+)$/); if (a) out[a[1]]=Number(a[2]); }
  return out;
}
function pressure(p) {
  const s=read(p), out={};
  if (!s) return null;
  for(const line of s.split('\n')) {
    const a=line.match(/^(some|full) .*\btotal=(\d+)/);
    if(a) out[a[1]]=Number(a[2]);
  }
  return out;
}
function cpuCores() {
  const s=read('/proc/stat'), out={};
  if(!s) return null;
  for(const line of s.split('\n')) {
    const a=line.trim().split(/\s+/);
    if(!/^cpu\d+$/.test(a[0])) continue;
    const v=a.slice(1,9).map(Number);
    if(v.length!==8 || v.some(n=>!Number.isFinite(n))) continue;
    out[a[0]]={total:v.reduce((p,n)=>p+n,0), idle:v[3]+v[4], steal:v[7], iowait:v[4]};
  }
  return out;
}
function findLlama(ppid) {
  if(!ppid) return null;
  let dirs;
  try { dirs=fs.readdirSync('/proc'); } catch { return null; }
  for(const x of dirs) {
    if(!/^\d+$/.test(x) || read('/proc/'+x+'/comm')!=='llama-server') continue;
    const stat=read('/proc/'+x+'/stat'), n=stat?.lastIndexOf(')');
    if(n>=0 && Number(stat.slice(n+2).split(/\s+/)[1])===ppid) return Number(x);
  }
  return null;
}
function threadStats(pid) {
  if(!pid) return null;
  const out={}; let tids;
  try { tids=fs.readdirSync('/proc/'+pid+'/task'); } catch { return null; }
  for(const tid of tids) {
    if(!/^\d+$/.test(tid)) continue;
    const pre='/proc/'+pid+'/task/'+tid+'/';
    const stat=read(pre+'stat'), sched=read(pre+'schedstat');
    if(!stat&&!sched)continue;
    const pos=stat?.lastIndexOf(')');
    const cpu=pos>=0?Number(stat.slice(pos+2).split(/\s+/)[36]):null;
    const fields=sched?.split(/\s+/).map(Number);
    out[tid]={name:read(pre+'comm')?.slice(0,20)||null,lastCpu:Number.isInteger(cpu)?cpu:null,
      runNs:fields?.[0]??null,waitNs:fields?.[1]??null,slices:fields?.[2]??null};
  }
  return out;
}
const delta=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:null;
const round=(n)=>Math.round(n*100)/100;
function sample() {
  if(finished||samples>=LIMIT)return;
  const now=Date.now(), pid=findLlama(child?.pid);
  if(pid && pid!==previousPid) {previousPid=pid; console.log('[cpu-monitor] tracking llama-server PID '+pid);}
  const raw={ms:now,cores:cpuCores(),cgroup:pairs('/sys/fs/cgroup/cpu.stat'),
    cpuPressure:pressure('/sys/fs/cgroup/cpu.pressure'),hostPressure:pressure('/proc/pressure/cpu'),
    threads:threadStats(pid),pid,
    memory:Number(read('/sys/fs/cgroup/memory.current'))||null,
    swap:Number(read('/sys/fs/cgroup/memory.swap.current'))||null,
    memoryEvents:pairs('/sys/fs/cgroup/memory.events')};
  const elapsed=last?now-last.ms:null;
  const perCore={};
  if(last?.cores && raw.cores) for(const [k,v] of Object.entries(raw.cores)) {
    const old=last.cores[k], total=delta(old?.total,v.total), idle=delta(old?.idle,v.idle);
    if(total>0&&idle!==null)perCore[k]=round(100*(1-idle/total));
  }
  const threads=[];
  if(raw.threads)for(const [tid,v] of Object.entries(raw.threads)) {
    const old=last?.pid===pid?last.threads?.[tid]:null;
    const run=delta(old?.runNs,v.runNs), wait=delta(old?.waitNs,v.waitNs);
    threads.push({tid:Number(tid),name:v.name,lastCpu:v.lastCpu,
      runMs:run===null?null:round(run/1e6),waitMs:wait===null?null:round(wait/1e6),
      cpuPercent:run!==null&&elapsed>0?round(run/1e6/elapsed*100):null,
      slices:delta(old?.slices,v.slices)});
  }
  const usage=delta(last?.cgroup?.usage_usec,raw.cgroup?.usage_usec);
  const record={utc:new Date(now).toISOString(),kind:'sample',elapsedMs:elapsed,
    aiPid:pid, aiCpuPercent:usage!==null&&elapsed>0?round(usage/1000/elapsed*100):null,
    throttlePeriods:delta(last?.cgroup?.nr_throttled,raw.cgroup?.nr_throttled),
    throttleMs:(n=>n===null?null:round(n/1000))(delta(last?.cgroup?.throttled_usec,raw.cgroup?.throttled_usec)),
    aiCpuPressureMs:(n=>n===null?null:round(n/1000))(delta(last?.cpuPressure?.some,raw.cpuPressure?.some)),
    hostCpuPressureMs:(n=>n===null?null:round(n/1000))(delta(last?.hostPressure?.some,raw.hostPressure?.some)),
    perCoreCpuPercent:perCore, aiThreads:threads,
    aiMemoryMiB:raw.memory===null?null:round(raw.memory/1048576),
    aiSwapMiB:raw.swap===null?null:round(raw.swap/1048576),memoryEvents:raw.memoryEvents};
  stream.write(JSON.stringify(record)+'\n'); last=raw; samples++;
  if(samples===LIMIT){console.log('[cpu-monitor] max 20 minutes reached; stopping samples');clearInterval(timer);}
}
function stop(signal) {
  if(stopping)return;
  stopping=true;
  console.log('[cpu-monitor] '+new Date().toISOString()+' stopping on '+signal);
  if(child && child.exitCode===null)child.kill('SIGTERM');
  end();
  if (!child || child.exitCode !== null) process.exit(0);
  const t=setTimeout(()=>process.exit(0),2500);t.unref();
}
function end() {
  if(finished)return;
  if(timer)clearInterval(timer);
  try{sample()}catch{}
  finished=true;
  if(stream){stream.write(JSON.stringify({kind:'end',utc:new Date().toISOString(),samples})+'\n');stream.end();}
}
process.on('SIGINT',()=>stop('SIGINT'));
process.on('SIGTERM',()=>stop('SIGTERM'));
function idle(message) {console.log('[cpu-monitor] '+message+'. No inference started; manually STOP.');setInterval(()=>{},60000);}
// The approved test may be enabled by a panel environment setting OR a one-run owner marker.
// The owner marker is consumed atomically before model launch, preventing restart-loop replay.
function requireOneTimeOwnerApproval() {
  if (process.env.ENTHUSIA_BLOOM_INFERENCE_RUN_APPROVED === '1') return true;
  const marker = path.join(ROOT, 'bloom-cpu-one-run-approval.txt');
  const today = new Date().toISOString().slice(0,10);
  const expected = 'APPROVE ONE ENTHUSIA AI TEST CC19EA3C '+today;
  try {
    const stat = fs.lstatSync(marker);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>110) return false;
    if(fs.readFileSync(marker,'utf8').trim()!==expected) return false;
    // Preserve a consumed record but never allow it to authorize another launch.
    const consumed=path.join(ROOT, 'bloom-cpu-approval-used-'+Date.now()+'.txt');
    fs.renameSync(marker,consumed);
    process.env.ENTHUSIA_BLOOM_INFERENCE_RUN_APPROVED='1';
    console.log('[cpu-monitor] one-time owner approval accepted and consumed (UTC '+today+')');
    return true;
  } catch {return false;}
}
function main(){
  if(process.platform!=='linux'||process.arch!=='x64')return idle('Linux x64 required');
  const b=read(BENCH);
  const safeBenchmark = b && b.length<=200000 &&
    b.includes('enthusia-qwen3-30b-a3b-sustained-smp-profiling') &&
    b.includes('verifyExistingModel') &&
    b.includes('requireApprovedWipedServer') &&
    b.includes("'--threads', '4'") &&
    b.includes("'--parallel', '1'") &&
    b.includes("'--ctx-size', '2048'") &&
    b.includes("'--host', '127.0.0.1'") &&
    !b.includes('downloadModel(') &&
    !b.includes('MODEL_URL');
  if(!safeBenchmark)return idle('Guarded cached-only four-thread benchmark missing');
  if(!requireOneTimeOwnerApproval())return idle('Inference approval missing; set panel variable or create one-time approval marker');
  const file=path.join(ROOT,'bloom-cpu-evidence-'+new Date().toISOString().replace(/[:.]/g,'-')+'.jsonl');
  try { const fd=fs.openSync(file,'wx',0o600); stream=fs.createWriteStream(file,{fd,autoClose:true}); }
  catch{return idle('Cannot create evidence file');}
  stream.on('error',e=>{console.log('[cpu-monitor] write error '+(e.code||'unknown'));stop('write-error')});
  stream.write(JSON.stringify({kind:'meta',utc:new Date().toISOString(),
    cpusAllowed:read('/proc/self/status')?.match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1]||null,
    cpuset:read('/sys/fs/cgroup/cpuset.cpus.effective'),cpuMax:read('/sys/fs/cgroup/cpu.max'),
    perCoreScope:'host-visible-not-per-container',model:'existing-guarded-four-thread-Qwen3',testOnly:true})+'\n');
  console.log('[cpu-monitor] evidence '+path.basename(file));
  console.log('[cpu-monitor] '+new Date().toISOString()+' starting existing benchmark once');
  sample();
  child=spawn(process.execPath,[BENCH],{cwd:ROOT,stdio:'inherit',env:process.env,shell:false});
  child.on('error',e=>{console.log('[cpu-monitor] subprocess error '+(e.code||'unknown'));stop('spawn-error')});
  child.on('exit',(code,signal)=>{end();console.log('[cpu-monitor] benchmark finished '+code+' '+signal+'; manually STOP AI split');setInterval(()=>{},60000)});
  timer=setInterval(sample,1000);
}
main();
