// Isolated UI integration: node tests/verify_styles.mjs <fixtures folder> <ZIP output folder>.
import { chromium } from '/Users/bytedance/Documents/graduation/asset-search/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const [inputDir,outputDir]=process.argv.slice(2)
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1512,height:982},acceptDownloads:true})
page.setDefaultTimeout(25000)
const base='http://127.0.0.1:8971'
const button=name=>page.getByRole('button',{name,exact:true})
const errors=[]
page.on('pageerror',e=>errors.push(e.message))
let pid
const read=async()=> (await fetch(`${base}/api/projects/${pid}`)).json()
async function idle(){
  await page.waitForFunction(()=>!document.querySelector('.job-card,.loading-pill'))
  assert.equal(await page.getByRole('alert').count(),0,await page.getByRole('alert').allTextContents())
}
async function apply(){
  const r=page.waitForResponse(r=>r.url().endsWith('/process')&&r.request().method()==='POST')
  await button('应用').click();assert.equal((await r).status(),200);await idle()
}
async function preview(){
  const r=page.waitForResponse(r=>r.url().endsWith('/preview')&&r.request().method()==='POST')
  await button('预览当前帧').click()
  const response=await r;assert.equal(response.status(),200,await response.text());await idle()
  return response.json()
}
async function exportZip(name){
  await button('导出动画').click()
  await page.getByRole('img',{name:'图集帧矩形布局'}).waitFor()
  await button('导出 ZIP').click()
  await page.getByRole('link',{name:'下载 ZIP'}).waitFor()
  const download=page.waitForEvent('download')
  await page.getByRole('link',{name:'下载 ZIP'}).click()
  await (await download).saveAs(`${outputDir}/${name}.zip`)
  await button('关闭导出结果').click()
}
try{
  await page.goto(base,{waitUntil:'networkidle'})
  await button('导入素材').click()
  const inputs=(await fs.readdir(inputDir)).filter(f=>f.endsWith('.png')).sort()
  await page.getByLabel('选择视频或序列帧',{exact:true}).setInputFiles(inputs.map(f=>`${inputDir}/${f}`))
  await page.getByLabel('序列名称',{exact:true}).fill('风格处理隔离验证')
  const imported=page.waitForResponse(r=>r.url().endsWith('/import'))
  await button('开始导入').click();pid=(await (await imported).json()).project_id
  await page.locator('.frame-tile').nth(3).waitFor();await idle()
  await page.getByLabel('输出长边',{exact:true}).selectOption('64');await apply()
  await button('第 2 帧').click()
  await page.getByLabel('应用范围',{exact:true}).selectOption('selection')
  await page.getByLabel('水平偏移',{exact:true}).focus()
  await page.getByLabel('水平偏移',{exact:true}).press('ArrowRight')
  await apply()
  assert.equal((await read()).frames[1].settings.offset_x,.005)
  await page.getByLabel('应用范围',{exact:true}).selectOption('all')
  await page.getByLabel('风格预设',{exact:true}).selectOption('卡通块面')
  let p=await read();const revision=p.revision
  let result=await preview()
  assert.equal((await read()).revision,revision)
  await apply()
  p=await read()
  assert.equal(p.frames[1].output_url,result.url)
  assert.equal(p.frames[1].settings.offset_x,.005)
  assert.equal(p.frames[0].settings.offset_x,0)
  assert.equal(p.settings.smooth_levels,6)
  assert.equal(p.settings.outline_width,2)
  await exportZip('smooth')
  console.log('PASS smooth preset, read-only preview/apply, local position preserved, ZIP')

  await button('像素风 网格与共用色板').click()
  await page.getByLabel('输出长边',{exact:true}).selectOption('64')
  await page.getByLabel('风格预设',{exact:true}).selectOption('复古抖色')
  result=await preview();await apply()
  p=await read()
  assert.equal(p.frames[1].output_url,result.url)
  assert.equal(p.settings.pixel_sampling,'area')
  assert.equal(p.settings.pixel_cell,2)
  assert.equal(p.settings.custom_palette.length,16)
  assert.equal(p.frames[1].settings.offset_x,.005)
  console.log('PASS pixel retro preset, logical grid, palette, preview/apply')

  await page.getByText('固定 / 导入色板',{exact:true}).click()
  const currentRevision=p.revision
  await page.getByLabel('色板文件',{exact:true}).setInputFiles({name:'test.gpl',mimeType:'text/plain',
    buffer:Buffer.from('GIMP Palette\nName: Smoke\nColumns: 3\n# Note\n22 27 43 Dark\n255 244 219 Light\n98 150 116 Green\n')})
  assert.equal((await read()).revision,currentRevision)
  await apply()
  assert.equal((await read()).palette.length,3)
  await page.getByLabel('自定义色板内容',{exact:true}).fill('invalid')
  await button('使用输入色板').click()
  assert.equal(await page.getByRole('alert').count(),1)
  assert.equal((await read()).palette.length,3)
  await page.getByLabel('自定义色板内容',{exact:true}).fill('["#161b2b","#fff4db"]')
  await button('使用输入色板').click()
  assert.equal(await page.getByRole('alert').count(),0)
  await page.getByLabel('颜色匹配',{exact:true}).selectOption('lab')
  result=await preview();await apply()
  p=await read();assert.equal(p.frames[1].output_url,result.url)
  assert.equal(p.settings.custom_palette.length,2)
  const outputs=p.frames.map(f=>f.output)
  await button('第 3 帧').click()
  await page.getByLabel('应用范围',{exact:true}).selectOption('selection')
  await page.getByLabel('有序抖色强度',{exact:true}).focus()
  await page.getByLabel('有序抖色强度',{exact:true}).press('ArrowLeft')
  await apply()
  p=await read()
  assert.equal(p.last_run.base_computed,0)
  assert.equal(p.frames[2].settings.dither_strength,.65)
  assert.equal(p.frames[0].output,outputs[0])
  assert.equal(p.frames[3].output,outputs[3])
  await button('撤销上次操作').click();await idle()
  assert.equal((await read()).frames[2].settings.dither_strength,.7)
  console.log('PASS GPL/JSON import, invalid palette rejected, Lab, local dither cache/undo')

  await button('播放动画').click()
  const initial=await page.locator('.transport-info>.mono').first().textContent()
  await page.waitForFunction(initial=>document.querySelector('.transport-info>.mono').textContent!==initial,initial)
  await button('暂停').click()
  await exportZip('pixel')
  await page.reload({waitUntil:'networkidle'});await page.locator('.frame-tile').nth(3).waitFor()
  assert.equal((await read()).settings.palette_mode,'custom')
  await page.setViewportSize({width:1100,height:800})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.deepEqual(errors,[])
  console.log('PASS animation playback, ZIP download, persistence and no browser errors')
  console.log(JSON.stringify({pid,outputDir,errors}))
}finally{await browser.close()}
