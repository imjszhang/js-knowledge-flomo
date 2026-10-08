import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {AnalysisRecord, Workspace, WritingInput} from '../../shared/contracts';
import {analysisIsStale} from '../../shared/analysis';
import {api, ApiError, messageOf} from './api';
import {useAnalysisInput} from './analysis-forms';

export const writingLabels = {questions:'补充想法', outline:'组织提纲', paragraph:'展开段落'};
const steps = ['questions', 'outline', 'paragraph'] as const;
const stepDescriptions = {
  questions: '先写下一句核心判断，再补上你想说明的内容。',
  outline: '选择表达顺序，让想法和材料形成一份有依据的提纲。',
  paragraph: '核对提纲，挑选其中一段展开，再预览加入草稿。',
};
export function WritingPanel({workspace, aiConfigured, disabled, flush, onUpdate, onMaterials, onBusy, onPreview, renderContent}: {
  workspace:Workspace; aiConfigured:boolean; disabled:boolean; flush:()=>Promise<Workspace>;
  onBusy:(busy:boolean)=>void; onUpdate:(workspace:Workspace)=>void; onMaterials:()=>void;
  onPreview:(content:string, originAnalysisId?:string)=>void; renderContent:(text:string)=>ReactNode;
}) {
  const [form,setForm] = useAnalysisInput<WritingInput>(`flomo:writing:${workspace.id}`, {stage:'questions',claim:'',audience:'',answers:'',structure:'direct',outline:'',section:''});
  const [basisId,setBasisId] = useAnalysisInput<string>(`flomo:writing-basis:${workspace.id}`, '');
  const [step,setStep] = useAnalysisInput<WritingInput['stage']>(`flomo:writing-step:${workspace.id}`, 'questions');
  const surface = useRef<HTMLElement>(null);
  function changeStep(next:WritingInput['stage']) {
    setStep(next);
    requestAnimationFrame(()=>surface.current?.scrollIntoView({block:'start'}));
  }
  const [engine,setEngine] = useState<'builtin'|'external'>(aiConfigured ? 'builtin' : 'external');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const attempt = useRef<{signature:string;version:number;key:string} | undefined>(undefined);
  useEffect(()=>{onBusy(busy);},[busy]);
  const matchingRecords = (workspace.analyses ?? []).filter(r=>r.writing?.claim === form.claim.trim());
  const records = matchingRecords.filter(r=>r.status === 'succeeded');
  const questions = records.filter(r=>r.writing?.stage === 'questions').at(-1);
  const outlines = records.filter(r=>r.writing?.stage === 'outline');
  const basis = outlines.find(r=>r.id === basisId);
  const currentStep = steps.includes(step) ? step : 'questions';
  const latestResult = matchingRecords.filter(r=>r.writing?.stage === currentStep).at(-1);
  function change(patch:Partial<WritingInput>) {setForm({...form,...patch});}
  function chooseOutline(record:AnalysisRecord) {
    setBasisId(record.id);
    change({outline:record.output});
  }
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
  return <section ref={surface} className="writing-workflow" aria-label="把这条想法展开">
    <div className="writing-settings"><label>分析助手<select value={engine} disabled={locked} onChange={e=>setEngine(e.target.value as typeof engine)}><option value="builtin" disabled={!aiConfigured}>内置 AI</option><option value="external">Codex / 外部助手</option></select></label></div>
    <nav className="writing-stepper" aria-label="写作步骤">{steps.map((item,index)=><button key={item} type="button" className={currentStep === item ? 'active' : ''} aria-current={currentStep === item ? 'step' : undefined} disabled={locked} onClick={()=>changeStep(item)}><span>{index + 1}</span>{writingLabels[item]}</button>)}</nav>
    {currentStep !== 'questions' && <div className="writing-context"><div><small>核心判断</small><p>{form.claim.trim() || '先补充一句你想表达的判断。'}</p></div><button type="button" className="text-button" disabled={locked} onClick={()=>changeStep('questions')}>修改想法</button></div>}
    <div className="writing-step">
      <div className="writing-step-heading"><h3>{writingLabels[currentStep]}</h3><p>{stepDescriptions[currentStep]}</p></div>
      <fieldset className="writing-fieldset analysis-form" disabled={locked}>
        {currentStep === 'questions' && <>
          <label>你最想表达的一句话<textarea value={form.claim} maxLength={2000} rows={3} onChange={e=>{change({claim:e.target.value,outline:''});setBasisId('');}} placeholder="例如：找到自己的生态位，比单纯提高能力更重要"/></label>
          <label>写给谁，希望读者理解什么（可选）<input value={form.audience} maxLength={1000} onChange={e=>change({audience:e.target.value})} placeholder="例如：正在选择职业方向的人，理解如何找到适合自己的位置"/></label>
          <div className="analysis-actions"><button type="button" className="button secondary small" disabled={!form.claim.trim()} onClick={()=>void run('questions')}>{engine === 'external' ? '准备给 Codex 补充问题' : '看看还需要说明什么'}</button></div>
          {latestResult && <WritingResult record={latestResult} workspace={workspace} renderContent={renderContent}/>}
          <label>我的补充<textarea value={form.answers} maxLength={10000} rows={5} onChange={e=>change({answers:e.target.value})} placeholder="写下自己的解释、例子或不确定的地方，也可以回答上面的追问。"/></label>
          <div className="writing-context"><p>已有 {workspace.materials.length} 条已选笔记、{workspace.collectorMaterials?.length ?? 0} 篇收藏原文，可一起作为依据。</p><button type="button" className="text-button" onClick={onMaterials}>查找更多材料</button></div>
          <div className="writing-step-footer"><span>补充问题是可选的，有了想法即可继续。</span><button type="button" className="button primary small" disabled={!form.claim.trim()} onClick={()=>changeStep('outline')}>下一步：组织提纲</button></div>
        </>}
        {currentStep === 'outline' && <>
          <label>用什么顺序展开<select value={form.structure} onChange={e=>change({structure:e.target.value as WritingInput['structure']})}><option value="direct">第一句话：解释 → 证明 → 补充</option><option value="scqa">SCQA：情境 → 冲突 → 问题 → 回答</option><option value="golden-circle">黄金圈：为什么 → 怎么做 → 做什么</option></select></label>
          <p className="scope-notice">结合核心判断、你的补充和已选材料组织提纲，缺少的依据会标为待补充。</p>
          <div className="analysis-actions"><button type="button" className={`button ${latestResult?.status === 'succeeded' ? 'secondary' : 'primary'} small`} disabled={!form.claim.trim()} onClick={()=>void run('outline')}>{engine === 'external' ? '准备给 Codex 组织提纲' : '生成提纲'}</button></div>
          {latestResult && <WritingResult record={latestResult} workspace={workspace} renderContent={renderContent}>{latestResult.status === 'succeeded' && <button type="button" className="button primary small" onClick={()=>{chooseOutline(latestResult);changeStep('paragraph');}}>采用这份提纲，继续展开</button>}</WritingResult>}
          <div className="writing-step-footer"><button type="button" className="text-button subdued" onClick={()=>changeStep('questions')}>上一步：补充想法</button>{latestResult?.status !== 'succeeded' && <button type="button" className="button secondary small" disabled={!outlines.length} onClick={()=>changeStep('paragraph')}>选择已有提纲</button>}</div>
        </>}
        {currentStep === 'paragraph' && <>
          <label>采用哪份提纲<select value={basisId} onChange={e=>{setBasisId(e.target.value);change({outline:outlines.find(r=>r.id === e.target.value)?.output ?? ''});}}><option value="">选择一份已完成的提纲</option>{outlines.map(r=><option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString('zh-CN')}{analysisIsStale(r,workspace) ? '（材料已变化）' : ''}</option>)}</select></label>
          {!outlines.length && <p className="scope-notice">还没有可用的提纲，先到“组织提纲”生成一份。</p>}
          {basis && <><label>核对并编辑提纲<textarea rows={7} maxLength={20000} value={form.outline} onChange={e=>change({outline:e.target.value})}/></label><label>这次展开哪一段<textarea rows={2} maxLength={2000} value={form.section} onChange={e=>change({section:e.target.value})} placeholder="填写提纲中的段落标题，或说明这一段想讲清楚什么"/></label>{requirementsChanged && <p className="notice">写作要求已变化，请回到“组织提纲”重新生成。</p>}{analysisIsStale(basis,workspace) && <p className="notice">材料或目标已变化，请回到“组织提纲”重新生成。</p>}</>}
          <div className="analysis-actions"><button type="button" className="button primary small" disabled={!basis || requirementsChanged || analysisIsStale(basis,workspace) || !form.outline.trim() || !form.section.trim()} onClick={()=>void run('paragraph')}>{engine === 'external' ? '确认提纲，交给 Codex 展开' : '确认提纲并展开这一段'}</button></div>
          {latestResult && <WritingResult record={latestResult} workspace={workspace} renderContent={renderContent}>{latestResult.status === 'succeeded' && <button type="button" className="button primary small" onClick={()=>onPreview(latestResult.output,latestResult.id)}>预览加入草稿</button>}</WritingResult>}
          <div className="writing-step-footer"><button type="button" className="text-button subdued" onClick={()=>changeStep('outline')}>上一步：组织提纲</button><span>先预览核对，再追加到草稿。</span></div>
        </>}
      </fieldset>
    </div>
    {engine === 'external' && <p className="agent-inline-note">准备任务后，请回到 Codex 对话继续分析。完成的内容会显示在当前步骤和“结果记录”中。</p>}
    {busy && <p role="status">正在准备写作任务…</p>}{error && <p className="error-box" role="alert">{error}</p>}
  </section>;
}

