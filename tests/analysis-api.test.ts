import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Memo, Workspace, AnalysisRecord } from '../shared/contracts.js';
import { analysisIsStale, formatAnalysisCard } from '../shared/analysis.js';
import { Store } from '../server/store.js';
import { WorkbenchService } from '../server/service.js';
import { createApp } from '../server/app.js';

const memo = (id: string): Memo => ({id,url:`https://v.flomoapp.com/mine/?memo_id=${id}`,content:`我的判断 ${id}`,tags:['想法'],created_at:'2026-09-01',updated_at:'2026-09-01',content_truncated:false,linked_memos:[]});
async function setup() {
  let creates = 0;
  const createdMemos = new Map<string,Memo>();
  const store = await Store.open(':memory:');
  const service = new WorkbenchService(store,{
    get:async id => createdMemos.get(id) ?? memo(id),search:async input => ({memos:[memo(input.query || 'found')],scope:'remote-search',limit:30,possiblyLimited:false,checkedAt:''}),
    related:async () => [],tags:async () => ({tags:[],total:0,returned:0,truncated:false}),update:async () => {throw Error('Never update originals');},
    create:async content => {creates++;const created={...memo('new'),content,linked_memos:['source']};createdMemos.set(created.id,created);return created;},
  });
  const workspace = await service.createWorkspace('source',undefined,'web');
  const app = await createApp({service});
  const request = async (method: 'GET'|'POST'|'PATCH', path: string, body?: unknown) => app.inject({method,url:`/api/v1/workspaces/${workspace.id}${path}`,
    headers:{'x-workbench-actor':'cli'},...(body === undefined ? {} : {payload:body as Record<string,unknown>})});
  return {store,service,app,workspace,request,creates:() => creates,close:async () => {await app.close();await store.close();}};
}

test('HTTP external analysis -> reviewed card -> explicit creation preserves draft and shared state', async () => {
  const f = await setup();
  try {
    const created = await f.request('POST','/analyses',{kind:'connections',question:'这些判断之间有什么联系？',engine:'external',baseVersion:1,idempotencyKey:'prepare'});
    assert.equal(created.statusCode,202,created.body);
    let state: Workspace = created.json();
    let record = state.analyses![0];
    assert.equal(record.status,'prepared');
    assert.ok(record.instructions.length > 30);assert.equal(record.sources[0].content,'我的判断 source');
    assert.equal((await f.request('GET','/analyses')).json()[0].id,record.id);
    assert.equal((await f.request('GET',`/analyses/${record.id}`)).json().question,record.question);
    assert.equal((await f.request('GET','/analyses/missing')).statusCode,404);
    const connection = await f.request('POST',`/analyses/${record.id}/result`,{text:'一个有依据的判断。',baseVersion:state.version});
    assert.equal(connection.statusCode,200,connection.body);state=connection.json();
    const extraction = await f.request('POST','/analyses',{kind:'cards',engine:'external',basisAnalysisId:record.id,baseVersion:state.version,idempotencyKey:'extract'});
    assert.equal(extraction.statusCode,202,extraction.body);state=extraction.json();record=state.analyses![1];
    const result = await f.request('POST',`/analyses/${record.id}/result`,{text:'候选卡片',cards:[{
      title:'能力需要匹配需求',body:'在具体需求里验证能力的价值。',tags:['想法','生态位'],sourceKeys:['flomo:source'],
    }],baseVersion:state.version});
    assert.equal(result.statusCode,200,result.body);state=result.json();
    const card=state.analyses![1].cards[0];
    assert.equal(f.creates(),0);
    assert.notEqual((await f.request('POST',`/analyses/${record.id}/cards/${card.id}/publish`,{baseVersion:state.version,idempotencyKey:'before-review'})).statusCode,202);
    const edited={title:card.title,body:card.body,tags:card.tags,sourceKeys:card.sourceKeys};
    const review=await f.request('PATCH',`/analyses/${record.id}/cards/${card.id}`,{...edited,baseVersion:state.version});
    assert.equal(review.statusCode,200,review.body);state=review.json();
    assert.ok(state.analyses![1].cards[0].reviewedAt);
    const publication=await f.request('POST',`/analyses/${record.id}/cards/${card.id}/publish`,{baseVersion:state.version,idempotencyKey:'publish-card'});
    assert.equal(publication.statusCode,202,publication.body);
    await f.service.settle();
    state=await f.store.getWorkspace(state.id);
    assert.equal(state.analyses![1].cards[0].status,'published');
    assert.equal(state.analyses![1].cards[0].resultMemo?.content,formatAnalysisCard(edited,record.sources));
    assert.equal(f.creates(),1);assert.equal(state.draft,f.workspace.draft);
    const retry=await f.request('POST',`/analyses/${record.id}/cards/${card.id}/publish`,{baseVersion:state.version,idempotencyKey:'different-key'});
    assert.equal(retry.statusCode,202,retry.body);await f.service.settle();assert.equal(f.creates(),1);
  } finally {await f.close();}
});

test('analysis routes reject invalid requests and discovery does not select its candidates', async () => {
  const f = await setup();
  try {
    const result=await f.request('POST','/discover',{terms:['生态位','定位'],baseVersion:1});
    assert.equal(result.statusCode,200,result.body);const discovered=result.json();
    assert.equal(discovered.workspace.materials.length,0);
    assert.equal(discovered.workspace.materialCandidates.length,2);
    assert.equal((await f.request('POST','/discover',{terms:[],baseVersion:discovered.workspace.version})).statusCode,400);
    const missingActor=await f.app.inject({method:'POST',url:`/api/v1/workspaces/${f.workspace.id}/analyses`,payload:{kind:'insights',engine:'external',baseVersion:1,idempotencyKey:'x'}});
    assert.equal(missingActor.statusCode,403);
    assert.equal((await f.request('POST','/analyses',{kind:'invalid',engine:'external',baseVersion:1,idempotencyKey:'x'})).statusCode,400);
    assert.equal((await f.request('POST','/analyses',{kind:'insights',engine:'external',baseVersion:1,idempotencyKey:'x'})).statusCode,409);
  } finally {await f.close();}
});

test('staleness follows material content and goal rather than workflow revisions', async () => {
  const f = await setup();
  try {
    const created=await f.request('POST','/analyses',{kind:'insights',engine:'external',baseVersion:1,idempotencyKey:'x'});
    const state:Workspace=created.json();const record:AnalysisRecord=state.analyses![0];
    assert.equal(analysisIsStale(record,state),false);
    assert.equal(analysisIsStale(record,{...state,version:99,draft:'修改草稿',messages:[]}),false);
    assert.equal(analysisIsStale(record,{...state,goal:'不同的问题'}),true);
    assert.equal(analysisIsStale(record,{...state,source:{...state.source,content:'新判断'}}),true);
    assert.equal(analysisIsStale(record,{...state,materials:[memo('new')]}),true);
  } finally {await f.close();}
});

test('source titles cannot add their old classification tags to a published card', () => {
  const formatted = formatAnalysisCard({title:'判断',body:'依据',tags:['想法'],sourceKeys:['flomo:source']},[
    {key:'flomo:source',kind:'flomo',id:'source',url:'https://v.flomoapp.com/mine/?memo_id=source',title:'#概要 外部作者的观点',content:'全文',tags:['概要'],createdAt:'',updatedAt:''},
  ]);
  assert.match(formatted,/#想法/);
  assert.doesNotMatch(formatted,/#概要/);
  assert.match(formatted,/＃概要 外部作者的观点/);
  assert.match(formatted,/https:\/\/v\.flomoapp\.com\/mine\/\?memo_id=source/);
});
