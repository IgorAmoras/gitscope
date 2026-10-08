import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

const dir = await mkdtemp(join(tmpdir(),'gitscope api repo '));
const data = await mkdtemp(join(tmpdir(),'gitscope api data '));
const cmd = (...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Web Fixture',GIT_AUTHOR_EMAIL:'web@example.test',GIT_COMMITTER_NAME:'Web Fixture',GIT_COMMITTER_EMAIL:'web@example.test'}}).trim();
cmd('init','-b','main'); cmd('config','user.name','Web Fixture');cmd('config','user.email','web@example.test');
await writeFile(join(dir,'test.txt'),'data\n');cmd('add','.');cmd('commit','-m','test init');
// Unique port and private store keep the test server entirely local.
process.env.GITSCOPE_DATA_DIR = data;
const { start } = await import('../server/index.js');
const app=await start({port:0,noOpen:true});
const base=app.address;
async function get(path){const r=await fetch(base+'/api/'+path);return {code:r.status,body:await r.json()};}
async function post(path, body, token){const r=await fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json',...token?{'x-gitscope-token':token}:{}},body:JSON.stringify(body)});return {code:r.status,body:await r.json()};}

test('API allows read-only bootstrap, rejects mutation without CSRF and handles Git data', async()=>{
  const boot=await get('bootstrap');assert.equal(boot.code,200);const token=boot.body.token;
  const forbidden=await post('open',{path:dir});assert.equal(forbidden.code,403);
  const opened=await post('open',{path:dir},token);assert.equal(opened.code,200);assert.equal(opened.body.total,1);
  assert.equal((await get('state')).body.commits.length,1);
  assert.equal((await get('stats')).body.total,1);
  const reachable=await get('reachable?ref=refs%2Fheads%2Fmain');assert.equal(reachable.body.shas.length,1);
  const sn=await get('snapshots');assert.equal(sn.body.items.length,1);
  assert.equal((await get('commit?sha=INVALID')).code,400);
  const safe=await get('preview?type=create&branch=feature%2Fnew');assert.equal(safe.code,200);
  const made=await post('operation',{type:'create',branch:'feature/new'},token);assert.equal(made.body.ok,true);
  assert.equal((await get('state')).body.refs.length,2);
  const latest=await get('snapshots');assert.equal(latest.body.items.length,2);
  const comparison=await get('compare?a=refs%2Fheads%2Fmain&b=refs%2Fheads%2Ffeature%2Fnew');assert.equal(comparison.body.status,'aligned');
});
test('API refuses cross-origin and invalid host headers',async()=>{
  const r=await fetch(base+'/api/bootstrap',{headers:{origin:'http://evil.example'}});assert.equal(r.status,403);
  const hostCode = await new Promise((ok,fail)=>{const r=httpRequest(base+'/api/bootstrap',{headers:{Host:'evil.example'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});r.on('error',fail);r.end();});assert.equal(hostCode,403);
});
test('Static index is delivered with restrictive CSP',async()=>{
  const r=await fetch(base+'/');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/default-src 'self'/);assert.match(await r.text(),/Commit Graph/);
});
test('cleanup',async()=>{
  await new Promise((ok,e)=>app.server.close(x=>x?e(x):ok()));
  await rm(dir,{recursive:true,force:true});await rm(data,{recursive:true,force:true});
});
