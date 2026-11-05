import { useEffect, useState } from 'react'
import { ArrowRight, ScanLine, Waypoints, X } from 'lucide-react'
import type { Project, PropagationReport } from './types'
import './propagation.css'

type Props = {
  project:Project; current:number; selection:number[]; busy:boolean; report:PropagationReport|null
  onClose:()=>void; onInvalidate:()=>void
  onPreview:(indices:number[],confidence:number)=>void; onApply:(indices:number[])=>void; onClear:()=>void
}
export default function PropagationDialog(p:Props){
  const frame=p.project.frames[p.current]
  const action=p.project.actions.find(a=>a.start<=p.current&&p.current<=a.end)
  const [before,setBefore]=useState(0)
  const [after,setAfter]=useState(3)
  const [range,setRange]=useState('nearby')
  const [confidence,setConfidence]=useState(.6)
  const [selected,setSelected]=useState<number[]>([])
  const [risk,setRisk]=useState(false)
  useEffect(()=>{
    setSelected(p.report?.items.filter(i=>i.applicable&&i.accepted_ratio>=.8).map(i=>i.index)||[])
  },[p.report])
  const valid=(i:number)=>i!==p.current&&Math.abs(i-p.current)<=12&&!!action&&i>=action.start&&i<=action.end
  const targets=(range==='selection'?p.selection:Array.from({length:p.project.frames.length},(_,i)=>i)
    .filter(i=>i>=p.current-before&&i<=p.current+after)).filter(valid)
  const ready=frame.enabled&&!frame.output_override&&frame.strokes.length>0
  const change=(fn:()=>void)=>{fn();p.onInvalidate()}
  const layers=frame.mask_corrections||[]
  return <div className="modal-scrim"><section className="modal propagation-dialog" role="dialog" aria-modal="true" aria-label="跨帧遮罩传播">
    <button className="modal-close" aria-label="关闭跨帧遮罩" disabled={p.busy} onClick={p.onClose}><X size={19}/></button>
    <div className="propagation-title"><Waypoints size={22}/><div><h2>让修订跟随动作</h2><p className="modal-subtitle">先跟踪、逐帧检查，再保存到你选中的帧。</p></div></div>
    <div className="propagation-source"><div className="checker"><img src={frame.output_url||frame.original_url} alt="传播源帧"/></div>
      <div><span className="eyebrow">SOURCE / 第 {p.current+1} 帧</span><strong>{frame.strokes.length} 笔已保存的遮罩修订</strong>
        <span>{action?.name||'无动作归属'} · 擦除与恢复随运动传播，目标手动修订优先。</span></div><ArrowRight size={18}/></div>
    {!ready&&<p className="inline-error">先在启用且没有成品覆盖的当前帧画笔修订并保存，再生成传播预览。</p>}
    <div className="propagation-options">
      <label className="form-field"><span>目标范围</span><select aria-label="传播目标范围" disabled={p.busy} value={range} onChange={e=>change(()=>setRange(e.target.value))}>
        <option value="nearby">相邻帧</option><option value="selection">时间轴已选帧</option></select></label>
      {range==='nearby'&&<><label className="form-field"><span>向前</span><select aria-label="传播前帧数" disabled={p.busy} value={before} onChange={e=>change(()=>setBefore(+e.target.value))}>
        {Array.from({length:13},(_,i)=><option key={i} value={i}>{i} 帧</option>)}</select></label>
        <label className="form-field"><span>向后</span><select aria-label="传播后帧数" disabled={p.busy} value={after} onChange={e=>change(()=>setAfter(+e.target.value))}>
          {Array.from({length:13},(_,i)=><option key={i} value={i}>{i} 帧</option>)}</select></label></>}
      <label className="form-field"><span>跟踪置信阈值 · {Math.round(confidence*100)}%</span><input aria-label="传播置信阈值" type="range" min={.3} max={.95} step={.05} value={confidence} disabled={p.busy}
        onChange={e=>change(()=>setConfidence(+e.target.value))}/></label>
    </div>
    <div className="propagation-run"><p className="hint">{targets.length} 个目标 · 同一动作、前后各最多 12 帧；不跨循环首尾。阈值越高越保守。</p>
      <button className="btn secondary" disabled={p.busy||!ready||!targets.length} onClick={()=>{p.onInvalidate();p.onPreview(targets,confidence)}}><ScanLine size={15}/>生成传播预览</button></div>
    {p.report?<div className="propagation-results">
      <div className="propagation-result-heading"><strong>预览结果 · 已选 {selected.length} 帧</strong><label className="check-field"><input aria-label="显示传播风险区域" type="checkbox" checked={risk} onChange={e=>setRisk(e.target.checked)}/>查看未通过区域</label></div>
      <p className="hint">默认勾选保留比例 ≥ 80% 的可用帧。红色风险区域不会应用；效果图单独预览每个目标，多选时帧间颜色稳定可能略有变化。</p>
      <div className="propagation-candidates">{p.report.items.map(item=><article key={item.frame_id} className={`propagation-candidate ${selected.includes(item.index)?'chosen':''}`}>
        <label className="propagation-candidate-heading"><input aria-label={`应用传播第 ${item.index+1} 帧`} type="checkbox" disabled={p.busy||!item.applicable} checked={selected.includes(item.index)}
          onChange={e=>setSelected(s=>e.target.checked?[...s,item.index]:s.filter(i=>i!==item.index))}/>
          <strong>第 {item.index+1} 帧</strong><span>{item.applicable?`保留 ${Math.round(item.accepted_ratio*100)}% 修订`:'暂不可用'}</span></label>
        <div className="propagation-pair"><figure><div className="checker"><img src={item.before_url} alt={`第 ${item.index+1} 帧传播前`}/></div><figcaption>传播前</figcaption></figure>
          <figure><div className="checker"><img src={item.preview_url} alt={`第 ${item.index+1} 帧传播预览`}/></div><figcaption>通过检查的修订</figcaption></figure></div>
        {risk&&<figure className="propagation-risk"><div className="checker"><img src={item.original_url} alt="风险区域原始帧"/><img src={item.rejected_url} alt={`第 ${item.index+1} 帧未通过区域`}/></div><figcaption>原始帧坐标 · 红色区域不应用</figcaption></figure>}
        <p className="hint">{item.warnings.join('；')||`通过区域平均置信 ${Math.round(item.mean_confidence*100)}%`}</p>
      </article>)}</div>
    </div>:<div className="propagation-empty">在快速运动、遮挡、出画或大幅变形处，先逐帧修正，再从新的源帧继续传播。</div>}
    <div className="modal-footer"><div>{layers.length>0?<button className="btn secondary" disabled={p.busy} onClick={p.onClear}>清除当前帧 {layers.length} 层传播修订</button>:<span className="hint">保存后可撤销；每帧最多 8 层传播修订。</span>}</div>
      <button className="btn primary" disabled={p.busy||!p.report||!selected.length} onClick={()=>p.onApply(selected)}>应用到所选 {selected.length} 帧</button></div>
  </section></div>
}
