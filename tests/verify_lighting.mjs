// Isolated integration: node tests/verify_lighting.mjs <fixtures> <output folder>.
import { chromium } from '/Users/bytedance/Documents/graduation/asset-search/node_modules/playwright/index.mjs'
import ts from '../web/node_modules/typescript/lib/typescript.js'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const [inputDir,outputDir]=process.argv.slice(2)
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1512,height:982},acceptDownloads:true})
page.setDefaultTimeout(25000)
const base='http://127.0.0.1:8971', errors=[], posts=[]
const button=name=>page.getByRole('button',{name,exact:true})
page.on('pageerror',e=>errors.push(e.message))
page.on('request',r=>{if(r.method()==='POST')posts.push(r.url())})
let pid
const read=async()=> (await fetch(`${base}/api/projects/${pid}`)).json()
async function idle(){
  await page.waitForFunction(()=>!document.querySelector('.job-card,.loading-pill'))
  assert.equal(await page.getByRole('alert').count(),0,await page.getByRole('alert').allTextContents())
}
async function settle(){
  await page.waitForLoadState('networkidle')
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
}
async function processPatch(patch,extra={}){
  const p=await read()
  const response=await fetch(`${base}/api/projects/${pid}/process`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({settings_patch:patch,expected_revision:p.revision,...extra}),
  })
  assert.equal(response.status,200,await response.clone().text())
  const {job_id}=await response.json()
  const deadline=Date.now()+25000
  while(Date.now()<deadline){
    const job=await (await fetch(`${base}/api/jobs/${job_id}`)).json()
    if(job.state==='done')break
    assert.notEqual(job.state,'failed',job.message)
    await new Promise(resolve=>setTimeout(resolve,30))
  }
  await page.reload({waitUntil:'networkidle'});await page.locator('.frame-tile').nth(3).waitFor()
  await idle()
}
async function generate(count){
  await button(`生成法线 · ${count} 帧`).click();await idle();await settle()
}
async function exportZip(name){
  await button('导出动画').click()
  await page.getByLabel('导出法线与打光示例',{exact:true}).check()
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
  await page.getByLabel('序列名称',{exact:true}).fill('法线与灯光隔离验证')
  const imported=page.waitForResponse(r=>r.url().endsWith('/import'))
  await button('开始导入').click();pid=(await (await imported).json()).project_id
  await page.locator('.frame-tile').nth(3).waitFor();await idle()
  await processPatch({size:64,offset_x:.1},{asset_options:{canvas_width:84,canvas_height:72}})
  let p=await read(), revision=p.revision, outputs=p.frames.map(f=>f.output)
  await page.getByLabel('近似法线方法',{exact:true}).selectOption('mix')
  await button('预览法线').click();await idle();await settle()
  assert.equal((await read()).revision,revision)
  assert.equal(await page.getByText('法线预览 · 尚未应用',{exact:true}).count(),1)
  assert.equal(await button('播放动画').isDisabled(),true)
  await button('实时打光').click();await settle()
  // Keyboard must enforce the same playback prerequisite as the button.
  await page.locator('.stage-surface canvas').focus()
  await page.keyboard.press('Space')
  assert.equal(await button('暂停').count(),0)
  const beforePosts=posts.length
  const beforeImage=await page.locator('.stage-surface canvas').evaluate(c=>c.toDataURL())
  await page.getByLabel('光源 X',{exact:true}).focus()
  await page.getByLabel('光源 X',{exact:true}).press('ArrowRight')
  await page.getByLabel('光源强度',{exact:true}).focus()
  await page.getByLabel('光源强度',{exact:true}).press('ArrowRight')
  const canvas=page.locator('.stage-surface canvas')
  const box=await canvas.boundingBox(), [w,h]=p.frames[0].geometry.canvas
  const scale=Math.min((box.width-72)/w,(box.height-72)/h)
  const x=box.x+(box.width-w*scale)/2+w*scale*.2
  const y=box.y+(box.height-h*scale)/2+h*scale*.75
  await page.mouse.move(x,y);await page.mouse.down()
  await page.mouse.move(x+1,y,{steps:4});await page.mouse.up();await settle()
  assert.ok(Math.abs(Number(await page.getByLabel('光源 X',{exact:true}).inputValue())-(.2+1/(w*scale)))<.002)
  assert.ok(Math.abs(Number(await page.getByLabel('光源 Y',{exact:true}).inputValue())-.75)<.002)
  assert.notEqual(await canvas.evaluate(c=>c.toDataURL()),beforeImage)
  assert.equal(posts.length,beforePosts,'Lamp adjustments must not submit processing requests')
  assert.equal((await read()).revision,revision)
  console.log('PASS draft preview read-only; GPU lamp updates and drag use output coordinates; zero POSTs')

  await button('第 2 帧').click()
  await page.getByLabel('应用范围',{exact:true}).selectOption('selection')
  await page.getByLabel('近似法线方法',{exact:true}).selectOption('luma')
  await generate(1);p=await read()
  assert.equal(p.frames[1].normal_settings.method,'luma')
  assert.equal(p.frames[0].normal_url,undefined)
  assert.deepEqual(p.frames.map(f=>f.output),outputs)
  await button('撤销上次操作').click();await idle()
  assert.equal((await read()).frames[1].normal_url,undefined)
  await page.getByLabel('应用范围',{exact:true}).selectOption('all')
  await generate(4)
  await button('实时打光').click();await settle()
  assert.equal(await button('播放动画').isDisabled(),false)
  await button('播放动画').click()
  const first=await page.locator('.transport-info>.mono').first().textContent()
  await page.waitForFunction(first=>document.querySelector('.transport-info>.mono').textContent!==first,first)
  await button('暂停').click()
  await page.screenshot({path:`${outputDir}/smooth-lighting.png`})
  await exportZip('smooth')
  console.log('PASS scoped generation, color preservation, undo, lit playback, paired smooth export')

  await processPatch({style:'pixel',pixel_cell:2,palette_mode:'custom',custom_palette:['#18202b','#eac28a'],dither_strength:.7})
  p=await read();const normals=p.frames.map(f=>f.normal)
  await processPatch({dither_strength:.2,palette_distance:'lab',stabilize:.2})
  assert.deepEqual((await read()).frames.map(f=>f.normal),normals)
  await button('法线贴图').click();await settle()
  await button('实时打光').click();await settle()
  await page.screenshot({path:`${outputDir}/pixel-lighting.png`})
  await exportZip('pixel')
  await page.reload({waitUntil:'networkidle'})
  assert.ok((await read()).frames.every(f=>f.normal_url))
  await page.setViewportSize({width:1100,height:800})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  console.log('PASS pixel grid, palette/dither cache reuse, saved normal persistence, paired pixel export')

  // Test real WebGL output independently: +Y direction, straight alpha and light position.
  const source=await fs.readFile(new URL('../web/src/lighting.ts',import.meta.url),'utf8')
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
  const gpu=await page.evaluate(async moduleUrl=>{
    const {LightingRenderer}=await import(moduleUrl)
    const image=async rgba=>{
      const c=document.createElement('canvas');c.width=16;c.height=16
      const ctx=c.getContext('2d'),data=ctx.createImageData(16,16)
      for(let i=0;i<data.data.length;i+=4)data.data.set(rgba,i)
      ctx.putImageData(data,0,0)
      const im=new Image();im.src=c.toDataURL();await im.decode();return im
    }
    const color=await image([180,120,80,180]),normal=await image([128,218,218,255])
    const renderer=new LightingRenderer()
    const sample=y=>{
      renderer.render(color,normal,{x:.5,y,height:.25,intensity:2,range:4,ambient:0,color:'#ffffff'},true)
      const gl=renderer.canvas.getContext('webgl'),data=new Uint8Array(4)
      gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,data);return Array.from(data)
    }
    const top=sample(0),bottom=sample(1);renderer.dispose()
    return {top,bottom}
  },'data:text/javascript;base64,'+Buffer.from(js).toString('base64'))
  assert.ok(gpu.top[0]>gpu.bottom[0]+30,JSON.stringify(gpu))
  assert.equal(gpu.top[3],180);assert.equal(gpu.bottom[3],180)
  assert.deepEqual(errors,[])
  console.log('PASS real GPU +Y lighting direction and alpha',JSON.stringify(gpu))
  console.log(JSON.stringify({pid,outputDir,errors}))
}finally{await browser.close()}
