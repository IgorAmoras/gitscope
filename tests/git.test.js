import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, log, openRepo, overview, compare, head, xray, diff, commitDetail } from '../server/git.js';
import { analytics, fileActivity } from '../server/analytics.js';
import { SnapshotStore } from '../server/snapshots.js';
import { preview, execute } from '../server/operations.js';

const cmd = (p,...args) => execFileSync('git',args,{cwd:p,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Test Person',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test Person',GIT_COMMITTER_EMAIL:'test@example.test'}}).trim();
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'gitscope fixture '));
  cmd(dir,'init','-b','main'); cmd(dir,'config','user.name','Test Person');cmd(dir,'config','user.email','test@example.test');
  await writeFile(join(dir,'readme.txt'),'one\n');cmd(dir,'add','.');cmd(dir,'commit','-m','Initial commit');
  return dir;
}
async function cleanup(dir){await rm(dir,{recursive:true,force:true});}

test('Git CLI parses linear, Unicode, multi-line and parent metadata',async()=>{
  const d=await fixture();try{
    await writeFile(join(d,'readme.txt'),'two\n');cmd(d,'add','.');cmd(d,'commit','-m','Unicode café 🚀','-m','Detailed body line');
    const a=await log(d);assert.equal(a.length,2);assert.equal(a[0].parents.length,1);assert.match(a[0].body,/Detailed body/);
    assert.match((await diff(d,a[0].sha)).content,/\+two/);assert.equal((await commitDetail(d,a[0].sha)).email,'test@example.test');
    assert.equal(await openRepo(d),d);assert.equal((await overview(d)).total,2);
  }finally{await cleanup(d);}
});
test('Divergence, merge commit, ancestry, unique stats, detached head',async()=>{
  const d=await fixture();try{
    cmd(d,'switch','-c','feature');await writeFile(join(d,'feature.txt'),'f\n');cmd(d,'add','.');cmd(d,'commit','-m','feature');
    cmd(d,'switch','main');await writeFile(join(d,'main.txt'),'m\n');cmd(d,'add','.');cmd(d,'commit','-m','main changes');
    const divergent=await compare(d,'main','feature'); assert.equal(divergent.aheadA,1);assert.equal(divergent.aheadB,1);assert.equal(divergent.status,'diverged');
    cmd(d,'merge','--no-ff','feature','-m','Merge feature');
    const record=(await log(d))[0];assert.equal(record.parents.length,2);
    const result=await compare(d,'main','feature');assert.equal(result.aheadB,0);assert.equal(result.status,'fast-forward B → A');
    const stats=await analytics(d);assert.equal(stats.total,4);assert.equal(stats.merges,1);assert.equal(stats.contributors,1);
    cmd(d,'checkout','--detach','HEAD');assert.equal((await head(d)).detached,true);
  }finally{await cleanup(d);}
});
test('Empty repository and unborn branch show a readable state',async()=>{
  const d=await mkdtemp(join(tmpdir(),'gitscope empty '));try{
    cmd(d,'init','-b','main');const a=await overview(d);assert.equal(a.total,0);assert.equal(a.commits.length,0);assert.equal(a.head.sha,null);
  }finally{await cleanup(d);}
});
test('Snapshots persist outside repository, deduplicate and compare refs',async()=>{
  const d=await fixture(),data=await mkdtemp(join(tmpdir(),'gitscope data '));const store=new SnapshotStore(data);
  try {await store.init();const a=await store.capture(d,'initial');assert.equal(a.changed,true);
    const same=await store.capture(d,'same');assert.equal(same.changed,false);
    cmd(d,'switch','-c','experiment');await writeFile(join(d,'test2.txt'),'test');cmd(d,'add','.');cmd(d,'commit','-m','new branch');
    const b=await store.capture(d,'new-ref');assert.equal(b.changed,true);
    const comparisons=await store.compare(d,a.id,b.id);assert(comparisons.created.includes('refs/heads/experiment'));
    const old=await store.read(d,a.id);assert.equal(old.commits.length,1);
    assert.equal(store.list(d).length,2);
  }finally{store.close();await cleanup(d);await cleanup(data);}
});
test('Preview blocks destructive changes when working tree is dirty; creates safely',async()=>{
  const d=await fixture();try {
    await writeFile(join(d,'readme.txt'),'dirty');await assert.rejects(preview(d,'merge',{branch:'main'}),/Working tree/);
    cmd(d,'restore','.');const plan=await preview(d,'create',{branch:'my-topic'});assert.equal(plan.branch,'my-topic');
    const result=await execute(d,'create',{branch:'my-topic'});assert.equal(result.ok,true);
    assert.equal((await overview(d)).refs.filter(x=>x.kind==='local').length,2);
    await assert.rejects(preview(d,'delete',{branch:'main'}),/checked-out/);
  }finally{await cleanup(d);}
});
test('X-Ray reveals reflog and cherry-pick equivalence is suggestive only',async()=>{
  const d=await fixture();try {
    cmd(d,'switch','-c','topic');await writeFile(join(d,'a.txt'),'topic\n');cmd(d,'add','.');cmd(d,'commit','-m','add topic');
    const c=cmd(d,'rev-parse','HEAD');cmd(d,'switch','main');await writeFile(join(d,'another.txt'),'base changed\n');cmd(d,'add','.');cmd(d,'commit','-m','diverge first');cmd(d,'cherry-pick',c);
    const info=await xray(d,'topic','main');assert(info.reflog.length>0);assert(info.equivalent.length>0);assert.match(info.equivalent[0].description,/not proof/);
  }finally{await cleanup(d);}
});
test('File analytics reports recent changes with sampled provenance',async()=>{
  const d=await fixture();try {const r=await fileActivity(d);assert.equal(r.approximate,true);assert(r.files.some(x=>x.file==='readme.txt'));}finally{await cleanup(d);}
});
