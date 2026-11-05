import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowLeftRight, Copy, Timer, Trash2, ScanSearch } from 'lucide-react'
import type { EditOperation, Project } from './types'

type Props = {
  project: Project; current: number; selection: number[]; disabled: boolean
  onEdit: (operation: EditOperation, body?: { order?: number[]; duration?: number }) => void
  onCheck: () => void
}
export default function FrameControls({ project, current, selection, disabled, onEdit, onCheck }: Props) {
  const [timing, setTiming] = useState(false)
  const [milliseconds, setMilliseconds] = useState(83)
  useEffect(() => { setTiming(false) }, [project.revision])
  function move(direction: number) {
    const order = project.frames.map((_, i) => i)
    const chosen = new Set(selection)
    const positions = direction < 0 ? [...order] : [...order].reverse()
    for (const i of positions) {
      const j = i + direction
      if (j >= 0 && j < order.length && chosen.has(order[i]) && !chosen.has(order[j]))
        [order[i], order[j]] = [order[j], order[i]]
    }
    onEdit('order', { order })
  }
  return <>
    <div className="frame-edit-controls" aria-label="动画编辑工具">
      <button disabled={disabled || !selection.length || Math.min(...selection) === 0} onClick={() => move(-1)}><ArrowLeft size={13}/>前移</button>
      <button disabled={disabled || !selection.length || Math.max(...selection) === project.frames.length-1} onClick={() => move(1)}><ArrowRight size={13}/>后移</button>
      <button disabled={disabled || selection.length < 2} onClick={() => onEdit('reverse')}><ArrowLeftRight size={13}/>倒序</button>
      <button disabled={disabled || !selection.length || project.frames.length+selection.length > 480} onClick={() => onEdit('duplicate')}><Copy size={13}/>复制帧</button>
      <button disabled={disabled || !selection.length || selection.length === project.frames.length} onClick={() => onEdit('delete')} title="删除所选帧，可撤销；原始文件保留"><Trash2 size={13}/>删除帧</button>
      <button disabled={disabled || !selection.length} onClick={() => {setMilliseconds(Math.round(project.frames[current].duration*1000));setTiming(v => !v)}}><Timer size={13}/>帧时长</button>
      <span className="edit-drag-note">同一动作内拖动排序</span>
      <button className="check-open" disabled={disabled} onClick={onCheck}><ScanSearch size={14}/>动画检查</button>
    </div>
    {timing && <div className="frame-timing-controls">
      <label>基础时长 <input aria-label="选中帧基础时长" type="number" min={1} max={60000} step={1}
        value={milliseconds} onChange={e => setMilliseconds(+e.target.value)}/> ms</label>
      <button className="btn secondary" disabled={disabled || !Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 60000}
        onClick={() => onEdit('duration', { duration: milliseconds/1000 })}>设置所选 {selection.length} 帧时长</button>
      <span>动作 FPS 会调整实际播放速度</span>
    </div>}
  </>
}