function WritingResult({record,workspace,renderContent,children}: {record:AnalysisRecord;workspace:Workspace;renderContent:(text:string)=>ReactNode;children?:ReactNode}) {
  const status = {prepared:'等待 Codex 完成',running:'正在生成',succeeded:'已完成',failed:'未完成'}[record.status];
  return <section className={`writing-result ${record.status}`}>
    <div className="analysis-record-heading"><h4>{record.writing?.stage === 'questions' ? '需要补充的问题' : record.writing?.stage === 'outline' ? '最近生成的提纲' : '最近生成的段落'}</h4><span role="status">{status}</span></div>
    {record.writing?.stage === 'paragraph' && <p className="scope-notice">展开内容：{record.writing.section}</p>}
    {record.status === 'prepared' && <p className="agent-inline-note">在 Codex 中说：“继续当前工作区已准备的分析任务，并把结果保存到工作台。”</p>}
    {record.status === 'running' && !record.output && <p className="scope-notice">完成后会显示在这里，你可以继续查看其他步骤。</p>}
    {record.error && <p className="error-box" role="alert">{record.error}</p>}
    {analysisIsStale(record,workspace) && <p className="notice">材料或目标已变化，这份结果使用的是生成时的材料。</p>}
    {record.output && <div className="analysis-output">{renderContent(record.output)}</div>}
    {children && <div className="analysis-actions">{children}</div>}
  </section>;
}
