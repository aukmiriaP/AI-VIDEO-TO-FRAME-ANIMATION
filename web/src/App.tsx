import { useCallback, useEffect, useRef, useState } from 'react'
import { Aperture, ArrowDownToLine, ArrowLeftRight, ArrowRight, Check, ChevronLeft, ChevronRight,
  CircleHelp, Clapperboard, Download, Eraser, Film, FolderOpen, Grid2X2, ImagePlus, Layers3,
  LoaderCircle, Maximize2, Minus, MousePointer2, Paintbrush, Pause, Play, Plus, RotateCcw, Scissors,
  Settings2, SkipBack, SkipForward, Sparkles, Upload, WandSparkles, X, EyeOff, CheckCircle2 } from 'lucide-react'
import { api, json } from './api'
import Stage from './Stage'
import FrameControls from './FrameControls'
import OnionControls, { onionFrames } from './OnionControls'
import ReplaceFrame from './ReplaceFrame'
import AnimationCheck from './AnimationCheck'
import { AssetPanel, ExportDialog } from './Assets'
import StyleControls, { STYLE_FIELDS } from './StyleControls'
import LightingPanel from './LightingPanel'
import { defaults, normalDefaults, lightDefaults } from './types'
import type { Action, AnalysisReport, EditOperation, Job, Preview, Project, ProjectSummary, Settings, Stroke, NormalSettings, Light, LightMode, LightingPair, OnionOptions } from './types'
import './style.css'
import './animation.css'

const number = (v: number) => String(v+1).padStart(3, '0')
const fmt = (v: number) => `${v.toFixed(2)}s`

