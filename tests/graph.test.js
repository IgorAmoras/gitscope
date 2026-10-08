import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout } from '../public/js/graph.js';
const c=(sha,parents=[])=>({sha,parents});
test('SVG graph only creates edges for genuine Git parents; merges have two',()=>{
  const commits=[c('H',['F','G']),c('G',['A']),c('F',['A']),c('A',[])];
  const graph=buildLayout(commits);
  assert.equal(graph.rows.length,4);
  assert.equal(graph.edges.length,4);
  for(const edge of graph.edges){assert(commits[edge.from].parents.includes(edge.parent));if(edge.to!==null)assert.equal(commits[edge.to].sha,edge.parent);}
  assert.equal(graph.edges.filter(x=>x.from===0).length,2);
});
test('Graph explicitly marks connections to unloaded parents',()=>{
  const g=buildLayout([c('x',['earlier'])]);assert.equal(g.edges[0].to,null);
});
