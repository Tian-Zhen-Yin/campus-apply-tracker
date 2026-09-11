#!/usr/bin/env node
// 生成 docs/demo.html：真实控制台 UI + fetch 桩 + 虚构数据 → 纯静态「在线体验」页。
// UI 有改动后重跑本脚本即可（node scripts/build-demo.mjs）。产物提交进仓库，由 GitHub Pages 发布。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'web-ui.html'), 'utf8');

// ===== 虚构演示数据（任何人、任何公司均无关联；截止日期相对生成时刻，保证演示效果稳定） =====
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

const demoState = {
  home: '/Users/xiaoming/.ats-status',
  now: new Date().toISOString(),
  busy: null,
  sessions: [],
  lastInspection: null,
  platform: 'darwin',
  services: { console: true, schedule: true, jobpack: true },
  residents: [{ site: 'alibaba', label: '阿里', confirmed: true, openedAt: Date.now() - 7200000, pageUrl: 'https://campus-talent.alibaba.com/campus/home?lang=zh' }],
  events: [
    '09:30:05 ✅ status:all 完成',
    '09:30:02 📬 随查询拉取邮件：新增招聘相关 2 封',
    '09:30:01 🟢 常驻浏览器已连接，登录态正常',
    '08:14:33 📦 岗位包已同步：共 18 条',
  ],
  sites: [
    {
      site: 'bytedance', key: 'bytedance', label: '字节跳动', risk: '中', riskLevel: 'mid', builtin: true,
      hasProfile: true, hasSpec: true, hasSeeds: false, failStreak: 0,
      spec: { mode: 'api', verified: true, url: 'https://jobs.bytedance.com/api/v1/search/jobposts', capturedAt: '2026-09-02' },
      last: {
        at: ago(3), via: 'api',
        records: [
          { job: '大模型算法工程师-Seed', dept: 'Seed', city: '北京', statusRaw: '笔试', appliedAt: '2026-09-05' },
          { job: '推荐算法工程师', dept: '抖音', city: '北京', statusRaw: '已投递', appliedAt: '2026-09-06' },
          { job: 'AI Lab-多模态算法实习生', dept: '', city: '上海', statusRaw: '已查看', appliedAt: '2026-09-08' },
        ],
      },
      heartbeat: { intervalMin: 720, lastBeatAt: Date.now() - 21600000 }, entry: 'https://jobs.bytedance.com/campus/position',
    },
    {
      site: 'alibaba', key: 'alibaba', label: '阿里', risk: '中', riskLevel: 'mid', builtin: true,
      hasProfile: true, hasSpec: true, hasSeeds: false, failStreak: 0,
      spec: { mode: 'api', verified: true, url: 'https://campus-talent.alibaba.com/api/apply/records', capturedAt: '2026-09-03' },
      last: {
        at: ago(4), via: 'api',
        records: [
          { job: 'AI应用算法工程师', dept: '阿里巴巴控股集团-平台技术-算法智能', city: '远程', statusRaw: '评估中', appliedAt: '2026-09-04' },
          { job: 'AI安全技术工程师', dept: '千问办公-安全中心', city: '远程', statusRaw: '面试中', appliedAt: '2026-09-02' },
          { job: 'AI应用算法工程师', dept: '阿里云-MaaS业务线', city: '远程', statusRaw: '评估中', appliedAt: '2026-09-07' },
          { job: 'AI Agent优化工程师-训练/数据/评测', dept: '阿里安全-行为风控算法', city: '远程', statusRaw: '已结束', appliedAt: '2026-08-28' },
        ],
      },
      heartbeat: { intervalMin: 720, lastBeatAt: Date.now() - 21600000 }, entry: 'https://campus-talent.alibaba.com/campus/home',
    },
    {
      site: 'meituan', key: 'meituan', label: '美团', risk: '中', riskLevel: 'mid', builtin: true,
      hasProfile: true, hasSpec: true, hasSeeds: false, failStreak: 0,
      spec: { mode: 'page', verified: false, url: 'https://zhaopin.meituan.com/api/campus/record', capturedAt: '2026-09-04' },
      last: {
        at: ago(20), via: 'page',
        records: [
          { job: '后端开发工程师', dept: '到店事业群', city: '上海市', statusRaw: '已结束', archived: true, appliedAt: '2026-08-20' },
          { job: '大模型训练推理引擎', dept: '北斗计划', city: '北京', statusRaw: '筛选中', appliedAt: '2026-09-05' },
        ],
      },
      heartbeat: { intervalMin: 720, lastBeatAt: Date.now() - 43200000 }, entry: 'https://zhaopin.meituan.com/web/campus',
    },
    {
      site: 'kuaishou', key: 'kuaishou', label: '快手', risk: '中', riskLevel: 'mid', builtin: true,
      hasProfile: true, hasSpec: true, hasSeeds: true, failStreak: 0,
      spec: { mode: 'api', verified: true, url: 'https://campus.kuaishou.cn/recruit/campus/e/api/record', capturedAt: '2026-09-01' },
      last: {
        at: ago(26), via: 'api',
        records: [
          { job: 'Java开发工程师', dept: '', city: '北京、杭州', statusRaw: '已结束', corrected: true, appliedAt: '2026-08-15' },
          { job: '数据研发工程师', dept: '', city: '北京、上海', statusRaw: '已结束', appliedAt: '2026-08-15' },
        ],
      },
      heartbeat: { intervalMin: 720, lastBeatAt: Date.now() - 43200000 }, entry: 'https://campus.kuaishou.cn/recruit/campus/e/',
    },
    {
      site: 'ctrip', key: 'ctrip', label: '携程', risk: '中', riskLevel: 'mid', builtin: true,
      hasProfile: true, hasSpec: true, hasSeeds: true, failStreak: 0,
      spec: { mode: 'api', verified: true, url: 'https://campus.ctrip.com/api/apply/list', capturedAt: '2026-09-05' },
      last: {
        at: ago(30), via: 'api',
        records: [
          { job: '后端开发工程师（2026届秋招）', dept: '', city: '上海', statusRaw: '面试中', appliedAt: '2026-09-03' },
          { job: 'Java开发工程师（2024届秋招）', dept: '669567', city: '—', statusRaw: '进入人才池', appliedAt: '2024-09-20' },
        ],
      },
      heartbeat: { intervalMin: 720, lastBeatAt: Date.now() - 28800000 }, entry: 'https://campus.ctrip.com/',
    },
    {
      site: 'xiaohongshu', key: 'xiaohongshu', label: '小红书', risk: '高', riskLevel: 'high', builtin: true,
      hasProfile: false, hasSpec: false, hasSeeds: true, failStreak: 0, spec: null, last: null,
      heartbeat: { intervalMin: 720, lastBeatAt: 0 }, entry: 'https://campus.xiaohongshu.com/',
    },
  ],
  apps: [{ company: '米哈游', job: '大模型算法工程师（对话方向）', statusRaw: '网申完成', appliedAt: '2026-09-09' }],
  feishu: { configured: false, webhookMasked: '', hasSecret: false },
  dashboard: { mtimeMs: Date.now() - 86400000 },
  mail: {
    configured: true,
    accounts: [{ user: 'xiaoming@163.com', userMasked: 'xia****@163.com', provider: '163' }],
    userMasked: 'xia****@163.com',
    lastAt: ago(3),
    recent: [
      { id: 'mail-1', at: ago(6), kind: 'INTERVIEW', company: '快手', subject: '【快手】面试邀请——后端开发工程师二面安排通知', tip: { kind: '面试', round: '二面', iso: `${day(2)}T14:00`, place: '腾讯会议' }, link: null, candidates: [{ company: '快手', kind: 'site', site: 'kuaishou', job: '数据研发工程师', dept: '' }] },
      { id: 'mail-2', at: ago(9), kind: 'OFFER', company: '腾讯', subject: '【腾讯】录用意向书——恭喜你通过 PCG 后端开发岗位全部面试', tip: null, link: null, candidates: null },
      { id: 'mail-3', at: ago(11), kind: 'EXAM', company: '牛客（笔试平台）', subject: '【美团】2026 校招在线笔试邀请——请准时参加', tip: { kind: '笔试', round: '笔试', iso: `${day(1)}T19:00`, place: '线上' }, link: null, candidates: null },
      { id: 'mail-4', at: ago(28), kind: 'SCREENING', company: '米哈游', subject: '【米哈游】投递成功通知——大模型算法工程师（对话方向）', tip: null, link: { kind: 'apps', company: '米哈游', job: '大模型算法工程师（对话方向）', dept: '', src: 'auto' }, candidates: null },
      { id: 'mail-5', at: ago(52), kind: 'REJECTED', company: '小红书', subject: '【小红书】感谢参与 2026 校园招聘', tip: null, link: null, candidates: [{ company: '小红书', kind: 'site', site: 'xiaohongshu', job: '任何岗位', dept: '' }] },
    ],
  },
  jobs: {
    source: 'doc', docUrl: 'https://docs.qq.com/smartsheet/DemoDemoDemo?tab=demo&viewId=demo', packAt: '',
    lastSync: { at: ago(2), count: 16, error: null },
    marks: { 'job-0815': { applied: true, skip: false, star: true, at: ago(30) }, 'job-0816': { applied: true, skip: false, star: false, at: ago(29) }, 'job-0822': { applied: false, skip: true, star: false, at: ago(20) } },
    jobs: [
      { id: 'job-0901', company: '月之暗面', position: '大模型预训练工程师', city: '北京', deadline: day(3), deadlineRaw: '招满即止', link: 'https://careers.kimi.com/campus', note: '穿越计划顶尖人才', referralCode: 'KIMI08', referrer: '', batch: '27届秋招正式批', addedAt: ago(50), updatedAt: ago(4) },
      { id: 'job-0902', company: '阶跃星辰', position: 'LLM 后训练算法研究员', city: '上海', deadline: day(6), deadlineRaw: '招满即止', link: 'https://app.mokahr.com/campus-recruitment/step', note: '', referralCode: 'STEP66', referrer: '学长A', batch: '27届秋招正式批', addedAt: ago(50), updatedAt: ago(6) },
      { id: 'job-0903', company: '理想汽车', position: '智能驾驶感知算法', city: '北京', deadline: day(9), deadlineRaw: '10-17', link: 'https://www.lixiang.com/about/campus', note: 'offer 选择权', referralCode: '', referrer: '', batch: '27届秋招正式批', addedAt: ago(60), updatedAt: ago(10) },
      { id: 'job-0815', company: '字节跳动', position: 'Seed 大模型人才校招', city: '北京/上海', deadline: '', deadlineRaw: '招满即止', link: 'https://jobs.bytedance.com/campus/position', note: '已官网投递', referralCode: 'DS9qsAYm', referrer: '喵师兄', batch: '27届提前批', addedAt: ago(80), updatedAt: ago(12) },
      { id: 'job-0816', company: '快手', position: 'Java 开发工程师', city: '北京', deadline: '', deadlineRaw: '招满即止', link: 'https://campus.kuaishou.cn/recruit/campus/e/', note: '', referralCode: 'DSk1sgc7', referrer: '', batch: '27届秋招正式批', addedAt: ago(80), updatedAt: ago(14) },
      { id: 'job-0822', company: '莉莉丝', position: '游戏 AI 算法工程师', city: '上海', deadline: day(40), deadlineRaw: '11-30', link: 'https://campus.lilith.com/', note: '观摩中', referralCode: '', referrer: '', batch: '27届秋招正式批', addedAt: ago(70), updatedAt: ago(20) },
      { id: 'job-0825', company: '腾讯', position: 'AI 算法工程师（青云计划）', city: '深圳', deadline: '', deadlineRaw: '长期开放', link: 'https://join.qq.com/', note: '顶尖技术专项', referralCode: 'TX2026', referrer: '', batch: '27届秋招正式批', addedAt: ago(75), updatedAt: ago(24) },
      { id: 'job-0830', company: '美团', position: '北斗计划-大模型训练推理', city: '北京', deadline: day(12), deadlineRaw: '09-23', link: 'https://zhaopin.meituan.com/web/campus', note: '', referralCode: '', referrer: '', batch: '27届秋招正式批', addedAt: ago(72), updatedAt: ago(30) },
      { id: 'job-0831', company: '面壁智能', position: '端侧大模型算法（MiniCPM）', city: '北京', deadline: day(2), deadlineRaw: '09-13', link: 'https://modelbest.jobs.feishu.cn/', note: '前进四计划,硕博', referralCode: 'MB0901', referrer: '', batch: '27届秋招正式批', addedAt: ago(65), updatedAt: ago(36) },
      { id: 'job-0840', company: 'DeepSeek', position: '深度学习研究员', city: '北京/杭州', deadline: '', deadlineRaw: '常年开放', link: 'https://talent.deepseek.com/', note: '扩招中', referralCode: '', referrer: '', batch: '27届秋招正式批', addedAt: ago(90), updatedAt: ago(40) },
      { id: 'job-0841', company: '米哈游', position: '大模型算法工程师（对话方向）', city: '上海', deadline: day(20), deadlineRaw: '10-31', link: 'https://campus.mihoyo.com/', note: '限投 1 岗', referralCode: 'MH6666', referrer: '', batch: '27届秋招正式批', addedAt: ago(85), updatedAt: ago(48) },
      { id: 'job-0842', company: '阿里云', position: '大模型服务平台研发', city: '杭州', deadline: '', deadlineRaw: '招满即止', link: 'https://careers.aliyun.com/campus/home', note: '', referralCode: '', referrer: '', batch: '27届秋招正式批', addedAt: ago(88), updatedAt: ago(60) },
    ],
  },
};

