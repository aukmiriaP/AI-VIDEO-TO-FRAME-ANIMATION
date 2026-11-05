import { useCallback, useEffect, useRef, useState } from 'react'
import type { Frame, Geometry, Settings, Stroke, Light, LightMode, LightingPair, OnionFrame, OnionOptions } from './types'
import { LightingRenderer } from './lighting'

type Props = {
  index: number; frame: Frame; settings: Settings; preview?: string; view: 'result' | 'original' | 'compare'
  background: string; zoom: number; brush: 'erase' | 'restore' | null; radius: number
  pending: Stroke[]; onStroke: (stroke: Stroke) => void; playing: boolean
  previewGeometry?: Geometry
  lightingMode:LightMode; light:Light; lightingPair?:LightingPair; onLight:(light:Light)=>void
  prefetch?:string[]
  normalDraftPreview?:boolean
  onion:OnionOptions; onionFrames:OnionFrame[]
}
export default function Stage(p: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const images = useRef<Map<string, HTMLImageElement>>(new Map())
  const tints=useRef(new Map<string,HTMLCanvasElement>())
  const activeStroke = useRef<Stroke | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [wipe, setWipe] = useState(.5)
  const [tick, setTick] = useState(0)
  const [lightError, setLightError] = useState('')
  const gpu = useRef<LightingRenderer | null>(null)
  const draggingLight = useRef(false)
  const lighting = p.view === 'result' && p.lightingMode !== 'off'
  const onionVisible=p.onion.enabled&&!p.playing&&!lighting&&p.view!=='compare'
  const geometry = useRef({ x: 0, y: 0, w: 1, h: 1, cw: 1, ch: 1, sx: 1, sy: 1, dx: 0, dy: 0 })
  const invalidate = () => setTick(t => t + 1)
  useEffect(() => {
    const el = canvas.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(()=>()=>{gpu.current?.dispose();gpu.current=null},[])
  const get = useCallback((src: string) => {
    if (images.current.has(src)) return images.current.get(src)!
    const image = new Image()
    image.onload = invalidate
    image.src = src
    images.current.set(src, image)
    if (images.current.size > 100) {
      const first = images.current.keys().next().value
      if (first) images.current.delete(first)
    }
    return image
  }, [])
  useEffect(()=>{p.prefetch?.forEach(get)},[p.prefetch,get])
  useEffect(() => {
    const c = canvas.current
    if (!c || !size.w) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr)
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    const result = get((lighting ? p.lightingPair?.url : p.preview) || p.frame.output_url || p.frame.original_url)
    const original = get(p.frame.original_url)
    const meta = (lighting ? p.lightingPair?.geometry : p.previewGeometry) || p.frame.geometry
    const processed = !!(p.preview || p.frame.output_url)
    const originalView = p.view === 'original'
    const w = originalView || !processed ? p.frame.width : meta?.canvas[0] || result.naturalWidth || p.frame.width
    const h = originalView || !processed ? p.frame.height : meta?.canvas[1] || result.naturalHeight || p.frame.height
    const scale = Math.min((size.w - 72)/w, (size.h - 72)/h) * p.zoom
    const rect = { x: (size.w-w*scale)/2, y: (size.h-h*scale)/2, w: w*scale, h: h*scale }
    const sx = originalView || !processed ? 1 : meta?.scale[0] ?? w/p.frame.width*p.settings.scale
    const sy = originalView || !processed ? 1 : meta?.scale[1] ?? h/p.frame.height*p.settings.scale
    const dx = originalView || !processed ? 0 : meta?.offset[0] ?? (w-w*p.settings.scale)/2+p.settings.offset_x*w
    const dy = originalView || !processed ? 0 : meta?.offset[1] ?? (h-h*p.settings.scale)/2+p.settings.offset_y*h
    geometry.current = {...rect, cw:w, ch:h, sx, sy, dx, dy}
    const { x, y } = rect
    ctx.fillStyle = p.background === 'checker' ? '#24292a' : p.background
    ctx.fillRect(x, y, rect.w, rect.h)
    if (p.background === 'checker') {
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, rect.w, rect.h); ctx.clip()
      ctx.fillStyle = '#2c3233'
      const grid = 14
      for (let yy = 0; yy < rect.h/grid; yy++) for (let xx = 0; xx < rect.w/grid; xx++)
        if ((xx + yy) % 2 === 0) ctx.fillRect(x+xx*grid, y+yy*grid, grid, grid)
      ctx.restore()
    }
    ctx.imageSmoothingEnabled = p.settings.style !== 'pixel'
    const draw = (image: HTMLImageElement, asSource = false) => {
      if (!image.complete || !image.naturalWidth) return
      if (asSource) ctx.drawImage(image, x+dx*scale, y+dy*scale,
        p.frame.width*sx*scale, p.frame.height*sy*scale)
      else ctx.drawImage(image, x, y, rect.w, rect.h)
    }
    if (p.view === 'original') draw(original)
    else {
      if(lighting){
        const normal=p.lightingPair ? get(p.lightingPair.normal_url) : null
        if(normal?.complete && normal.naturalWidth && result.complete && result.naturalWidth){
          if(p.lightingMode==='normal')draw(normal)
          else{
            try{
              gpu.current ||= new LightingRenderer()
              ctx.drawImage(gpu.current.render(result,normal,p.light,p.settings.style==='pixel'),x,y,rect.w,rect.h)
              setLightError('')
            }catch(e){setLightError((e as Error).message)}
          }
        }
      }else draw(result)
      if (p.view === 'compare') {
        ctx.save(); ctx.beginPath(); ctx.rect(x + rect.w*wipe, y, rect.w*(1-wipe), rect.h); ctx.clip()
        draw(original, true); ctx.restore()
        ctx.strokeStyle = '#f1cba7'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x+rect.w*wipe, y); ctx.lineTo(x+rect.w*wipe, y+rect.h); ctx.stroke()
      }
    }
    if(onionVisible){
      ctx.save();ctx.beginPath();ctx.rect(x,y,rect.w,rect.h);ctx.clip()
      for(const ghost of p.onionFrames){
        const src=originalView?ghost.frame.original_url:ghost.frame.output_url||ghost.frame.original_url
        const image=get(src)
        if(!image.complete||!image.naturalWidth)continue
        let drawable:CanvasImageSource=image
        if(p.onion.tint){
          const key=src+ghost.direction
          let tinted=tints.current.get(key)
          if(!tinted){
            tinted=document.createElement('canvas');tinted.width=image.naturalWidth;tinted.height=image.naturalHeight
            const tc=tinted.getContext('2d')!
            tc.drawImage(image,0,0);tc.globalCompositeOperation='source-in'
            tc.fillStyle=ghost.direction==='before'?'#ec9c87':'#91c3d5';tc.fillRect(0,0,tinted.width,tinted.height)
            tints.current.set(key,tinted)
            if(tints.current.size>48)tints.current.delete(tints.current.keys().next().value!)
          }
          drawable=tinted
        }
        ctx.globalAlpha=p.onion.opacity/ghost.distance
        // Ghosts use the same output coordinate origin and scale, never stretch to fit another frame.
        if(!originalView&&!ghost.frame.output_url&&ghost.frame.geometry){
          const g=ghost.frame.geometry
          ctx.drawImage(drawable,x+g.offset[0]*scale,y+g.offset[1]*scale,
            ghost.frame.width*g.scale[0]*scale,ghost.frame.height*g.scale[1]*scale)
        }else ctx.drawImage(drawable,x,y,image.naturalWidth*scale,image.naturalHeight*scale)
      }
      ctx.restore()
    }
    ctx.strokeStyle = '#6b71704d'; ctx.lineWidth = 1; ctx.strokeRect(x-.5, y-.5, rect.w+1, rect.h+1)
    if (!originalView && processed) {
      const pivot = meta?.pivot || [.5,.5]
      const px = x+pivot[0]*rect.w, py = y+pivot[1]*rect.h
      ctx.strokeStyle = '#f1cba7'; ctx.beginPath()
      ctx.moveTo(px-8,py);ctx.lineTo(px+8,py);ctx.moveTo(px,py-8);ctx.lineTo(px,py+8);ctx.stroke()
    }
    ctx.strokeStyle = '#8d95917a'
    for (const [dx, dy] of [[0, 0], [rect.w, 0], [0, rect.h], [rect.w, rect.h]]) {
      const sx = dx ? 1 : -1, sy = dy ? 1 : -1
      ctx.beginPath(); ctx.moveTo(x+dx+sx*5,y+dy); ctx.lineTo(x+dx+sx*13,y+dy)
      ctx.moveTo(x+dx,y+dy+sy*5); ctx.lineTo(x+dx,y+dy+sy*13); ctx.stroke()
    }
    const strokes = [...p.pending, ...(activeStroke.current ? [activeStroke.current] : [])]
    ctx.save();ctx.beginPath();ctx.rect(x,y,rect.w,rect.h);ctx.clip()
    for (const stroke of originalView ? [] : strokes) {
      ctx.strokeStyle = stroke.mode === 'erase' ? '#ff997c99' : '#98dbbb99'
      ctx.fillStyle = ctx.strokeStyle
      ctx.lineWidth = stroke.radius * Math.min(p.frame.width,p.frame.height) * 2 * Math.min(sx,sy)*scale
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath()
      stroke.points.forEach(([u, v], i) => {
        const px = x+(u*(p.frame.width-1)*sx+dx)*scale
        const py = y+(v*(p.frame.height-1)*sy+dy)*scale
        if (i === 0) ctx.moveTo(px,py)
        ctx.lineTo(px+.01,py+.01)
      })
      ctx.stroke()
    }
    ctx.restore()
    if(lighting && p.lightingMode==='lit'){
      const lx=x+p.light.x*rect.w,ly=y+p.light.y*rect.h
      ctx.strokeStyle=p.light.color;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(lx,ly,7,0,Math.PI*2);ctx.stroke()
      for(let i=0;i<8;i++){
        const a=i*Math.PI/4;ctx.beginPath();ctx.moveTo(lx+11*Math.cos(a),ly+11*Math.sin(a))
        ctx.lineTo(lx+15*Math.cos(a),ly+15*Math.sin(a));ctx.stroke()
      }
    }
  }, [p.frame, p.settings, p.preview, p.previewGeometry, p.view, p.background, p.zoom, p.pending, size, wipe, tick, get, lighting, p.lightingMode, p.lightingPair, p.light, p.onion, p.onionFrames, onionVisible])

  function point(e: React.PointerEvent): [number, number] {
    const r = canvas.current!.getBoundingClientRect(), g = geometry.current
    return [((e.clientX-r.left-g.x)/g.w*g.cw-g.dx)/g.sx/Math.max(1,p.frame.width-1),
      ((e.clientY-r.top-g.y)/g.h*g.ch-g.dy)/g.sy/Math.max(1,p.frame.height-1)]
  }
  function end() {
    draggingLight.current=false
    if (activeStroke.current) { p.onStroke(activeStroke.current); activeStroke.current = null; invalidate() }
  }
  function moveLight(e:React.PointerEvent){
    const r=canvas.current!.getBoundingClientRect(),g=geometry.current
    p.onLight({...p.light,x:Math.max(0,Math.min(1,(e.clientX-r.left-g.x)/g.w)),
      y:Math.max(0,Math.min(1,(e.clientY-r.top-g.y)/g.h))})
  }
  return <div className={`stage-surface ${p.brush ? 'painting' : ''} ${lighting?'lighting':''}`}>
    <canvas ref={canvas} aria-label="动画画布，可用擦除和恢复画笔修正透明遮罩"
      onPointerDown={e => {
        if(lighting && p.lightingMode==='lit'){
          e.currentTarget.setPointerCapture(e.pointerId);draggingLight.current=true;moveLight(e);return
        }
        if(lighting||p.frame.output_override)return
        if (!p.brush || p.playing || p.view !== 'result') return
        const xy = point(e)
        if (xy.some(v => v < 0 || v > 1)) return
        e.currentTarget.setPointerCapture(e.pointerId)
        activeStroke.current = { mode: p.brush, radius: p.radius, points: [xy] }; invalidate()
      }}
      onPointerMove={e => {
        if(draggingLight.current){moveLight(e);return}
        if (activeStroke.current && activeStroke.current.points.length < 1000) {
          activeStroke.current.points.push(point(e)); invalidate()
        }
      }} onPointerUp={end} onPointerCancel={end} />
    <div className="stage-coordinate mono">FRAME {String(p.index+1).padStart(3, '0')} <span> / {p.settings.style === 'pixel' ? 'PIXEL' : 'RGBA'}</span></div>
    {p.preview && <span className="preview-flag">参数预览 · 尚未应用</span>}
    {onionVisible&&p.onionFrames.length>0&&<span className="onion-legend"><span className="before">前帧 {p.onionFrames.filter(f=>f.direction==='before').map(f=>f.index+1).join('、')||'无'}</span><span className="after">后帧 {p.onionFrames.filter(f=>f.direction==='after').map(f=>f.index+1).join('、')||'无'}</span></span>}
    {p.frame.output_override&&<span className="replacement-note">成品覆盖 · 参数不改变此帧 · 可在替换窗口解除</span>}
    {lighting&&p.normalDraftPreview&&<span className="preview-flag">法线预览 · 尚未应用</span>}
    {lighting&&!p.lightingPair&&<span className="light-canvas-message">点击「预览法线」或「生成法线」查看效果</span>}
    {lighting&&p.lightingMode==='lit'&&lightError&&<span className="light-canvas-message" role="alert">{lightError}</span>}
    {(p.previewGeometry || p.frame.geometry)?.warnings.length ? <span className="stage-warning">{(p.previewGeometry || p.frame.geometry)!.warnings.join(' ')}</span> : null}
    {p.view === 'compare' && <div className="wipe-control"><span>处理后</span><input aria-label="原图对照分界" type="range" min={0} max={1} step={.01} value={wipe} onChange={e => setWipe(+e.target.value)}/><span>原始帧</span></div>}
  </div>
}
