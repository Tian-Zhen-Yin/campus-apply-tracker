// 控制台岗位库：两种岗位源（jobs.json 的 source 字段，不提供界面配置）——
//   pack（默认，普通用户）：读岗位包 jobs-pack.json（维护者导出的快照，随仓库/安装包分发，零配置开箱即用）；
//   doc（维护者本机）：读固定绑定的腾讯智能表格（地址存 docUrl，文档需「链接可查看」），复刻台账插件的
//   dop-api 读取链路，匿名无头浏览器执行（独立 profile profiles/docsqq）。对外只发布岗位包，文档地址永不分发。
// 「已投/不投/关注」是本地标记覆盖层，重同步保留。与台账（校招投递管理）的岗位库互不影响、不推送。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from './session.mjs';
import { HOME, jobsFile } from './paths.mjs';
import { readJson, nowIso } from './util.mjs';

const DOCS_ORIGIN = 'https://docs.qq.com/';
const PACK_KIND = 'campus-apply-tracker-job-pack';
const PACK_VERSION = 1;
// 内置岗位包随仓库/安装包分发（打包脚本整仓 rsync，根目录文件自动带上）
const BUNDLED_PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jobs-pack.json');

// source 缺省时的推断：有 docUrl 说明是维护者机器（旧数据兼容），否则普通用户走岗位包
export function effectiveSource(st) {
  if (st.source === 'doc' || st.source === 'pack') return st.source;
  return st.docUrl ? 'doc' : 'pack';
}

export function readJobState() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(jobsFile(), 'utf8')); } catch { /* 还没有 jobs.json 的全新用户 */ }
  const base = {
    source: st?.source === 'doc' || st?.source === 'pack' ? st.source : '',
    docUrl: String(st?.docUrl || ''),
    packUrl: String(st?.packUrl || ''),
    packAt: String(st?.packAt || ''),
    lastSync: st?.lastSync || null,
    jobs: Array.isArray(st?.jobs) ? st.jobs : [],
    marks: st?.marks && typeof st.marks === 'object' ? st.marks : {},
  };
  return { ...base, source: effectiveSource(base) };
}

// 全量快照、tmp+rename 原子写（同 tracker-sync 先例；台账/别的进程不会读到半截文件）
export function saveJobState(st) {
  const target = jobsFile();
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

// 解析智能表格链接：只要 docId + tab(subId) + viewId，login_t 等噪声参数一律剥掉
export function parseDocUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (u.hostname !== 'docs.qq.com' || !u.pathname.startsWith('/smartsheet/')) return null;
  const docId = u.pathname.split('/').filter(Boolean)[1] || '';
  const subId = u.searchParams.get('tab') || u.searchParams.get('subId') || '';
  const viewId = u.searchParams.get('viewId') || '';
  if (!docId || !subId) return null;
  return { docId, subId, viewId, canonical: `https://docs.qq.com/smartsheet/${docId}?tab=${subId}${viewId ? `&viewId=${viewId}` : ''}` };
}

// 与台账 stableJobId 同配方（company|position|link，zh-CN 小写 FNV-1a）：内容不变 id 不变，重同步天然幂等
export function stableJobId(company, position, link) {
  const s = `${company}|${position}|${link}`.toLocaleLowerCase('zh-CN');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `job-${(h >>> 0).toString(16)}`;
}

