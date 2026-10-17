import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from '../shared/contracts.js';
import { emptyDiscoveryFilters, mergeDiscoveryJob, prepareDiscoveryAttempt } from '../web/src/discovery-jobs.js';

function job(overrides: Partial<Job> = {}): Job {
  return {id:'discovery-1',workspaceId:'workspace-1',kind:'discovery',status:'running',actor:'cli',text:'',error:null,
    createdAt:'2026-10-13T10:00:00.000Z',updatedAt:'2026-10-13T10:00:00.000Z',idempotencyKey:'request-1',baseVersion:7,
    discovery:{input:{instruction:'寻找实际案例',limit:20,baseVersion:7},phase:'planning'},...overrides};
}

test('an unconfirmed AI submission retries its original key and payload after edits, a version change, and reload', () => {
  let keys = 0;
  const initial = prepareDiscoveryAttempt(null,{...emptyDiscoveryFilters,tag:' #案例 ',limit:10},'  寻找实际案例  ',7,() => `request-${++keys}`);
  assert.deepEqual(initial.payload,{instruction:'寻找实际案例',tag:'案例',limit:10,baseVersion:7,idempotencyKey:'request-1'});
  const restored = JSON.parse(JSON.stringify(initial));
  const retry = prepareDiscoveryAttempt(restored,{...emptyDiscoveryFilters,tag:'反例',limit:30},'新方向',12,() => `request-${++keys}`);
  assert.deepEqual(retry,initial);
  assert.equal(keys,1);
  assert.equal(retry.instruction,'  寻找实际案例  ');
  assert.equal(retry.filters.tag,' #案例 ');
  const next = prepareDiscoveryAttempt(null,{...emptyDiscoveryFilters,tag:'反例',limit:30},'新方向',12,() => `request-${++keys}`);
  assert.equal(next.payload.idempotencyKey,'request-2');
  assert.equal(next.payload.baseVersion,12);
});

test('a late start response does not overwrite completed discovery results already received through the jobs feed', () => {
  const result = {terms:['案例'],readCount:3,possiblyLimited:false,omitted:[],ai:{summary:'没有足够相关的材料',recommendedCount:0}};
  const finished = job({status:'succeeded',text:result.ai.summary,updatedAt:'2026-10-13T10:02:00.000Z',
    discovery:{input:{instruction:'寻找实际案例',limit:20,baseVersion:7},phase:'ranking',terms:result.terms,result,workspaceVersion:7}});
  const other = job({id:'discussion-1',kind:'ai'});
  const merged = mergeDiscoveryJob([finished,other],job());
  assert.deepEqual(merged,[finished,other]);
  assert.equal(merged[0].discovery?.result?.ai?.recommendedCount,0);
  assert.equal(mergeDiscoveryJob([finished],job({updatedAt:finished.updatedAt}))[0].status,'succeeded');
});

test('the newest running phase survives an older start response and each job is included only once', () => {
  const ranking = job({updatedAt:'2026-10-13T10:01:00.000Z',discovery:{input:{instruction:'寻找实际案例',limit:20,baseVersion:7},phase:'ranking',terms:['案例']}});
  assert.deepEqual(mergeDiscoveryJob([ranking],job()),[ranking]);
  assert.deepEqual(mergeDiscoveryJob([job()],ranking),[ranking]);
  assert.deepEqual(mergeDiscoveryJob(undefined,job()),[job()]);
});
