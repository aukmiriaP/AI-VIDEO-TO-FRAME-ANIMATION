import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api, json } from './api'
import type { AssetEdits, AssetOptions, ExportLayout, ExportOptions, Preview, Project, Settings } from './types'
import './assets.css'

const edits = (s: Settings): AssetEdits => ({
  align_mode:s.align_mode,bounds_threshold:s.bounds_threshold,matte_grow:s.matte_grow,
  matte_feather:s.matte_feather,edge_cleanup:s.edge_cleanup,speck_area:s.speck_area,
})
function Numeric({label,value,onChange,min=0,max,step=1,disabled=false}:{label:string;value:number;onChange:(v:number)=>void;min?:number;max?:number;step?:number;disabled?:boolean}) {
  return <label className="form-field"><span>{label}</span><input aria-label={label} type="number" min={min} max={max} step={step} disabled={disabled} value={value} onChange={e=>onChange(+e.target.value)}/></label>
}
export function AssetPanel({project,current,selection,busy,onClose,onApply}:{project:Project;current:number;selection:number[];busy:boolean;onClose:()=>void;onApply:(body:unknown)=>void}) {
  const [scope,setScope]=useState<'all'|'selection'>('all')
  const [options,setOptions]=useState<AssetOptions>(project.asset_options)
  const [patch,setPatch]=useState<AssetEdits>(edits(project.settings))
  const [preview,setPreview]=useState<Preview|null>(null)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const index=scope==='all'||selection.includes(current)?current:selection[0]
  const body={expected_revision:project.revision,indices:scope==='all'?null:selection,asset_options:scope==='all'?options:null,asset_patch:patch}
  useEffect(()=>{setPreview(null);setError('')},[scope,options,patch])
  const change=<K extends keyof AssetEdits>(k:K,v:AssetEdits[K])=>setPatch(p=>({...p,[k]:v}))
  const option=<K extends keyof AssetOptions>(k:K,v:AssetOptions[K])=>setOptions(p=>({...p,[k]:v}))
  async function inspect() {
    setLoading(true);setError('')
    try{setPreview(await api<Preview>(`/projects/${project.id}/preview`,json({...body,index})))}
    catch(e){setError((e as Error).message)}
    finally{setLoading(false)}
  }
  return <div className="modal-scrim"><section className="modal asset-dialog" role="dialog" aria-modal="true" aria-label="资产整理">
    <button className="modal-close" aria-label="关闭资产整理" disabled={loading||busy} onClick={onClose}><X size={19}/></button>
    <h2>资产整理</h2><p className="modal-subtitle">统一画布与锚点，按透明主体边界对齐。预览使用已应用的背景与缩放设置。</p>
    <label className="form-field"><span>整理范围</span><select aria-label="整理范围" disabled={loading||busy} value={scope} onChange={e=>{
      const v=e.target.value as 'all'|'selection';const nextIndex=selection.includes(current)?current:selection[0]
      setScope(v);setPatch(edits(v==='all'?project.settings:project.frames[nextIndex]?.settings||project.settings))
    }}><option value="all">全部 {project.frames.length} 帧</option><option value="selection">选中 {selection.length} 帧</option></select></label>
    <div className="asset-columns"><div><h3>画布与锚点</h3><div className="asset-fields">
      <Numeric label="画布宽度（0 自动）" value={options.canvas_width} max={2048} disabled={scope==='selection'||loading||busy} onChange={v=>option('canvas_width',v)}/>
      <Numeric label="画布高度（0 自动）" value={options.canvas_height} max={2048} disabled={scope==='selection'||loading||busy} onChange={v=>option('canvas_height',v)}/>
      <Numeric label="锚点 X" value={options.pivot_x} max={1} step={.01} disabled={scope==='selection'||loading||busy} onChange={v=>option('pivot_x',v)}/>
      <Numeric label="锚点 Y" value={options.pivot_y} max={1} step={.01} disabled={scope==='selection'||loading||busy} onChange={v=>option('pivot_y',v)}/>
    </div><p className="hint">0 自动沿用输出尺寸；锚点 0–1，左上为 (0,0)。画布与锚点作用于全部帧。脚底锚点建议 (0.5,0.9)。</p>
    <h3>主体与边缘</h3><label className="form-field"><span>主体对齐</span><select aria-label="主体对齐" disabled={loading||busy} value={patch.align_mode} onChange={e=>change('align_mode',e.target.value as AssetEdits['align_mode'])}><option value="none">保留原位置</option><option value="center">边界中心对齐锚点</option><option value="bottom">底部中心对齐锚点</option></select></label>
    <div className="asset-fields">
      <Numeric label="主体边界透明阈值" value={patch.bounds_threshold} min={1} max={254} disabled={loading||busy} onChange={v=>change('bounds_threshold',v)}/>
      <Numeric label="遮罩扩缩（源图 px）" value={patch.matte_grow} min={-8} max={8} disabled={loading||busy} onChange={v=>change('matte_grow',v)}/>
      <Numeric label="边缘羽化（源图 px）" value={patch.matte_feather} max={5} step={.25} disabled={loading||busy} onChange={v=>change('matte_feather',v)}/>
      <Numeric label="边缘颜色清理" value={patch.edge_cleanup} max={1} step={.05} disabled={loading||busy} onChange={v=>change('edge_cleanup',v)}/>
      <Numeric label="移除小块（源图面积）" value={patch.speck_area} max={400} disabled={loading||busy} onChange={v=>change('speck_area',v)}/>
    </div><p className="hint">负数收缩、正数扩张；0 关闭。修整在画笔之前执行，手动笔迹继续生效。像素输出保持硬边。</p>
    </div><div className="asset-preview"><h3>第 {index+1} 帧预览</h3>
      {preview?<><div className="asset-image checker" style={{aspectRatio:`${preview.geometry.canvas[0]}/${preview.geometry.canvas[1]}`,maxWidth:`${300*preview.geometry.canvas[0]/preview.geometry.canvas[1]}px`}}>
        <img src={preview.url} alt="资产整理预览"/><i className="asset-pivot" style={{left:`${preview.geometry.pivot[0]*100}%`,top:`${preview.geometry.pivot[1]*100}%`}}/>
      </div><p className="hint">{preview.geometry.canvas.join(' × ')} px · 锚点 {preview.geometry.pivot.join(', ')}</p>{preview.geometry.warnings.map(w=><p className="inline-error" key={w}>{w}</p>)}</>:<p className="check-empty">调整参数后点击预览，查看主体位置、透明边缘与裁切提示。</p>}
      <p className="hint">逐帧底部对齐会抵消跳跃、浮动等位移；这些动作可保留原位置，或只整理指定帧。边界跟随整体轮廓，不识别脚部语义。</p>
    </div></div>{error&&<p className="inline-error" role="alert">{error}</p>}
    <div className="modal-footer"><button className="btn secondary" disabled={loading||busy||index===undefined} onClick={inspect}>{loading?'正在预览…':'预览整理效果'}</button>
      <button className="btn primary" disabled={loading||busy||!selection.length&&scope==='selection'} onClick={()=>onApply(body)}>应用资产整理</button></div>
  </section></div>
}

