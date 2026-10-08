import { GraphView, short } from './graph.js';
const $ = id => document.getElementById(id);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => value ? new Date(value).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'short'}) : '—';
const number = n => Number(n || 0).toLocaleString();
const state = { token:'', repo:null, live:null, active:null, selected:null, branch:null, reachable:null, compare:null, panel:'details', stats:null, snapshots:[], snapshotIndex:null, loading:false, rowsLoading:false, operation:null, preview:null, xray:null, search:'' };
const api = async (route, body = undefined) => {
  const response = await fetch('/api/' + route, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-GitScope-Token':state.token},body:JSON.stringify(body)});
  const result = await response.json(); if (!response.ok) throw Error(result.error || `HTTP ${response.status}`); return result;
};
let toastTimer;
function toast(message, bad = false) { const el = $('toast'); el.textContent = message; el.classList.remove('hidden'); el.style.borderColor = bad?'#bf6a7c':'#568c93'; clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.add('hidden'),4500); }
function report(e) { console.error(e); toast(e?.message || String(e), true); }
const graph = new GraphView($('graphScroller'), $('graphSpacer'), $('edgesSvg'), $('visibleRows'), {
  select(sha){state.selected=sha; graph.setHighlights({selected:sha,branch:state.branch,reachable:state.reachable,compare:state.compare,query:state.search}); if (state.panel==='details'|| state.panel==='diff') showPanel(state.panel);},
  inspect(sha){state.selected=sha;graph.setHighlights({selected:sha,branch:state.branch,reachable:state.reachable,compare:state.compare,query:state.search});showPanel('details');}
});
function setConnected(data, keepScroll = false) {
  state.active = data;
  $('emptyGraph').classList.toggle('hidden', !!data && data.commits.length > 0);
  if (!data) return;
  $('repoTitle').textContent = data.name;
  $('repoLocation').textContent = data.repo;
  $('currentBranch').textContent = data.head.branch || (data.head.detached ? 'DETACHED HEAD':'Unborn branch');
  $('workStatus').className = 'status-pill ' + (data.head.dirty?'dirty':'clean');
  $('workStatus').innerHTML = `<span class="status-dot"></span> ${data.head.dirty ? `${number(data.head.changes)} changes`:'Clean workspace'}`;
  $('graphCount').textContent = `${number(data.total)} commits`;
  $('graphFooterLeft').textContent = `${number(data.commits.length)} / ${number(data.total)} COMMITS LOADED`;
  $('graphFooterRight').textContent = data.complete === false ? 'RECORDED METADATA · PARTIAL' : 'TOPOLOGICAL ORDER · GIT NATIVE';
  graph.setData(data.commits, data.refs, {keepScroll});
  graph.setHighlights({selected:state.selected,branch:state.branch,reachable:state.reachable,compare:state.compare,query:state.search});
  renderRefs();
}
async function openPath(path) {
  $('welcome').classList.add('hidden');
  try {
    const data = await api('open', {path});
    state.repo = path; state.live = data; state.branch = null; state.reachable=null; state.compare = null; state.snapshotIndex=null;state.selected=null;
    setConnected(data); await Promise.all([refreshStats(), loadSnapshots()]);
    toast('Repository connected: '+data.name);
  } catch(e) { $('welcome').classList.remove('hidden'); report(e); }
}
async function refreshLive({keepScroll=true,force=false}={}) {
  if (!state.repo || state.loading || state.snapshotIndex!==null && !force) return;
  state.loading=true;
  try {
    const data=await api('state?limit=600'); state.live=data;
    if (state.snapshotIndex===null) setConnected(data,keepScroll);
    await refreshStats(); await loadSnapshots(false);
  } catch(e){report(e);} finally {state.loading=false;}
}
async function loadMore() {
  if (state.rowsLoading || !state.live?.hasMore || state.snapshotIndex!==null) return;
  state.rowsLoading=true;
  try {
    const next=await api(`state?offset=${state.live.commits.length}&limit=500`);
    if (next.commits.length) {
      state.live.commits.push(...next.commits);state.live.hasMore=next.hasMore;
      setConnected(state.live,true);
    } else state.live.hasMore=false;
  } catch(e){report(e);} finally{state.rowsLoading=false;}
}
$('graphScroller').addEventListener('scroll', () => {
  const el=$('graphScroller'); if (el.scrollTop + el.clientHeight >= el.scrollHeight - 900) loadMore();
},{passive:true});
function refsHTML(branches, root, id) {
  const entries = branches.filter(r=>r.kind===id);
  $(root).innerHTML = entries.map(r=> `<button class="branch-item ${r.kind==='remote'?'remote':r.kind==='tag'?'tag':''} ${r.fullName===state.branch?'selected':''} ${r.fullName===state.compare?.b.fullName?'comparing':''}" data-ref="${esc(r.fullName)}" title="${esc(r.fullName)}">
    <span class="branch-symbol">${id==='local'?'⑂':id==='remote'?'◈':'◇'}</span><span class="branch-name">${esc(r.name)}</span>${r.current?'<span class="current-badge">HEAD</span>':''}<span class="branch-menu" title="Git actions">⋮</span></button>`).join('') || '<p class="small-note" style="padding-left:12px">None detected</p>';
  $(({local:'localCount',remote:'remoteCount',tag:'tagCount'})[id]).textContent=entries.length;
}
function renderRefs(){ if (!state.active) return; for(const [k,v] of [['local','localBranches'],['remote','remoteBranches'],['tag','tagBranches']]) refsHTML(state.active.refs,v,k); }
for(const root of ['localBranches','remoteBranches','tagBranches']) $(root).addEventListener('click',e=> {
  const node=e.target.closest('.branch-item'); if(!node) return;
  const ref=state.active.refs.find(r=>r.fullName===node.dataset.ref);
  if(e.target.classList.contains('branch-menu')) {openOperation('switch',ref.name);return;}
  selectBranch(ref.fullName,e.ctrlKey||e.metaKey||e.shiftKey);
});
async function selectBranch(ref,compareMode=false) {
  if (state.snapshotIndex!==null) {toast('Return to LIVE to compare current references.');return;}
  if (compareMode && state.branch && state.branch!==ref) {
    try {state.compare=await api(`compare?a=${encodeURIComponent(state.branch)}&b=${encodeURIComponent(ref)}`);
      $('comparisonRibbon').classList.remove('hidden');
      $('comparisonText').textContent=`${state.compare.a.name}: +${state.compare.aheadA}  /  ${state.compare.b.name}: +${state.compare.aheadB}  ·  ${state.compare.status}`;
    } catch(e){report(e);return;}
  } else {state.branch=state.branch===ref?null:ref;state.reachable=null;state.compare=null;$('comparisonRibbon').classList.add('hidden');}
  const sel=state.active.refs.find(r=>r.fullName===state.branch);
  if(sel){try{const reached=await api('reachable?ref='+encodeURIComponent(sel.fullName));state.reachable=new Set(reached.shas);}catch(e){report(e);}}
  $('scopeName').textContent=sel?sel.name.toUpperCase():'ALL HISTORY';
  graph.setHighlights({selected:state.selected,branch:state.branch,reachable:state.reachable,compare:state.compare,query:state.search});
  if(sel) graph.seek(sel.sha);
  renderRefs(); await refreshStats(); if(state.compare) showPanel('details');
}
$('comparisonClose').onclick=()=>{state.compare=null;$('comparisonRibbon').classList.add('hidden');graph.setHighlights({selected:state.selected,branch:state.branch,compare:null,query:state.search});renderRefs();};
async function refreshStats() {
  if(!state.live || state.snapshotIndex!==null) return;
  try {
    const branch = state.branch ? '&branch='+encodeURIComponent(state.branch) : '';
    const stats = await api('stats?days=365'+branch);
    state.stats=stats;
    $('metricCommits').textContent=number(stats.total);
    $('metricAuthors').textContent=number(stats.contributors);
    $('metricBranches').textContent=number(stats.branches);
    $('metricMonth').textContent=number(stats.recent30);
    $('metricMerges').textContent=number(stats.merges);
    if (state.panel==='analytics' && !$('drawer').classList.contains('hidden')) drawAnalytics();
  } catch(e){report(e);}
}
function drawerOpen(panel,title){ state.panel=panel;$('drawer').classList.remove('hidden');$('drawerCategory').textContent=panel.toUpperCase();$('drawerTitle').textContent=title;
  for(const tab of $('drawerTabs').children)tab.classList.toggle('active',tab.dataset.panel===panel); }
