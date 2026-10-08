const palette = ['#59ded5', '#af92ff', '#e9b672', '#72c8fb', '#84d5a0', '#e48da2', '#b1ce6b', '#f3a47c', '#97a8e3'];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const colorFor = lane => palette[((lane % palette.length) + palette.length) % palette.length];
export const short = sha => sha ? sha.slice(0, 8) : '—';

export function buildLayout(commits) {
  const positions = new Map(), rows = [], active = [], edges = [];
  let largest = 0;
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    let lane = active.indexOf(commit.sha);
    if (lane < 0) { lane = active.indexOf(null); if (lane < 0) lane = active.length; active[lane] = commit.sha; }
    positions.set(commit.sha, { index:i, lane });
    rows.push({ commit, index:i, lane });
    const firstParent = commit.parents[0] || null;
    active[lane] = firstParent && active.some((v, k) => k !== lane && v === firstParent) ? null : firstParent;
    for (const parent of commit.parents.slice(1)) {
      if (active.includes(parent)) continue;
      let free = active.indexOf(null);
      if (free < 0) free = active.length;
      active[free] = parent;
    }
    while (active.at(-1) === null) active.pop();
    largest = Math.max(largest, lane, active.length);
  }
  for (const row of rows) for (let index = 0; index < row.commit.parents.length; index++) {
    const parent = row.commit.parents[index], end = positions.get(parent);
    edges.push({ from: row.index, fromLane: row.lane, to: end?.index ?? null, toLane: end?.lane ?? row.lane, parent, color: colorFor(row.lane + (index ? index : 0)), secondary: index > 0 });
  }
  return { rows, edges, positions, lanes: largest + 1 };
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', year:'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour:'2-digit', minute:'2-digit' });
function labelDate(ts) { if (!ts) return '—'; return dateFormat.format(new Date(ts * 1000)); }

