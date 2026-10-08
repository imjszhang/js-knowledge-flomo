import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {Workspace, WritingInput} from '../../shared/contracts';
import {analysisIsStale} from '../../shared/analysis';
import {api, ApiError, messageOf} from './api';
import {useAnalysisInput} from './analysis-forms';

export const writingLabels = {questions:'补充想法', outline:'组织提纲', paragraph:'展开段落'};
export function WritingPanel({workspace, aiConfigured, disabled, flush, onUpdate, onMaterials, onBusy, renderContent}: {
  workspace:Workspace; aiConfigured:boolean; disabled:boolean; flush:()=>Promise<Workspace>;
  onBusy:(busy:boolean)=>void; onUpdate:(workspace:Workspace)=>void; onMaterials:()=>void; renderContent:(text:string)=>ReactNode;
}) {
  const [form,setForm] = useAnalysisInput<WritingInput>(`flomo:writing:${workspace.id}`, {stage:'questions',claim:'',audience:'',answers:'',structure:'direct',outline:'',section:''});
  const [basisId,setBasisId] = useAnalysisInput<string>(`flomo:writing-basis:${workspace.id}`, '');
  const [engine,setEngine] = useState<'builtin'|'external'>(aiConfigured ? 'builtin' : 'external');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const attempt = useRef<{signature:string;version:number;key:string} | undefined>(undefined);
  useEffect(()=>{onBusy(busy);},[busy]);
  const records = (workspace.analyses ?? []).filter(r=>r.writing?.claim === form.claim.trim() && r.status === 'succeeded');
  const questions = records.filter(r=>r.writing?.stage === 'questions').at(-1);
  const outlines = records.filter(r=>r.writing?.stage === 'outline');
  const basis = outlines.find(r=>r.id === basisId);
  function change(patch:Partial<WritingInput>) {setForm({...form,...patch});}
  async function run(stage:WritingInput['stage']) {
    if(busy || disabled) return;
    setBusy(true);setError('');
    try {
      const saved = await flush();
      const input = {kind:stage === 'questions' ? 'insights' as const : 'outline' as const,engine,question:'',writing:{...form,claim:form.claim.trim(),stage},basisAnalysisId:stage === 'paragraph' ? basisId : stage === 'outline' ? questions?.id : undefined};
      const signature = JSON.stringify(input);
      if(attempt.current?.signature !== signature) attempt.current = {signature,version:saved.version,key:crypto.randomUUID()};
      onUpdate(await api.createAnalysis(workspace.id,{...input,baseVersion:attempt.current.version,idempotencyKey:attempt.current.key}));
      attempt.current = undefined;
    } catch(error) {
      setError(messageOf(error));
      if(error instanceof ApiError && error.status >= 400 && error.status < 500) attempt.current = undefined;
    } finally {setBusy(false);}
  }
  const requirementsChanged = !!basis && (['audience','answers','structure'] as const).some(key => basis.writing?.[key] !== form[key].trim());
  const locked = disabled || busy;
  return <details className="quiet-disclosure"><summary>把这条想法展开</summary>
    <p className="section-description">先补充想法，再组织提纲，确认后逐段展开。输入保存在当前浏览器，分析结果保存在工作区。</p>
    <fieldset className="analysis-form" disabled={locked}>
      <label>核心判断<textarea value={form.claim} maxLength={2000} rows={2} onChange={e=>{change({claim:e.target.value,outline:''});setBasisId('');}} placeholder="例如：找到自己的生态位，比单纯提高能力更重要"/></label>
      <label>写给谁、希望读者理解什么（可选）<input value={form.audience} maxLength={1000} onChange={e=>change({audience:e.target.value})}/></label>
      <label>由谁分析<select value={engine} onChange={e=>setEngine(e.target.value as typeof engine)}><option value="builtin" disabled={!aiConfigured}>内置 AI</option><option value="external">Codex / 外部助手</option></select></label>
      <h4>1. 补充想法</h4>
      <button type="button" className="button secondary small" disabled={!form.claim.trim()} onClick={()=>void run('questions')}>看看还需要说明什么</button>
      {questions && <div className="analysis-output">{renderContent(questions.output)}</div>}
      <label>我的补充<textarea value={form.answers} maxLength={10000} rows={5} onChange={e=>change({answers:e.target.value})} placeholder="回答追问，补充自己的例子、解释和不确定的地方。"/></label>
      <button type="button" className="text-button" onClick={onMaterials}>去材料页查找并选用依据</button>
      <p className="scope-notice">使用当前笔记、{workspace.materials.length} 条已选笔记和 {workspace.collectorMaterials?.length ?? 0} 篇收藏原文。找不到依据的地方会标为待补充。</p>
      <h4>2. 组织提纲</h4>
      <label>展开方式<select value={form.structure} onChange={e=>change({structure:e.target.value as WritingInput['structure']})}><option value="direct">围绕第一句话解释、证明、补充</option><option value="scqa">SCQA：情境 → 冲突 → 问题 → 回答</option><option value="golden-circle">黄金圈：Why → How → What</option></select></label>
      <button type="button" className="button secondary small" disabled={!form.claim.trim()} onClick={()=>void run('outline')}>生成提纲</button>
      <h4>3. 确认提纲，展开一段</h4>
      <label>采用的提纲<select value={basisId} onChange={e=>{setBasisId(e.target.value);change({outline:outlines.find(r=>r.id === e.target.value)?.output ?? ''});}}><option value="">先选择一份已完成的提纲</option>{outlines.map(r=><option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString('zh-CN')}{analysisIsStale(r,workspace) ? '（材料已变化）' : ''}</option>)}</select></label>
      {basis && <><label>核对并编辑提纲<textarea rows={8} maxLength={20000} value={form.outline} onChange={e=>change({outline:e.target.value})}/></label><label>这次展开哪一段<textarea rows={2} maxLength={2000} value={form.section} onChange={e=>change({section:e.target.value})} placeholder="填写提纲中的段落标题或具体要求"/></label>{requirementsChanged && <p className="notice">写作要求已变化，请重新生成提纲。</p>}{analysisIsStale(basis,workspace) && <p className="notice">材料或目标已变化，请重新生成提纲后继续。</p>}</>}
      <button type="button" className="button primary small" disabled={!basis || requirementsChanged || analysisIsStale(basis,workspace) || !form.outline.trim() || !form.section.trim()} onClick={()=>void run('paragraph')}>确认提纲并展开这一段</button>
      <p className="scope-notice">结果出现在下方分析记录中。核对后点击“用于草稿”，预览并追加。选择 Codex 时只准备任务，请回到对话让它完成分析。</p>
    </fieldset>
    {busy && <p role="status">正在准备写作任务…</p>}{error && <p className="error-box" role="alert">{error}</p>}
  </details>;
}
