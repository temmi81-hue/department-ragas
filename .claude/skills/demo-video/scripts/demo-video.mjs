import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { parse } from 'yaml';
import ffmpegPath from 'ffmpeg-static';

const scenarioPath = process.argv[2];
if (!scenarioPath) throw new Error('Usage: node demo-video.mjs <scenario.yml>');
const root = process.cwd();
const scenario = parse(await fs.readFile(path.resolve(root, scenarioPath), 'utf8'));
const outDir = path.resolve(root, 'out');
await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const webm = path.join(outDir, `demo-${stamp}.webm`);
const mp4 = path.resolve(root, scenario.output ?? path.join('out', `demo-${stamp}.mp4`));
await fs.mkdir(path.dirname(mp4), { recursive: true });

// Probes a media file's duration (seconds) by parsing ffmpeg's own stderr banner - avoids
// depending on a separate ffprobe binary that ffmpeg-static doesn't ship.
const probeDuration = file => new Promise(resolve => {
  let stderr = '';
  const p = spawn(ffmpegPath, ['-i', file]);
  p.stderr.on('data', d => { stderr += d; });
  p.on('close', () => { const m = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/); resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null); });
});
// Builds an ffmpeg filter_complex that time-lapses specific [start,end) windows of the video
// (e.g. an LLM call's real wall-clock wait) down to a `target` duration, leaving everything
// else at normal speed - so a slow backend call doesn't force the whole video to look rushed
// or blow the runtime budget. `segments`: [{start,end,target}] in seconds, chronological.
const buildSpeedFilter = (totalDuration, segments) => {
  const bounds = [...new Set([0, totalDuration, ...segments.flatMap(s => [s.start, s.end])])].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const t0 = bounds[i], t1 = bounds[i + 1];
    if (t1 - t0 <= 0.01) continue;
    const seg = segments.find(s => t0 >= s.start - 0.01 && t1 <= s.end + 0.01);
    const factor = seg ? Math.max(1, (seg.end - seg.start) / seg.target) : 1;
    parts.push({ t0, t1, factor });
  }
  const trims = parts.map((p, i) => `[0:v]trim=start=${p.t0}:end=${p.t1},setpts=(PTS-STARTPTS)/${p.factor}[v${i}]`);
  const concatIn = parts.map((_, i) => `[v${i}]`).join('');
  return `${trims.join(';')};${concatIn}concat=n=${parts.length}:v=1:a=0[outv]`;
};
const overlayScript = () => {
  const style = document.createElement('style');
  style.textContent = `#demo-cursor{position:fixed;z-index:2147483647;width:22px;height:22px;border:3px solid white;border-radius:50%;background:#2563eb;box-shadow:0 2px 8px #0008;pointer-events:none;transform:translate(-50%,-50%)}#demo-click{position:fixed;z-index:2147483646;width:20px;height:20px;border:4px solid #60a5fa;border-radius:50%;pointer-events:none;opacity:0;transform:translate(-50%,-50%)}#demo-caption{position:fixed;z-index:2147483645;left:50%;bottom:42px;transform:translateX(-50%);padding:14px 28px;color:#fff;background:#111c;border-radius:8px;font:600 26px/1.3 sans-serif;opacity:0;pointer-events:none}#demo-card{position:fixed;inset:0;z-index:2147483644;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#101827;color:white;font:700 54px sans-serif;opacity:0;pointer-events:none}#demo-card small{margin-top:18px;font-size:24px;font-weight:400;color:#cbd5e1}#demo-highlight{position:fixed;z-index:2147483643;border:4px solid #f59e0b;border-radius:8px;box-shadow:0 0 0 9999px #0005;opacity:0;pointer-events:none}`;
  const install = () => { document.documentElement.append(style); for (const [id, tag] of [['demo-cursor','div'],['demo-click','div'],['demo-caption','div'],['demo-card','div'],['demo-highlight','div']]) { const el=document.createElement(tag); el.id=id; document.body.append(el); } };
  if (document.body) install(); else document.addEventListener('DOMContentLoaded', install, { once: true });
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } } });
await context.addInitScript(overlayScript);
const page = await context.newPage();
page.setDefaultTimeout(60000); // this app's RAG step calls an LLM and can take ~10-20s
const video = page.video();
const sleep = ms => page.waitForTimeout(ms);
// Wall-clock marks (name -> elapsed ms since recording start), set via `mark: <name>` steps.
// Used after recording to find and time-lapse slow/uninteresting waits (e.g. an LLM call)
// without guessing a fixed duration - see buildSpeedFilter below.
const recordingStart = Date.now();
const marks = {};
// This app's RAG step calls an LLM and can take 10-20s (slower reasoning models can run
// longer) before the target element (e.g. .rag-panel) even exists in the DOM. Both the
// click path and the move/highlight path must wait for that, not just assume it's already
// there - otherwise boundingBox() below returns null immediately and the run fails.
const ASYNC_WAIT_MS = 45000;
const clickStable = async (selector) => {
  const target = page.locator(selector);
  try { await target.waitFor({ state: 'visible', timeout: ASYNC_WAIT_MS }); await move(selector); await target.click(); }
  catch (error) { if (!(await page.locator('#results').isVisible().catch(() => false))) throw error; }
  await sleep(800);
};
const show = async (id, text, ms = 1200) => { await page.locator(`#${id}`).evaluate((e, t) => { e.textContent=t; e.style.opacity='1'; }, text); await sleep(ms); await page.locator(`#${id}`).evaluate(e => e.style.opacity='0'); };
const move = async selector => { const el = page.locator(selector); await el.waitFor({ state: 'visible', timeout: ASYNC_WAIT_MS }); const box = await el.boundingBox(); if (!box) throw new Error(`Element not visible: ${selector}`); const from = await page.locator('#demo-cursor').boundingBox() ?? { x: 40, y: 40, width: 0, height: 0 }; const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; await page.locator('#demo-cursor').evaluate((e,p)=>{e.style.left=`${p.x}px`;e.style.top=`${p.y}px`},{x:from.x,y:from.y}); await page.locator('#demo-cursor').evaluate((e,p)=>{e.animate([{left:`${p.fromX}px`,top:`${p.fromY}px`},{left:`${p.toX}px`,top:`${p.toY}px`}],{duration:700,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'});},{fromX:from.x,fromY:from.y,toX:to.x,toY:to.y}); await sleep(750); };
try {
  await page.goto(scenario.url, { waitUntil: 'networkidle' });
  for (const chapter of scenario.chapters ?? []) {
    await page.locator('#demo-card').evaluate((e,c)=>{e.innerHTML=`${c.title ?? ''}<small>${c.subtitle ?? ''}</small>`;e.style.opacity='1';},{title:chapter.title,subtitle:chapter.subtitle}); await sleep(chapter.title ? 1800 : 400); await page.locator('#demo-card').evaluate(e=>e.style.opacity='0');
    for (const step of chapter.steps ?? []) { const [kind, value] = Object.entries(step)[0]; const cfg = typeof value === 'object' ? value : { duration:value }; if (step.caption && !cfg.caption) cfg.caption = step.caption;
      if (cfg.caption) await show('demo-caption', cfg.caption, 350);
      if (kind === 'wait') await sleep(Number(value));
      if (kind === 'mark') marks[typeof value === 'string' ? value : cfg.name] = Date.now() - recordingStart;
      if (kind === 'scroll') { if (cfg.align === 'center') await page.locator(cfg.selector).evaluate(el => el.scrollIntoView({ block: 'center' })); else await page.locator(cfg.selector).scrollIntoViewIfNeeded(); await sleep(cfg.duration ?? 1000); }
      if (kind === 'expand') { await page.locator(cfg.selector).evaluate(el => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; el.style.overflow = 'hidden'; }); await sleep(cfg.duration ?? 300); }
      if (kind === 'move') await move(cfg.selector);
      if (kind === 'type') { await move(cfg.selector); await page.locator(cfg.selector).click(); await page.locator(cfg.selector).pressSequentially(cfg.text, { delay: cfg.delay ?? 65 }); }
      if (kind === 'click') { const box = await page.locator(cfg.selector).boundingBox().catch(() => null); await clickStable(cfg.selector); if(box) await page.locator('#demo-click').evaluate((e,p)=>{e.style.left=`${p.x}px`;e.style.top=`${p.y}px`;e.style.opacity='1';e.animate([{transform:'translate(-50%,-50%) scale(.5)'},{transform:'translate(-50%,-50%) scale(2)',opacity:0}],{duration:450})},{x:box.x+box.width/2,y:box.y+box.height/2}); await sleep(500); }
      if (kind === 'highlight') { await move(cfg.selector); const box=await page.locator(cfg.selector).boundingBox(); await page.locator('#demo-highlight').evaluate((e,b)=>{Object.assign(e.style,{left:`${b.x-8}px`,top:`${b.y-8}px`,width:`${b.width+16}px`,height:`${b.height+16}px`,opacity:'1'});},box); await sleep(cfg.duration ?? 1000); await page.locator('#demo-highlight').evaluate(e=>e.style.opacity='0'); }
      if (kind === 'screenshot') await page.screenshot({ path:path.join(outDir, `${cfg.name ?? 'step'}.png`) });
    }
  }
  await context.close(); await browser.close();
  const recordedPath = await video.path();
  await fs.rename(recordedPath, webm);
  // Encode to a temp path first: on Windows the target mp4 can be held open (OneDrive sync,
  // a media player, etc.), which makes ffmpeg's direct write fail with EBUSY/"Permission
  // denied". Renaming a temp file over an existing, locked target can also fail (EPERM), so
  // move the old file aside before swapping the new one in, and clean the old one up after.
  const mp4Tmp = `${mp4}.tmp-${stamp}.mp4`;
  // Resolve scenario.speedSegments (mark names -> seconds) into concrete windows, and skip
  // any pair whose marks weren't actually set (e.g. a step failed/branch not taken).
  const resolvedSegments = (scenario.speedSegments ?? [])
    .map(s => ({ start: marks[s.from] / 1000, end: marks[s.to] / 1000, target: s.target ?? 3 }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  let ffmpegArgs = ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Tmp];
  if (resolvedSegments.length) {
    const totalDuration = await probeDuration(webm);
    if (totalDuration) {
      const filterComplex = buildSpeedFilter(totalDuration, resolvedSegments);
      ffmpegArgs = ['-y', '-i', webm, '-filter_complex', filterComplex, '-map', '[outv]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Tmp];
      console.log('Time-lapsing segments:', resolvedSegments);
    }
  }
  await new Promise((resolve,reject)=>{const p=spawn(ffmpegPath,ffmpegArgs,{stdio:'inherit'});p.on('close',c=>c?reject(new Error(`ffmpeg exited ${c}`)):resolve());});
  const mp4Old = `${mp4}.old-${stamp}.mp4`;
  const hadPrevious = await fs.rename(mp4, mp4Old).then(() => true).catch(() => false);
  await fs.rename(mp4Tmp, mp4);
  if (hadPrevious) await fs.rm(mp4Old, { force: true }).catch(() => {});
  console.log(`Created ${mp4}`);
} catch (error) {
  const failure = path.join(outDir, `failure-${stamp}.png`); await page.screenshot({ path: failure }).catch(()=>{}); await context.close().catch(()=>{}); await browser.close().catch(()=>{}); console.error(`Failed. Screenshot: ${failure}`); throw error;
}