async function showPanel(panel) {
  const selected=state.active?.commits.find(c=>c.sha===state.selected);
  const titles={details:selected?'Commit details':'Branch intelligence',diff:'Patch viewer',analytics:'Repository insights',xray:'Git X-Ray',machine:'Time Machine',history:'Commit history'};
  drawerOpen(panel,titles[panel]);$('drawerBody').innerHTML='<p class="muted">Reading Git data…</p>';
  try {
    if(panel==='details')await drawDetails();
    else if(panel==='diff')await drawDiff();
    else if(panel==='analytics')await drawAnalytics();
    else if(panel==='xray')await drawXray();
    else if(panel==='machine')await drawMachine();
    else if(panel==='history')await drawHistory();
  }catch(e){$('drawerBody').innerHTML=`<div class="alert">${esc(e.message)}</div>`;}
}
async function drawDetails(){
  const sha=state.selected;
  if(!sha && !state.compare) { $('drawerBody').innerHTML='<p class="muted">Click a commit to inspect its parents, branch membership, metadata and diff. Ctrl-click a second branch to compare histories.</p>';return; }
  if(state.compare){const c=state.compare;
    $('drawerBody').innerHTML=`<div class="dim-heading">DETERMINISTIC BRANCH INTELLIGENCE</div><h3>${esc(c.a.name)} ⇄ ${esc(c.b.name)}</h3><div class="info-grid"><dt>Status</dt><dd>${esc(c.status)}</dd><dt>Left unique</dt><dd>${number(c.aheadA)} commits</dd><dt>Right unique</dt><dd>${number(c.aheadB)} commits</dd><dt>Merge-base</dt><dd><code>${esc(short(c.mergeBase))}</code></dd></div><p>${esc(c.explanation)}</p><p class="small-note">Numbers use git rev-list --left-right --count. Shaded commits do not belong to either exclusive set.</p>`;
    return;
  }
  const c=state.snapshotIndex!==null ? state.active.commits.find(x=>x.sha===sha) : await api('commit?sha='+encodeURIComponent(sha));
  if(!c){$('drawerBody').innerHTML='<p>Commit not found in the captured metadata.</p>';return;}
  $('drawerBody').innerHTML=`<span class="dim-heading">COMMIT / ${esc(short(c.sha))}</span><h3>${esc(c.subject)}</h3><p>${esc(c.body)}</p>
    <dl class="info-grid"><dt>SHA</dt><dd><code>${esc(c.sha)}</code></dd><dt>Author</dt><dd>${esc(c.author)}<br><span class="muted">${esc(c.email)}</span></dd><dt>Authored</dt><dd>${date(c.authored*1000)}</dd><dt>Committed</dt><dd>${date(c.committed*1000)}</dd><dt>Parents</dt><dd>${c.parents.map(x=>'<code>'+esc(short(x))+'</code>').join('<br>')||'Root commit'}</dd><dt>Reachable from</dt><dd>${esc(c.branches?.join(', ')||'Not recorded')}</dd></dl>
    <div class="panel-actions"><button data-action="diff">View diff ↗</button><button data-action="copy">Copy SHA</button></div>${c.stat?'<h3>Changed files</h3><pre>'+esc(c.stat)+'</pre>':''}${state.snapshotIndex!==null?'<p class="alert">Captured metadata only; file contents are not backed up.</p>':''}`;
  $('drawerBody').querySelector('[data-action="diff"]').onclick=()=>showPanel('diff');
  $('drawerBody').querySelector('[data-action="copy"]').onclick=()=>navigator.clipboard.writeText(c.sha).then(()=>toast('Copied commit SHA'));
}
async function drawDiff(){if(!state.selected){$('drawerBody').innerHTML='<p>Select a commit to view its Git patch.</p>';return;}
  if(state.snapshotIndex!==null){$('drawerBody').innerHTML='<div class="alert">Snapshots retain commit metadata, not full source files. Return to LIVE to inspect the available patch.</div>';return;}
  const d=await api('diff?sha='+encodeURIComponent(state.selected));
  $('drawerBody').innerHTML=`<p class="muted">Native Git diff · ${esc(short(d.sha))} · bounded to 2 MB</p><pre>${esc(d.content||'No textual changes')}</pre>`;
}
function heatmap(daily, days){
  const end=new Date(), start=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate()-days+1));
  const first=new Date(start);first.setUTCDate(first.getUTCDate()-first.getUTCDay());const cells=[];
  for(let d=new Date(first); d<=end; d.setUTCDate(d.getUTCDate()+1)){
    const key=d.toISOString().slice(0,10),count=daily?.[key]||0;
    const level=count===0?0:count===1?1:count<4?2:count<8?3:4;
    cells.push(`<span class="heat-cell" data-level="${level}" title="${key}: ${count} commits"></span>`);
  }
  return `<div class="heat-scroll"><div class="heatmap">${cells.join('')}</div></div><p class="heat-legend">Less ▪ ▪ ▪ ▪ More &nbsp;·&nbsp; Git author dates in UTC</p>`;
}
function authorOptions(stats,chosen=''){return `<option value="">All contributors</option>`+stats.authors.map(a=>`<option value="${esc(a.email)}" ${chosen===a.email?'selected':''}>${esc(a.name)} (${esc(a.email)})</option>`).join('');}
async function drawAnalytics(){
  const stats=state.stats;
  if(!stats){$('drawerBody').innerHTML='<p>Open a repository for analytics.</p>';return;}
  const oldAuthor=$('analyticsAuthor')?.value || ''; const oldDays=$('analyticsDays')?.value || '365';
  $('drawerBody').innerHTML=`<div class="dim-heading">FILTERS</div><label class="small-note">CONTRIBUTOR</label><select class="picker" id="analyticsAuthor">${authorOptions(stats,oldAuthor)}</select><label class="small-note">PERIOD</label><select class="picker" id="analyticsDays"><option value="90">90 days</option><option value="365" selected>12 months</option><option value="730">24 months</option></select>
    <div id="analyticsData"></div>`;
  $('analyticsDays').value=oldDays;
  const draw=async()=>{
    const params=new URLSearchParams({days:$('analyticsDays').value});if(state.branch)params.set('branch',state.branch);if($('analyticsAuthor').value)params.set('author',$('analyticsAuthor').value);
    const s=await api('stats?'+params);
    const top=Math.max(1,...s.contributorsRanked.map(a=>a.count));
    $('analyticsData').innerHTML=`<div class="data-row"><span>Reachable commits ${s.sampled?'(sampled)':''}</span><strong>${number(s.total)}</strong></div><div class="data-row"><span>Contributors</span><strong>${number(s.contributors)}</strong></div><div class="data-row"><span>Merge commits</span><strong>${number(s.merges)}</strong></div><h3>Contribution activity</h3>${heatmap(s.daily,Number($('analyticsDays').value))}<h3>Top contributors</h3>${s.contributorsRanked.map(a=>`<div class="bar-line"><span class="bar-name" title="${esc(a.email)}">${esc(a.name)}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${Math.max(2,a.count/top*100)}%"></span></span><span class="bar-number">${a.count}</span></div>`).join('')||'<p>No commits in this period.</p>'}<h3>File activity (sample)</h3><div id="fileStats"><p class="muted">Loading sampled file activity…</p></div><p class="small-note">${esc(s.note)} ${s.sampled?'Older commits omitted for performance.':''}</p>`;
    try {
      const f=await api('files?'+params);
      $('fileStats').innerHTML=f.files.map(x=>`<div class="data-row"><span title="${esc(x.file)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.file)}</span><span>${x.touches} changes</span></div>`).join('')||'<p class="muted">No textual file statistics found.</p>';
      $('fileStats').insertAdjacentHTML('beforeend','<p class="small-note">Sampled up to 450 recent commits; totals do not represent the entire repository.</p>');
    }catch(e){$('fileStats').textContent=e.message;}
  };
  $('analyticsAuthor').onchange=()=>draw().catch(report);$('analyticsDays').onchange=()=>draw().catch(report);await draw();
}
async function drawXray(){
  if(state.snapshotIndex!==null){$('drawerBody').innerHTML='<p>Return to LIVE to inspect local reflogs.</p>';return;}
  const c=state.compare;const qs=c?`?a=${encodeURIComponent(c.a.fullName)}&b=${encodeURIComponent(c.b.fullName)}`:'';
  const x=await api('xray'+qs);
  $('drawerBody').innerHTML=`<p>Analyze reflogs and patch-equivalence signals without an LLM. Evidence is not proof of how a rebase or cherry-pick occurred.</p>
    <h3>Equivalent changes ${c?'between compared branches':''}</h3>${x.equivalent.map(i=>`<div class="data-row"><code>${esc(short(i.sha))}</code><span>Patch match</span></div>`).join('')||'<p class="muted">No equivalent patches identified in this view.</p>'}
    <h3>Local reflog events</h3>${x.reflog.slice(0,80).map(i=>`<div class="data-row"><span><code>${esc(short(i.sha))}</code><br><span class="muted">${esc(i.message)}</span></span><span>${esc(i.ref)}</span></div>`).join('')||'<p class="muted">No reflog records available.</p>'}
    <div class="alert">Reflogs can expire and rewritten objects may be garbage-collected. These signals cannot reconstruct unavailable code.</div>`;
}
async function loadSnapshots(openPanel=false){if(!state.repo)return; try {const x=await api('snapshots');state.snapshots=x.items.reverse();state.operations=x.operations;if(openPanel)showPanel('machine');}catch(e){report(e);} }
async function snapshotAt(index){
  if(index<0||index>=state.snapshots.length)return;
  try {
    const item=await api('snapshot?id='+encodeURIComponent(state.snapshots[index].id));state.snapshotIndex=index;state.selected=null;
    state.branch=null;state.reachable=null;state.compare=null;
    for(const id of ['metricCommits','metricAuthors','metricBranches','metricMonth','metricMerges'])$(id).textContent='—';
    setConnected({...item,name:item.repo.split(/[\\/]/).at(-1),hasMore:false});
    $('machineRibbon').classList.remove('hidden');$('machineRange').min='0';$('machineRange').max=String(state.snapshots.length-1);$('machineRange').value=String(index);
    $('machineAt').textContent=date(item.captured);$('scopeName').textContent='RECORDED STATE';$('comparisonRibbon').classList.add('hidden');
    if(state.panel==='machine')showPanel('machine');
  }catch(e){report(e);}
}
function returnLive(){state.snapshotIndex=null;state.selected=null;state.branch=null;state.reachable=null;state.compare=null;$('machineRibbon').classList.add('hidden');$('scopeName').textContent='ALL HISTORY';if(state.live)setConnected(state.live);refreshStats();if(state.panel==='machine')showPanel('machine');}
async function drawMachine(){
  const snapshots=state.snapshots;
  $('drawerBody').innerHTML=`<p>GitScope automatically captures changed references and recent graph metadata. These records are not source-code backups.</p><div class="data-row"><span>Recorded states</span><strong>${snapshots.length}</strong></div>
    <div class="panel-actions"><button id="timeReturn">Return to live</button>${snapshots.length>=2?'<button id="timeCompare">Compare earliest ⇄ latest</button>':''}</div>
    <div id="machineCompareResult"></div><h3>Recorded snapshots</h3>${snapshots.slice().reverse().map((x,i)=>`<button class="snapshot-item" data-snapshot="${snapshots.length-1-i}">${esc(date(x.captured))}<small>${esc(x.summary.reason)} · ${x.summary.refs} refs · ${number(x.summary.commits)} commits (${x.summary.cached} cached)</small></button>`).join('')}`;
  $('timeReturn').onclick=returnLive;
  $('timeCompare') && ($('timeCompare').onclick=async()=>{
    try {const a=snapshots[0],b=snapshots.at(-1);const x=await api(`snapshot-diff?from=${a.id}&to=${b.id}`);
      $('machineCompareResult').innerHTML=`<div class="info-grid"><dt>Created</dt><dd>${esc(x.created.join(', ')||'None')}</dd><dt>Deleted</dt><dd>${esc(x.deleted.join(', ')||'None')}</dd><dt>Moved refs</dt><dd>${esc(x.moved.map(m=>m.ref).join(', ')||'None')}</dd><dt>HEAD changed</dt><dd>${x.headChanged?'Yes':'No'}</dd></div><p class="small-note">${esc(x.note)}</p>`;
    }catch(e){report(e);}
  });
  $('drawerBody').querySelectorAll('[data-snapshot]').forEach(b=>b.onclick=()=>snapshotAt(Number(b.dataset.snapshot)));
}
async function drawHistory(){
  const items=state.active?.commits||[];
  $('drawerBody').innerHTML=`<p>${number(items.length)} loaded commits, topological order. Click a row to inspect.</p><div class="history-rows">${items.slice(0,750).map(c=>`<button class="snapshot-item" data-commit="${esc(c.sha)}"><code>${esc(short(c.sha))}</code> &nbsp; ${esc(c.subject)}<small>${esc(c.author)} · ${date(c.authored*1000)}</small></button>`).join('')}</div>`;
  $('drawerBody').querySelectorAll('[data-commit]').forEach(b=>b.onclick=()=>{state.selected=b.dataset.commit;graph.seek(state.selected);showPanel('details');});
}
function showWelcome(){$('welcome').classList.remove('hidden');$('repoPath').focus();}
function closeWelcome(){if(state.active)$('welcome').classList.add('hidden');}
$('chooseRepo').onclick=showWelcome;$('emptyOpen').onclick=showWelcome;$('closeWelcome').onclick=closeWelcome;
$('repoForm').onsubmit=e=>{e.preventDefault();openPath($('repoPath').value.trim());};
$('closeDrawer').onclick=()=>$('drawer').classList.add('hidden');
$('drawerTabs').addEventListener('click',e=>{const button=e.target.closest('button[data-panel]');if(button)showPanel(button.dataset.panel);});
$('analyticsButton').onclick=()=>showPanel('analytics');$('commitTableButton').onclick=()=>showPanel('history');
$('xrayButton').onclick=()=>showPanel('xray');$('timeButton').onclick=()=>loadSnapshots(true);
$('refresh').onclick=()=>refreshLive({keepScroll:true});
$('zoomIn').onclick=()=>{$('zoomLabel').textContent=graph.zoom(8)+'%';};$('zoomOut').onclick=()=>{$('zoomLabel').textContent=graph.zoom(-8)+'%';};
$('search').addEventListener('input',()=>{
  state.search=$('search').value.trim();graph.setHighlights({selected:state.selected,branch:state.branch,reachable:state.reachable,compare:state.compare,query:state.search});
  if(state.search.length>2){const match=state.active?.commits.find(c=>[c.sha,c.subject,c.author,c.email].some(v=>v.toLowerCase().includes(state.search.toLowerCase())));if(match)graph.seek(match.sha);}
});
$('collapseSidebar').onclick=()=>{$('sidebar').classList.toggle('collapsed');};
$('machineLive').onclick=returnLive;$('machinePrevious').onclick=()=>snapshotAt((state.snapshotIndex??0)-1);$('machineNext').onclick=()=>snapshotAt((state.snapshotIndex??-1)+1);$('machineRange').oninput=()=>snapshotAt(Number($('machineRange').value));
$('settingsButton').onclick=()=>{drawerOpen('settings','About GitScope');$('drawerBody').innerHTML='<h3>History, illuminated.</h3><p>Vanilla JavaScript · Node.js · native Git CLI · SQLite persistence. Everything runs on your machine.</p><div class="data-row"><span>Search</span><span>/</span></div><div class="data-row"><span>Compare branches</span><span>Ctrl + click</span></div><div class="data-row"><span>Inspect commit</span><span>Double click</span></div><div class="data-row"><span>Close panels</span><span>Esc</span></div><p class="small-note">Snapshots live in ~/.gitscope outside the selected repository.</p>';};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('confirmModal').classList.add('hidden');closeWelcome();$('drawer').classList.add('hidden');}if(e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();$('search').focus();}});
// Operation preview and explicit two-step confirmation.
function openOperation(type='fetch',branch=''){
  if(state.snapshotIndex!==null){toast('Return to LIVE before running Git operations.',true);return;}
  if(!state.repo){showWelcome();return;}
  state.preview=null;$('confirmModal').classList.remove('hidden');$('operationType').value=type;$('confirmBranch').value=branch;
  $('confirmPreview').textContent='Review the operation before execution.';$('confirmProceed').textContent='Review operation ↗';$('confirmProceed').disabled=false;
  $('confirmTitle').textContent='Git operation';$('confirmExplanation').textContent='GitScope uses your locally installed Git and does not automatically force or discard changes.';
  $('confirmBranch').disabled=false;$('confirmRemote').disabled=false; syncOperationInputs();
}
function syncOperationInputs(){state.preview=null;const t=$('operationType').value,need=['switch','create','delete','merge','rebase'].includes(t),net=['fetch','pull','push'].includes(t);
  $('confirmBranch').disabled=!need;$('confirmRemote').disabled=!net;
  if(need&&!$('confirmBranch').value&&state.branch){$('confirmBranch').value=state.active.refs.find(x=>x.fullName===state.branch)?.name||'';}
  $('confirmProceed').textContent='Review operation ↗';$('confirmPreview').textContent='';}
