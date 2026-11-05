import type { OnionFrame, OnionOptions, Project } from './types'
import './refining.css'

export function onionFrames(project:Project,current:number,options:OnionOptions):OnionFrame[]{
  const action=project.actions.find(a=>a.start<=current&&current<=a.end)
  const lo=action?.start??0,hi=action?.end??project.frames.length-1
  const enabled=project.frames.flatMap((f,i)=>f.enabled&&i>=lo&&i<=hi?[i]:[])
  const result:OnionFrame[]=[]
  const used=new Set<number>([current])
  for(const direction of ['before','after'] as const){
    const candidates=direction==='before'?enabled.filter(i=>i<current).reverse():enabled.filter(i=>i>current)
    if(options.wrap&&action?.loop){
      candidates.push(...(direction==='before'?enabled.filter(i=>i>current).reverse():enabled.filter(i=>i<current)))
    }
    for(const index of candidates){
      if(used.has(index))continue
      const distance=result.filter(f=>f.direction===direction).length+1
      if(distance>options[direction])break
      used.add(index);result.push({index,frame:project.frames[index],direction,distance})
    }
  }
  return result.sort((a,b)=>b.distance-a.distance)
}

type Props={options:OnionOptions;onChange:(o:OnionOptions)=>void;disabled:boolean;suspended:boolean;frames:OnionFrame[]}
export default function OnionControls(p:Props){
  const set=<K extends keyof OnionOptions>(key:K,value:OnionOptions[K])=>p.onChange({...p.options,[key]:value})
  return <div className="onion-controls">
    <label className="onion-toggle"><input aria-label="启用洋葱皮" type="checkbox" checked={p.options.enabled} disabled={p.disabled} onChange={e=>set('enabled',e.target.checked)}/>洋葱皮</label>
    {p.options.enabled&&<>
      <label>前帧<select aria-label="洋葱皮前帧数" value={p.options.before} disabled={p.disabled} onChange={e=>set('before',+e.target.value)}>{[0,1,2,3].map(n=><option key={n}>{n}</option>)}</select></label>
      <label>后帧<select aria-label="洋葱皮后帧数" value={p.options.after} disabled={p.disabled} onChange={e=>set('after',+e.target.value)}>{[0,1,2,3].map(n=><option key={n}>{n}</option>)}</select></label>
      <label>透明度<input aria-label="洋葱皮透明度" type="range" min={.05} max={.6} step={.05} value={p.options.opacity} disabled={p.disabled} onChange={e=>set('opacity',+e.target.value)}/><span className="mono">{Math.round(p.options.opacity*100)}%</span></label>
      <label><input aria-label="洋葱皮双色区分" type="checkbox" checked={p.options.tint} disabled={p.disabled} onChange={e=>set('tint',e.target.checked)}/>双色</label>
      <label><input aria-label="洋葱皮循环首尾" type="checkbox" checked={p.options.wrap} disabled={p.disabled} onChange={e=>set('wrap',e.target.checked)}/>循环首尾</label>
      <span className="onion-info">{p.suspended?'播放 / 对照 / 打光时暂时隐藏':p.frames.length?`参考 ${p.frames.map(f=>f.index+1).sort((a,b)=>a-b).join('、')} 帧`:'当前动作没有可参考的启用帧'}</span>
    </>}
  </div>
}