// ===== fetch 桩：拦截全部 /api/*，可交互（标记/筛选/修正均真实改演示状态） =====
const STUB = `<script>
(function () {
  var ribbon = document.createElement('div');
  ribbon.style.cssText = 'position:fixed;z-index:99;top:0;left:0;right:0;background:linear-gradient(90deg,#4f63e9,#35b98a);color:#fff;text-align:center;font-size:13px;font-weight:700;padding:7px 12px;box-shadow:0 4px 14px rgba(33,47,93,.25)';
  ribbon.innerHTML = '🎭 在线演示 · 虚构示例数据，可随意点击体验 · <a href="index.html" style="color:#fff">下载正式版</a>';
  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(ribbon);
    document.body.style.paddingTop = '34px';
  });
  var DEMO = ${'__DEMO_STATE__'};
  DEMO.now = function () { return new Date().toISOString(); };
  DEMO.snapshot = function () {
    var s = JSON.parse(JSON.stringify(this));
    s.now = this.now();
    s.jobs.jobs = s.jobs.jobs.slice().sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    return s;
  };
  var j = function (obj, code) { return new Response(JSON.stringify(obj), { status: code || 200, headers: { 'content-type': 'application/json' } }); };
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    var path = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    if (path.indexOf('/api/') !== 0) return realFetch ? realFetch(input, init) : j({ ok: true });
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}
    if (path === '/api/state') return Promise.resolve(j(DEMO.snapshot()));
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (path === '/api/jobs/mark' && body.id) {
          DEMO.jobs.marks[body.id] = Object.assign({}, DEMO.jobs.marks[body.id], { applied: !!body.applied, skip: !!body.skip, star: !!body.star, at: DEMO.now() });
          return resolve(j({ ok: true, marks: DEMO.jobs.marks[body.id] }));
        }
        if (path === '/api/jobs/sync') { DEMO.jobs.lastSync = { at: DEMO.now(), count: DEMO.jobs.jobs.length, error: null }; return resolve(j({ ok: true })); }
        if (path === '/api/records/correct') {
          for (var si in DEMO.sites) { var st = DEMO.sites[si]; if (st.key !== body.site || !st.last) continue;
            for (var ri in st.last.records) { var r = st.last.records[ri];
              if (r.job === body.job && (r.dept || '') === (body.dept || '')) {
                if (body.archive !== undefined) { r.archived = !!body.archive; }
                else if (body.reset) { delete r.corrected; }
                else { r.statusRaw = { APPLIED:'已投递', VIEWED:'已查看', SCREENING:'评估中', TEST:'笔试', INTERVIEW1:'面试中', INTERVIEW2:'复试', HRFACE:'HR面', OFFER:'录用', CLOSED:'已结束', REJECTED:'不合适', TALENT:'人才池', UNKNOWN:'未知' }[body.status] || body.status; r.corrected = true; }
              } } }
          return resolve(j({ ok: true }));
        }
        if (path === '/api/status') { for (var si2 in DEMO.sites) { if (DEMO.sites[si2].last) DEMO.sites[si2].last.at = DEMO.now(); } return resolve(j({ ok: true })); }
        if (path === '/api/mail/link') { for (var mi in DEMO.mail.recent) { var m = DEMO.mail.recent[mi]; if (m.id === body.id) { m.link = { kind: body.kind, company: body.company, job: body.job, dept: body.dept, src: 'manual' }; delete m.candidates; } } return resolve(j({ ok: true })); }
        if (path === '/api/jobs/schedule') { DEMO.services.jobpack = !body.remove; return resolve(j({ ok: true, installed: !body.remove })); }
        if (path === '/api/login' || path === '/api/resident' || path === '/api/capture') return resolve(j({ error: '演示模式：接入真实官网需要下载安装到本机' }), 409);
        return resolve(j({ ok: true }));
      }, 260);
    });
  };
})();
</script>`;