export class GraphView {
  constructor(scroller, spacer, svg, rowsRoot, callbacks) {
    Object.assign(this, { scroller, spacer, svg, rowsRoot, callbacks });
    this.rowHeight = 53; this.graphWidth = 218; this.data = []; this.layout = buildLayout([]); this.refs = []; this.selected = null;
    this.branch = null; this.reachable = null; this.compare = null; this.query = ''; this.onScroll = () => this.render();
    scroller.addEventListener('scroll', this.onScroll, { passive:true });
    window.addEventListener('resize', () => this.render());
    rowsRoot.addEventListener('click', e => { const row = e.target.closest('.commit-row'); if (row) this.callbacks.select?.(row.dataset.sha); });
    rowsRoot.addEventListener('dblclick', e => { const row = e.target.closest('.commit-row'); if (row) this.callbacks.inspect?.(row.dataset.sha); });
    rowsRoot.addEventListener('contextmenu', e => { const row = e.target.closest('.commit-row'); if (row) { e.preventDefault(); this.callbacks.inspect?.(row.dataset.sha); } });
  }
  setData(commits, refs, options = {}) {
    const original = this.scroller.scrollTop;
    this.data = commits; this.refs = refs;
    this.layout = buildLayout(commits);
    this.spacer.style.height = `${commits.length * this.rowHeight}px`;
    this.scroller.scrollTop = options.keepScroll ? original : 0;
    this.render();
  }
  zoom(delta) { this.rowHeight = Math.max(37, Math.min(72, this.rowHeight + delta)); this.spacer.style.height = `${this.data.length * this.rowHeight}px`; this.render(); return Math.round(this.rowHeight / 53 * 100); }
  setHighlights({ selected, branch, reachable, compare, query } = {}) { this.selected = selected; this.branch = branch; this.reachable = reachable; this.compare = compare; this.query = (query || '').toLowerCase(); this.render(); }
  seek(sha) { const x = this.layout.positions.get(sha); if (x) { this.scroller.scrollTo({ top: Math.max(0, x.index * this.rowHeight - this.scroller.clientHeight / 3), behavior:'smooth' }); return true; } return false; }
  render() {
    if (!this.data.length) { this.rowsRoot.innerHTML=''; this.svg.innerHTML=''; return; }
    const rowH = this.rowHeight, top = this.scroller.scrollTop, viewport = this.scroller.clientHeight || 700;
    const start = Math.max(0, Math.floor(top / rowH) - 12), end = Math.min(this.data.length, Math.ceil((top + viewport) / rowH) + 15);
    const topPx = start * rowH, height = (end - start) * rowH;
    this.graphWidth = Math.max(210, Math.min(320, this.layout.lanes * 17 + 36));
    this.scroller.closest('.main-column').style.setProperty('--graph-width', `${this.graphWidth}px`);
    const labels = new Map(); for (const ref of this.refs) { if (!labels.has(ref.sha)) labels.set(ref.sha, []); labels.get(ref.sha).push(ref); }
    const path = [], circles = [];
    const relevant = sha => !this.compare || this.compare.uniqueA.includes(sha) || this.compare.uniqueB.includes(sha) || sha === this.compare.mergeBase;
    const x = lane => 24 + lane * 17;
    for (const edge of this.layout.edges) {
      const t = edge.to ?? this.data.length;
      if (t < start || edge.from > end || t < edge.from) continue;
      const a = (edge.from + .5) * rowH - topPx, b = (Math.min(t, this.data.length) + .5) * rowH - topPx;
      const x1 = x(edge.fromLane), x2 = x(edge.toLane), mid = Math.min(b - 8, a + Math.max(11, (b-a)*.42));
      const d = `M${x1} ${a} C${x1} ${mid},${x2} ${Math.max(mid,b-15)},${x2} ${Math.min(b,height+16)}`;
      path.push(`<path d="${d}" fill="none" stroke="${edge.color}" stroke-width="${edge.secondary ? 1.9 : 2.3}" stroke-opacity="${this.compare && !relevant(this.data[edge.from].sha) ? .18 : .77}" ${edge.to === null ? 'stroke-dasharray="4 6"' : ''}/>`);
    }
    for (let i = start; i < end; i++) {
      const item = this.layout.rows[i], p = item.commit, cx = x(item.lane), cy = (i+.5)*rowH-topPx;
      const chosen = p.sha === this.selected, isMerge = p.parents.length > 1;
      const faded = this.compare && !relevant(p.sha) || this.reachable && !this.reachable.has(p.sha);
      circles.push(`<circle cx="${cx}" cy="${cy}" r="${chosen ? 8 : isMerge ? 6.2 : 5.2}" fill="${chosen ? '#f5fcff' : '#0b101a'}" stroke="${colorFor(item.lane)}" stroke-width="${chosen?3:2.3}" opacity="${faded?.3:1}"/>`);
    }
    this.svg.setAttribute('width', String(this.graphWidth)); this.svg.style.left='0px'; this.svg.style.top=`${topPx}px`; this.svg.style.height=`${height}px`;
    this.svg.setAttribute('viewBox', `0 0 ${this.graphWidth} ${height}`);
    this.svg.innerHTML = path.join('') + circles.join('');
    let previousDate = start ? labelDate(this.data[start - 1].authored) : '';
    this.rowsRoot.innerHTML = this.layout.rows.slice(start,end).map(({ commit:p,index:i,lane }) => {
      const stamp = labelDate(p.authored), newDate = stamp !== previousDate; previousDate = stamp;
      const refsHTML = (labels.get(p.sha) || []).map(r=>`<span class="ref-badge ${r.kind === 'local'?'local':''}">${r.current ? '● ':''}${esc(r.name)}</span>`).join('');
      const matches = this.query && [p.sha,p.subject,p.author,p.email].some(v=>v.toLowerCase().includes(this.query));
      const dim = this.query && !matches || this.compare && !relevant(p.sha) || this.reachable && !this.reachable.has(p.sha);
      return `<div class="commit-row ${p.sha === this.selected?'selected':''} ${dim?'dim':''} ${matches?'matched':''}" data-sha="${p.sha}" style="top:${i*rowH}px;height:${rowH}px;--lane-color:${colorFor(lane)}" title="${esc(p.body.slice(0,450))}">
        <div class="commit-graph-cell"></div><div class="commit-message"><span class="commit-subject">${esc(p.subject||'(empty message)')}</span>${refsHTML}</div>
        <div class="commit-author"><span class="avatar" style="--avatar-color:${colorFor((p.author.charCodeAt(0)||0)%palette.length)}">${esc(p.author.slice(0,1).toUpperCase())}</span><span>${esc(p.author)}</span></div>
        <div class="commit-date">${newDate?'<span class="day-mark">'+esc(stamp)+'</span>':esc(timeFormat.format(new Date(p.authored*1000)))}</div>
        <div class="commit-sha">${short(p.sha)}</div></div>`;
    }).join('');
  }
}
