// Run with an isolated FRAME_STUDIO_DATA server and propagation_fixtures.py output.
import { chromium } from '/Users/bytedance/Documents/graduation/asset-search/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = process.argv[2]
const base = 'http://127.0.0.1:8971'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1512, height: 982 }, acceptDownloads: true })
page.setDefaultTimeout(20000)
const button = name => page.getByRole('button', { name, exact: true })
const errors = []
page.on('pageerror', e => errors.push(e.message))
let pid
const read = async () => (await fetch(`${base}/api/projects/${pid}`)).json()
async function idle() {
  await page.waitForFunction(() => !document.querySelector('.job-card,.loading-pill'))
  assert.equal(await page.getByRole('alert').count(), 0, (await page.getByRole('alert').allTextContents()).join('\n'))
}
async function layout(label) {
  const state = await page.evaluate(() => ({
    viewport: innerWidth, width: document.documentElement.scrollWidth,
    modal: [...document.querySelectorAll('.modal')].map(el => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, height: r.height, top: r.top, bottom: r.bottom, overflow: el.scrollWidth - el.clientWidth }
    }),
    canvas: document.querySelector('.canvas-area')?.getBoundingClientRect().height,
    height: innerHeight,
  }))
  assert.ok(state.width <= state.viewport, `${label}: page overflow ${JSON.stringify(state)}`)
  for (const r of state.modal) {
    assert.ok(r.left >= 0 && r.right <= state.viewport && r.top >= 0 && r.bottom <= state.height + 1, `${label}: dialog bounds`)
    assert.ok(r.overflow <= 1, `${label}: dialog content overflow ${r.overflow}`)
  }
  assert.ok(state.canvas >= 190, `${label}: canvas too short`)
}
async function chooseTheme(label, theme) {
  await button('界面外观').click()
  await button(label).click()
  await page.waitForFunction(t => document.documentElement.dataset.theme === t, theme)
  await button('完成').click()
  await page.waitForFunction(() => {
    const sample = document.querySelector('.btn.secondary')
    // Wait for the short native-style surface transition before inspecting pixels.
    return sample && getComputedStyle(sample).backgroundColor === (document.documentElement.dataset.theme === 'dark' ? 'rgb(36, 36, 38)' : 'rgb(255, 255, 255)')
  })
}
async function dialog(open, close, label) {
  await button(open).click()
  await page.getByRole('dialog').waitFor()
  await layout(label)
  await button(close).click()
}
const canvas = async () => page.locator('.stage-surface canvas').evaluate(el => el.toDataURL())