// 列映射：精确 → 前缀 → 包含，三级兜底（真实表头如「招聘截止日期」「投递链接or推文」靠后两级命中）。
// deadline 判在 link 前（「网申时间」是截止不是链接）；内推码/联系人/批次为可选列，命中后折叠进备注展示。
const COLUMN_RULES = [
  ['company', ['公司', '公司名称', '企业', '单位', '厂商', '雇主']],
  ['position', ['岗位', '岗位方向', '招聘岗位', '职位', '职务', '方向']],
  ['city', ['城市', '工作城市', '工作地', '地点', '地区']],
  ['deadline', ['截止时间', '截止日期', '招聘截止日期', '网申截止', '网申时间', '结束时间', '截止', 'deadline']],
  ['link', ['投递链接', '投递地址', '链接', '投递', '网申', '申请', '官网']],
  ['note', ['备注信息', '备注', '说明']],
  ['referralCode', ['内推码', '内推代码']],
  ['referrer', ['内推联系人', '联系人']],
  ['batch', ['批次', '届次', '招聘类型']],
  ['updatedAt', ['更新日期', '更新时间']],
];
function matchColumn(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  for (const [key, names] of COLUMN_RULES) if (names.includes(n)) return key;
  for (const [key, names] of COLUMN_RULES) if (names.some((x) => n.startsWith(x))) return key;
  for (const [key, names] of COLUMN_RULES) if (names.some((x) => n.includes(x))) return key;
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(y, m, 0).getDate())}`;

// 截止时间归一：常见写法 → ISO 日期（分隔符含空格，如「2026 06 30」）；无年份按「已过顺延一年」（秋招语境）；认不出返回空串
export function parseDeadline(raw, now = new Date()) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  let m = s.match(/(20\d{2})\s*[年./\s-]\s*(\d{1,2})\s*[月./\s-]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/(20\d{2})\s*[年./\s-]\s*(\d{1,2})\s*月?\s*底?$/);
  if (m) return monthEnd(Number(m[1]), Number(m[2]));
  m = s.match(/^(\d{1,2})\s*[月./\s-]\s*(\d{1,2})\s*日?/);
  if (m) {
    let y = now.getFullYear();
    if (new Date(y, Number(m[1]) - 1, Number(m[2])) < now) y += 1;
    return `${y}-${pad2(m[1])}-${pad2(m[2])}`;
  }
  m = s.match(/^(\d{1,2})\s*月\s*底?$/);
  if (m) {
    let y = now.getFullYear();
    if (Number(m[1]) < now.getMonth() + 1) y += 1;
    return monthEnd(y, Number(m[1]));
  }
  return '';
}

// 噪声链接：头像/微信素材、指向文档自身的地址（docs.qq.com/link?url=… 跳转包装除外，解包后是真实岗位页）
const NOISE_LINK = /qlogo\.cn|thirdwx\.|^https?:\/\/docs\.qq\.com\/(?!link\?url=)/i;
// 腾讯文档会把外链包装成 docs.qq.com/link?url=… 跳转，这里还原真实地址（同台账 normalizeTencentLink 语义）
export function normalizeUrl(link, text = '') {
  let u = String(link || '').trim() || String(text || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  const m = u.match(/^https?:\/\/docs\.qq\.com\/link\?url=([^&]+)/i);
  if (m) {
    try { u = decodeURIComponent(m[1]); } catch { /* 解不开就用原链 */ }
  }
  return NOISE_LINK.test(u) ? '' : u.replace(/[)\]}」，。；;]+$/, '');
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// 智能表格的行（表头 + 每格 {text, link}）→ 岗位数组。公司/岗位两列认不出直接报错，宁缺毋滥。
export function mapRowsToJobs(header, rows, prevJobs = []) {
  const idx = {};
  header.forEach((name, i) => {
    const key = matchColumn(name);
    if (key && !(key in idx)) idx[key] = i;
  });
  if (!('company' in idx) || !('position' in idx)) {
    return { error: `表头里没认出「公司/岗位」列（现有列：${header.map(clean).join('、') || '空'}）`, jobs: [] };
  }
  const prevAt = new Map(prevJobs.map((j) => [j.id, j.addedAt]));
  const prevUpd = new Map(prevJobs.map((j) => [j.id, j.updatedAt]).filter(([, v]) => !!v));
  const seen = new Set();
  const jobs = [];
  for (const cells of rows) {
    const cell = (k) => {
      const c = (k in idx) ? (cells[idx[k]] || {}) : {};
      return { text: clean(c.text), link: normalizeUrl(c.link, c.text) };
    };
    const company = cell('company').text;
    const position = cell('position').text;
    if (!company || !position) continue; // 空行/填了一半的行不算岗位
    const { link } = cell('link');
    const deadlineRaw = cell('deadline').text;
    const id = stableJobId(company, position, link);
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push({
      id, company, position, link,
      city: cell('city').text,
      deadline: parseDeadline(deadlineRaw),
      deadlineRaw,
      note: cell('note').text,
      // 内推信息结构化保存（展示时拼装，岗位包导出默认剥离 referralCode/referrer）
      referralCode: cell('referralCode').text,
      referrer: cell('referrer').text,
      batch: cell('batch').text,
      addedAt: prevAt.get(id) || nowIso(),
      // 文档没填更新日期的行：沿用上次的值（没有则入库时间），保证「最新优先」排序稳定
      updatedAt: cell('updatedAt').text || prevUpd.get(id) || prevAt.get(id) || nowIso(),
    });
  }
  return { jobs };
}

// 页面内读取器（在 docs.qq.com 同源页面里执行，自动带登录态）。
// 结构与插件 background.js 保持一致：字段名挂在键 "30"、单选选项表在键 "9"、文本/超链接分段收集。
const READ_SHEET = async (params) => {
  const { docId, subId, viewId } = params;
  const out = { ok: false, needLogin: false, error: '', header: [], rows: [] };
  const apiFetchJson = async (url) => {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error('接口返回 ' + resp.status);
    return resp.json();
  };
  const parseSheetChunk = (json) => {
    const text = json && json.data && json.data.initialAttributedText
      && json.data.initialAttributedText.text && json.data.initialAttributedText.text[0]
      && json.data.initialAttributedText.text[0].smartsheet;
    if (!text) return null;
    // 载荷形态会漂移：同一接口有时给 JSON 字符串、有时给已解析对象
    let inner = null;
    try { inner = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { return null; }
    if (!Array.isArray(inner) || !inner[0] || typeof inner[0] !== 'object') return null;
    // 封套随页次变化：首页 inner[0]['0'] 是字段定义树、行在 inner[0]['1'].c['2']['1']；
    // 续页是 {t:3028} 节点（c['1'] 为 subId），行在 inner[0]['0'].c['2']['1']——漏了这层就永远只读到第一页
    const head = inner[0]['0'];
    const isContinuation = !!(head && typeof head === 'object' && head.t === 3028);
    let schemaRec = null;
    let rows = {};
    try {
      if (isContinuation) rows = head.c['2']['1'] || {};
      else { schemaRec = head || null; rows = inner[0]['1'].c['2']['1'] || {}; }
    } catch (_) { rows = {}; }
    const fields = {};
    const fieldOptions = {};
    (function findFields(node, depth) {
      if (depth > 10) return;
      if (Array.isArray(node)) { node.forEach((item) => findFields(item, depth + 1)); return; }
      if (node && typeof node === 'object') {
        for (const key of Object.keys(node)) {
          const value = node[key];
          if (value && typeof value === 'object' && !Array.isArray(value)
            && typeof value['30'] === 'string' && value['30'].length <= 20 && !fields[key]) {
            fields[key] = value['30'];
            // 选项对照表：单选在键 "9" 下、17 类字段（批次/联系人等）在键 "17" 下，结构同为 {3:[{1:id,2:名称}]}
            for (const optKey of ['9', '17']) {
              const opts = value[optKey] && value[optKey]['3'];
              if (!Array.isArray(opts)) continue;
              const map = fieldOptions[key] || {};
              opts.forEach((opt) => { if (opt && typeof opt['1'] === 'string' && typeof opt['2'] === 'string') map[opt['1']] = opt['2']; });
              if (Object.keys(map).length) fieldOptions[key] = map;
            }
          }
          findFields(value, depth + 1);
        }
      }
    })(schemaRec, 0);
    return { fields, fieldOptions, rows, maxrow: (json.data && json.data.maxrow) || 0 };
  };
  const sheetCellToValue = (cell) => {
    let runs = [];
    if (cell && typeof cell === 'object') {
      for (const key of Object.keys(cell)) {
        if (Array.isArray(cell[key])) runs = runs.concat(cell[key]);
      }
    }
    let text = '';
    let link = '';
    for (const run of runs) {
      if (!run || typeof run !== 'object') continue;
      if (run['1'] === 'url' && typeof run['3'] === 'string' && run['3']) {
        link = run['3'];
        if (typeof run['2'] === 'string') text += run['2'];
      } else if (typeof run['2'] === 'string') {
        text += run['2'];
      }
    }
    // 日期字段没有文本分段，值是键 "4" 下的毫秒时间戳（10 位按秒）。日历日期按北京时区取日：
    // 智能表格把「9月11日」存为北京零点对应的 UTC 毫秒（前一日 16:00Z），直接 toISOString 会差一天
    if (!text && cell && typeof cell['4'] === 'string' && /^\d{10,13}$/.test(cell['4'])) {
      const n = Number(cell['4']);
      const ms = n > 1e11 ? n : n * 1000;
      text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    }
    return { text: text.trim(), link };
  };
  try {
    const meta = await apiFetchJson(`https://docs.qq.com/dop-api/opendoc?id=${encodeURIComponent(docId)}&outformat=1&normal=1`);
    const localPadId = (meta && meta.bodyData && meta.bodyData.localPadId) || '';
    if (!localPadId) { out.needLogin = true; out.error = '没有读到文档信息——多半是未登录腾讯文档或无查看权限'; return out; }
    const fields = {};
    const fieldOptions = {};
    let fieldsReady = false;
    const collected = new Map();
    const step = 60;
    const limit = 5000; // 翻页行数上限（实际以响应 maxrow 为准，正常到最后一页即停）
    for (let start = 0; start < limit; start += step) {
      const query = `padId=${encodeURIComponent('300000000$' + localPadId)}&subId=${encodeURIComponent(subId)}`
        + `&startrow=${start}&endrow=${start + step - 1}&outformat=1&normal=1&needSheetState=2`
        + (viewId ? `&viewId=${encodeURIComponent(viewId)}` : '');
      let chunk = null;
      try { chunk = parseSheetChunk(await apiFetchJson('https://docs.qq.com/dop-api/get/sheet?' + query)); } catch (_) { break; }
      if (!chunk) break;
      if (!fieldsReady && Object.keys(chunk.fields).length) {
        Object.assign(fields, chunk.fields);
        Object.assign(fieldOptions, chunk.fieldOptions || {});
        fieldsReady = true;
      }
      const ids = Object.keys(chunk.rows);
      let added = 0;
      ids.forEach((rowId) => { if (!collected.has(rowId)) { collected.set(rowId, chunk.rows[rowId]); added += 1; } });
      if (!ids.length || !added) break;
      if (chunk.maxrow && start + step >= chunk.maxrow) break; // 响应自带总行数，读完最后一页即止
    }
    if (!fieldsReady) { out.needLogin = true; out.error = '没有读到表格结构——未登录、无权限或不是智能表格'; return out; }
    const fieldIds = Object.keys(fields);
    out.header = fieldIds.map((f) => fields[f]);
    for (const rowId of collected.keys()) {
      const cellsMap = (collected.get(rowId) && collected.get(rowId)['1']) || {};
      out.rows.push(fieldIds.map((fieldId) => {
        const cell = cellsMap[fieldId];
        // 选项类字段（单选 "9" / 17 类）：单元格存选项 ID，用字段定义里的对照表还原成名称
        const ids = cell && (Array.isArray(cell['9']) ? cell['9'] : (Array.isArray(cell['17']) ? cell['17'] : null));
        if (ids) {
          const opts = fieldOptions[fieldId] || {};
          return { text: ids.map((id) => opts[id]).filter(Boolean).join('、'), link: '' };
        }
        return sheetCellToValue(cell);
      }));
    }
    out.ok = true;
    return out;
  } catch (e) { out.error = String((e && e.message) || e); return out; }
};

