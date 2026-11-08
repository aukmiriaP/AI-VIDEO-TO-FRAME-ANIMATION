import { useEffect, useState } from 'react'
import { Check, Monitor, Moon, Sun, X } from 'lucide-react'

type Mode = 'light' | 'dark' | 'system'
const key = 'frame-studio-appearance'
const choices = [
  { mode: 'light', label: '浅色', Icon: Sun },
  { mode: 'dark', label: '深色', Icon: Moon },
  { mode: 'system', label: '跟随系统', Icon: Monitor },
] as const

export function useAppearance() {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved === 'dark' || saved === 'system' ? saved : 'light'
    } catch { return 'light' }
  })
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1b1b1d' : '#fafaf9')
      window.dispatchEvent(new Event('appearancechange'))
    }
    try { localStorage.setItem(key, mode) } catch { /* Preferences are optional. */ }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [mode])
  return { mode, setMode }
}

export function AppearanceDialog({ mode, onChange, onClose }:
  { mode: Mode; onChange: (mode: Mode) => void; onClose: () => void }) {
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return <div className="modal-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <section className="modal appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
      <div className="modal-heading"><h2 id="appearance-title">界面外观</h2>
        <button autoFocus className="icon-btn" aria-label="关闭外观设置" onClick={onClose}><X size={18}/></button></div>
      <p className="modal-intro">选择适合当前环境的显示方式。</p>
      <div className="appearance-options" role="group" aria-label="界面主题">
        {choices.map(({ mode: value, label, Icon }) => <button key={value} aria-pressed={mode === value}
          className={mode === value ? 'active' : ''} onClick={() => onChange(value)}>
          <span className={`appearance-sample ${value}`}><i/><i/><i/></span>
          <span><Icon size={15}/>{label}{mode === value && <Check size={14}/>}</span>
        </button>)}
      </div>
      <div className="modal-footer"><span className="hint">偏好会保存在此浏览器。</span><button className="btn primary" onClick={onClose}>完成</button></div>
    </section>
  </div>
}