function Slider({ label, value, min, max, step = 1, onChange, suffix = '', disabled = false }:
  { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string; disabled?: boolean }) {
  return <label className="control-slider"><span>{label}<output className="mono">{Number(value.toFixed(3))}{suffix}</output></span>
    <input aria-label={label} type="range" value={value} min={min} max={max} step={step} disabled={disabled} onChange={e => onChange(+e.target.value)}/></label>
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [current, setCurrent] = useState(0)
  const [selection, setSelection] = useState<number[]>([0])
  const [settings, setSettings] = useState<Settings>(defaults)
  const [scope, setScope] = useState<'all' | 'selection'>('all')
  const [view, setView] = useState<'result' | 'original' | 'compare'>('result')
  const [bg, setBg] = useState('checker')
  const [zoom, setZoom] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [activeAction, setActiveAction] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [preview, setPreview] = useState<Preview>()
  const [normalDraft,setNormalDraft]=useState<NormalSettings>(normalDefaults)
  const [light,setLight]=useState<Light>(lightDefaults)
  const [lightMode,setLightMode]=useState<LightMode>('off')
  const [normalPreview,setNormalPreview]=useState<LightingPair>()
  const [onion,setOnion]=useState<OnionOptions>({enabled:false,before:1,after:1,opacity:.25,tint:true,wrap:false})
  const [brush, setBrush] = useState<'erase' | 'restore' | null>(null)
  const [radius, setRadius] = useState(.035)
  const [pending, setPending] = useState<Stroke[]>([])
  const [modal, setModal] = useState<'import' | 'action' | 'help' | 'check' | 'assets' | 'export' | 'replace' | null>(null)
  const [analysisReport, setAnalysisReport] = useState<AnalysisReport | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [name, setName] = useState('')
  const [importFps, setImportFps] = useState(12)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [importStyle, setImportStyle] = useState<'pixel' | 'smooth'>('smooth')
  const [actionName, setActionName] = useState('walk')
  const [actionFps, setActionFps] = useState(12)
  const [actionLoop, setActionLoop] = useState(true)
  const [aiReady, setAiReady] = useState(false)
  const [download, setDownload] = useState<string>()
  const [filmstripSize, setFilmstripSize] = useState<'small' | 'large'>('large')
  const fileInput = useRef<HTMLInputElement>(null)
  const projectRef = useRef(project)
  projectRef.current = project
  const busy = !!jobId || loading
  const frame = project?.frames[current]
  const action = project?.actions.find(a => a.id === activeAction)
  const playbackFps = action?.fps || project?.actions.find(a => a.start <= current && current <= a.end)?.fps || project?.fps || 12
  const duration = project?.frames.reduce((s,f,i) => s+(f.enabled ? f.duration*project.fps/(project.actions.find(a=>a.start<=i && i<=a.end)?.fps || project.fps) : 0),0) || 0
  const activeReport = analysisReport?.project_id === project?.id && analysisReport?.revision === project?.revision ? analysisReport : null
  const markers = new Map<number, string>()
  activeReport?.duplicates.forEach(d => d.indices.slice(1).forEach(i => markers.set(i, d.kind === 'consecutive' ? '相似' : '回返')))
  activeReport?.suspects.forEach(s => markers.set(s.index, '可疑'))
  const changed = frame && JSON.stringify(settings) !== JSON.stringify(scope === 'all' ? project?.settings : frame.settings || project?.settings)
  const lightingPair = project && frame && normalPreview?.frame_id===frame.id && normalPreview.revision===project.revision
    ? normalPreview : project && frame?.normal_url && frame.output_url && frame.geometry
    ? {url:frame.output_url,normal_url:frame.normal_url,geometry:frame.geometry,frame_id:frame.id,revision:project.revision} : undefined
  const lightingPlaybackReady = !!project && project.frames.every((f,i)=>
    !f.enabled || (action && (i<action.start || i>action.end)) || !!(f.normal_url&&f.output_url))
  const lightActive=lightMode!=='off'&&view==='result'
  const ghosts=project?onionFrames(project,current,onion):[]
  const prefetch=project?.frames.slice(current+1,current+7).flatMap(f=>[f.output_url,f.normal_url].filter((s):s is string=>!!s))
  const normalBaseline=scope==='all'?project?.normal_settings:frame?.normal_settings||project?.normal_settings
  useEffect(()=>{
    if(!project)return
    setNormalDraft(scope==='all'?project.normal_settings:project.frames[current]?.normal_settings||project.normal_settings)
    setNormalPreview(undefined)
  },[project?.id,project?.revision,current,scope])

  const notify = (text: string, error = false) => setToast({text, error})
  const refreshProjects = useCallback(async () => setProjects(await api<ProjectSummary[]>('/projects')), [])
  const loadProject = useCallback(async (pid: string, reset = true) => {
    const p = await api<Project>(`/projects/${pid}`)
    setProject(p)
    if (reset) {
      setCurrent(0); setSelection([0]); setSettings(p.settings); setActiveAction(null); setScope('all')
      setPlaying(false); setPending([]); setBrush(null); setPreview(undefined); setDownload(undefined)
      setLightMode('off');setNormalPreview(undefined)
    }
    localStorage.setItem('frame-studio-project', pid)
    if (p.job_id && p.job_id !== 'preview') setJobId(p.job_id)
    return p
  }, [])

  useEffect(() => {
    refreshProjects().catch(e => notify(e.message, true))
    api<{ ai_ready: boolean }>('/health').then(r => setAiReady(r.ai_ready)).catch(() => {})
    const pid = localStorage.getItem('frame-studio-project')
    if (pid) loadProject(pid).catch(() => localStorage.removeItem('frame-studio-project'))
  }, [refreshProjects, loadProject])
  useEffect(() => { if (toast) { const id = setTimeout(() => setToast(null), 6500); return () => clearTimeout(id) } }, [toast])
  useEffect(() => {
    if (!jobId) return
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const j = await api<Job>(`/jobs/${jobId}`)
        if (stopped) return
        setJob(j)
        if (['done', 'failed', 'canceled'].includes(j.state)) {
          setJobId(null)
          if (j.kind === 'analysis') {
            if (j.state === 'done') setAnalysisReport(j.result?.analysis || null)
          } else if (j.project_id !== '_model') {
            const old = projectRef.current
            const p = await loadProject(j.project_id, !old || old.id !== j.project_id || j.kind === 'import')
            setSettings(scope === 'all' ? p.settings : p.frames[current]?.settings || p.settings)
            setPending([]); setPreview(undefined)
          } else {
            const h = await api<{ ai_ready: boolean }>('/health')
            setAiReady(h.ai_ready)
          }
          await refreshProjects()
          if (j.state === 'done') {
            if (j.result?.url) { setDownload(j.result.url); notify('导出完成：PNG 序列、图集与 Godot 工程已打包。') }
            else if (j.kind === 'analysis') notify('检查完成，选择候选后可应用；素材尚未修改。')
            else if (j.kind === 'process' || j.kind === 'brush') notify(`已更新 ${j.result?.processed || 0} 帧，复用 ${j.result?.base_cached || 0} 次缓存。`)
            else if (j.kind === 'normals') notify(`已生成 ${j.result?.processed || 0} 帧法线，可切换实时打光并播放。`)
            else if (j.kind === 'replace') notify(`单帧替换已保存，更新 ${j.result?.processed || 0} 帧及依赖，可撤销。`)
            else notify(j.kind === 'model' ? 'AI 抠图模型已就绪。' : '素材已就绪，可以开始编辑。')
          } else notify(j.message, j.state === 'failed')
          return
        }
        timer = setTimeout(poll, 750)
      } catch (e) { if (!stopped) { setJobId(null); notify((e as Error).message, true) } }
    }
    poll()
    return () => { stopped = true; clearTimeout(timer) }
    // Do not restart polling as playback/current frame changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, loadProject, refreshProjects])

  useEffect(() => {
    if (!playing || !project || !frame) return
    const lo = action?.start ?? 0, hi = action?.end ?? project.frames.length-1
    const enabled = Array.from({length: hi-lo+1}, (_,i) => lo+i).filter(i => project.frames[i].enabled)
    if (!enabled.length) { setPlaying(false); return }
    const index = enabled.indexOf(current)
    if (index < 0) { setCurrent(enabled[0]); return }
    const fps = action?.fps || project.actions.find(a=>a.start<=current && current<=a.end)?.fps || project.fps
    const delay = frame.duration * project.fps / fps * 1000
    const timer = setTimeout(() => {
      if (index === enabled.length-1 && action && !action.loop) { setPlaying(false); return }
      setCurrent(enabled[(index+1) % enabled.length])
    }, Math.max(1, delay))
    return () => clearTimeout(timer)
  }, [playing, project, frame, current, action])

  function select(index: number, extend = false, toggle = false) {
    if (pending.length) { notify('请先保存或放弃当前画笔修订。'); return }
    setPlaying(false); setCurrent(index); setPreview(undefined)
    if (extend) setSelection(Array.from({length: Math.abs(index-(selection[0] ?? 0))+1}, (_,i) => Math.min(index,selection[0] ?? 0)+i))
    else if (toggle) setSelection(old => old.includes(index) ? old.filter(i => i !== index) : [...old,index].sort((a,b) => a-b))
    else setSelection([index])
    if (project) setSettings(scope === 'all' ? project.settings : project.frames[index].settings || project.settings)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea') || modal || busy || pending.length) return
      if (e.code === 'Space' && frame) { e.preventDefault(); togglePlayback() }
      if (e.key === 'ArrowRight' && project) { e.preventDefault(); select(Math.min(project.frames.length-1,current+1), e.shiftKey) }
      if (e.key === 'ArrowLeft' && project) { e.preventDefault(); select(Math.max(0,current-1), e.shiftKey) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setLightMode('off')
    setPlaying(false); setPreview(undefined); setSettings(s => ({...s, [key]: value}))
  }
  function styleChange(patch:Partial<Settings>,global=false){
    setLightMode('off')
    setPlaying(false);setPreview(undefined)
    setSettings(s=>({...((global&&scope==='selection'&&project)?{
      ...project.settings,...Object.fromEntries(STYLE_FIELDS.map(k=>[k,s[k]])),
    }:s),...patch}))
    if(global)setScope('all')
  }
  function settingsPatch(){
    const baseline=scope==='all'?project?.settings:frame?.settings||project?.settings
    return Object.fromEntries(Object.entries(settings).filter(([k,v])=>
      JSON.stringify(v)!==JSON.stringify(baseline?.[k as keyof Settings])))
  }
  async function perform(fn: () => Promise<void>) {
    setLoading(true); setPlaying(false)
    try { await fn() } catch (e) { notify((e as Error).message, true) } finally { setLoading(false) }
  }
  async function begin(url: string, body?: unknown) {
    const r = await api<{job_id: string; project_id: string}>(url, json(body))
    setJob(null); setJobId(r.job_id)
    if (r.project_id !== '_model' && r.project_id !== project?.id) await loadProject(r.project_id)
  }
  function apply(rebuild = false) {
    if (!project) return
    perform(() => begin(`/projects/${project.id}/process`, {indices: scope === 'all' || rebuild ? null : selection,
      settings_patch:settingsPatch(),rebuild_palette: rebuild,expected_revision:project.revision}))
  }
  function togglePlayback(){
    if(!playing && lightActive && !lightingPlaybackReady){
      notify('请先为播放范围生成法线，再播放打光动画。');return
    }
    setPreview(undefined);setBrush(null);setNormalPreview(undefined);setPlaying(v=>!v)
  }
  function changeLightMode(mode:LightMode){
    setPlaying(false);setBrush(null);setPreview(undefined);setView('result');setLightMode(mode)
  }
  function inspectNormals(){
    if(!project)return
    perform(async()=>{
      const result=await api<LightingPair>(`/projects/${project.id}/normals/preview`,json({
        index:current,settings:normalDraft,expected_revision:project.revision,
      }))
      setNormalPreview(result);setPreview(undefined);setBrush(null);setView('result')
      setLightMode(mode=>mode==='off'?'normal':mode)
    })
  }
  function applyNormals(){
    if(!project)return
    setPreview(undefined);setNormalPreview(undefined);setBrush(null)
    perform(()=>begin(`/projects/${project.id}/normals`,{
      settings:normalDraft,indices:scope==='all'?null:selection,expected_revision:project.revision,
    }))
  }
  function replaceFrame(file:File,mode:'source'|'output',keep:boolean){
    if(!project||!frame)return
    perform(async()=>{
      const body=new FormData()
      body.set('file',file);body.set('mode',mode);body.set('keep_strokes',String(keep))
      body.set('expected_revision',String(project.revision));body.set('expected_frame_id',frame.id)
      const result=await api<{job_id:string}>(`/projects/${project.id}/frames/${current}/replace`,{method:'POST',body})
      setModal(null);setBrush(null);setPreview(undefined);setNormalPreview(undefined)
      setJob(null);setJobId(result.job_id)
    })
  }
  function resetReplacement(){
    if(!project||!frame)return
    perform(async()=>{
      await begin(`/projects/${project.id}/frames/${current}/replacement/reset`,{
        expected_revision:project.revision,expected_frame_id:frame.id,
      })
      setModal(null);setPreview(undefined);setNormalPreview(undefined)
    })
  }
  function toggleFrames() {
    if (!project) return
    const enabled = selection.some(i => !project.frames[i].enabled)
    perform(async () => {
      setProject(await api<Project>(`/projects/${project.id}/frames`, json({indices: selection, enabled}, 'PATCH')))
    })
  }
  async function acceptEdit(p: Project) {
    const old = projectRef.current
    const oldIds = old ? selection.map(i => old.frames[i]?.id).filter(Boolean) : []
    const keepIds = p.edit_result?.selected_ids.length ? p.edit_result.selected_ids : oldIds
    const selected = p.frames.flatMap((f,i) => keepIds.includes(f.id) ? [i] : [])
    const oldCurrent = old?.frames[current]?.id
    const sameCurrent = p.frames.findIndex(f => f.id === oldCurrent)
    const next = selected[0] ?? (sameCurrent >= 0 ? sameCurrent : Math.min(current,p.frames.length-1))
    setProject(p);setCurrent(next);setSelection(selected.length ? selected : [next])
    setSettings(scope === 'all' ? p.settings : p.frames[next]?.settings || p.settings)
    setActiveAction(id => p.actions.some(a=>a.id === id) ? id : null)
    setPreview(undefined);setBrush(null);setAnalysisReport(null)
    await refreshProjects()
  }
  function editFrames(operation: EditOperation, body: { order?: number[]; duration?: number } = {}) {
    if (!project || busy || pending.length) return
    perform(async () => {
      const p = await api<Project>(`/projects/${project.id}/edit`,json({
        expected_revision:project.revision,operation,indices:selection,...body,
      }))
      await acceptEdit(p)
      notify('编辑已保存，可撤销；后续导出使用当前顺序与时长。')
    })
  }
  function dropFrame(from: number, to: number) {
    if (!project || from===to || !Number.isInteger(from) || from<0 || from>=project.frames.length) return
    const order = project.frames.map((_,i)=>i).filter(i=>i!==from)
    order.splice(order.indexOf(to),0,from)
    editFrames('order',{order})
  }
  function acceptFiles(items: File[]) {
    setFiles(items)
    if (items[0]) setName(items[0].name.replace(/\.[^.]+$/, ''))
  }
  function importFiles() {
    perform(async () => {
      const data = new FormData()
      files.forEach(f => data.append('files', f))
      data.set('name', name); data.set('fps', String(importFps)); data.set('style', importStyle)
      data.set('start', String(start)); data.set('end', String(end))
      const r = await api<{job_id: string; project_id: string}>('/import', {method: 'POST', body: data})
      setModal(null); setFiles([]); setJob(null); setJobId(r.job_id); await loadProject(r.project_id)
    })
  }
  function chooseAction(a: Action) {
    if (pending.length) { notify('请先保存或放弃画笔修订。'); return }
    setActiveAction(a.id); setCurrent(a.start); setSelection(Array.from({length:a.end-a.start+1}, (_,i) => a.start+i))
    setPlaying(false); setPreview(undefined)
    if (project) setSettings(scope === 'all' ? project.settings : project.frames[a.start].settings || project.settings)
  }
  const empty = !project?.frames.length
  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#" onClick={e => e.preventDefault()}><span className="brand-mark"><Aperture size={24}/></span><b>帧序</b><span className="brand-en">FRAME STUDIO</span><span className="version">0.6</span></a>
      <div className="header-center"><span className="live-dot"/>本地工作空间<span className="slash">/</span><span>{project?.name || '新的创作，从这里开始'}</span></div>
      <div className="header-actions"><button className="icon-btn" title="使用说明" aria-label="使用说明" onClick={() => setModal('help')}><CircleHelp size={17}/></button>
        <button className="btn secondary" onClick={() => setModal('import')} disabled={busy}><Plus size={16}/>导入素材</button>
        <button className="btn secondary" disabled={busy || empty || !!pending.length} onClick={()=>{setPlaying(false);setModal('assets')}}><Layers3 size={16}/>资产整理</button>
        <button className="btn primary" disabled={busy || empty || !!pending.length} onClick={() => {setPlaying(false);setModal('export')}}><ArrowDownToLine size={16}/>导出动画</button></div>
    </header>
    <div className="workspace">
      <aside className="library">
        <div className="side-heading"><span>序列库</span><button className="icon-btn" aria-label="新建序列" onClick={() => setModal('import')} disabled={busy}><Plus size={16}/></button></div>
        <div className="project-list">
          {projects.map(p => <button key={p.id} className={`project-card ${p.id === project?.id ? 'active' : ''}`} disabled={busy || !!pending.length}
            onClick={() => perform(async () => { await loadProject(p.id) })}>
            <span className="project-symbol"><Film size={19}/></span><span className="project-copy"><strong>{p.name}</strong><small>{p.style === 'pixel' ? '像素风' : '非像素'} <i>·</i> {p.frame_count} 帧</small></span>
            {p.id === project?.id && <span className="selected-indicator"/>}
          </button>)}
          {!projects.length && <div className="library-empty"><Layers3 size={27}/><span>你的动画序列<br/>会保存在这里</span></div>}
        </div>
        {!empty && <><div className="side-heading actions-title"><span>动作片段 <em>{project!.actions.length}</em></span><button className="icon-btn" aria-label="创建动作片段" disabled={busy || !selection.length} onClick={() => { setModal('action'); setActionFps(project!.fps) }}><Plus size={16}/></button></div>
          <div className="action-list">
            <button className={`action-item ${!activeAction ? 'active' : ''}`} onClick={() => { setActiveAction(null); select(0) }}><Layers3 size={15}/><span>完整序列</span><small>{project!.frames.length}</small></button>
            {project!.actions.map(a => <button key={a.id} className={`action-item ${activeAction === a.id ? 'active' : ''}`} onClick={() => chooseAction(a)}><span className="action-dot"/><span>{a.name}</span><small>{number(a.start)}–{number(a.end)}</small></button>)}
          </div>
          <div className="source-note"><span className="eyebrow">SOURCE INFO</span><div>{project!.width} × {project!.height}<span>RGBA</span></div><div>{project!.frames.length} 帧<span>{fmt(duration)}</span></div>
            {project!.demo && <p>内置程序绘制练习素材<br/>可用于尝试抠图与修帧</p>}</div></>}
        <div className="library-bottom"><span className="live-dot"/><span>素材与修改保存在本机</span><button className="icon-btn" title="了解保存方式" onClick={() => setModal('help')}><CircleHelp size={14}/></button></div>
      </aside>
      <main className="editor">
        <div className="editor-toolbar">
          <div className="workspace-label"><Clapperboard size={16}/><span>动画工作台</span><span className="tiny-separator"/><small>{empty ? '等待导入' : action?.name || '完整序列'}</small></div>
          <div className="view-switch" role="group" aria-label="预览模式">{([['result','处理后'],['original','原始帧'],['compare','对照']] as const).map(([value,label]) =>
            <button key={value} className={view === value ? 'active' : ''} disabled={!!brush} onClick={() => {setView(value); setPlaying(false)}}>{value === 'compare' && <ArrowLeftRight size={13}/>} {label}</button>)}</div>
        </div>
        {!empty&&<OnionControls options={onion} onChange={setOnion} disabled={busy}
          suspended={playing||lightActive||view==='compare'} frames={ghosts}/>}
        <div className="canvas-area">
          {empty ? <div className="welcome">
            <div className="welcome-eyebrow"><span/> VIDEO TO GAME-READY FRAMES</div>
            <div className="welcome-art"><div className="art-frame back"/><div className="art-frame mid"/><div className="art-frame front"><Aperture size={54} strokeWidth={1}/><span>01 / ∞</span></div></div>
            <h1>让每一帧，<br/><span>都进入创作。</span></h1>
            <p>把 AI 视频整理成可编辑的游戏动画。<br/>从抠图、修帧，到像素与非像素资产导出。</p>
            {project?.import_status === 'failed' && <p className="inline-error">{project.import_error}</p>}
            <div className="welcome-actions"><button className="btn primary" disabled={busy} onClick={() => setModal('import')}><Upload size={16}/>导入视频或序列帧</button>
              <button className="btn text" disabled={busy} onClick={() => perform(() => begin('/demo'))}>试用练习素材 <ArrowRight size={16}/></button></div>
            <div className="welcome-formats"><span>MP4 / MOV / WebM</span><i/><span>PNG 序列</span><i/><span>所有处理在本机进行</span></div>
          </div> : <>
            <div className="canvas-tools"><button className={`tool ${!brush ? 'active' : ''}`} aria-label="选择工具" title="选择工具" onClick={() => setBrush(null)}><MousePointer2 size={17}/></button>
              <span/><button className={`tool ${brush === 'erase' ? 'active' : ''}`} disabled={busy || playing || !!preview || lightActive || !!frame?.output_override} aria-label="擦除背景画笔" title="擦除背景画笔" onClick={() => {setLightMode('off');setBrush('erase'); setView('result'); setPlaying(false)}}><Eraser size={17}/></button>
              <button className={`tool ${brush === 'restore' ? 'active' : ''}`} disabled={busy || playing || !!preview || lightActive || !!frame?.output_override} aria-label="恢复前景画笔" title="恢复原始前景" onClick={() => {setLightMode('off');setBrush('restore'); setView('result'); setPlaying(false)}}><Paintbrush size={17}/></button>
              <span/><button className="tool" aria-label="适应画布" title="适应画布" onClick={() => setZoom(1)}><Maximize2 size={17}/></button></div>
            <Stage index={current} frame={frame!} settings={preview ? settings : frame?.settings || project!.settings} preview={preview?.url} previewGeometry={preview?.geometry} view={view} background={bg} zoom={zoom}
              light={light} lightingMode={lightMode} lightingPair={lightingPair} onLight={setLight} prefetch={prefetch}
              normalDraftPreview={!!normalPreview&&lightingPair===normalPreview}
              onion={onion} onionFrames={ghosts}
              brush={brush} radius={radius} pending={pending} onStroke={s => setPending(a => [...a,s])} playing={playing}/>
            <div className="canvas-topline"><span>{project!.name}</span><span>{frame?.enabled ? '启用' : '已跳过'} <i/> {frame?.output_url ? '已处理' : '原始素材'}</span></div>
            <div className="canvas-bottomline"><div className="background-picker" aria-label="画布背景">{['checker','#141617','#f1eee7','#344f67'].map(color =>
              <button key={color} className={`${color === 'checker' ? 'checker-swatch' : ''} ${bg === color ? 'active' : ''}`} style={color !== 'checker' ? {background:color} : {}} title={color === 'checker' ? '透明棋盘' : color} aria-label={'背景 '+color} onClick={() => setBg(color)}/>)}</div>
              <div className="zoom-controls"><button aria-label="缩小" disabled={zoom <= .5} onClick={() => setZoom(Math.max(.5,zoom-.25))}><Minus size={14}/></button><span className="mono">{Math.round(zoom*100)}%</span><button aria-label="放大" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3,zoom+.25))}><Plus size={14}/></button></div></div>
            {brush && <div className="brush-bar"><span>{brush === 'erase' ? '擦除背景' : '恢复原图'}</span><input aria-label="画笔大小" type="range" min={.005} max={.12} step={.005} value={radius} onChange={e => setRadius(+e.target.value)}/>
              <span>{pending.length} 笔</span><button disabled={!pending.length} onClick={() => setPending(a => a.slice(0,-1))}><RotateCcw size={14}/></button>
              <button className="brush-save" disabled={busy || !pending.length} onClick={() => perform(async () => {
                const r = await api<{job_id:string}>(`/projects/${project!.id}/frames/${current}/mask`, json({strokes:[...frame!.strokes,...pending]},'PUT'))
                setJobId(r.job_id); setJob(null); setBrush(null)
              })}>保存修订</button><button onClick={() => {setPending([]); setBrush(null)}} aria-label="放弃画笔修订"><X size={15}/></button></div>}
          </>}
        </div>
        <div className="transport">
          <div className="transport-info"><span className="mono">{empty ? '000' : number(current)}</span><span className="muted">/ {String(project?.frames.length || 0).padStart(3,'0')} 帧</span><span className="transport-time mono" title={frame ? `原始素材时间 ${fmt(frame.source_time)}` : ''}>{frame ? fmt(frame.timeline_time) : '0.00s'}</span></div>
          <div className="playback"><button aria-label="第一帧" disabled={empty || !!pending.length} onClick={() => select(action?.start ?? 0)}><SkipBack size={15}/></button>
            <button aria-label="上一帧" disabled={empty || current === 0 || !!pending.length} onClick={() => select(current-1)}><ChevronLeft size={18}/></button>
            <button className="play-button" disabled={empty || busy || !!pending.length || (lightActive&&!lightingPlaybackReady)} aria-label={playing ? '暂停' : '播放动画'} onClick={togglePlayback}>{playing ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button>
            <button aria-label="下一帧" disabled={empty || current === (project?.frames.length || 1)-1 || !!pending.length} onClick={() => select(current+1)}><ChevronRight size={18}/></button>
            <button aria-label="最后一帧" disabled={empty || !!pending.length} onClick={() => select(action?.end ?? project!.frames.length-1)}><SkipForward size={15}/></button></div>
          <div className="transport-end"><span className="mono">{playbackFps} FPS</span><span className="keycap">SPACE</span></div>
        </div>
        <section className="timeline">
          <div className="timeline-heading"><div><Layers3 size={15}/><b>帧时间轴</b><span>{empty ? '0' : selection.length} 帧已选</span></div>
            <div className="timeline-actions"><button disabled={empty || busy || !!pending.length} onClick={() => setSelection(project!.frames.map((_,i) => i))}>全选</button>
              <button disabled={empty || busy || !selection.length || !!pending.length} onClick={toggleFrames}><EyeOff size={14}/>{selection.some(i => !project?.frames[i]?.enabled) ? '启用' : '跳过'}</button>
              <button disabled={empty || busy || !selection.length} onClick={() => {setModal('action');setActionFps(project!.fps)}}><Scissors size={14}/>切为动作</button>
              <button aria-label="切换时间轴大小" title="切换时间轴大小" onClick={() => setFilmstripSize(v => v === 'large' ? 'small' : 'large')}><Grid2X2 size={14}/></button></div></div>
          {!empty && <FrameControls project={project!} current={current} selection={selection} disabled={busy || !!pending.length}
            onReplace={()=>{setPlaying(false);setModal('replace')}}
            onEdit={editFrames} onCheck={()=>{setPlaying(false);setModal('check')}}/>}
          <div className={`filmstrip ${filmstripSize}`}>
            {project?.frames.map((f,i) => <button key={f.id} className={`frame-tile ${selection.includes(i) ? 'selected' : ''} ${current === i ? 'current' : ''} ${!f.enabled ? 'excluded' : ''}`}
              disabled={busy || !!pending.length} draggable={!busy && !pending.length} onDragStart={e=>{select(i);e.dataTransfer.setData('application/x-frame',String(i));e.dataTransfer.effectAllowed='move'}}
              onDragOver={e=>{if(!busy && !pending.length)e.preventDefault()}}
              onDrop={e=>{e.preventDefault();const raw=e.dataTransfer.getData('application/x-frame');if(raw)dropFrame(Number(raw),i)}}
              aria-label={`第 ${i+1} 帧${!f.enabled ? ' 已跳过' : ''}`} aria-pressed={selection.includes(i)} onClick={e => select(i,e.shiftKey,e.metaKey || e.ctrlKey)}>
              <span className="frame-index mono">{number(i)}{f.output_url && <span/>}</span><div className="frame-thumb checker"><img src={f.thumb_url} alt="" loading="lazy"/>{!f.enabled && <EyeOff size={16}/>}</div>
              <span className="frame-duration mono">{Math.round(f.duration*1000)} ms{markers.has(i) && <em className="frame-check-mark">{markers.get(i)}</em>}</span>
            </button>)}
            {empty && <div className="timeline-empty"><Film size={21}/><span>导入后，在这里选择、预览和修订每一帧。</span></div>}
          </div>
          <div className="timeline-footer"><span>Shift 连选 <i/> ⌘ / Ctrl 多选 <i/> ← → 逐帧</span><span>{project?.last_run ? `上次更新 ${project.last_run.processed} 帧 · 缓存命中 ${project.last_run.base_cached}` : '保留原始帧 · 修改可撤销'}</span></div>
        </section>
      </main>
      <aside className="inspector">
        <div className="inspector-heading"><Settings2 size={16}/><span>处理与修订</span><button className="icon-btn" title="撤销上次操作" aria-label="撤销上次操作" disabled={busy || !project?.can_undo || !!pending.length}
          onClick={() => perform(async () => { const p = await api<Project>(`/projects/${project!.id}/undo`,json());await acceptEdit(p) })}><RotateCcw size={16}/></button></div>
        <div className="inspector-scroll">
          {!empty&&<LightingPanel normal={normalDraft} onNormal={n=>{setNormalDraft(n);setPlaying(false)}}
            light={light} onLight={setLight} mode={lightMode} onMode={changeLightMode}
            busy={busy||!!pending.length} count={scope==='all'?project!.frames.length:selection.length}
            ready={lightingPlaybackReady} dirty={JSON.stringify(normalDraft)!==JSON.stringify(normalBaseline)}
            onPreview={inspectNormals} onApply={applyNormals}/>}
          <section className="inspector-section style-section"><div className="section-title"><span className="step-number">01</span><h2>输出风格</h2></div>
            <div className="style-options"><button className={settings.style === 'smooth' ? 'active' : ''} disabled={busy} onClick={() => styleChange({style:'smooth',size:384},true)}><span className="smooth-icon"/><b>非像素</b><small>保留线条与渐变</small>{settings.style === 'smooth' && <Check size={12}/>}</button>
              <button className={settings.style === 'pixel' ? 'active' : ''} disabled={busy} onClick={() => styleChange({style:'pixel',size:128},true)}><Grid2X2 size={20}/><b>像素风</b><small>网格与共用色板</small>{settings.style === 'pixel' && <Check size={12}/>}</button></div>
            <label className="select-row">输出长边<select aria-label="输出长边" value={settings.size} disabled={busy} onChange={e => styleChange({size:+e.target.value},true)}>{[64,96,128,192,256,384,512,768,1024].map(n => <option key={n} value={n}>{n} px</option>)}</select></label>
            <p className="hint">保持原始比例；风格与尺寸应用到全部帧。</p>
            <StyleControls settings={settings} palette={project?.palette||null} disabled={busy||empty||!!pending.length}
              onChange={styleChange}
              onPreset={patch=>{styleChange(patch,patch.palette_mode!==undefined||patch.custom_palette!==undefined);notify('风格预设已填入，预览或应用后生效。')}}/>
          </section>
          <section className="inspector-section"><div className="section-title"><span className="step-number">02</span><h2>背景与透明度</h2><span className="section-tag">ALPHA</span></div>
            <div className="segmented">{([['keep','保留'],['chroma','色键'],['ai','AI 抠图']] as const).map(([v,l]) => <button key={v} disabled={busy} className={settings.background === v ? 'active' : ''} onClick={() => set('background',v)}>{l}</button>)}</div>
            {settings.background === 'keep' ? <p className="hint block-hint">保留素材原有透明度。已有透明 PNG 可直接编辑与导出。</p> : settings.background === 'chroma' ? <>
              <label className="color-control"><span>背景颜色</span><span className="color-field"><input aria-label="色键背景颜色" type="color" value={settings.key_color} onChange={e => set('key_color',e.target.value)}/><span className="mono">{settings.key_color.toUpperCase()}</span></span></label>
              <Slider label="颜色容差" min={0} max={120} value={settings.tolerance} onChange={v => set('tolerance',v)}/>
              <Slider label="边缘过渡" min={1} max={80} value={settings.softness} onChange={v => set('softness',v)}/>
              <Slider label="去除溢色" min={0} max={1} step={.05} value={settings.despill} onChange={v => set('despill',v)}/>
            </> : <div className="model-panel"><div><Sparkles size={15}/><b>U2NetP · 本地 CPU</b></div><p>{aiReady ? '轻量模型已就绪。适合主体明确的素材，复杂发丝可用画笔修正。' : '首次使用需下载约 5 MB 模型，之后可离线处理。'}</p>
              {!aiReady && <button className="btn secondary" disabled={busy} onClick={() => perform(() => begin('/models/install'))}><Download size={14}/>下载抠图模型</button>}</div>}
            {settings.style === 'pixel' && <Slider label="硬边透明阈值" min={1} max={254} value={settings.alpha_cutoff} onChange={v => set('alpha_cutoff',v)}/>}
            <details><summary className="subtle-link">边缘修整</summary>
              <Slider label="遮罩扩缩（源图 px）" min={-8} max={8} value={settings.matte_grow} onChange={v=>set('matte_grow',v)}/>
              <Slider label="边缘羽化（源图 px）" min={0} max={5} step={.25} value={settings.matte_feather} onChange={v=>set('matte_feather',v)}/>
              <Slider label="边缘颜色清理" min={0} max={1} step={.05} value={settings.edge_cleanup} onChange={v=>set('edge_cleanup',v)}/>
              <Slider label="移除小块（源图面积）" min={0} max={400} value={settings.speck_area} onChange={v=>set('speck_area',v)}/>
              <p className="hint">0 关闭；负数收缩、正数扩张。先修整，再执行已有手动画笔。</p>
            </details>
          </section>
          <section className="inspector-section"><div className="section-title"><span className="step-number">03</span><h2>序列一致性</h2></div>
            {settings.style === 'pixel' && <><label className="select-row">{settings.palette_mode==='custom'?'固定色板':'共用色板'}<select aria-label="色板颜色数" value={settings.palette_mode==='custom'?settings.custom_palette.length:settings.colors} disabled={busy||settings.palette_mode==='custom'} onChange={e => styleChange({colors:+e.target.value},true)}>{(settings.palette_mode==='custom'?[settings.custom_palette.length]:[8,12,16,24,32,48,64]).map(n => <option key={n} value={n}>{n} 色</option>)}</select></label>
              {project?.palette && <div className="palette">{project.palette.map((c,i) => <span key={i} style={{background:`rgb(${c.join(',')})`}} title={c.join(', ')}/>)}</div>}
              <button className="subtle-link" disabled={busy || empty||settings.palette_mode==='custom'} onClick={() => {setScope('all');apply(true)}}><RotateCcw size={12}/>重新提取全序列色板</button>
              <p className="hint">{settings.palette_mode==='custom'?`固定 ${settings.custom_palette.length} 色；修改色板需应用到全部帧。`:'提取色板会锁定；调色后需要新的颜色时可重新提取。'}</p></>}
            <Slider label="帧间稳定强度" min={0} max={.6} step={.05} value={settings.stabilize} onChange={v => set('stabilize',v)}/>
            <p className="hint">{settings.style === 'smooth' ? '通过运动对应减少颜色闪烁，保留当前帧轮廓。快速运动建议低强度。' : '在相近颜色之间稳定变化，输出仍约束在同一色板内。'}</p>
          </section>
          <section className="inspector-section"><div className="section-title"><span className="step-number">04</span><h2>位置与比例</h2><button className="icon-btn" aria-label="重置位置与比例" title="重置位置与比例" onClick={() => setSettings(s => ({...s,offset_x:0,offset_y:0,scale:1}))}><RotateCcw size={13}/></button></div>
            <Slider label="水平偏移" min={-.5} max={.5} step={.005} value={settings.offset_x} onChange={v => set('offset_x',v)}/>
            <Slider label="垂直偏移" min={-.5} max={.5} step={.005} value={settings.offset_y} onChange={v => set('offset_y',v)}/>
            <Slider label="主体缩放" min={.25} max={2} step={.01} value={settings.scale} onChange={v => set('scale',v)} suffix="×"/>
            <p className="hint">偏移按画布比例计算。放大超出画布的部分会被裁切。</p>
          </section>
        </div>
        <div className="apply-panel"><label className="select-row"><span>应用范围</span><select aria-label="应用范围" value={scope} disabled={busy || !!pending.length} onChange={e => {const v = e.target.value as 'all' | 'selection';setScope(v);if(project)setSettings(v === 'all' ? project.settings : frame?.settings || project.settings);setPreview(undefined)}}>
          <option value="all">全部 {project?.frames.length || 0} 帧</option><option value="selection">选中 {selection.length} 帧</option></select></label>
          <div className="apply-buttons"><button className="btn secondary" disabled={empty || busy || !!pending.length || (scope === 'selection' && (!selection.length || !selection.includes(current)))} onClick={() => perform(async () => {const r = await api<Preview>(`/projects/${project!.id}/preview`,json({index:current,settings_patch:settingsPatch(),indices:scope === 'all' ? null : selection,expected_revision:project!.revision}));setLightMode('off');setPreview(r);setView('result');setBrush(null)})}><EyeOff size={14} className="preview-eye"/>预览当前帧</button>
            <button className="btn primary" disabled={empty || busy || !!pending.length || (scope === 'selection' && !selection.length)} onClick={() => apply()}><WandSparkles size={15}/>应用</button></div>
          <div className="apply-note">{changed ? <><span className="unsaved-dot"/>有参数待应用</> : <><CheckCircle2 size={12}/>原始素材始终保留</>}</div>
        </div>
      </aside>
    </div>
    <footer className="statusbar"><span><span className="live-dot"/>{jobId ? job?.message || '准备任务…' : loading ? '正在处理…' : '工作空间已就绪'}</span><span>FRAME STUDIO <i/> 本地创作 · 自由修订</span></footer>
    {jobId && <div className="job-card" role="status"><LoaderCircle className="spin" size={20}/><div><strong>{job?.message || '准备任务…'}</strong><div className="progress-track"><span style={{width:`${Math.max(3,(job?.progress || 0)*100)}%`}}/></div></div><span className="mono">{Math.round((job?.progress || 0)*100)}%</span>
      {job?.kind !== 'model' && <button aria-label="取消任务" onClick={() => api(`/jobs/${jobId}/cancel`,json()).catch(e => notify(e.message,true))}><X size={16}/></button>}</div>}
    {loading && !jobId && <div className="loading-pill" role="status"><LoaderCircle size={16} className="spin"/>正在处理，请稍候…</div>}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={17}/> : <CheckCircle2 size={17}/>}<span>{toast.text}</span><button onClick={() => setToast(null)} aria-label="关闭通知"><X size={15}/></button></div>}
    {download && !jobId && <div className="download-card"><span className="export-icon"><Check size={20}/></span><div><b>动画资源已打包</b><small>PNG · 图集 · Godot 4 工程</small></div><a className="btn primary" href={download} download><Download size={15}/>下载 ZIP</a><button className="icon-btn" onClick={() => setDownload(undefined)} aria-label="关闭导出结果"><X size={15}/></button></div>}
    {modal==='replace'&&project&&frame&&<ReplaceFrame project={project} current={current} busy={busy}
      onClose={()=>setModal(null)} onReplace={replaceFrame} onReset={resetReplacement}/>}
    {modal === 'assets' && project && <AssetPanel project={project} current={current} selection={selection} busy={busy} onClose={()=>setModal(null)}
      onApply={body=>perform(async()=>{await begin(`/projects/${project.id}/process`,body);setModal(null);setPreview(undefined);setBrush(null)})}/>}
    {modal === 'export' && project && <ExportDialog project={project} busy={busy} onClose={()=>setModal(null)}
      onExport={body=>perform(async()=>{await begin(`/projects/${project.id}/export`,body);setModal(null)})}/>}
    {modal === 'check' && project && <AnimationCheck project={project} busy={busy} actionId={activeAction} report={activeReport}
      onClose={()=>setModal(null)} onLocate={index=>{setModal(null);select(index)}}
      onRun={options=>perform(()=>begin(`/projects/${project.id}/analyze`,{expected_revision:project.revision,...options}))}
      onApply={(operation,candidateIds,name)=>perform(async()=>{
        if(!activeReport)return
        const p=await api<Project>(`/projects/${project.id}/analysis/apply`,json({expected_revision:project.revision,report_id:activeReport.id,operation,candidate_ids:candidateIds,name}))
        await acceptEdit(p);setModal(null);notify(operation==='compress' ? '连续相似帧已合并，原时长保留；可撤销恢复。' : operation==='skip' ? '所选可疑帧已跳过，可撤销恢复。' : '循环候选已设为动作，其余帧保留。')
      })}/>}
    {(modal === 'import' || modal === 'action' || modal === 'help') && <div className="modal-scrim" onClick={e => {if(e.target === e.currentTarget && !loading)setModal(null)}}><section className={`modal ${modal === 'help' ? 'help-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-heading"><span className="eyebrow">{modal === 'import' ? 'START A SEQUENCE' : modal === 'action' ? 'DEFINE AN ACTION' : 'YOUR LOCAL WORKSPACE'}</span><button className="icon-btn" aria-label="关闭窗口" onClick={() => setModal(null)} disabled={loading}><X size={20}/></button></div>
      <h2 id="modal-title">{modal === 'import' ? '导入，让创作开始。' : modal === 'action' ? '把选中帧设为一个动作' : '每一帧，都可以重新来过。'}</h2>
      {modal === 'import' ? <>
        <p className="modal-intro">导入已生成的视频，或已有的透明序列帧。所有文件会复制到本地项目。</p>
        <input ref={fileInput} type="file" multiple accept="video/*,.png,.jpg,.jpeg,.webp" className="sr-only" aria-label="选择视频或序列帧" onChange={e => acceptFiles(Array.from(e.target.files || []))}/>
        <button className={`dropzone ${files.length ? 'has-files' : ''}`} onClick={() => fileInput.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => {e.preventDefault();acceptFiles(Array.from(e.dataTransfer.files))}}>
          <span><ImagePlus size={28}/></span><strong>{files.length ? files.length === 1 ? files[0].name : `已选择 ${files.length} 张图片` : '拖入素材，或点击选择文件'}</strong><small>{files.length ? `${(files.reduce((s,f)=>s+f.size,0)/1024/1024).toFixed(1)} MB · 点击重新选择` : '一个 MP4 / MOV / WebM，或一组 PNG · 最多 512 MB'}</small></button>
        <label className="form-field">序列名称<input aria-label="序列名称" placeholder="例如：森林旅人 · 行走" value={name} onChange={e => setName(e.target.value)}/></label>
        <div className="form-grid"><label className="form-field">输出风格<select aria-label="导入输出风格" value={importStyle} onChange={e=>setImportStyle(e.target.value as 'smooth'|'pixel')}><option value="smooth">非像素 · 保留渐变</option><option value="pixel">像素风 · 共用色板</option></select></label><label className="form-field">抽帧率 / 图片播放帧率<input aria-label="导入帧率" type="number" min={1} max={60} value={importFps} onChange={e=>setImportFps(+e.target.value)}/></label></div>
        <div className="form-grid"><label className="form-field">开始时间（秒）<input aria-label="开始时间" type="number" min={0} step={.1} value={start} onChange={e=>setStart(+e.target.value)}/></label><label className="form-field">结束时间（0 = 结尾）<input aria-label="结束时间" type="number" min={0} step={.1} value={end} onChange={e=>setEnd(+e.target.value)}/></label></div>
        <p className="hint">首版每个序列最多 480 帧。图片按文件名自然排序；视频按实际时间戳抽帧。起止时间只影响视频。</p>
        <div className="modal-footer"><button className="btn text" disabled={busy} onClick={() => {setModal(null);perform(() => begin('/demo'))}}>先试用练习素材</button><button className="btn primary" disabled={busy || !files.length || !name.trim()} onClick={importFiles}>{loading ? <LoaderCircle className="spin" size={16}/> : <Upload size={16}/>}开始导入</button></div>
      </> : modal === 'action' ? <>
        <p className="modal-intro">将第 {number(Math.min(...selection))}–{number(Math.max(...selection))} 帧（含区间内所有帧）划为新动作；原有动作会按边界拆分。</p>
        <label className="form-field">动作名称<input aria-label="动作名称" value={actionName} onChange={e=>setActionName(e.target.value)} placeholder="walk / idle / attack"/></label>
        <label className="form-field">播放帧率<input aria-label="动作播放帧率" type="number" min={1} max={60} value={actionFps} onChange={e=>setActionFps(+e.target.value)}/></label>
        <label className="check-field"><input type="checkbox" checked={actionLoop} onChange={e=>setActionLoop(e.target.checked)}/>循环播放</label>
        <div className="modal-footer"><span className="hint">禁用帧会被跳过，动作时长会缩短。</span><button className="btn primary" disabled={busy || !actionName.trim()} onClick={() => perform(async () => {
          const p = await api<Project>(`/projects/${project!.id}/actions`,json({name:actionName,start:Math.min(...selection),end:Math.max(...selection),fps:actionFps,loop:actionLoop}))
          setProject(p);setModal(null);setActiveAction(p.actions.find(a=>a.name===actionName)?.id || null);notify('动作已保存，受影响的稳定帧已更新。')
        })}><Scissors size={15}/>保存动作</button></div>
      </> : <>
        <p className="modal-intro">帧序将已有视频整理成游戏引擎可使用的动画资产。当前版本专注本地后处理，视频生成服务尚未接入。</p>
        <ol className="help-steps"><li><Upload/><div><b>导入已有视频或序列帧</b><p>素材复制入项目，原文件保持不变。内置水母是程序绘制的练习动画。</p></div></li>
          <li><Settings2/><div><b>先预览，再应用</b><p>选风格、抠背景、统一色板。仅改当前帧时选择「选中帧」；风格和输出尺寸属于整段设置。</p></div></li>
          <li><Paintbrush/><div><b>画笔修订与局部更新</b><p>擦除背景或恢复原图，保存后仅更新当前帧和依赖它的邻帧。最近 12 次编辑可撤销。</p></div></li>
          <li><Download/><div><b>导出到 Godot</b><p>ZIP 包含 RGBA PNG、图集、动作元数据和可直接打开的 Godot 4 工程。两种风格均支持。</p></div></li></ol>
        <div className="help-note"><FolderOpen size={18}/><p>项目存放在工具目录的 <code>data/projects</code>。关闭浏览器后仍会保留；后端服务运行时，可重新打开编辑器继续。</p></div>
        <div className="modal-footer"><span className="hint">本地 CPU 推理 · 不上传素材 · 无需云端密钥</span><button className="btn primary" onClick={()=>setModal(null)}>开始创作 <ArrowRight size={16}/></button></div>
      </>}
    </section></div>}
  </div>
}
