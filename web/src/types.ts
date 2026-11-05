export type Settings = {
  style: 'smooth' | 'pixel'
  background: 'keep' | 'chroma' | 'ai'
  key_color: string
  tolerance: number
  softness: number
  despill: number
  size: number
  colors: number
  alpha_cutoff: number
  stabilize: number
  offset_x: number
  offset_y: number
  scale: number
  align_mode: 'none' | 'center' | 'bottom'
  bounds_threshold: number
  matte_grow: number
  matte_feather: number
  edge_cleanup: number
  speck_area: number
  pixel_sampling: 'nearest' | 'area' | 'majority'
  pixel_cell: number
  palette_mode: 'auto' | 'custom'
  custom_palette: string[]
  palette_distance: 'rgb' | 'lab'
  dither_strength: number
  saturation: number
  contrast: number
  brightness: number
  smooth_strength: number
  smooth_levels: number
  outline_width: number
  outline_color: string
}
export type AssetEdits = Pick<Settings, 'align_mode' | 'bounds_threshold' | 'matte_grow' | 'matte_feather' | 'edge_cleanup' | 'speck_area'>
export type AssetOptions = { canvas_width: number; canvas_height: number; pivot_x: number; pivot_y: number }
export type Geometry = { canvas: [number, number]; source: [number, number]; scaled: [number, number]; scale: [number, number]; offset: [number, number]; pivot: [number, number]; bounds: number[] | null; clipped_pixels: number; warnings: string[] }
export type Preview = { url: string; geometry: Geometry }
export type ExportOptions = { columns: number; padding: number; extrude: number; page_size: number; prefix: string; action_ids: string[] | null }
export type ExportLayout = { canvas: [number, number]; pivot: [number, number]; columns: number; frames: number; pages: { file: string; size: [number, number]; cells: { index: number; rect: number[] }[] }[]; actions: (Action & { frames: number[] })[] }
export type Stroke = { mode: 'erase' | 'restore'; points: [number, number][]; radius: number }
export type Frame = {
  id: string; original_url: string; output_url?: string; thumb_url: string
  width: number; height: number; time: number; duration: number; enabled: boolean
  source_time: number; timeline_time: number
  settings: Settings | null; strokes: Stroke[]; label: string
  geometry?: Geometry
}
export type Action = { id: string; name: string; start: number; end: number; fps: number; loop: boolean }
export type Project = {
  id: string; name: string; fps: number; style: 'smooth' | 'pixel'; frames: Frame[]
  settings: Settings; width: number; height: number; actions: Action[]; palette: number[][] | null
  asset_options: AssetOptions; export_options: ExportOptions
  can_undo: boolean; revision: number; demo?: boolean; import_status: string; import_error?: string
  last_run?: { processed: number; base_cached: number; base_computed: number }
  job_id?: string
  edit_result?: { selected_ids: string[]; updated_frames: number }
}
export type ProjectSummary = Pick<Project, 'id' | 'name' | 'style' | 'import_status'> & { frame_count: number; job_id?: string }
export type Duplicate = { id: string; kind: 'consecutive' | 'return'; action_id: string; action_name: string; indices: number[]; keep: number; score: number; duration: number }
export type Suspect = { id: string; frame_id: string; index: number; previous: number; next: number; action_name: string; left: number; right: number; outer: number; threshold: number; reason: string }
export type LoopCandidate = { id: string; action_id: string; action_name: string; indices: number[]; start: number; end: number; repeat_start: number; period: number; mean_error: number; support: number; duration: number; fps: number }
export type AnalysisReport = {
  id: string; project_id: string; revision: number; source: 'original' | 'result'
  duplicates: Duplicate[]; suspects: Suspect[]; loops: LoopCandidate[]
  transitions: { previous: number; next: number; diff: number; rate: number; kind: string; action_name: string }[]
  stats: { action_id: string; name: string; frames: number; median: number; threshold: number; timing_normalized: boolean }[]
  warnings: string[]
  params: AnalysisOptions
}
export type AnalysisOptions = {
  source: 'original' | 'result'; scope: 'all' | 'action'; action_id?: string
  duplicate_threshold: number; window: number; jump_k: number; min_period: number; max_period: number; loop_max_error: number
}
export type EditOperation = 'order' | 'duplicate' | 'reverse' | 'delete' | 'duration'
export type Job = { id: string; project_id: string; kind: string; state: string; progress: number; message: string; result?: { url?: string; frames?: number; processed?: number; base_cached?: number; analysis?: AnalysisReport } }
export const defaults: Settings = {
  style: 'smooth', background: 'keep', key_color: '#36b859', tolerance: 35, softness: 20, despill: .5,
  size: 384, colors: 24, alpha_cutoff: 128, stabilize: 0, offset_x: 0, offset_y: 0, scale: 1,
  align_mode: 'none', bounds_threshold: 16, matte_grow: 0, matte_feather: 0, edge_cleanup: 0, speck_area: 0,
  pixel_sampling:'nearest',pixel_cell:1,palette_mode:'auto',custom_palette:[],palette_distance:'rgb',dither_strength:0,
  saturation:1,contrast:1,brightness:0,smooth_strength:0,smooth_levels:0,outline_width:0,outline_color:'#202638',
}
