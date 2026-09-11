// 识别投递网址:无头打开岗位详情页,提取公司/岗位/城市并推断——移植自台账「一键收录插件」
// 的识别引擎(background.js extractJobPage/normalizeCaptured,同 MIT 系),控制台原生化:
// 不依赖浏览器插件,Playwright 直接打开页面;结果仅供人工确认后录入「手动收录」岗位源。
import { launch } from './session.mjs';

// ===== 页面内提取(在岗位页上下文执行) =====
export const EXTRACT_JOB_PAGE = () => {
  const flatten = (value, output = []) => {
    if (!value) return output;
    if (Array.isArray(value)) { value.forEach((item) => flatten(item, output)); return output; }
    if (typeof value === 'object') {
      output.push(value);
      if (value['@graph']) flatten(value['@graph'], output);
    }
    return output;
  };
  const objects = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((node) => {
    try { flatten(JSON.parse(node.textContent), objects); } catch (_) {}
  });
  const job = objects.find((item) => {
    const type = item && item['@type'];
    return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
  }) || {};
  const meta = (name) => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content?.trim() || '';
  const firstText = (selectors) => {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.textContent?.trim();
      if (value && value.length < 160) return value;
    }
    return '';
  };
  const organization = typeof job.hiringOrganization === 'string' ? job.hiringOrganization : job.hiringOrganization?.name;
  const locations = Array.isArray(job.jobLocation) ? job.jobLocation : [job.jobLocation].filter(Boolean);
  const city = locations.map((location) => {
    const address = location?.address || location;
    return [address?.addressLocality, address?.addressRegion].filter(Boolean).join(' ');
  }).filter(Boolean).join(' / ');
  const headingTexts = [...document.querySelectorAll('h1, h2, h3, h4, [class*="position-name"], [class*="positionName"], [class*="job-name"], [class*="jobName"], [class*="title"]')]
    .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
    .map((node) => node.innerText?.trim() || '')
    .filter((value) => value && value.length <= 120)
    .slice(0, 120);
  return {
    url: location.href,
    hostname: location.hostname,
    title: job.title || firstText(['[data-testid*="position"]', '[class*="position-name"]', '[class*="positionName"]', '[class*="job-name"]', '[class*="jobName"]', '[class*="job-title"]', '[class*="jobTitle"]', 'h1']) || meta('og:title') || document.title,
    company: organization || firstText(['[data-testid*="company"]', '[class*="company-name"]', '[class*="companyName"]', '[class*="company_title"]']) || meta('og:site_name'),
    city,
    headingTexts,
    pageTitle: document.title,
    pageText: (document.body?.innerText || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, 80000),
  };
};

// ===== Node 侧推断(宁缺勿猜,与插件同规则) =====
const tidy = (value) => String(value || '').replace(/\s+/g, ' ').replace(/^招聘[:：]?\s*/, '').trim();

const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '重庆', '武汉', '西安', '长沙', '天津', '厦门', '合肥', '郑州', '青岛', '济南', '宁波', '无锡', '珠海', '佛山', '东莞', '福州', '昆明', '南昌', '大连', '沈阳', '哈尔滨', '石家庄', '太原', '贵阳', '南宁', '海口', '兰州', '乌鲁木齐', '呼和浩特', '长春', '香港', '澳门'];

export function inferCity(text, hostname = '') {
  const labeled = String(text || '').match(/(?:工作地点|工作城市|意向城市|所在城市|城市|地点)\s*[:：]?\s*[①②③④⑤]?\s*([^\n，。|]{1,12})/);
  const labeledCity = labeled ? CITIES.find((city) => labeled[1].includes(city)) : '';
  if (labeledCity) return labeledCity;
  if (/(?:^|\.)campus\.anta\.com$/i.test(hostname)) return '';
  return CITIES.find((city) => text.includes(city)) || '';
}

const GENERIC_POSITION = /^(?:应聘记录|申请记录|我的申请|职位申请|校园招聘|社会招聘|招聘官网|职位列表|岗位列表|职位详情|岗位详情|首页)$/i;
const POSITION_WORDS = /工程师|经理|运营|设计师|分析师|顾问|开发|算法|产品|销售|商务|市场|营销|商业化|策略|行业|客户|供应链|财务|人力|法务|测试|数据|项目(?:经理|管理|运营|策划|专员)|采购|管培|校招生|实习生|专员|研究员|策划|编辑|审计|助理|负责人/;
const POSITION_NOISE = /编辑短信|发送短信|修改志愿|查看详情|个人资料|我的简历|投递记录|撤回投递|更新简历|重新投递|取消申请|官网主投|初筛中|筛选中|已投递|申请时间|投递时间|发布|全职|兼职|第\d志愿|^(?:招聘)?项目\s*[:：]|招聘批次|校招项目|应届生项目|^(?:产品|技术|设计|运营|职能|销售|市场|研发)类$/;

function knownCompany(hostname) {
  if (/(?:^|\.)xiaomi\.jobs\.f\.mioffice\.cn$/i.test(hostname || '')) return '小米集团';
  if (/(?:^|\.)campus\.kuaishou\.cn$/i.test(hostname || '')) return '快手';
  if (/(?:^|\.)campus\.anta\.com$/i.test(hostname || '')) return '安踏集团';
  return '';
}

