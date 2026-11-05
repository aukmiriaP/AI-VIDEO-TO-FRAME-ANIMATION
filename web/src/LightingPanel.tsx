import { Sun, RotateCcw } from 'lucide-react'
import { lightDefaults } from './types'
import type { Light, LightMode, NormalSettings } from './types'
import './lighting.css'

type Props = {
  normal:NormalSettings; onNormal:(n:NormalSettings)=>void; light:Light; onLight:(l:Light)=>void
  mode:LightMode; onMode:(m:LightMode)=>void; busy:boolean; count:number; ready:boolean; dirty:boolean
  onPreview:()=>void; onApply:()=>void
}
export default function LightingPanel(p:Props){
  const normal=<K extends keyof NormalSettings>(k:K,v:NormalSettings[K])=>p.onNormal({...p.normal,[k]:v})
  const light=<K extends keyof Light>(k:K,v:Light[K])=>p.onLight({...p.light,[k]:v})
  const slider=(label:string,value:number,min:number,max:number,step:number,change:(v:number)=>void,disabled=false)=>
    <label className="control-slider"><span>{label}<output className="mono">{Number(value.toFixed(2))}</output></span>
      <input type="range" aria-label={label} value={value} min={min} max={max} step={step} onChange={e=>change(+e.target.value)} disabled={disabled}/></label>
  return <section className="inspector-section lighting-panel">
    <div className="section-title"><span className="step-number"><Sun size={13}/></span><h2>法线与打光</h2><span className="lighting-tag">LOCAL</span></div>
    <div className="lighting-modes" role="group" aria-label="打光预览模式">
      {([['off','关闭'],['lit','实时打光'],['normal','法线贴图']] as const).map(([m,label])=>
        <button key={m} disabled={p.busy} className={m===p.mode?'active':''} onClick={()=>p.onMode(m)}>{label}</button>)}
    </div>
    <label className="form-field"><span>近似法线方法</span><select aria-label="近似法线方法" value={p.normal.method} disabled={p.busy} onChange={e=>normal('method',e.target.value as NormalSettings['method'])}>
      <option value="bevel">轮廓倒角</option><option value="luma">亮度起伏</option><option value="mix">轮廓 + 亮度</option>
    </select></label>
    {slider('法线强度',p.normal.strength,0,8,.1,v=>normal('strength',v),p.busy)}
    {p.normal.method!=='luma'&&slider('倒角宽度（网格 px）',p.normal.bevel,1,32,1,v=>normal('bevel',v),p.busy)}
    {p.normal.method!=='bevel'&&slider('亮度平滑',p.normal.smooth,0,4,.25,v=>normal('smooth',v),p.busy)}
    {p.normal.method==='mix'&&slider('亮度细节',p.normal.detail,0,1,.05,v=>normal('detail',v),p.busy)}
    <div className="lighting-checks"><label className="check-field"><input type="checkbox" checked={p.normal.invert} disabled={p.busy} onChange={e=>normal('invert',e.target.checked)}/>反转凹凸</label>
      <label className="check-field"><input type="checkbox" checked={p.normal.flip_y} disabled={p.busy} onChange={e=>normal('flip_y',e.target.checked)}/>翻转绿色通道</label></div>
    <div className="lighting-actions"><button className="btn secondary" disabled={p.busy} onClick={p.onPreview}>预览法线</button>
      <button className="btn primary" disabled={p.busy||!p.count} onClick={p.onApply}>生成法线 · {p.count} 帧</button></div>
    <p className="hint">{p.dirty?'法线参数已修改，点击预览或生成。':'近似表面起伏，保留原图透明度。'} {p.normal.method!=='bevel'?'原图阴影也可能被解释为凹凸。':''}</p>
    {p.mode==='lit'&&<div className="light-controls"><div className="light-heading"><b>点光源</b><button className="icon-btn" aria-label="重置光源" onClick={()=>p.onLight({...lightDefaults})}><RotateCcw size={13}/></button></div>
      <p className="hint">拖动画布移动光源，即时查看受光变化。</p>
      {slider('光源 X',p.light.x,0,1,.01,v=>light('x',v))}
      {slider('光源 Y',p.light.y,0,1,.01,v=>light('y',v))}
      {slider('光源高度',p.light.height,.05,2,.05,v=>light('height',v))}
      {slider('光源强度',p.light.intensity,0,5,.1,v=>light('intensity',v))}
      {slider('光源范围',p.light.range,.25,4,.05,v=>light('range',v))}
      {slider('环境光',p.light.ambient,0,1,.05,v=>light('ambient',v))}
      <label className="color-control"><span>光源颜色</span><input aria-label="光源颜色" type="color" value={p.light.color} onChange={e=>light('color',e.target.value)}/></label>
    </div>}
    {p.mode!=='off'&&!p.ready&&<p className="hint lighting-status">播放打光动画前，请为播放范围生成法线；单帧可先预览。</p>}
    <p className="hint">灯光仅影响预览。导出勾选法线，可在 Godot 内继续打光。</p>
  </section>
}
