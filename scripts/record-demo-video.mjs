#!/usr/bin/env node
// 重制产品主页 hero 素材：加载 docs/demo.html(虚构数据) 按剧本录屏 → ffmpeg 转 mp4/webm,
// 并截取当前 UI 的静态截图作为 poster/README 用(替换 guide-img/console-home.png)。
// UI 改版后重跑:node scripts/record-demo-video.mjs(需 ffmpeg)。
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'guide-img');
const TMP = fs.mkdtempSync('/tmp/campusvid-');
const W = 1280, H = 800;
const pause = (p, ms) => p.waitForTimeout(ms);

const b = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: TMP, size: { width: W, height: H } } });
const p = await ctx.newPage();
await p.goto('file://' + path.resolve(ROOT, 'docs', 'demo.html'));
await p.waitForSelector('#overview table');
await p.evaluate(() => localStorage.removeItem('ats.console.onboardingDismissed'));

// 剧本(约 11 秒):总览 → 投递总览 → 岗位库临近截止 → 复制内推码(toast) → 标已投 → 回顶部
await pause(p, 1400);
await p.evaluate(() => document.getElementById('secRecords').scrollIntoView({ behavior: 'smooth', block: 'start' }));
await pause(p, 2000);
await p.evaluate(() => document.getElementById('secJobs').scrollIntoView({ behavior: 'smooth', block: 'start' }));
await pause(p, 1400);
await p.evaluate(() => { const x = [...document.querySelectorAll('#jobFilters button')].find((b2) => b2.textContent === '临近截止'); x && x.click(); });
await pause(p, 1800);
await p.evaluate(() => { const x = [...document.querySelectorAll('#jobList .chip.on')].find((c) => c.textContent.includes('内推')); x && x.click(); });
await pause(p, 1800);
await p.evaluate(() => { const x = [...document.querySelectorAll('#jobList tbody button')].find((b2) => b2.textContent.trim() === '已投'); x && x.click(); });
await pause(p, 2000);
await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await pause(p, 1000);
await p.evaluate(() => window.scrollTo(0, 0));
await pause(p, 500);

// poster:当前 UI 静态截图(替换过时的 console-home.png,README/guide 同步受益)
fs.mkdirSync(OUT, { recursive: true });
await p.screenshot({ path: path.join(OUT, 'console-home.png') });

// 先 close 让录制器收尾,再从录制目录取成片(saveAs 会与 close 形成死锁)
const rawPath = await p.video().path();
await ctx.close();
await b.close();
const raw = path.join(TMP, 'raw.webm');
fs.copyFileSync(rawPath, raw);

const mp4 = path.join(OUT, 'console-demo.mp4');
const webm = path.join(OUT, 'console-demo.webm');
execSync(`ffmpeg -y -ss 0.6 -i "${raw}" -an -vf "scale=${W}:${H}:flags=lanczos,fps=15" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 27 "${mp4}"`, { stdio: 'pipe' });
execSync(`ffmpeg -y -ss 0.6 -i "${raw}" -an -vf "scale=${W}:${H}:flags=lanczos,fps=15" -c:v libvpx -crf 32 -b:v 0 "${webm}"`, { stdio: 'pipe' });
fs.rmSync(TMP, { recursive: true, force: true });
const kb = (f) => Math.round(fs.statSync(f).size / 1024);
console.log(`✓ console-home.png(重制) | console-demo.mp4 ${kb(mp4)}KB | console-demo.webm ${kb(webm)}KB`);
