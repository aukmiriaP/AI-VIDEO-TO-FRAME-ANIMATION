import { useEffect, useState } from 'react'
import { Play, Pause, X, ScanSearch, Check, ArrowRight } from 'lucide-react'
import type { AnalysisOptions, AnalysisReport, Project } from './types'

type Props = {
  project: Project; busy: boolean; actionId: string | null; report: AnalysisReport | null
  onClose: () => void; onRun: (options: AnalysisOptions) => void; onLocate: (index: number) => void
  onApply: (operation: 'compress' | 'skip' | 'loop', candidateIds: string[], name?: string) => void
}
const label = (index: number) => String(index+1).padStart(3, '0')
export default function AnimationCheck(p: Props) {
  const [options, setOptions] = useState<AnalysisOptions>({
    source: 'result', scope: p.actionId ? 'action' : 'all', action_id: p.actionId || undefined,
    duplicate_threshold: 1, window: 6, jump_k: 3, min_period: 2, max_period: 60, loop_max_error: 5,
  })
  const [tab, setTab] = useState<'duplicates' | 'jumps' | 'loops'>('duplicates')
  const [chosen, setChosen] = useState<string[]>([])
  const [inspect, setInspect] = useState(0)
  const [loopPlaying, setLoopPlaying] = useState(false)
  const [loopPos, setLoopPos] = useState(0)
  const [loopName, setLoopName] = useState('loop')
  const report = p.report && p.report.revision === p.project.revision ? p.report : null
  const duplicates = report?.duplicates || [], suspects = report?.suspects || [], loops = report?.loops || []
  const loop = loops[inspect]
  useEffect(() => {setChosen([]);setInspect(0);setLoopPlaying(false);setLoopPos(0)}, [report?.id, tab])
  useEffect(() => {
    if (!loopPlaying || !loop || p.busy) return
    const index = loop.indices[loopPos % loop.indices.length]
    const delay = p.project.frames[index].duration * p.project.fps / loop.fps * 1000
    const timer = setTimeout(() => setLoopPos(v => (v+1)%loop.indices.length), Math.max(1, delay))
    return () => clearTimeout(timer)
  }, [loopPlaying, loop, loopPos, p.busy, p.project])
  function toggle(id: string) {
    setChosen(ids => ids.includes(id) ? ids.filter(v => v !== id) : [...ids, id])
  }
  function change<K extends keyof AnalysisOptions>(key: K, value: AnalysisOptions[K]) {
    setOptions(o => ({...o, [key]: value}))
  }
  const source = (index: number) => report?.source === 'original' ? p.project.frames[index]?.original_url
    : p.project.frames[index]?.output_url || p.project.frames[index]?.original_url
  const duplicate = duplicates[inspect], suspect = suspects[inspect]
  const compare = tab === 'duplicates' && duplicate ? [duplicate.keep, duplicate.indices[1], duplicate.indices[1]+1]
    : tab === 'jumps' && suspect ? [suspect.previous, suspect.index, suspect.next] : []
  const applicable = tab === 'duplicates' ? duplicates.filter(g => g.kind === 'consecutive').map(g => g.id)
    : tab === 'jumps' ? suspects.map(s => s.id) : []
  const sameSettings = !report || Object.entries(options).every(([key,value]) =>
    (report.params[key as keyof AnalysisOptions] ?? null) === (value ?? null))
  return <div className="modal-scrim"><section className="modal animation-check" role="dialog" aria-modal="true" aria-labelledby="check-title">
    <div className="modal-heading"><span className="eyebrow">ANIMATION CHECK</span><button className="icon-btn" aria-label="关闭动画检查" disabled={p.busy} onClick={p.onClose}><X size={20}/></button></div>
    <h2 id="check-title">动画编辑与检查</h2>
    <p className="modal-intro">按动作分别检查启用帧。检查只生成候选；选择后才能合并、跳过或设为动作，操作可撤销。</p>
    <div className="check-form">
      <label className="form-field">检查图像<select aria-label="检查图像" value={options.source} disabled={p.busy} onChange={e=>change('source',e.target.value as AnalysisOptions['source'])}>
        <option value="result">已应用的处理结果</option><option value="original">原始帧</option></select></label>
      <label className="form-field">检查范围<select aria-label="检查范围" disabled={p.busy} value={options.scope === 'all' ? 'all' : options.action_id}
        onChange={e=>setOptions(o=>({...o,scope:e.target.value === 'all' ? 'all' : 'action', action_id:e.target.value === 'all' ? undefined : e.target.value}))}>
        <option value="all">全部动作（各自检查）</option>{p.project.actions.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="form-field">重复差异上限<input aria-label="重复差异上限" disabled={p.busy} type="number" min={0} max={20} step={.1} value={options.duplicate_threshold} onChange={e=>change('duplicate_threshold',+e.target.value)}/></label>
      <label className="form-field">回返比较窗口<input aria-label="回返比较窗口" disabled={p.busy} type="number" min={1} max={24} value={options.window} onChange={e=>change('window',+e.target.value)}/></label>
    </div>
    <details className="check-advanced"><summary>跳变与循环参数</summary><div className="check-form">
      <label className="form-field">跳变保守程度<input aria-label="跳变保守程度" disabled={p.busy} type="number" min={1} max={10} step={.5} value={options.jump_k} onChange={e=>change('jump_k',+e.target.value)}/></label>
      <label className="form-field">循环差异上限<input aria-label="循环差异上限" disabled={p.busy} type="number" min={.1} max={30} step={.5} value={options.loop_max_error} onChange={e=>change('loop_max_error',+e.target.value)}/></label>
      <label className="form-field">最小周期（帧）<input aria-label="最小周期" disabled={p.busy} type="number" min={2} max={120} value={options.min_period} onChange={e=>change('min_period',+e.target.value)}/></label>
      <label className="form-field">最大周期（帧）<input aria-label="最大周期" disabled={p.busy} type="number" min={2} max={120} value={options.max_period} onChange={e=>change('max_period',+e.target.value)}/></label>
    </div></details>
    <div className="check-run"><span>{report ? `本次结果来自${report.source === 'original' ? '原始帧' : '处理结果'}；参数变化需重新检查。` : '图像包含颜色、透明度和边缘信息；小细节仍需人工检查。'}</span>
      <button className="btn primary" disabled={p.busy || options.min_period > options.max_period ||
        !Object.values(options).filter(v=>typeof v==='number').every(Number.isFinite)}
        onClick={()=>{setLoopPlaying(false);p.onRun(options)}}><ScanSearch size={15}/>{report ? '重新检查' : '开始检查'}</button></div>
    {report ? <>
      <div className="check-tabs">{([['duplicates',`相似帧 ${duplicates.length}`],['jumps',`可疑帧 ${suspects.length}`],['loops',`循环候选 ${loops.length}`]] as const).map(([value,text])=>
        <button key={value} className={tab===value ? 'active' : ''} disabled={p.busy} onClick={()=>setTab(value)}>{text}</button>)}</div>
      <div className="check-results">
        <div className="check-candidates">
          {tab === 'duplicates' && duplicates.map((d,i)=><div key={d.id} className={`check-row ${inspect===i ? 'active' : ''}`}>
            <input type="checkbox" aria-label={`选择相似候选 ${i+1}`} disabled={p.busy || d.kind==='return'} checked={chosen.includes(d.id)} onChange={()=>toggle(d.id)}/>
            <button disabled={p.busy} onClick={()=>setInspect(i)}><b>{d.kind==='consecutive' ? '连续相似' : '姿态回返'} · {label(d.keep)} → {label(d.indices[d.indices.length-1])}</b>
              <small>{d.action_name} · {d.indices.length} 帧 · 差异 {d.score.toFixed(2)}{d.kind==='return' ? ' · 仅供查看' : ''}</small></button></div>)}
          {tab === 'jumps' && suspects.map((s,i)=><div key={s.id} className={`check-row ${inspect===i ? 'active' : ''}`}>
            <input type="checkbox" aria-label={`选择可疑帧 ${s.index+1}`} disabled={p.busy} checked={chosen.includes(s.id)} onChange={()=>toggle(s.id)}/>
            <button disabled={p.busy} onClick={()=>setInspect(i)}><b>第 {label(s.index)} 帧 · {s.action_name}</b><small>{s.reason}</small></button></div>)}
          {tab === 'loops' && loops.map((c,i)=><div key={c.id} className={`check-row ${inspect===i ? 'active' : ''}`}>
            <input type="radio" name="loop-choice" aria-label={`选择循环候选 ${i+1}`} disabled={p.busy} checked={chosen.includes(c.id)} onChange={()=>{setChosen([c.id]);setInspect(i);setLoopPos(0);setLoopPlaying(false)}}/>
            <button disabled={p.busy} onClick={()=>{setInspect(i);setLoopPos(0);setLoopPlaying(false)}}><b>{c.action_name} · {c.period} 帧周期</b><small>{label(c.start)}–{label(c.end)} · 重复匹配差异 {c.mean_error.toFixed(2)}</small></button></div>)}
          {!(tab==='duplicates' ? duplicates.length : tab==='jumps' ? suspects.length : loops.length) && <p className="check-empty">
            {tab==='duplicates' ? '未发现相似候选。' : tab==='jumps' ? '未发现两侧同时跳变的可疑帧。' : '未找到可信周期；可手动选择帧划分动作。'}</p>}
        </div>
        <div className="check-preview">
          {tab!=='loops' && compare.length>0 && <>
            <div className="check-triptych">{compare.map((index,i)=><button key={`${index}-${i}`} disabled={p.busy || !p.project.frames[index]} onClick={()=>p.onLocate(index)}>
              <span>{tab==='jumps' ? ['前一帧','当前帧','后一帧'][i] : ['保留参考','相似候选','后一帧'][i]}</span>
              <div className="checker">{p.project.frames[index] && <img src={source(index)} alt={`对照第 ${index+1} 帧`}/>}</div><small>{p.project.frames[index] ? label(index) : '边界'}</small></button>)}</div>
            <p className="hint">{tab==='duplicates' ? '相似也可能是刻意停顿。连续组才可合并，时长将累加；姿态回返不会自动删除。'
              : `${suspect?.reason}。左右原始差异 ${suspect?.left} / ${suspect?.right}，前后差异 ${suspect?.outer}。点击图片可定位修帧。`}</p>
          </>}
          {tab==='loops' && loop && <>
            <div className="loop-image checker"><img src={source(loop.indices[loopPos%loop.indices.length])} alt="循环候选预览"/></div>
            <div className="loop-transport"><button className="btn secondary" disabled={p.busy} onClick={()=>setLoopPlaying(v=>!v)}>
              {loopPlaying ? <Pause size={14}/> : <Play size={14}/>} {loopPlaying ? '暂停候选' : '预览候选'}</button>
              <span>第 {label(loop.indices[loopPos%loop.indices.length])} 帧 · {loop.fps} FPS</span></div>
            <div className="check-triptych seam"><button onClick={()=>p.onLocate(loop.end)} disabled={p.busy}><span>首尾接缝：末帧</span><div className="checker"><img src={source(loop.end)} alt="循环末帧"/></div></button>
              <ArrowRight size={15}/><button onClick={()=>p.onLocate(loop.start)} disabled={p.busy}><span>首帧</span><div className="checker"><img src={source(loop.start)} alt="循环首帧"/></div></button></div>
            <p className="hint">依据整段重复匹配推荐；支持率 {Math.round(loop.support*100)}% 是达标帧对占比。候选仍需检查接缝。</p>
          </>}
          {!compare.length && !(tab==='loops' && loop) && <p className="hint">选中候选后查看帧对照或循环预览。</p>}
        </div>
      </div>
      {tab==='jumps' && <div className="check-boundaries"><b>变化边界（仅提示）</b>
        {report.transitions.filter(t=>t.kind==='boundary').map(t=><button disabled={p.busy} key={`${t.previous}-${t.next}`} onClick={()=>p.onLocate(t.next)}>
          {label(t.previous)} → {label(t.next)} · {t.action_name}</button>)}
        {!report.transitions.some(t=>t.kind==='boundary') && <span>未发现单侧变化边界。</span>}
        {report.stats.map(s=><span key={s.action_id}>{s.name}：基准 {s.median.toFixed(2)} / 跳变阈值 {s.threshold.toFixed(2)}{s.timing_normalized ? ' · 已按帧时长归一' : ''}</span>)}</div>}
      {report.warnings.length>0 && <details className="check-warnings"><summary>检查说明（{report.warnings.length}）</summary>{report.warnings.map((w,i)=><p key={i}>{w}</p>)}</details>}
      <div className="modal-footer check-footer">
        {tab!=='loops' ? <label className="check-field"><input type="checkbox" disabled={p.busy || !applicable.length} checked={!!applicable.length && applicable.every(id=>chosen.includes(id))}
          onChange={e=>setChosen(e.target.checked ? applicable : [])}/>选择全部{tab==='duplicates' ? '连续组' : '可疑帧'}</label>
          : <label className="form-field">新动作名称<input aria-label="循环动作名称" disabled={p.busy} value={loopName} onChange={e=>setLoopName(e.target.value)}/></label>}
        <button className="btn primary" disabled={p.busy || !chosen.length || !sameSettings || (tab==='loops' && (!loopName.trim() || !chosen.includes(loop?.id || '')))}
          onClick={()=>{setLoopPlaying(false);p.onApply(tab==='duplicates' ? 'compress' : tab==='jumps' ? 'skip' : 'loop',chosen,tab==='loops' ? loopName : undefined)}}>
          <Check size={15}/>{tab==='duplicates' ? `合并所选 ${chosen.length} 组（保留时长）` : tab==='jumps' ? `跳过所选 ${chosen.length} 帧` : '将所选循环设为动作'}</button>
      </div>
    </> : <p className="check-empty">{p.busy ? '检查任务正在运行，可在底部查看进度。' : '修改项目后旧结果失效，请运行检查。'}</p>}
  </section></div>
}