$('operationType').onchange=syncOperationInputs;
$('confirmBranch').oninput=()=>{state.preview=null;$('confirmProceed').textContent='Review operation ↗';};
$('confirmRemote').oninput=()=>{state.preview=null;$('confirmProceed').textContent='Review operation ↗';};
$('operationsButton').onclick=()=>openOperation('fetch');$('confirmCancel').onclick=()=>$('confirmModal').classList.add('hidden');
$('confirmProceed').onclick=async()=>{
  const payload={type:$('operationType').value,branch:$('confirmBranch').value.trim(),remote:$('confirmRemote').value.trim()};
  const button=$('confirmProceed');button.disabled=true;
  try {
    if(!state.preview){
      const query=new URLSearchParams(payload);state.preview=await api('preview?'+query);
      $('confirmExplanation').textContent=state.preview.summary;
      $('confirmPreview').textContent=state.preview.destructive?'CAUTION: This operation may change Git history. Conflicts must be resolved externally.':'Preview verified by GitScope.';
      button.textContent='Execute '+payload.type+' →';
    }else{
      if(state.preview.type!==payload.type || state.preview.branch!==payload.branch && ['switch','create','delete','merge','rebase'].includes(payload.type)) throw Error('Parameters changed. Please review again.');
      button.textContent='Executing…';
      const out=await api('operation',payload);
      $('confirmModal').classList.add('hidden');state.preview=null;
      toast(out.ok?'Git operation completed':'Git operation reported a conflict or error',!out.ok);
      if(!out.ok) {drawerOpen('history','Operation result');$('drawerBody').innerHTML=`<pre>${esc(out.output)}</pre>${out.guidance?`<div class="alert">${esc(out.guidance)}</div>`:''}`;}
      await refreshLive({force:true,keepScroll:true});
    }
  }catch(e){report(e);state.preview=null;button.textContent='Review operation ↗';}finally{button.disabled=false;}
};
async function bootstrap(){
  try{
    const b=await api('bootstrap');state.token=b.token;
    $('recentList').innerHTML=b.recent.map(x=>`<button class="recent-item" data-path="${esc(x.repo)}">⌘ &nbsp; ${esc(x.repo)}</button>`).join('')||'<span class="small-note">No workspaces opened yet.</span>';
    $('recentList').querySelectorAll('[data-path]').forEach(b=>b.onclick=()=>openPath(b.dataset.path));
    if(b.repo){const data=await api('state?limit=600');state.repo=b.repo;state.live=data;setConnected(data);refreshStats();loadSnapshots();}
    else showWelcome();
  }catch(e){report(e);showWelcome();}
}
bootstrap();
