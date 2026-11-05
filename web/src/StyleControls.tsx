import { useEffect, useRef, useState } from 'react'
import type { Settings } from './types'
import './styling.css'

export const STYLE_FIELDS: (keyof Settings)[] = ['saturation','contrast','brightness','smooth_strength','smooth_levels',
  'outline_width','outline_color','pixel_sampling','pixel_cell','dither_strength','palette_distance','palette_mode','custom_palette','colors']

const retro = ['#161b2b','#30364e','#57627c','#929cab','#ded8c5','#fff4db','#5b314e','#a64d59',
  '#dc8669','#eebe83','#37625b','#629674','#a5c88b','#305176','#548aaf','#98cee0']
const grayscale = Array.from({length:8},(_,i)=>'#'+Math.round(i*255/7).toString(16).padStart(2,'0').repeat(3))
const neutral: Partial<Settings> = {saturation:1,contrast:1,brightness:0,smooth_strength:0,
  smooth_levels:0,outline_width:0,outline_color:'#202638',pixel_sampling:'nearest',
  pixel_cell:1,dither_strength:0,palette_distance:'rgb'}
const presets = {
  smooth: [
    {name:'原色保留',patch:neutral},
    {name:'柔和去噪',patch:{...neutral,smooth_strength:.65}},
    {name:'卡通块面',patch:{...neutral,smooth_strength:.6,smooth_levels:6,saturation:.9,outline_width:2}},
  ],
  pixel: [
    {name:'基础像素',patch:neutral},
    {name:'干净网格',patch:{...neutral,pixel_sampling:'majority',palette_distance:'lab'}},
    {name:'复古抖色',patch:{...neutral,pixel_sampling:'area',pixel_cell:2,dither_strength:.7,
      palette_mode:'custom',custom_palette:retro,palette_distance:'lab',outline_width:1,outline_color:'#161b2b'}},
  ],
} satisfies Record<string,{name:string;patch:Partial<Settings>}[]>