// ===== 岗位包（对外分发的岗位快照；不含文档地址与本地标记）=====

// 链接里的内推参数（recommendCode/referralCode 只是归属标记，去掉不影响投递）；
// SPA 路由的查询串常挂在 hash 里（#/path?referralCode=…），两处都要洗
const REFERRAL_PARAMS = [/^recommendcode$/i, /^referralcode$/i];
export function scrubLink(link) {
  if (!link) return '';
  const scrubQuery = (qs) => {
    const params = new URLSearchParams(qs);
    let hit = false;
    for (const re of REFERRAL_PARAMS) {
      for (const k of [...params.keys()]) {
        if (re.test(k)) { params.delete(k); hit = true; }
      }
    }
    return { hit, qs: params.toString() };
  };
  try {
    const u = new URL(link);
    let touched = false;
    const q1 = scrubQuery(u.search.replace(/^\?/, ''));
    if (q1.hit) { u.search = q1.qs; touched = true; }
    const qi = u.hash.indexOf('?');
    if (qi >= 0) {
      const q2 = scrubQuery(u.hash.slice(qi + 1));
      if (q2.hit) { u.hash = u.hash.slice(0, qi + 1) + q2.qs; touched = true; }
    }
    return touched ? u.toString() : link;
  } catch { return link; }
}

