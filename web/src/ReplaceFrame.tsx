import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import type { Project } from './types'
import './refining.css'

type Props={project:Project;current:number;busy:boolean;onClose:()=>void;onReplace:(file:File,mode:'source'|'output',keep:boolean)=>void;onReset:()=>void}
export default function ReplaceFrame(p:Props){
  const frame=p.project.frames[p.current]
  const [mode,setMode]=useState<'source'|'output'>('source')
  const [file,setFile]=useState<File>()
  const [url,setUrl]=useState('')
  const [size,setSize]=useState<[number,number]>()
  const [error,setError]=useState('')
  const [keep,setKeep]=useState(false)
  const expected=mode==='source'?[frame.width,frame.height]:frame.geometry?.canvas
  const matching=!!expected&&size?.[0]===expected[0]&&size?.[1]===expected[1]
  useEffect(()=>{
    setSize(undefined);setError('');setUrl('')
    if(!file){setUrl('');return}
    if(file.size>32*1024*1024){setError('替换图片最多 32 MB');return}
    const value=URL.createObjectURL(file);setUrl(value)
    const image=new Image()
    let stopped=false
    image.onload=()=>{if(!stopped)setSize([image.naturalWidth,image.naturalHeight])}
    image.onerror=()=>{if(!stopped)setError('无法读取图片')}
    image.src=value
    return()=>{stopped=true;URL.revokeObjectURL(value)}
  },[file])
  const download=async(url:string,name:string)=>{
    try{
      const response=await fetch(url)
      if(!response.ok)throw new Error('下载失败')
      const object=URL.createObjectURL(await response.blob()),a=document.createElement('a')
      a.href=object;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(object),1000)
    }catch(e){setError((e as Error).message)}
  }
  return <div className="modal-scrim"><section className="modal replace-dialog" role="dialog" aria-modal="true" aria-label="单帧替换">
    <button className="modal-close" aria-label="关闭单帧替换" disabled={p.busy} onClick={p.onClose}><X size={19}/></button>
    <h2>替换第 {p.current+1} 帧</h2><p className="modal-subtitle">先下载对应帧，在外部绘图工具精修，再选择图片替换。时长、动作归属与帧编号保持一致。</p>
    <div className="replace-downloads"><button className="btn secondary" disabled={p.busy} onClick={()=>download(frame.original_url,`frame-${frame.id}-source.png`)}><Download size={14}/>下载原始帧</button>
      <button className="btn secondary" disabled={p.busy||!frame.output_url} onClick={()=>download(frame.output_url!,`frame-${frame.id}-output.png`)}><Download size={14}/>下载处理后帧</button></div>
    <label className="form-field"><span>替换方式</span><select aria-label="单帧替换方式" value={mode} disabled={p.busy} onChange={e=>setMode(e.target.value as 'source'|'output')}>
      <option value="source">原始帧：继续抠图和风格处理</option><option value="output" disabled={!frame.geometry||!frame.output_url}>成品帧：直接覆盖处理后结果</option></select></label>
    <p className="hint">{mode==='source'?'保留当前帧的处理参数，新图片重新执行现有流程。':'成品图不会再次抠图、调色、量化或帧间滤波；可以导出和生成法线。覆盖期间参数修订不会改变这张成品图。'}</p>
    <label className="form-field"><span>选择替换图片 · 必须 {expected?.join(' × ')||'先应用处理'} px</span><input aria-label="单帧替换图片" type="file" accept=".png,.jpg,.jpeg,.webp" disabled={p.busy} onChange={e=>setFile(e.target.files?.[0])}/></label>
    {url&&<div className="replace-preview checker"><img src={url} alt="待替换图片预览"/></div>}
    {size&&<p className={matching?'hint':'inline-error'}>{file?.name} · {size.join(' × ')} px{!matching?' · 尺寸不匹配，请保持对应画布尺寸。':''}</p>}
    {mode==='source'&&frame.strokes.length>0&&<label className="check-field"><input aria-label="替换保留遮罩笔迹" type="checkbox" checked={keep} disabled={p.busy} onChange={e=>setKeep(e.target.checked)}/>保留已有 {frame.strokes.length} 笔遮罩修订（默认清除）</label>}
    {mode==='output'&&p.project.style==='pixel'&&<p className="hint">像素成品请自行保持网格与共用色板；成品覆盖保留你上传的颜色和透明度。</p>}
    {frame.output_override&&<p className="hint">当前帧已有成品覆盖。解除后恢复原始帧的处理结果；操作可撤销。</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <div className="modal-footer">{frame.output_override?<button className="btn secondary" disabled={p.busy} onClick={p.onReset}>解除成品覆盖</button>:<span className="hint">仅更新当前帧及必要的稳定邻帧，可撤销。</span>}
      <button className="btn primary" disabled={p.busy||!file||!matching||!!error} onClick={()=>p.onReplace(file!,mode,keep)}>应用单帧替换</button></div>
  </section></div>
}
