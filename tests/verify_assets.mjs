// UI validation against an isolated FRAME_STUDIO_DATA server at port 8971.
// Usage: node tests/verify_assets.mjs <PNG input directory> <output ZIP>
import { chromium } from '/Users/bytedance/Documents/graduation/asset-search/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const [inputDir, archive]=process.argv.slice(2)
assert(inputDir && archive,'Provide input directory and output ZIP')
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1512,height:982},acceptDownloads:true})
page.setDefaultTimeout(30000)
const base='http://127.0.0.1:8971'
const button=name=>page.getByRole('button',{name,exact:true})
const errors=[]
page.on('pageerror',e=>errors.push(e.message))
let pid
const read=async()=> (await fetch(`${base}/api/projects/${pid}`)).json()
async function idle(){await page.waitForFunction(()=>!document.querySelector('.job-card,.loading-pill'));assert.equal(await page.getByRole('alert').count(),0,await page.getByRole('alert').allTextContents())}
async function action(name,endpoint='/process'){
  const response=page.waitForResponse(r=>r.url().endsWith(endpoint)&&r.request().method()==='POST').catch(e=>e)
  try {
    await button(name).click()
    const r=await response;if(r instanceof Error)throw r
    assert.equal(r.status(),200,await r.text());await idle()
  } catch(e) {
    console.log('FAILED_UI_STEP',name,JSON.stringify({errors,enabled:await button(name).isEnabled(),
      alerts:await page.locator('.inline-error').allTextContents(),
      rect:await button(name).boundingBox(),
      dialogs:await page.getByRole('dialog').evaluateAll(els=>els.map(el=>el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')))}))
    throw e
  }
}
try {
  if(process.argv.includes('--resume')){
    const projects=await (await fetch(base+'/api/projects')).json()
    pid=projects.find(p=>p.name==='资产整理隔离验证').id
    await page.addInitScript(pid=>localStorage.setItem('frame-studio-project',pid),pid)
    await page.goto(base,{waitUntil:'networkidle'})
    await page.locator('.frame-tile').nth(3).waitFor();await idle()
  } else {
  await page.goto(base,{waitUntil:'networkidle'})
  await button('导入素材').click()
  const inputs=(await fs.readdir(inputDir)).filter(f=>f.endsWith('.png')).sort()
  await page.getByLabel('选择视频或序列帧',{exact:true}).setInputFiles(inputs.map(f=>`${inputDir}/${f}`))
  await page.getByLabel('序列名称',{exact:true}).fill('资产整理隔离验证')
  const imported=page.waitForResponse(r=>r.url().endsWith('/import'))
  await button('开始导入').click()
  pid=(await (await imported).json()).project_id
  await page.locator('.frame-tile').nth(3).waitFor();await idle()
  await page.getByLabel('输出长边',{exact:true}).selectOption('64')
  await action('应用')
  }
  let p=await read()
  if(!process.argv.includes('--after-alignment')){
  await button('资产整理').click()
  assert.equal(await page.getByRole('dialog').count(),1)
  await page.getByLabel('画布宽度（0 自动）',{exact:true}).fill('96')
  await page.getByLabel('画布高度（0 自动）',{exact:true}).fill('80')
  await page.getByLabel('锚点 Y',{exact:true}).fill('0.9')
  await page.getByLabel('主体对齐',{exact:true}).selectOption('bottom')
  await action('预览整理效果','/preview')
  const image=page.getByAltText('资产整理预览')
  await image.waitFor()
  const natural=await image.evaluate(el=>({width:el.naturalWidth,height:el.naturalHeight}))
  assert.deepEqual(natural,{width:96,height:80})
  assert.equal((await read()).revision,p.revision)
  await action('应用资产整理')
  p=await read()
  assert.deepEqual(p.frames[0].geometry.canvas,[96,80])
  const bounds=p.frames.map(f=>f.geometry.bounds)
  assert(bounds.every(b=>b[0]===bounds[0][0]&&b[3]===72))
  console.log('PASS UI preview is read-only, canvas/pivot persist, bottom bounds align')

  const g=p.frames[0].geometry
  const c=await page.locator('canvas').boundingBox()
  const k=Math.min((c.width-72)/96,(c.height-72)/80)
  const x=c.x+(c.width-96*k)/2+(20*g.scale[0]+g.offset[0])*k
  const y=c.y+(c.height-80*k)/2+(28*g.scale[1]+g.offset[1])*k
  await button('擦除背景画笔').click()
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.up()
  const mask=page.waitForResponse(r=>r.url().endsWith('/mask')&&r.request().method()==='PUT')
  await button('保存修订').click();assert.equal((await mask).status(),200);await idle()
  p=await read()
  assert(Math.abs(p.frames[0].strokes[0].points[0][0]-20/63)<.01)
  assert(Math.abs(p.frames[0].strokes[0].points[0][1]-28/63)<.01)
  await button('撤销上次操作').click();await idle()
  assert.equal((await read()).frames[0].strokes.length,0)
  console.log('PASS UI brush source coordinate mapping after alignment and undo')
  }

  await button('第 2 帧').click()
  p=await read();const prior=p.frames.map(f=>f.output)
  await button('资产整理').click()
  await page.getByLabel('整理范围',{exact:true}).selectOption('selection')
  assert.equal(await page.getByLabel('画布宽度（0 自动）',{exact:true}).isDisabled(),true)
  await page.getByRole('dialog',{name:'资产整理',exact:true}).getByLabel('遮罩扩缩（源图 px）',{exact:true}).fill('-1')
  await action('预览整理效果','/preview')
  await action('应用资产整理')
  p=await read()
  assert.equal(p.frames[1].settings.matte_grow,-1)
  assert.equal(p.frames[0].settings.matte_grow,0)
  assert.equal(p.frames[3].output,prior[3])
  await button('撤销上次操作').click();await idle()
  console.log('PASS UI selected asset edit preserves other frames and canvas')

  await button('第 1 帧').click()
  await button('第 2 帧').click({modifiers:['Shift']})
  await button('切为动作').click()
  await page.getByLabel('动作名称',{exact:true}).fill('walk')
  await action('保存动作','/actions')
  p=await read()
  await button('导出动画').click()
  await page.getByLabel('图集列数（0 自动）',{exact:true}).fill('1')
  await page.getByLabel('单页上限',{exact:true}).selectOption('128')
  await page.getByLabel('图集留白（px）',{exact:true}).fill('4')
  await page.getByLabel('边缘扩边（px）',{exact:true}).fill('1')
  await page.getByLabel('文件名前缀',{exact:true}).fill('hero')
  await page.getByLabel('全部动作',{exact:true}).uncheck()
  await page.getByLabel('walk · 2 帧',{exact:true}).check()
  await page.getByRole('img',{name:'图集帧矩形布局'}).waitFor()
  assert.equal((await read()).revision,p.revision)
  await page.getByLabel('预览图集页',{exact:true}).selectOption('1')
  assert((await page.locator('.asset-preview').textContent()).includes('hero-atlas-01.png'))
  await action('导出 ZIP','/export')
  await page.getByRole('link',{name:'下载 ZIP'}).waitFor()
  const downloaded=page.waitForEvent('download')
  await page.getByRole('link',{name:'下载 ZIP'}).click()
  await (await downloaded).saveAs(archive)
  p=await read();assert.equal(p.export_options.prefix,'hero')
  await button('关闭导出结果').click()
  await button('导出动画').click()
  assert.equal(await page.getByLabel('文件名前缀',{exact:true}).inputValue(),'hero')
  await page.getByRole('img',{name:'图集帧矩形布局'}).waitFor()
  await button('关闭导出设置').click()
  await page.reload({waitUntil:'networkidle'})
  assert.deepEqual((await read()).asset_options,{canvas_width:96,canvas_height:80,pivot_x:.5,pivot_y:.9})
  assert.deepEqual(errors,[])
  console.log('PASS UI atlas page preview, action subset, ZIP download, persistence; no JS errors')
  console.log(JSON.stringify({pid,archive,errors}))
} finally {await browser.close()}