// 从本机岗位库构建岗位包。默认剥离 referralCode/referrer 字段并清洗链接里的内推参数
// （内推是别人给的资源，不随开源扩散），ID 按清洗后的内容重算——文档里换内推码不会让包使用方的岗位 ID 漂移。
// --full 保留全部原始内容。
export function buildJobPack({ full = false } = {}) {
  const st = readJobState();
  if (!st.jobs.length) throw new Error('本机岗位库是空的——先在维护者机器上 ats jobs sync');
  let stripped = 0;
  const jobs = st.jobs.map((j) => {
    if (full) {
      return {
        id: j.id, company: j.company, position: j.position,
        city: j.city || '', deadline: j.deadline || '', deadlineRaw: j.deadlineRaw || '',
        link: j.link || '', note: j.note || '', batch: j.batch || '',
        ...(j.referralCode ? { referralCode: j.referralCode } : {}),
        ...(j.referrer ? { referrer: j.referrer } : {}),
        updatedAt: j.updatedAt || j.addedAt || nowIso(),
      };
    }
    const link = scrubLink(j.link);
    if (j.referralCode || j.referrer || link !== j.link) stripped += 1;
    return {
      id: stableJobId(j.company, j.position, link),
      company: j.company, position: j.position,
      city: j.city || '', deadline: j.deadline || '', deadlineRaw: j.deadlineRaw || '',
      link, note: j.note || '', batch: j.batch || '',
      updatedAt: j.updatedAt || j.addedAt || nowIso(),
    };
  });
  const pack = { kind: PACK_KIND, schemaVersion: PACK_VERSION, generatedAt: nowIso(), count: jobs.length, jobs };
  return { pack, stripped };
}

