'use strict';
// Enthusia AI: low-load, read-only CPU/NUMA/memory inspection for Bloom.
// Rename/upload this file as bloom-30b.js only on AI split CC19EA3C.
// It does NOT run inference or make any network requests.
const fs=require('node:fs');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
function read(p){
  try {
    const stat=fs.statSync(p);
    if (!stat.isFile() || stat.size>65536) return null;
    return fs.readFileSync(p,'utf8').trim();
  } catch { return null; }
}
function field(s,k){return s?.split('\n').find(l=>l.startsWith(k+':'))?.slice(k.length+1).trim()??null}
function range(s){
  if(!s || !/^[0-9,-]+$/.test(s)) return [];
  const out=new Set();
  for(const v of s.split(',')){
    const m=/^(\d+)(?:-(\d+))?$/.exec(v);if(!m) return [];
    const a=Number(m[1]),b=Number(m[2]??m[1]);
    if(b<a || b-a>512) return [];
    for(let n=a;n<=b;n++) out.add(n);
  }
  return [...out].sort((a,b)=>a-b);
}
function gib(v){return v&&/^\d+$/.test(v)?(Number(v)/1073741824).toFixed(2)+' GiB':v??'unavailable'}
function main(){
  const status=read('/proc/self/status');
  const affinity=field(status,'Cpus_allowed_list');
  const allowed=read('/sys/fs/cgroup/cpuset.cpus.effective')??read('/sys/fs/cgroup/cpuset/cpuset.cpus')??affinity;
  const cpus=range(allowed);
  const mems=read('/sys/fs/cgroup/cpuset.mems.effective')??read('/sys/fs/cgroup/cpuset/cpuset.mems');
  const stats=read('/sys/fs/cgroup/memory.stat');
  const topo=cpus.slice(0,64).map(cpu=>({
    cpu,
    socket:read('/sys/devices/system/cpu/cpu'+cpu+'/topology/physical_package_id'),
    core:read('/sys/devices/system/cpu/cpu'+cpu+'/topology/core_id'),
    siblings:read('/sys/devices/system/cpu/cpu'+cpu+'/topology/thread_siblings_list')
  }));
  let nodes=[];
  try {nodes=fs.readdirSync('/sys/devices/system/node').filter(x=>/^node\d+$/.test(x)).slice(0,16).map(x=>({
    node:x,cpus:read('/sys/devices/system/node/'+x+'/cpulist')
  }));} catch {}
  console.log('ENTHUSIA AI READ-ONLY RESOURCE DIAGNOSTIC');
  console.log(JSON.stringify({
    timeUTC:new Date().toISOString(), modelStarted:false,
    processAllowedCpus:affinity??'unavailable',
    cgroupEffectiveCpus:allowed??'unavailable',
    cgroupConfiguredCpus:read('/sys/fs/cgroup/cpuset.cpus')??'unavailable',
    processAllowedMemoryNodes:field(status,'Mems_allowed_list')??'unavailable',
    cgroupEffectiveMemoryNodes:mems??'unavailable',
    visibleLogicalCpuCount:os.cpus().length,
    availableParallelism:os.availableParallelism(),
    cpuQuotaPeriod:read('/sys/fs/cgroup/cpu.max')??'unavailable',
    cpuStats:read('/sys/fs/cgroup/cpu.stat')??'unavailable',
    memoryLimit:gib(read('/sys/fs/cgroup/memory.max')),
    memoryCurrent:gib(read('/sys/fs/cgroup/memory.current')),
    memoryPeak:gib(read('/sys/fs/cgroup/memory.peak')),
    memoryHigh:gib(read('/sys/fs/cgroup/memory.high')),
    swapLimit:gib(read('/sys/fs/cgroup/memory.swap.max')),
    swapCurrent:gib(read('/sys/fs/cgroup/memory.swap.current')),
    memoryEvents:read('/sys/fs/cgroup/memory.events')??'unavailable',
    memoryAnon:stats?.split('\n').find(x=>x.startsWith('anon '))??'unavailable',
    memoryFileCache:stats?.split('\n').find(x=>x.startsWith('file '))??'unavailable',
    logicalCpuTopology:topo,numaNodes:nodes
  },null,2));
  // Prove whether taskset can narrow CPU affinity of a harmless child only.
  // Never changes the long-lived container or any host-wide CPU affinity.
  if(cpus.length){
    const cpu=cpus[0];
    const js='const s=require("node:fs").readFileSync("/proc/self/status","utf8");console.log((s.match(/^Cpus_allowed_list:\\s*(.+)$/m)||[])[1]||"unknown")';
    const child=spawnSync('taskset',['-c',String(cpu),process.execPath,'-e',js],
      {encoding:'utf8',timeout:4000,windowsHide:true});
    const actual=child.status===0?child.stdout.trim():null;
    console.log(JSON.stringify({tasksetChildTest:{
      cpu,passed:actual===String(cpu),allowedCpus:actual??'tool missing or restricted',
      note:'A successful taskset child test does NOT reserve cores or guarantee SMP isolation.'
    }},null,2));
  }
  console.log('COMPLETE — no inference started. Manually STOP the AI split.');
}
try{main()}catch(e){console.error('Probe error:',String(e?.message??e).slice(0,180))}
if(!process.argv.includes('--once')){
  // Prevent the observed Pterodactyl 'exit 0 = crashed' restart loop.
  console.log('Idling with no workload until manually stopped.');
  const interval=setInterval(()=>{},60000);
  const stop=()=>{clearInterval(interval);process.exit(0)};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