export function parsePalette(text:string):string[] {
  const input=text.trim()
  let colors:string[]
  if(input.startsWith('[')){
    const parsed:unknown=JSON.parse(input)
    if(!Array.isArray(parsed))throw Error('JSON 色板应为颜色数组。')
    colors=parsed.map(c=>{
      if(Array.isArray(c)&&c.length===3&&c.every(v=>Number.isInteger(v)&&v>=0&&v<=255))
        return '#'+c.map(v=>(v as number).toString(16).padStart(2,'0')).join('')
      if(typeof c==='string')return c
      throw Error('颜色应为 #RRGGBB 或 [R,G,B]。')
    })
  }else{
    const gpl=input.startsWith('GIMP Palette')
    colors=[]
    for(const raw of input.split(/\r?\n/)){
      const line=raw.trim()
      if(!line)continue
      if(gpl&&!/^#[0-9a-fA-F]{6}$/.test(line)){
        if(line.startsWith('#')||/^(GIMP Palette|Name:|Columns:)/.test(line))continue
        const m=line.match(/^(\d+)\s+(\d+)\s+(\d+)(?:\s|$)/)
        if(!m||m.slice(1).some(v=>+v>255))throw Error('GPL 色板包含无效 RGB 行。')
        colors.push('#'+m.slice(1).map(v=>(+v).toString(16).padStart(2,'0')).join(''))
      }else colors.push(...line.split(/[\s,;]+/).filter(Boolean))
    }
  }
  if(!colors.length||colors.length>64||colors.some(c=>!/^#[0-9a-fA-F]{6}$/.test(c)))
    throw Error('色板需要 1–64 个 #RRGGBB 颜色。')
  return [...new Set(colors.map(c=>c.toLowerCase()))]
}

function Range({label,value,min,max,step=1,onChange,disabled,suffix=''}:{label:string;value:number;min:number;max:number;step?:number;onChange:(v:number)=>void;disabled:boolean;suffix?:string}){
  return <label className="control-slider"><span>{label}<output className="mono">{Number(value.toFixed(2))}{suffix}</output></span>
    <input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={e=>onChange(+e.target.value)}/></label>
}
export default function StyleControls({settings:s,palette,disabled,onChange,onPreset}:{settings:Settings;palette:number[][]|null;disabled:boolean;onChange:(patch:Partial<Settings>,global?:boolean)=>void;onPreset:(patch:Partial<Settings>)=>void}){
  const [text,setText]=useState(s.custom_palette.join('\n'))
  const [error,setError]=useState('')
  const file=useRef<HTMLInputElement>(null)
  useEffect(()=>{setText(s.custom_palette.join('\n'));setError('')},[s.custom_palette])
  const change=<K extends keyof Settings>(key:K,value:Settings[K])=>onChange({[key]:value})
  function importText(input:string){
    try{onChange({palette_mode:'custom',custom_palette:parsePalette(input)},true);setError('')}
    catch(e){setError((e as Error).message)}
  }
  return <div className="style-enhancement">
    <label className="select-row">风格预设<select aria-label="风格预设" value="" disabled={disabled} onChange={e=>{
      const preset=presets[s.style].find(p=>p.name===e.target.value);if(preset)onPreset(preset.patch)
    }}><option value="">选择预设…</option>{presets[s.style].map(p=><option key={p.name} value={p.name}>{p.name}</option>)}</select></label>
    <p className="hint">预设仅改风格参数；先预览，再应用。</p>
    {s.style==='pixel'?<>
      <label className="select-row">像素采样<select aria-label="像素采样" value={s.pixel_sampling} disabled={disabled} onChange={e=>change('pixel_sampling',e.target.value as Settings['pixel_sampling'])}>
        <option value="nearest">中心 / 最近邻</option><option value="area">区域平均</option><option value="majority">主色采样</option></select></label>
      <Range label="像素网格单元" value={s.pixel_cell} min={1} max={8} suffix=" px" disabled={disabled} onChange={v=>change('pixel_cell',v)}/>
      <label className="select-row">颜色匹配<select aria-label="颜色匹配" value={s.palette_distance} disabled={disabled} onChange={e=>change('palette_distance',e.target.value as Settings['palette_distance'])}><option value="rgb">RGB 距离</option><option value="lab">Lab 感知距离</option></select></label>
      <Range label="有序抖色强度" value={s.dither_strength} min={0} max={1} step={.05} disabled={disabled} onChange={v=>change('dither_strength',v)}/>
      <p className="hint">网格固定在输出画布；区域平均抗混叠，主色为每格五点采样。抖色使用固定图案，0 关闭。</p>
      <details className="custom-palette"><summary>固定 / 导入色板</summary>
        <label className="select-row">色板来源<select aria-label="色板来源" value={s.palette_mode} disabled={disabled} onChange={e=>{
          const mode=e.target.value as Settings['palette_mode']
          const colors=s.custom_palette.length?s.custom_palette:(palette?.length?palette.map(c=>'#'+c.map(v=>v.toString(16).padStart(2,'0')).join('')):retro)
          onChange({palette_mode:mode,custom_palette:mode==='custom'?colors:s.custom_palette},true)
        }}><option value="auto">序列提取 / 锁定</option><option value="custom">自定义固定色板</option></select></label>
        <div className="palette-shortcuts"><button disabled={disabled} onClick={()=>onChange({palette_mode:'custom',custom_palette:retro},true)}>复古 16 色</button><button disabled={disabled} onClick={()=>onChange({palette_mode:'custom',custom_palette:grayscale},true)}>灰度 8 色</button></div>
        <textarea aria-label="自定义色板内容" disabled={disabled} value={text} placeholder={'#161b2b\n#fff4db'} onChange={e=>setText(e.target.value)} rows={4}/>
        <input ref={file} className="sr-only" type="file" aria-label="色板文件" accept=".hex,.txt,.json,.gpl" onChange={async e=>{
          const f=e.target.files?.[0];if(!f)return
          try{if(f.size>65536)throw Error('色板文件最多 64 KB。');const content=await f.text();setText(content);importText(content)}
          catch(error){setError((error as Error).message)}
          e.target.value=''
        }}/>
        <div className="palette-shortcuts"><button disabled={disabled} onClick={()=>importText(text)}>使用输入色板</button><button disabled={disabled} onClick={()=>file.current?.click()}>导入色板文件</button></div>
        {s.palette_mode==='custom'&&<div className="palette">{s.custom_palette.map((c,i)=><input key={i} aria-label={`编辑色板颜色 ${i+1}`} type="color" value={c} disabled={disabled} onChange={e=>onChange({custom_palette:s.custom_palette.map((v,j)=>i===j?e.target.value:v)},true)}/>)}</div>}
        {error&&<p className="inline-error" role="alert">{error}</p>}
        <p className="hint">HEX / JSON / GPL，最多 64 色。色板作用于全部帧；导入后仍需应用。固定色板不会重新提取。</p>
      </details>
    </>:<>
      <Range label="保边平滑" value={s.smooth_strength} min={0} max={1} step={.05} disabled={disabled} onChange={v=>change('smooth_strength',v)}/>
      <label className="select-row">颜色分层<select aria-label="颜色分层" value={s.smooth_levels} disabled={disabled} onChange={e=>change('smooth_levels',+e.target.value)}>{[0,2,3,4,6,8,12,16].map(v=><option key={v} value={v}>{v?`${v} 层 / 通道`:'关闭 / 保留渐变'}</option>)}</select></label>
      <p className="hint">平滑减少颜色细噪声、保留边界；分层使用全序列固定色阶。两者保留原 Alpha。</p>
    </>}
    <details><summary>调色与描边</summary>
      <Range label="饱和度" value={s.saturation} min={0} max={2} step={.05} suffix="×" disabled={disabled} onChange={v=>change('saturation',v)}/>
      <Range label="对比度" value={s.contrast} min={.5} max={2} step={.05} suffix="×" disabled={disabled} onChange={v=>change('contrast',v)}/>
      <Range label="亮度调整" value={s.brightness} min={-.5} max={.5} step={.025} disabled={disabled} onChange={v=>change('brightness',v)}/>
      <Range label="外描边宽度" value={s.outline_width} min={0} max={6} suffix={s.style==='pixel'?' 格':' px'} disabled={disabled} onChange={v=>change('outline_width',v)}/>
      <label className="color-control"><span>描边颜色</span><input aria-label="描边颜色" type="color" value={s.outline_color} disabled={disabled} onChange={e=>change('outline_color',e.target.value)}/></label>
      <p className="hint">描边添加在透明主体外侧，原主体透明度保留。像素描边按网格计宽，颜色仍受色板约束；建议留足画布空间。</p>
    </details>
  </div>
}