// 岗位包落盘（默认仓库根目录 jobs-pack.json，随仓库/安装包分发）
export function writeJobPack({ full = false, out } = {}) {
  const { pack, stripped } = buildJobPack({ full });
  const target = out || BUNDLED_PACK;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pack, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return { target, count: pack.count, stripped };
}

// 读岗位包：远程优先（默认公开仓库的 raw 直链，维护者 push 后用户点同步即最新），失败回落本地内置包（离线可用）
const DEFAULT_PACK_URL = 'https://gitee.com/YinTianZheng/campus-apply-tracker/raw/master/jobs-pack.json';
export async function readPackSource(packUrl, log = () => {}) {
  const url = packUrl || DEFAULT_PACK_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    log(`⬇️ 拉取远程岗位包：${url}`);
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (!fs.existsSync(BUNDLED_PACK)) {
      throw new Error(`远程岗位包拉取失败（${e.message}），且本地没有内置岗位包`);
    }
    log(`⚠️ 远程岗位包拉取失败（${e.message}），回落本地内置包（数据停在随包发布的版本）`);
    return readJson(BUNDLED_PACK);
  } finally { clearTimeout(timer); }
}

// 校验并应用岗位包：白名单字段、缺 id 重算、按 id 去重、保留既有 addedAt
export function applyJobPack(payload, prevJobs = []) {
  if (!payload || payload.kind !== PACK_KIND || !Array.isArray(payload.jobs)) {
    throw new Error('不是有效的岗位包（kind/schemaVersion 不符）');
  }
  const prevAt = new Map(prevJobs.map((j) => [j.id, j.addedAt]));
  const seen = new Set();
  const jobs = [];
  for (const raw of payload.jobs) {
    const company = clean(raw?.company);
    const position = clean(raw?.position);
    if (!company || !position) continue;
    const link = normalizeUrl(raw?.link);
    const id = typeof raw.id === 'string' && raw.id.startsWith('job-') ? raw.id : stableJobId(company, position, link);
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push({
      id, company, position, link,
      city: clean(raw?.city), deadline: clean(raw?.deadline), deadlineRaw: clean(raw?.deadlineRaw),
      note: clean(raw?.note), batch: clean(raw?.batch),
      referralCode: clean(raw?.referralCode), referrer: clean(raw?.referrer),
      addedAt: prevAt.get(id) || nowIso(),
      updatedAt: clean(raw?.updatedAt) || nowIso(),
    });
  }
  if (!jobs.length) throw new Error('岗位包里没有有效岗位');
  return jobs;
}

