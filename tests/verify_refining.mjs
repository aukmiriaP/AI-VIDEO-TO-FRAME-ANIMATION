// Run against FRAME_STUDIO_DATA isolated server: node tests/verify_refining.mjs <fixture root>.
import { chromium } from '/Users/bytedance/Documents/graduation/asset-search/node_modules/playwright/index.mjs'
import ts from '../web/node_modules/typescript/lib/typescript.js'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const root=process.argv[2],base='http://127.0.0.1:8971'
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1512,height:982},acceptDownloads:true})
page.setDefaultTimeout(25000)
const button=name=>page.getByRole('button',{name,exact:true})
const errors=[],writes=[]
page.on('pageerror',e=>errors.push(e.message))
page.on('request',r=>{if(['POST','PUT','PATCH'].includes(r.method()))writes.push(r.url())})
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
async function download(name,file){
  const event=page.waitForEvent('download')
  await button(name).click()
  await (await event).saveAs(`${root}/exports/${file}`)
}
async function upload(mode,file){
  await button('替换当前帧').click()
  await page.getByLabel('单帧替换方式',{exact:true}).selectOption(mode)
  await page.getByLabel('单帧替换图片',{exact:true}).setInputFiles(`${root}/${file}`)
  await page.waitForFunction(()=>!document.querySelector('.replace-dialog .btn.primary').disabled)
  await button('应用单帧替换').click();await idle();await settled()
}
try{
  await page.goto(base,{waitUntil:'networkidle'})
  await button('导入素材').click()
  await page.getByLabel('选择视频或序列帧',{exact:true}).setInputFiles(
    (await fs.readdir(`${root}/fixtures`)).filter(f=>f.endsWith('.png')).sort().map(f=>`${root}/fixtures/${f}`))
  await page.getByLabel('序列名称',{exact:true}).fill('洋葱皮与单帧替换验证')
  const imported=page.waitForResponse(r=>r.url().endsWith('/import'))
  await button('开始导入').click();pid=(await (await imported).json()).project_id
  await page.locator('.frame-tile').nth(3).waitFor();await idle()
  await page.getByLabel('输出长边',{exact:true}).selectOption('64')
  await button('应用').click();await idle()
  await button('生成法线 · 4 帧').click();await idle()
  await button('第 2 帧').click();await settled()
  let p=await read(),before=structuredClone(p),revision=p.revision
  const canvas=page.locator('.stage-surface canvas')
  const plain=await canvas.evaluate(c=>c.toDataURL())
  const beforeWrites=writes.length
  await page.getByLabel('启用洋葱皮',{exact:true}).check();await settled()
  const onion=await canvas.evaluate(c=>c.toDataURL())
  assert.notEqual(onion,plain,'Onion skin must change actual rendered pixels')
  assert.equal(await page.locator('.onion-legend').textContent(),'前帧 1后帧 3')
  await page.getByLabel('洋葱皮前帧数',{exact:true}).selectOption('2')
  await page.getByLabel('洋葱皮循环首尾',{exact:true}).check();await settled()
  assert.ok((await page.locator('.onion-legend').textContent()).includes('4'))
  await page.getByLabel('洋葱皮循环首尾',{exact:true}).uncheck()
  await page.getByLabel('洋葱皮双色区分',{exact:true}).uncheck();await settled()
  assert.notEqual(await canvas.evaluate(c=>c.toDataURL()),onion)
  await page.getByLabel('洋葱皮双色区分',{exact:true}).check()
  await page.getByLabel('洋葱皮透明度',{exact:true}).focus()
  await page.getByLabel('洋葱皮透明度',{exact:true}).press('ArrowRight')
  assert.equal((await read()).revision,revision)
  assert.equal(writes.length,beforeWrites,'Onion settings are browser-local, without mutations')
  await page.screenshot({path:`${root}/exports/onion.png`})
  await button('播放动画').click()
  assert.equal(await page.locator('.onion-legend').count(),0)
  const first=await page.locator('.transport-info>.mono').first().textContent()
  await page.waitForFunction(first=>document.querySelector('.transport-info>.mono').textContent!==first,first)
  await button('暂停').click()
  assert.equal(await page.locator('.onion-legend').count(),1)
  await button('实时打光').click();await settled()
  assert.equal(await page.locator('.onion-legend').count(),0)
  await button('关闭').click()
  await button('对照').click();assert.equal(await page.locator('.onion-legend').count(),0)
  await button('处理后').click()
  await button('第 2 帧').click()
  console.log('PASS actual onion pixels, count, tint, wrap, no backend writes, playback/lighting/compare suspension')

  await button('替换当前帧').click()
  await download('下载原始帧','source.png')
  await download('下载处理后帧','output.png')
  await page.getByLabel('单帧替换图片',{exact:true}).setInputFiles(`${root}/wrong.png`)
  await page.getByText(/尺寸不匹配/).waitFor()
  assert.equal(await button('应用单帧替换').isDisabled(),true)
  assert.equal((await read()).revision,revision)
  await button('关闭单帧替换').click()
  await upload('source','replacement.png')
  p=await read()
  assert.notEqual(p.frames[1].original,before.frames[1].original)
  assert.notEqual(p.frames[1].normal,before.frames[1].normal)
  assert.equal(p.frames[0].output,before.frames[0].output)
  assert.equal(p.frames[2].output,before.frames[2].output)
  assert.deepEqual(p.actions,before.actions)
  assert.equal(p.frames[1].duration,before.frames[1].duration)
  assert.equal(p.frames[1].id,before.frames[1].id)
  await button('撤销上次操作').click();await idle()
  assert.equal((await read()).frames[1].original,before.frames[1].original)
  await upload('output','replacement.png')
  p=await read();const override=p.frames[1].output
  assert.equal(p.frames[1].original,before.frames[1].original)
  assert.equal(p.frames[1].output_override,override)
  assert.equal(await button('擦除背景画笔').isDisabled(),true)
  await page.getByLabel('水平偏移',{exact:true}).focus()
  await page.getByLabel('水平偏移',{exact:true}).press('ArrowRight')
  await button('应用').click();await idle()
  assert.equal((await read()).frames[1].output,override)
  await button('替换当前帧').click();await button('解除成品覆盖').click();await idle()
  assert.equal((await read()).frames[1].output_override,undefined)
  await button('撤销上次操作').click();await idle()
  assert.equal((await read()).frames[1].output_override,override)
  console.log('PASS downloads, dimension rejection, source replacement/undo, output override, parameter preservation/reset')

  await button('导出动画').click()
  await page.getByLabel('导出法线与打光示例',{exact:true}).check()
  await page.getByRole('img',{name:'图集帧矩形布局'}).waitFor()
  await button('导出 ZIP').click()
  await page.getByRole('link',{name:'下载 ZIP'}).waitFor()
  const exported=page.waitForEvent('download')
  await page.getByRole('link',{name:'下载 ZIP'}).click()
  await (await exported).saveAs(`${root}/exports/replaced.zip`)
  await button('关闭导出结果').click()
  await page.reload({waitUntil:'networkidle'});await page.locator('.frame-tile').nth(3).waitFor()
  assert.equal((await read()).frames[1].output_override,override)
  await page.setViewportSize({width:1100,height:800})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.deepEqual(errors,[])
  console.log('PASS paired atlas export, persistent override, responsive layout, no browser errors')

  // Boundary checks for selecting onion references, independent of the rendering implementation.
  const source=await fs.readFile(new URL('../web/src/OnionControls.tsx',import.meta.url),'utf8')
  const fn=source.slice(source.indexOf('export function onionFrames'),source.indexOf('\ntype Props='))
  const js=ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
  const {onionFrames}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'))
  const fixture={frames:Array.from({length:7},()=>({enabled:true})),actions:[
    {start:0,end:3,loop:true},{start:4,end:6,loop:false}]}
  const opts={before:3,after:3,wrap:false}
  assert.deepEqual(onionFrames(fixture,0,opts).map(f=>f.index).sort(),[1,2,3])
  assert.ok(onionFrames(fixture,3,opts).every(f=>f.index<4))
  const loop=onionFrames(fixture,0,{...opts,wrap:true})
  assert.equal(new Set(loop.map(f=>f.index)).size,3)
  assert.equal(loop.length,3)
  assert.ok(onionFrames(fixture,4,{...opts,wrap:true}).every(f=>f.index>=4))
  fixture.frames[1].enabled=false
  assert.ok(onionFrames(fixture,0,opts).every(f=>f.index!==1))
  assert.equal(onionFrames(fixture,1,opts).some(f=>f.index===1),false)
  assert.equal(onionFrames(fixture,2,{before:0,after:0,wrap:true}).length,0)
  console.log('PASS action boundaries, disabled frames, zero counts and unique loop references')
  console.log(JSON.stringify({pid,root,errors}))
}finally{await browser.close()}