export function ExportDialog({project,busy,onClose,onExport}:{project:Project;busy:boolean;onClose:()=>void;onExport:(body:unknown)=>void}) {
  const [options,setOptions]=useState<ExportOptions>(project.export_options)
  const [plan,setPlan]=useState<ExportLayout|null>(null)
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(false)
  const [page,setPage]=useState(0)
  const body={options,expected_revision:project.revision}
  useEffect(()=>{
    let stopped=false;setLoading(true);setPlan(null)
    const timer=setTimeout(()=>{
      api<ExportLayout>(`/projects/${project.id}/export/preview`,json({options,expected_revision:project.revision}))
        .then(p=>{if(!stopped){setPlan(p);setPage(0);setError('')}})
        .catch(e=>{if(!stopped)setError(e.message)})
        .finally(()=>{if(!stopped)setLoading(false)})
    },250)
    return()=>{stopped=true;clearTimeout(timer)}
  },[options,project.id,project.revision])
  const change=<K extends keyof ExportOptions>(k:K,v:ExportOptions[K])=>setOptions(p=>({...p,[k]:v}))
  const spec=plan?.pages[page]
  return <div className="modal-scrim"><section className="modal asset-dialog" role="dialog" aria-modal="true" aria-label="图集导出设置">
    <button className="modal-close" aria-label="关闭导出设置" disabled={busy||loading} onClick={onClose}><X size={19}/></button>
    <h2>导出动画</h2><p className="modal-subtitle">导出已应用的结果。布局预览不修改项目，导出成功后记住本次设置。</p>
    <div className="asset-columns"><div><div className="asset-fields">
      <Numeric label="图集列数（0 自动）" value={options.columns} max={64} disabled={busy} onChange={v=>change('columns',v)}/>
      <label className="form-field"><span>单页上限</span><select aria-label="单页上限" value={options.page_size} disabled={busy} onChange={e=>change('page_size',+e.target.value)}>{[128,256,512,1024,2048,4096].map(n=><option key={n} value={n}>{n} × {n}</option>)}</select></label>
      <Numeric label="图集留白（px）" value={options.padding} max={32} disabled={busy} onChange={v=>change('padding',v)}/>
      <Numeric label="边缘扩边（px）" value={options.extrude} max={32} disabled={busy} onChange={v=>change('extrude',v)}/>
    </div><label className="form-field"><span>文件名前缀</span><input aria-label="文件名前缀" value={options.prefix} maxLength={40} pattern="[a-zA-Z0-9_\-]*" disabled={busy} onChange={e=>change('prefix',e.target.value)}/></label>
    <p className="hint">前缀使用英文字母、数字、下划线或连字符。扩边复制边缘像素，不能超过留白；多余留白保持透明。</p>
    <label className="check-field"><input aria-label="导出法线与打光示例" type="checkbox" checked={options.include_normals} disabled={busy} onChange={e=>change('include_normals',e.target.checked)}/>导出法线与打光示例</label>
    <p className="hint">配对法线图集与颜色图集共用布局；缺失法线按已保存参数生成。灯光不烘焙到颜色帧。</p>
    <h3>导出动作</h3><label className="check-field"><input type="checkbox" checked={options.action_ids===null} disabled={busy} onChange={e=>change('action_ids',e.target.checked?null:[])}/>全部动作</label>
    <div className="export-action-list">{project.actions.map(a=><label className="check-field" key={a.id}><input type="checkbox" disabled={busy||options.action_ids===null} checked={options.action_ids===null||options.action_ids.includes(a.id)} onChange={e=>change('action_ids',e.target.checked?[...(options.action_ids||[]),a.id]:(options.action_ids||[]).filter(id=>id!==a.id))}/>{a.name} · {a.end-a.start+1} 帧</label>)}</div>
    </div><div className="asset-preview"><h3>图集布局预览</h3>{spec&&plan?<><svg className="atlas-layout" viewBox={`0 0 ${spec.size.join(' ')}`} role="img" aria-label="图集帧矩形布局">
      <rect width={spec.size[0]} height={spec.size[1]} fill="var(--raised)"/>
      {spec.cells.map(c=><g key={c.index}><rect x={c.rect[0]} y={c.rect[1]} width={c.rect[2]} height={c.rect[3]} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={Math.max(1,spec.size[0]/600)}/><text x={c.rect[0]+c.rect[2]/2} y={c.rect[1]+c.rect[3]/2} textAnchor="middle" dominantBaseline="middle" fill="var(--text)" fontSize={Math.min(c.rect[2]/3,c.rect[3]/3,32)}>{c.index+1}</text></g>)}
    </svg><p className="hint">{spec.file} · {spec.size.join(' × ')} px<br/>{plan.frames} 帧 · {plan.pages.length} 页 · {plan.columns} 列 · 画布 {plan.canvas.join(' × ')}<br/>锚点 {plan.pivot.join(', ')} · {plan.actions.length} 个动作</p>
    {plan.pages.length>1&&<label className="form-field"><span>预览页</span><select aria-label="预览图集页" value={page} onChange={e=>setPage(+e.target.value)}>{plan.pages.map((p,i)=><option key={p.file} value={i}>第 {i+1} 页</option>)}</select></label>}
    </>:<p className="check-empty">{loading?'正在计算布局…':'请调整导出设置。'}</p>}<p className="hint">ZIP 包含独立 PNG、图集、元数据和 Godot 工程。图集与 SpriteFrames 使用同一画布及锚点。</p></div></div>
    {error&&<p className="inline-error" role="alert">{error}</p>}<div className="modal-footer"><button className="btn secondary" disabled={busy||loading} onClick={onClose}>取消</button><button className="btn primary" disabled={busy||loading||!plan||!!error} onClick={()=>onExport(body)}>导出 ZIP</button></div>
  </section></div>
}