// 同步岗位库（按 source 分流）：
//   doc（维护者）：无头匿名读取智能表格 → 列映射 → 整表替换 jobs；
//   pack（普通用户）：读内置/远程岗位包 → 白名单清洗 → 整表替换 jobs。
// 两种模式失败都不覆盖已有岗位，只记 lastSync.error。
export async function syncJobs({ log = () => {}, headed = false } = {}) {
  const st = readJobState();
  if (st.source === 'pack') {
    try {
      const payload = await readPackSource(st.packUrl, log);
      const jobs = applyJobPack(payload, st.jobs);
      const prevIds = new Set(st.jobs.map((j) => j.id));
      const added = jobs.filter((j) => !prevIds.has(j.id)).length;
      const removed = st.jobs.filter((j) => !jobs.some((x) => x.id === j.id)).length;
      st.jobs = jobs;
      st.packAt = String(payload.generatedAt || '') || null; // 岗位包生成时间,界面据此展示数据新鲜度
      st.lastSync = { at: nowIso(), count: jobs.length, error: null };
      saveJobState(st);
      log(`📋 岗位包已同步：共 ${jobs.length} 条（新增 ${added}，移除 ${removed}）`);
      return { ok: true, source: 'pack', count: jobs.length, added, removed };
    } catch (e) {
      st.lastSync = { at: nowIso(), count: st.jobs.length, error: String(e?.message || e) };
      saveJobState(st);
      return { ok: false, source: 'pack', error: String(e?.message || e) };
    }
  }
  const parsed = parseDocUrl(st.docUrl);
  if (!parsed) throw new Error('岗位文档地址无效或未配置（需 docs.qq.com/smartsheet/… 智能表格链接，含 tab 参数）');
  const ctx = await launch('docsqq', { headless: !headed });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(DOCS_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const r = await page.evaluate(READ_SHEET, { docId: parsed.docId, subId: parsed.subId, viewId: parsed.viewId });
    if (r.needLogin) {
      st.lastSync = { at: nowIso(), count: st.jobs.length, error: r.error };
      saveJobState(st);
      return { ok: false, needLogin: true, error: r.error };
    }
    if (!r.ok) throw new Error(r.error || '读取文档失败');
    log(`📄 表头：${r.header.map(clean).join('、')}`);
    const { jobs, error } = mapRowsToJobs(r.header, r.rows, st.jobs);
    if (error) {
      st.lastSync = { at: nowIso(), count: st.jobs.length, error };
      saveJobState(st);
      return { ok: false, error };
    }
    const prevIds = new Set(st.jobs.map((j) => j.id));
    const added = jobs.filter((j) => !prevIds.has(j.id)).length;
    const removed = st.jobs.filter((j) => !jobs.some((x) => x.id === j.id)).length;
    st.jobs = jobs;
    st.lastSync = { at: nowIso(), count: jobs.length, error: null };
    saveJobState(st);
    log(`📋 岗位库已同步：共 ${jobs.length} 条（新增 ${added}，移除 ${removed}）`);
    return { ok: true, count: jobs.length, added, removed };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// 展示窗口：岗位库只露出最近更新的 N 条（完整数据留在 jobs.json，供岗位包发布导出用）
export const JOB_WINDOW = 250;
export function recentJobs(st, limit = JOB_WINDOW) {
  return [...st.jobs].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, limit);
}

// 本地标记（applied/skip/star）：只写覆盖层，永不写回文档
export function setJobMark(id, patch) {
  const st = readJobState();
  if (!st.jobs.some((j) => j.id === id)) throw new Error('岗位不存在（可能已被文档同步移除）');
  const next = { ...(st.marks[id] || {}) };
  for (const k of ['applied', 'skip', 'star']) if (k in patch) next[k] = !!patch[k];
  next.at = nowIso();
  st.marks[id] = next;
  saveJobState(st);
  return next;
}

// ===== 自动发布流水线（维护者）：sync → 防呆检查 → pack → git 提交推送 =====
// 定时触发走控制台 API（runJob 守卫避免与查询抢浏览器）；LaunchAgent/schtasks 只负责定时 curl 本地端点。

// 发布防呆：绝对下限 + 相对上一版跌幅过半即拦截——文档被清空/误删时绝不把坏包发出去
export function evaluatePublish({ count, prevCount, minCount = 100 } = {}) {
  if (!Number.isFinite(count) || count < minCount) return { ok: false, reason: `岗位数 ${count ?? '无'} 低于发布下限 ${minCount}` };
  if (Number.isFinite(prevCount) && prevCount > 0 && count < prevCount * 0.5) {
    return { ok: false, reason: `岗位数从 ${prevCount} 骤降到 ${count}（超过一半），疑似文档异常` };
  }
  return { ok: true };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

// 发布岗位包：同步文档 → 防呆 → 导出 → 只提交 jobs-pack.json（工作区其他改动不掺和）→ 推送当前分支。
// push:false 时只提交本地（--no-push：先人工确认再手动推）。推送失败时已提交本地，靠返回值/通知提醒人工补推。
export async function publishJobs({ log = () => {}, minCount, push = true } = {}) {
  const st0 = readJobState();
  if (st0.source !== 'doc') throw new Error('只有维护者（文档模式）机器能发布岗位包');
  const r = await syncJobs({ log });
  if (!r.ok) throw new Error(`文档同步失败：${r.error}`);
  const prevPack = readJson(BUNDLED_PACK);
  const verdict = evaluatePublish({ count: r.count, prevCount: prevPack && prevPack.count, minCount });
  if (!verdict.ok) return { ok: false, skipped: verdict.reason };
  const { count } = writeJobPack({});
  git(['add', 'jobs-pack.json']);
  let changed = true;
  try { git(['diff', '--cached', '--quiet']); changed = false; } catch { /* 有暂存内容时以非零退出 */ }
  if (!changed) { log('岗位包无变化，跳过提交'); return { ok: true, published: false, reason: 'no-change', count }; }
  git(['commit', '-m', `chore(job-pack): 岗位包自动更新 ${count} 条`]);
  if (!push) { log(`📦 岗位包已提交本地（${count} 条），未推送（--no-push）`); return { ok: true, published: true, count, pushed: false, noPush: true }; }
  let pushed = false;
  let pushError = '';
  try {
    git(['push']);
    pushed = true;
  } catch {
    try {
      const remote = git(['remote']).split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'origin';
      git(['push', '-u', remote, 'HEAD']);
      pushed = true;
    } catch (e2) {
      pushError = String((e2 && (e2.stderr || e2.message)) || e2).split('\n').filter(Boolean).pop() || '未知原因';
    }
  }
  log(pushed ? `🚀 岗位包已发布：${count} 条已提交并推送` : `📦 岗位包已提交本地（${count} 条），但推送失败：${pushError}`);
  return { ok: true, published: true, count, pushed, pushError };
}