try {
  await page.goto(base, { waitUntil: 'networkidle' })
  assert.equal(await page.title(), '动画编辑器')
  assert.equal(await page.locator('.brand,.brand-mark,.welcome-art,.lucide-aperture').count(), 0)
  assert.equal(await page.locator('body').getByText(/帧序|FRAME STUDIO/).count(), 0)
  assert.equal(await page.locator('h1').textContent(), '导入动画素材')
  await layout('empty')
  await page.screenshot({ path: `${root}/exports/interface-empty.png` })
  await dialog('使用说明', '关闭窗口', 'help')
  await dialog('导入素材', '关闭窗口', 'import')
  await chooseTheme('深色', 'dark')
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  await page.emulateMedia({ colorScheme: 'dark' })
  await chooseTheme('跟随系统', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
  await chooseTheme('浅色', 'light')
  await button('导入素材').click()
  const files = (await fs.readdir(`${root}/fixtures`)).filter(f => f.endsWith('.png')).sort()
  await page.getByLabel('选择视频或序列帧', { exact: true }).setInputFiles(files.map(f => `${root}/fixtures/${f}`))
  await page.getByLabel('序列名称', { exact: true }).fill('角色动作 · 行走')
  const imported = page.waitForResponse(r => r.url().endsWith('/import'))
  await button('开始导入').click()
  pid = (await (await imported).json()).project_id
  await page.locator('.frame-tile').nth(6).waitFor()
  await idle()
  await page.getByLabel('输出长边', { exact: true }).selectOption('128')
  await button('应用').click()
  await idle()
  await page.waitForLoadState('networkidle')
  const baseline = await read()
  const light = await canvas()
  await page.screenshot({ path: `${root}/exports/interface-light.png` })
  await chooseTheme('深色', 'dark')
  await page.waitForFunction(data => document.querySelector('.stage-surface canvas').toDataURL() !== data, light)
  const dark = await canvas()
  assert.notEqual(light, dark, 'Canvas must repaint its checker and guides')
  assert.deepEqual(await read(), baseline, 'Changing theme must not modify animation data')
  await page.screenshot({ path: `${root}/exports/interface-dark.png` })
  await chooseTheme('浅色', 'light')
  await button('第 3 帧').click()
  await page.getByLabel('启用洋葱皮', { exact: true }).check()
  await page.locator('.onion-legend').waitFor()
  const beforeFrame = await page.locator('.frame-tile.current').getAttribute('aria-label')
  await button('播放动画').click()
  await page.waitForFunction(v => document.querySelector('.frame-tile.current')?.getAttribute('aria-label') !== v, beforeFrame)
  await button('暂停').click()
  await button('第 3 帧').click()
  await page.getByRole('group', { name: '预览模式' }).getByRole('button', { name: '对照', exact: true }).click()
  await page.getByLabel('原图对照分界', { exact: true }).focus()
  await page.getByLabel('原图对照分界', { exact: true }).press('ArrowRight')
  await page.getByRole('group', { name: '预览模式' }).getByRole('button', { name: '处理后', exact: true }).click()
  await button('擦除背景画笔').click()
  const rect = await page.locator('.stage-surface canvas').boundingBox()
  const scale = Math.min((rect.width - 72) / 128, (rect.height - 72) / 128)
  await page.mouse.click(rect.x + rect.width / 2 - 6 * scale, rect.y + rect.height / 2 - 14 * scale)
  await button('保存修订').click()
  await idle()
  assert.equal((await read()).frames[2].strokes.length, 1)
  await button('撤销上次操作').click()
  await idle()
  assert.equal((await read()).frames[2].strokes.length, 0)
  for (const theme of ['浅色', '深色']) {
    await chooseTheme(theme, theme === '浅色' ? 'light' : 'dark')
    for (const viewport of [{ width: 1512, height: 982 }, { width: 1110, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await layout(`${theme} ${viewport.width}`)
      await dialog('资产整理', '关闭资产整理', 'assets')
      await dialog('替换当前帧', '关闭单帧替换', 'replace')
      await dialog('跨帧遮罩', '关闭跨帧遮罩', 'propagation')
      await dialog('动画检查', '关闭动画检查', 'check')
      await dialog('切为动作', '关闭窗口', 'action')
      await button('导出动画').click()
      await page.getByRole('img', { name: '图集帧矩形布局' }).waitFor()
      await layout('export')
      await button('关闭导出设置').click()
    }
  }
  await page.setViewportSize({ width: 1512, height: 982 })
  await chooseTheme('浅色', 'light')
  await button('导出动画').click()
  await page.getByRole('img', { name: '图集帧矩形布局' }).waitFor()
  await button('导出 ZIP').click()
  await page.getByRole('link', { name: '下载 ZIP' }).waitFor()
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载 ZIP' }).click()
  await (await download).saveAs(`${root}/exports/interface-export.zip`)
  assert.deepEqual(errors, [])
  console.log('PASS: branding removed, empty state, all themes and system/persistence, canvas repaint without data edits, playback, onion, compare, brush/save/undo, 6 dialogs in both themes at 1512/1110/390px, ZIP download; no JS errors')
  if (process.argv.includes('--screenshots')) {
    const docs = path.resolve('docs')
    for (const file of ['interface-empty.png', 'interface-light.png', 'interface-dark.png'])
      await fs.copyFile(`${root}/exports/${file}`, `${docs}/${file}`)
  }
} finally { await browser.close() }