export function inferPosition(text, proposed, headingTexts = []) {
  const clean = (value) => tidy(value)
    .replace(/^(?:岗位|职位)(?:名称)?\s*[:：]\s*/, '')
    .replace(/第\s*\d+\s*志愿/g, '')
    .replace(/(?:撤回投递|更新简历|重新投递|取消申请|官网主投|初筛中|筛选中|已投递)+/g, '')
    .trim();
  const direct = clean(proposed).split(/\s[-_|｜·]\s|招聘职位|职位详情|校园招聘/)[0].trim();
  if (direct && !GENERIC_POSITION.test(direct) && !POSITION_NOISE.test(direct) && POSITION_WORDS.test(direct) && direct.length <= 80) return direct;
  const sources = [
    ...headingTexts.map((value) => ({ value: clean(value), prominence: 5 })),
    ...String(text || '').split(/\n+/).map((value) => ({ value: clean(value), prominence: 0 })),
  ];
  const bestByValue = new Map();
  sources.filter((item) => item.value && item.value.length >= 2 && item.value.length <= 80)
    .filter((item) => !GENERIC_POSITION.test(item.value) && POSITION_WORDS.test(item.value) && !POSITION_NOISE.test(item.value))
    .forEach((item) => {
      const score = item.prominence + 3 + (/【|届|实习|校招/.test(item.value) ? 1 : 0) - (/登录|搜索|筛选|导航/.test(item.value) ? 3 : 0);
      if (!bestByValue.has(item.value) || bestByValue.get(item.value).score < score) bestByValue.set(item.value, { value: item.value, score });
    });
  const candidates = [...bestByValue.values()]
    .sort((a, b) => b.score - a.score || a.value.length - b.value.length);
  if (!candidates.length) return '';
  // 插件在打平时宁缺勿猜(静默播种);控制台是「预览+人工确认」形态,取首个候选让人改
  return candidates[0].value;
}

// 推断入口:页面提取的原始字段 → {company, position, city, url};阶段/投递日期与岗位库无关,不取
export function normalizeCaptured(raw) {
  // 无标题页(zhiye 等 SPA 无 h1-h4/类名,title 回落成站点名):从正文前段找第一条岗位行作提议
  let proposed = tidy(raw.title);
  const titleIsShell = !proposed || proposed === tidy(raw.pageTitle) || /招聘中心|招聘官网|校园招聘$/.test(proposed);
  if (titleIsShell) {
    const line = String(raw.pageText || '').split(/\n+/).slice(0, 40)
      .find((l) => l.length >= 4 && l.length <= 80 && POSITION_WORDS.test(l) && !POSITION_NOISE.test(l));
    if (line) proposed = line;
  }
  const position = inferPosition(raw.pageText, proposed, Array.isArray(raw.headingTexts) ? raw.headingTexts : []);
  let company = knownCompany(raw.hostname) || tidy(raw.company);
  if (!company || /^(?:官网|网站)$|BOSS直聘|猎聘|智联招聘|前程无忧|拉勾|牛客|实习僧|应届生求职网|招聘官网|招聘网站|校园招聘|社会招聘|应聘记录|申请记录/i.test(company)) {
    const parts = tidy(raw.pageTitle).split(/[_|｜·-]/).map((item) => item.trim()).filter(Boolean);
    company = parts.find((part) => part !== position && !/招聘|职位|官网|应聘|申请|BOSS|猎聘|智联|前程|拉勾|牛客|实习僧/.test(part)) || '';
  }
  const cityRaw = tidy(raw.city || inferCity(`${raw.pageTitle}\n${raw.pageText}`, raw.hostname));
  const cityHit = CITIES.find((c) => cityRaw.includes(c)) || cityRaw; // 「北京市海淀区」→「北京」收敛到白名单简称
  return {
    company: company.slice(0, 60),
    position: position.slice(0, 80),
    city: cityHit.slice(0, 30),
    url: raw.url,
  };
}

// ===== 无头识别:打开岗位页 → 等渲染 → 提取 → 推断 =====
// 与 docsqq 同思路串行化:同一 profile 不并发开浏览器(岗位页多为 SPA,等 DOM 稳定即取)
let captureChain = Promise.resolve();
export function captureJob(url, { headed = false } = {}) {
  const run = captureChain.then(async () => {
    let u;
    try { u = new URL(String(url || '').trim()); } catch { throw new Error('网址无效（需 http/https 链接）'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('只支持 http/https 链接');
    const ctx = await launch('jobpage', { headless: !headed });
    try {
      const page = await ctx.newPage();
      await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      // SPA 岗位页要等脚本渲染:轮询直到正文出现岗位信号(职责/要求/工作地等)或超时(~15s),
      // 只看正文长度会被"壳页+页脚超500字"骗过——等信号才取
      const SIGNAL = /岗位|职位|职责|任职要求|工作地点|工作城市|Job Posting|招聘对象/i;
      const ready = () => page.evaluate(() => {
        const t = (document.body?.innerText || '');
        return t.length > 300 && /岗位|职位|职责|任职要求|工作地点|工作城市|招聘对象/.test(t);
      }).catch(() => false);
      for (let i = 0; i < 10 && !(await ready()); i += 1) await page.waitForTimeout(1500);
      const raw = await page.evaluate(EXTRACT_JOB_PAGE);
      const result = normalizeCaptured(raw);
      if (!result.company || !result.position) {
        return { ok: false, error: `没认出${!result.company ? '公司' : '岗位'}——可改用手动添加,或把职位详情页(而非列表页)的链接发来再试`, raw: { title: raw.title, pageTitle: raw.pageTitle, hostname: raw.hostname } };
      }
      return { ok: true, ...result };
    } finally {
      await ctx.close().catch(() => {});
    }
  });
  captureChain = run.catch(() => {});
  return run;
}