const stub = STUB.replace('__DEMO_STATE__', JSON.stringify({
  home: demoState.home,
  now: demoState.now,
  busy: demoState.busy,
  sessions: demoState.sessions,
  lastInspection: demoState.lastInspection,
  platform: demoState.platform,
  services: demoState.services,
  residents: demoState.residents,
  events: demoState.events,
  sites: demoState.sites,
  apps: demoState.apps,
  feishu: demoState.feishu,
  dashboard: demoState.dashboard,
  mail: demoState.mail,
  jobs: { source: demoState.jobs.source, docUrl: demoState.jobs.docUrl, packAt: demoState.jobs.packAt, lastSync: demoState.jobs.lastSync, marks: demoState.jobs.marks, jobs: demoState.jobs.jobs },
}));

let html = src
  .replace('<script>', stub + '\n<script>')
  .replace('<title>校招投递控制台 · ats-status</title>', '<title>校招投递控制台 · 在线演示</title>')
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">')
  .replace('href="/guide"', 'href="guide.html"');

if (!html.includes('window.fetch')) throw new Error('stub 注入失败');
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'demo.html'), html);
console.log(`✓ docs/demo.html 生成（${Math.round(html.length / 1024)} KB，演示岗位 ${demoState.jobs.jobs.length} 条）`);
