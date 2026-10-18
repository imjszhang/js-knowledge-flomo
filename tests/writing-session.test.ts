import assert from 'node:assert/strict';
import test from 'node:test';
import type {AnalysisRecord} from '../shared/contracts.js';
import {savedWritingSession} from '../web/src/writing-session.js';

test('saved external paragraph restores its edited outline, answers and exact basis without aliasing the record', () => {
  const record = {id:'paragraph',engine:'external',status:'succeeded',basisAnalysisId:'chosen-outline',writing:{
    stage:'paragraph',claim:'一个核心判断',answers:'用户补充',audience:'写给读者',structure:'scqa',outline:'编辑过的提纲',section:'第二部分',
  }} as AnalysisRecord;
  const saved = savedWritingSession(record)!;
  assert.equal(saved.basisId,'chosen-outline');
  assert.equal(saved.step,'paragraph');
  assert.equal(saved.engine,'external');
  assert.deepEqual(saved.form,record.writing);
  saved.form.outline = '网页继续编辑';
  assert.equal(record.writing!.outline,'编辑过的提纲');
});

test('saved outline resumes the outline step and only completed outlines become a usable basis', () => {
  const record = {id:'outline',engine:'builtin',status:'running',writing:{stage:'outline',claim:'判断'}} as AnalysisRecord;
  assert.equal(savedWritingSession(record)!.basisId,'');
  const saved = savedWritingSession({...record,status:'succeeded'})!;
  assert.equal(saved.basisId,'outline');
  assert.equal(saved.step,'outline');
  assert.equal(savedWritingSession({...record,writing:undefined}),undefined);
});
