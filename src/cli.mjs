#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { SITES, SITE_KEYS } from './config.mjs';
import { HOME, ensureDirs, profileDir, capturedFile, metaFile } from './paths.mjs';
import { pad, readJson, table } from './util.mjs';
import { login } from './login.mjs';
import { capture } from './capture.mjs';
import { status } from './status.mjs';
import { keepalive } from './keepalive.mjs';
import { report } from './report.mjs';
import { writeTrackerSync } from './trackerSync.mjs';
import { importApps, listApps } from './apps.mjs';
import { feishuTest } from './feishu.mjs';

const [, , cmd, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const opt = (name) => flags.has(name);
const optVal = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

function requireSite(s) {
  if (!s || !SITES[s]) {
    console.error(`站点必须是: ${SITE_KEYS.join(' | ')}`);
    process.exit(1);
  }
}

function usage() {
  console.log(`用法: node src/cli.mjs <命令> [站点] [选项]
站点: ${SITE_KEYS.join(' | ')}

命令:
  ui                   启动本地控制台（浏览器图形界面，推荐入口；--no-open 不弹窗）
  sites                列出各站点配置与会话/接口就绪状态
  login <site>         打开浏览器人工登录一次（扫码/短信），保存会话
  capture <site>       抓包向导：登录后打开「我的投递」页，自动识别状态接口
  status <site|--all>  查询当前投递状态（--headed 显示浏览器，--raw 存原始返回）
  report [--open]      聚合各站最新数据 + 手工列表，生成总览面板 dashboard.html（有变化时 macOS 通知）
  tracker-sync        手动刷新「校招投递管理」状态包（查状态成功后已自动刷新）
  feishu-test          测试飞书群机器人推送（配置见 ~/.ats-status/feishu.json）
  import <file|-|>     导入手工投递列表（JSON 数组或 CSV：公司,岗位,状态,投递时间,链接；空=读管道）
  apps                 查看手工投递列表
  jobs                 查看岗位库（普通用户读内置岗位包；维护者读自己的腾讯智能表格）
  jobs sync            同步岗位库（--headed 显示浏览器，仅维护者文档模式有意义）
  jobs pack [--full]   导出岗位包 jobs-pack.json 随仓库分发（维护者用；默认剥离内推码/联系人，--full 保留）
  jobs publish         发布流水线：同步文档→防呆检查→打包→git 提交推送（维护者用；定时触发建议走控制台）
  keepalive            心跳保活（--once 单轮，--interval N 分钟）
  doctor <site>        查看站点会话与接口详情
  forget <site>        清除该站点会话与已保存接口`);
}

ensureDirs();
  try {
    switch (cmd) {
      case 'ui': {
        const { startServer } = await import('./web.mjs');
        await startServer({ openBrowser: !opt('--no-open') });
        break;
      }
      case 'sites':
    case undefined: {
      for (const k of SITE_KEYS) {
        const c = SITES[k];
        const hasProfile = fs.existsSync(profileDir(k));
        const hasSpec = fs.existsSync(capturedFile(k));
        const hb = c.heartbeat;
        const hbs = `保活 ${Math.round(hb.startMin / 60)}h${hb.floorMin < hb.startMin ? `（掉线下限 ${Math.round(hb.floorMin / 60)}h）` : '（固定）'}`;
        console.log(`${pad(k, 14)} ${pad(c.label, 6)} 会话:${hasProfile ? '✓' : '—'} 接口:${hasSpec ? '✓' : (c.seeds ? '预置' : '—')} ${pad(hbs, 22)} 风险:${c.risk}`);
      }
      if (!cmd) console.log('\n(提示: 输入 node src/cli.mjs 查看完整命令)');
      break;
    }
    case 'login':
      requireSite(args[0]);
      await login(args[0]);
      break;
    case 'capture':
      requireSite(args[0]);
      await capture(args[0]);
      break;
    case 'status': {
      const o = { headed: opt('--headed'), raw: opt('--raw') };
      if (opt('--all')) {
        for (const k of SITE_KEYS) {
          if (fs.existsSync(path.join(HOME, 'resident', `${k}.json`))) { console.log(`${k}: 常驻浏览器运行中，请在控制台里查询（避免浏览器 profile 冲突）`); continue; }
          if (!fs.existsSync(profileDir(k))) { console.log(`${k}: 未登录（先 login）`); continue; }
          await status(k, o);
        }
      } else {
        requireSite(args[0]);
        await status(args[0], o);
      }
      break;
    }
    case 'report':
      await report({ open: opt('--open') });
      break;
    case 'tracker-sync':
      writeTrackerSync();
      break;
    case 'feishu-test':
      await feishuTest();
      break;
    case 'import':
      await importApps(args[0]);
      break;
    case 'apps':
      await listApps();
      break;
    case 'jobs': {
      const { readJobState, syncJobs, writeJobPack } = await import('./jobs.mjs');
      const sub = args[0];
      if (sub === 'sync') {
        const r = await syncJobs({ log: console.log, headed: opt('--headed') });
        if (r.needLogin) console.log('读取失败：文档需保持「有链接即可查看」的公开权限');
        else if (!r.ok) console.log(`同步失败：${r.error}`);
        break;
      }
      if (sub === 'pack') {
        const r = writeJobPack({ full: opt('--full'), out: optVal('--out') });
        console.log(`岗位包已导出 → ${r.target}（${r.count} 条${r.stripped ? `，已剥离 ${r.stripped} 条的内推码/联系人${opt('--full') ? '' : '（--full 可保留）'}` : ''}）`);
        break;
      }
      if (sub === 'publish') {
        const { publishJobs } = await import('./jobs.mjs');
        const r = await publishJobs({ log: console.log, push: !opt('--no-push') });
        if (r.skipped) console.log(`⚠️ 未发布：${r.skipped}`);
        else if (r.reason === 'no-change') console.log('岗位包无变化，未提交');
        else console.log(r.pushed ? `已发布：${r.count} 条已提交并推送` : `已提交本地（${r.count} 条）${r.noPush ? '（--no-push）' : `，推送失败：${r.pushError}——请手动 git push`}`);
        break;
      }
      const st = readJobState();
      const ls = st.lastSync;
      const { recentJobs } = await import('./jobs.mjs');
      console.log(`岗位源: ${st.source === 'doc' ? `我的文档 ${st.docUrl}` : `岗位包${st.packUrl ? `（远程 ${st.packUrl}）` : '（内置 jobs-pack.json）'}`}`);
      console.log(`同步: ${ls ? `${ls.error ? '失败：' + ls.error : '共 ' + st.jobs.length + ' 条'} · ${new Date(ls.at).toLocaleString('zh-CN')}` : '从未'}`);
      const shown = recentJobs(st);
      if (shown.length) {
        if (st.jobs.length > shown.length) console.log(`（展示最近更新的 ${shown.length} 条，库中共 ${st.jobs.length} 条）`);
        console.log(table(shown.map((j) => ({ ...j, mark: [st.marks[j.id]?.applied && '已投', st.marks[j.id]?.star && '★', st.marks[j.id]?.skip && '不投'].filter(Boolean).join(',') || '' })), [
          { key: 'company', title: '公司', width: 16 },
          { key: 'position', title: '岗位', width: 36 },
          { key: 'city', title: '城市', width: 10 },
          { key: 'deadline', title: '截止', width: 12 },
          { key: 'mark', title: '标记', width: 8 },
        ]));
      }
      break;
    }
    case 'keepalive':
      await keepalive({ once: opt('--once'), ignoreQuiet: opt('--ignore-quiet'), interval: parseInt(optVal('--interval'), 10) || undefined });
      break;
    case 'doctor': {
      requireSite(args[0]);
      const k = args[0];
      const c = SITES[k];
      console.log(`站点: ${k} (${c.label})  风险:${c.risk}`);
      console.log(`入口: ${c.entry}`);
      console.log(`保活: 起始 ${Math.round(c.heartbeat.startMin / 60)}h/次${c.heartbeat.floorMin < c.heartbeat.startMin ? `，掉线后间隔减半、下限 ${Math.round(c.heartbeat.floorMin / 60)}h` : '，掉线不减频（高风险站点：掉线即人工重登）'}；静默时段 08:00–23:30 之外零流量`);
      if (c.extraEntries) console.log(`其他入口: ${c.extraEntries.join(', ')}`);
      console.log(`会话 profile: ${fs.existsSync(profileDir(k)) ? '存在 ✓' : '不存在（先 login）'}`);
      const meta = readJson(metaFile(k));
      if (meta) console.log(`保活状态: 间隔 ${meta.intervalMin} 分钟，上次 ${meta.lastBeatAt ? new Date(meta.lastBeatAt).toLocaleString('zh-CN') : '从未'}`);
      const spec = readJson(capturedFile(k));
      if (spec) {
        console.log(`已保存接口: ${spec.method} ${spec.url}`);
        console.log(`  模式: ${spec.mode}${spec.verified ? '（已验证）' : ''}  抓取时间: ${spec.capturedAt}`);
        console.log(`  页面回退: ${spec.statusPageUrl}`);
      } else {
        console.log(`已保存接口: 无${c.seeds ? `（有 ${c.seeds.length} 个预置候选，status 会自动尝试）` : '（先 capture）'}`);
      }
      break;
    }
    case 'forget': {
      requireSite(args[0]);
      for (const dir of [profileDir(args[0])]) fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(capturedFile(args[0]), { force: true });
      console.log(`已清除 ${args[0]} 的会话与接口。`);
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('出错:', e?.message || e);
  process.exit(1);
}
