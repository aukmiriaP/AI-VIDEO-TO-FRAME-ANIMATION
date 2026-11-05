// Run against an isolated 8971 server using fixtures from propagation_fixtures.py.
import { chromium } from '/Users/bytedance/Documents/graduation/asset-search/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const root=process.argv[2], base='http://127.0.0.1:8971'
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1512,height:982},acceptDownloads:true})
page.setDefaultTimeout(25000)
const button=name=>page.getByRole('button',{name,exact:true})
const errors=[]
page.on('pageerror',e=>errors.push(e.message))
let pid
const read=async()=> (await fetch(`${base}/api/projects/${pid}`)).json()
async function idle(){
  await page.waitForFunction(()=>!document.querySelector('.job-card,.loading-pill'))
  assert.equal(await page.getByRole('alert').count(),0,await page.getByRole('alert').allTextContents())
}
async function settled(){
  await page.waitForLoadState('networkidle')
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
}
async function importSequence(folder,name){
  await button('导入素材').click()
  await page.getByLabel('选择视频或序列帧',{exact:true}).setInputFiles(
    (await fs.readdir(`${root}/${folder}`)).filter(f=>f.endsWith('.png')).sort().map(f=>`${root}/${folder}/${f}`))
  await page.getByLabel('序列名称',{exact:true}).fill(name)
  const response=page.waitForResponse(r=>r.url().endsWith('/import'))
  await button('开始导入').click();pid=(await (await response).json()).project_id
  await page.locator('.frame-tile').nth(6).waitFor();await idle()
  await page.getByLabel('输出长边',{exact:true}).selectOption('128')
  await button('应用').click();await idle()
}
async function drawErase(){
  await button('第 3 帧').click();await button('擦除背景画笔').click();await settled()
  const rect=await page.locator('.stage-surface canvas').boundingBox()
  const s=Math.min((rect.width-72)/128,(rect.height-72)/128)
  await page.mouse.click(rect.x+(rect.width-128*s)/2+58*s,rect.y+(rect.height-128*s)/2+50*s)
  assert.equal(await button('跨帧遮罩').isDisabled(),true,'Unsaved brush must block propagation')
  await button('保存修订').click();await idle();await settled()
  assert.equal((await read()).frames[2].strokes.length,1)
}
async function runPreview(){
  await button('生成传播预览').click()
  await page.locator('.propagation-candidate').first().waitFor()
  await idle();await settled()
}
async function exportZip(name){
  await button('导出动画').click()
  await page.getByLabel('导出法线与打光示例',{exact:true}).check()
  await page.getByRole('img',{name:'图集帧矩形布局'}).waitFor()
  await button('导出 ZIP').click()
  await page.getByRole('link',{name:'下载 ZIP'}).waitFor()
  const event=page.waitForEvent('download')
  await page.getByRole('link',{name:'下载 ZIP'}).click()
  await (await event).saveAs(`${root}/exports/${name}.zip`)
  await button('关闭导出结果').click()
}
try{
  await page.goto(base,{waitUntil:'networkidle'})
  await importSequence('fixtures','跨帧遮罩浏览器验证')
  // An empty donor shows actionable instructions and prevents generation.
  await button('跨帧遮罩').click()
  assert.equal(await button('生成传播预览').isDisabled(),true)
  await button('关闭跨帧遮罩').click()
  await button('生成法线 · 7 帧').click();await idle()
  await drawErase()
  let p=await read(), before=structuredClone(p)
  await button('跨帧遮罩').click()
  await page.getByLabel('传播前帧数',{exact:true}).selectOption('2')
  await runPreview()
  assert.equal((await read()).revision,before.revision)
  assert.equal(await page.locator('.propagation-candidate').count(),5)
  assert.equal(await page.getByLabel('应用传播第 1 帧',{exact:true}).isChecked(),true)
  const previewUrl=await page.getByRole('img',{name:'第 4 帧传播预览',exact:true}).getAttribute('src')
  const oldUrl=await page.getByRole('img',{name:'第 4 帧传播前',exact:true}).getAttribute('src')
  assert.notEqual(previewUrl,oldUrl,'The preview must include the transported correction')
  await page.getByLabel('显示传播风险区域',{exact:true}).check()
  assert.equal(await page.locator('.propagation-risk').count(),5)
  assert.equal(await page.locator('.propagation-dialog').evaluate(el=>el.getBoundingClientRect().width),900)
  assert.equal(await page.getByLabel('传播置信阈值',{exact:true}).evaluate(el=>el.getBoundingClientRect().height),3)
  await page.screenshot({path:`${root}/exports/propagation-preview.png`})
  for(const i of [1,2,5,6])await page.getByLabel(`应用传播第 ${i} 帧`,{exact:true}).uncheck()
  await button('应用到所选 1 帧').click();await idle();await settled()
  p=await read()
  assert.equal(p.frames[3].output_url,previewUrl)
  assert.equal(p.frames[3].mask_corrections.length,1)
  assert.notEqual(p.frames[3].normal,before.frames[3].normal)
  assert.deepEqual(p.last_run.affected,[3])
  for(const i of [0,1,2,4,5,6])assert.deepEqual(p.frames[i],before.frames[i])
  await button('撤销上次操作').click();await idle()
  assert.deepEqual((await read()).frames,before.frames)
  console.log('PASS real brush, pending guard, bidirectional read-only preview, risks, selective application, normals and undo')

  // A changed threshold invalidates the old report.
  await button('跨帧遮罩').click();await runPreview()
  await page.getByLabel('传播置信阈值',{exact:true}).focus()
  await page.getByLabel('传播置信阈值',{exact:true}).press('ArrowRight')
  assert.equal(await page.locator('.propagation-candidate').count(),0)
  assert.equal(await button('应用到所选 0 帧').isDisabled(),true)
  await runPreview()
  for(const i of [5,6])await page.getByLabel(`应用传播第 ${i} 帧`,{exact:true}).uncheck()
  await button('应用到所选 1 帧').click();await idle()
  p=await read();const applied=structuredClone(p)
  await page.reload({waitUntil:'networkidle'});await page.locator('.frame-tile').nth(6).waitFor()
  await button('第 4 帧').click();await button('跨帧遮罩').click()
  await button('清除当前帧 1 层传播修订').click();await idle()
  assert.equal((await read()).frames[3].mask_corrections,undefined)
  await button('撤销上次操作').click();await idle()
  assert.deepEqual((await read()).frames,applied.frames)
  await exportZip('propagated-smooth')
  const smoothPid=pid
  // Fixed pixel palette remains valid after propagation; also export the paired pixel atlas.
  await button('像素风 网格与共用色板').click()
  await page.getByLabel('输出长边',{exact:true}).selectOption('128')
  await button('应用').click();await idle()
  await button('第 3 帧').click();await button('跨帧遮罩').click()
  await page.getByLabel('传播后帧数',{exact:true}).selectOption('1')
  await runPreview();await button('应用到所选 1 帧').click();await idle()
  await exportZip('propagated-pixel')
  console.log('PASS report invalidation, persisted corrections, clear/undo, smooth and pixel paired exports')

  await importSequence('occluded','遮挡丢失验证')
  await drawErase();p=await read()
  await button('跨帧遮罩').click();await runPreview()
  assert.equal(await page.locator('.propagation-candidate').count(),3)
  for(const i of [4,5,6])assert.equal(await page.getByLabel(`应用传播第 ${i} 帧`,{exact:true}).isDisabled(),true)
  assert.equal(await button('应用到所选 0 帧').isDisabled(),true)
  assert.equal((await read()).revision,p.revision)
  await page.getByLabel('显示传播风险区域',{exact:true}).check()
  await page.screenshot({path:`${root}/exports/propagation-occlusion.png`})
  await page.setViewportSize({width:1100,height:800})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await button('关闭跨帧遮罩').click()
  assert.deepEqual(errors,[])
  console.log('PASS occlusion halts future application, no mutations, responsive modal, no JavaScript errors')
  await fs.writeFile(`${root}/exports/validation.json`,JSON.stringify({smoothPid,occlusionPid:pid,root,errors},null,2))
  console.log(JSON.stringify({smoothPid,occlusionPid:pid,root,errors}))
}finally{await browser.close()}
