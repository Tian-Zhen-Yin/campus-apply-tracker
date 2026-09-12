// 控制台岗位库：岗位源(Source)可多个,全部只读、手动同步——
//   pack(原厂岗位包,默认):读 jobs-pack.json 快照(远程 raw 直链优先,失败回落内置),所有用户开箱即用;
//   doc(用户自助文档源):任意「有链接即可查看」的腾讯智能表格,添加时试读预览确认(ADR-0006 追记)。
// 岗位行带 src(来源 id),分源整表替换;「已投/不投/关注」是本地标记覆盖层,重同步保留。
// 与台账(校招投递管理)的岗位库互不影响、不推送。对外发布(ADR-0006)只含维护者主文档源。
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
// 内置岗位包随仓库/安装包分发(打包脚本整仓 rsync,根目录文件自动带上)
const BUNDLED_PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'jobs-pack.json');
const MAIN_DOC_ID = 'doc'; // 维护者主文档源:发布岗位包的唯一内容来源

export function readJobState() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(jobsFile(), 'utf8')); } catch { /* 全新用户:还没有 jobs.json */ }
  const out = {
    version: 2,
    sources: Array.isArray(st?.sources) ? st.sources : [],
    docUrl: String(st?.docUrl || ''),
    packUrl: String(st?.packUrl || ''),
    packAt: String(st?.packAt || ''),
    lastSync: st?.lastSync || null,
    jobs: Array.isArray(st?.jobs) ? st.jobs : [],
    marks: st?.marks && typeof st.marks === 'object' ? st.marks : {},
  };
  // v1 → v2 迁移:无 sources 时按旧字段推断(有 docUrl = 维护者文档源;否则原厂岗位包),并给岗位补 src
  if (!out.sources.length) {
    out.sources = out.docUrl
      ? [{ id: MAIN_DOC_ID, type: 'doc', url: out.docUrl, label: '我的岗位表', addedAt: out.lastSync?.at || nowIso() }]
      : [{ id: 'pack', type: 'pack', ...(out.packUrl ? { packUrl: out.packUrl } : {}) }];
  }
  // 内建「手动收录」源(识别投递网址/人工录入的落点):缺失自动补,排在原厂包之后
  if (!out.sources.some((s) => s.id === 'manual')) {
    const at = out.sources.length;
    out.sources.splice(Math.min(1, at), 0, { id: 'manual', type: 'manual', label: '手动收录', addedAt: nowIso() });
  }
  const legacySrc = out.docUrl ? MAIN_DOC_ID : 'pack';
  for (const j of out.jobs) if (!j.src) j.src = legacySrc;
  out.source = out.sources.some((s) => s.type === 'doc') ? 'doc' : 'pack'; // 兼容字段:UI 发布按钮显隐等
  return out;
}

export const saveJobState = (st) => {
  const target = jobsFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
  fs.renameSync(tmp, target);
};

// ===== 解析与纯函数 =====

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

// 与台账 stableJobId 同配方(company|position|link,zh-CN 小写 FNV-1a):内容不变 id 不变,跨源天然去重
export function stableJobId(company, position, link) {
  const s = `${company}|${position}|${link}`.toLocaleLowerCase('zh-CN');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `job-${(h >>> 0).toString(16)}`;
}

// 列映射:精确 → 前缀 → 包含,三级兜底(真实表头如「招聘截止日期」「投递链接or推文」靠后两级命中)。
// deadline 判在 link 前(「网申时间」是截止不是链接);内推码/联系人/批次为可选列。
const COLUMN_RULES = [
  ['company', ['公司', '公司名称', '企业', '单位', '厂商', '雇主']],
  ['position', ['岗位', '岗位方向', '招聘岗位', '职位', '职务', '方向']],
  ['title', ['公告标题', '公告名称']], // 公告板型表格:公司嵌在标题里,见 extractCompany(裸词「公告」太贪,会误吞链接列)
  ['city', ['城市', '工作城市', '工作地', '地点', '地区']],
  ['deadline', ['截止时间', '截止日期', '招聘截止日期', '网申截止', '网申时间', '结束时间', '截止', 'deadline']],
  ['link', ['投递链接', '投递地址', '链接', '投递', '网申', '申请', '官网']],
  ['note', ['备注信息', '备注', '说明']],
  ['referralCode', ['内推码', '内推代码']],
  ['referrer', ['内推联系人', '联系人']],
  ['batch', ['批次', '届次', '招聘类型']],
  ['updatedAt', ['更新日期', '更新时间']],
];
// 公告板型表格的公司名提取:标题形如「易方达基金 2027 届秋招启动」,取招聘关键词前的前缀
export function extractCompany(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const m = t.match(/^(.+?)\s*(?=20\d{2}\s*届|【?20\d{2}|校园|秋季|春季|秋招|春招|校招|招聘|实习|内推|补招|正式批|提前批)/);
  return clean(m ? m[1] : t.split(/\s+/)[0]);
}
export function matchColumn(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  for (const [key, names] of COLUMN_RULES) if (names.includes(n)) return key;
  for (const [key, names] of COLUMN_RULES) if (names.some((x) => n.startsWith(x))) return key;
  for (const [key, names] of COLUMN_RULES) if (names.some((x) => n.includes(x))) return key;
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const monthEnd = (y, m) => `${y}-${pad2(m)}-${pad2(new Date(y, m, 0).getDate())}`;

// 截止时间归一:常见写法 → ISO 日期(分隔符含空格,如「2026 06 30」);无年份按「已过顺延一年」;认不出返回空串
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

// 噪声链接:头像/微信素材、指向文档自身的地址(docs.qq.com/link?url=… 跳转包装除外,解包后是真实岗位页)
const NOISE_LINK = /qlogo\.cn|thirdwx\.|^https?:\/\/docs\.qq\.com\/(?!link\?url=)/i;
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

export function mapRowsToJobs(header, rows, prevJobs = []) {
  const idx = {};
  header.forEach((name, i) => {
    const key = matchColumn(name);
    if (key && !(key in idx)) idx[key] = i;
  });
  // 两种表型:岗位列表型(公司+岗位列)或公告板型(只有「公告标题」,公司嵌在标题前缀里)
  const boardMode = !('company' in idx) && !('position' in idx) && 'title' in idx;
  if (!('company' in idx) && !('position' in idx) && !boardMode) {
    return { error: `表头里没认出「公司/岗位」或「公告标题」列（现有列：${header.map(clean).join('、') || '空'}）`, jobs: [] };
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
    let company, position;
    if (boardMode) {
      position = cell('title').text;
      if (!position) continue;
      company = extractCompany(position);
    } else {
      company = cell('company').text;
      position = cell('position').text;
      if (!company || !position) continue; // 空行/填了一半的行不算岗位
    }
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
      // 内推信息结构化保存(展示时拼装,岗位包导出默认剥离 referralCode/referrer)
      referralCode: cell('referralCode').text,
      referrer: cell('referrer').text,
      batch: cell('batch').text,
      addedAt: prevAt.get(id) || nowIso(),
      // 文档没填更新日期的行:沿用上次的值(没有则入库时间),保证「最新优先」排序稳定
      updatedAt: cell('updatedAt').text || prevUpd.get(id) || prevAt.get(id) || nowIso(),
    });
  }
  return { jobs };
}

// 展示窗口:岗位库只露出最近更新的 N 条(完整数据仍在库中,供岗位包发布导出用)
export const JOB_WINDOW = 250;
export function recentJobs(st, limit = JOB_WINDOW) {
  return [...st.jobs].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, limit);
}

// ===== 页面内读取器(在 docs.qq.com 同源页面里执行,自动带上页面 Cookie) =====
const READ_SHEET = async (params) => {
  const { docId, subId, viewId } = params;
  const out = { ok: false, needLogin: false, error: '', title: '', header: [], rows: [] };
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
    // 载荷形态会漂移:同一接口有时给 JSON 字符串、有时给已解析对象
    let inner = null;
    try { inner = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { return null; }
    if (!Array.isArray(inner) || !inner[0] || typeof inner[0] !== 'object') return null;
    // 封套随页次变化:首页 inner[0]['0'] 是字段定义树、行在 inner[0]['1'].c['2']['1'];
    // 续页是 {t:3028} 节点(c['1'] 为 subId),行在 inner[0]['0'].c['2']['1']——漏了这层就永远只读到第一页
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
            // 选项对照表:单选在键 "9" 下、17 类字段(批次/联系人等)在键 "17" 下,结构同为 {3:[{1:id,2:名称}]}
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
    // 日期字段没有文本分段,值是键 "4" 下的毫秒时间戳(10 位按秒)。日历日期按北京时区取日:
    // 智能表格把「9月11日」存为北京零点对应的 UTC 毫秒(前一日 16:00Z),直接 toISOString 会差一天
    if (!text && cell && typeof cell['4'] === 'string' && /^\d{10,13}$/.test(cell['4'])) {
      const n = Number(cell['4']);
      const ms = n > 1e11 ? n : n * 1000;
      text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    }
    return { text: text.trim(), link };
  };
  try {
    const meta = await apiFetchJson(`https://docs.qq.com/dop-api/opendoc?id=${encodeURIComponent(docId)}&outformat=1&normal=1`);
    // 两种响应形态:常规文档走 bodyData.localPadId;新式项目(isBlankPage/isNewProject)没有 bodyData,
    // padId 与标题在 clientVars 里——漏掉这层就报「没有文档信息」,实测可直接用于 get/sheet
    const bd = meta && meta.bodyData;
    const cv = meta && meta.clientVars;
    const localPadId = (bd && bd.localPadId) || (cv && cv.padId) || '';
    if (!localPadId) { out.needLogin = true; out.error = '没有读到文档信息——多半是未登录腾讯文档或无查看权限'; return out; }
    out.title = (bd && (bd.initialTitle || bd.pageTitle)) || (cv && cv.padTitle) || '';
    const fields = {};
    const fieldOptions = {};
    let fieldsReady = false;
    const collected = new Map();
    const step = 60;
    const limit = 5000; // 翻页行数上限(实际以响应 maxrow 为准,正常到最后一页即止)
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
      if (chunk.maxrow && start + step >= chunk.maxrow) break; // 响应自带总行数,读完最后一页即止
    }
    if (!fieldsReady) { out.needLogin = true; out.error = '没有读到表格结构——未登录、无权限或不是智能表格'; return out; }
    const fieldIds = Object.keys(fields);
    out.header = fieldIds.map((f) => fields[f]);
    for (const rowId of collected.keys()) {
      const cellsMap = (collected.get(rowId) && collected.get(rowId)['1']) || {};
      out.rows.push(fieldIds.map((fieldId) => {
        const cell = cellsMap[fieldId];
        // 选项类字段(单选 "9" / 17 类):单元格存选项 ID,用字段定义里的对照表还原成名称
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

// ===== docsqq 浏览器任务串行化:同一 profile 不并发开浏览器 =====
let docsChain = Promise.resolve();
const withDocsLock = (fn) => {
  const run = docsChain.then(fn, fn);
  docsChain = run.catch(() => {});
  return run;
};

// 试读一个文档源(不落库):返回表头/行数/映射/样例,供添加前人工确认
export function previewDocSource(url, { headed = false } = {}) {
  return withDocsLock(async () => {
    const parsed = parseDocUrl(url);
    if (!parsed) throw new Error('不是有效的腾讯智能表格链接（需 docs.qq.com/smartsheet/… 且带 tab 参数）');
    const ctx = await launch('docsqq', { headless: !headed });
    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(DOCS_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      const r = await page.evaluate(READ_SHEET, { docId: parsed.docId, subId: parsed.subId, viewId: parsed.viewId });
      if (r.needLogin) return { ok: false, error: r.error };
      if (!r.ok) return { ok: false, error: r.error || '读取文档失败' };
      const header = r.header.map(clean);
      const idx = {};
      header.forEach((name, i) => {
        const key = matchColumn(name);
        if (key && !(key in idx)) idx[key] = i;
      });
      const missing = ['company', 'position'].filter((k) => !(k in idx));
      const boardOk = !('company' in idx) && 'title' in idx; // 公告板型:公司嵌在公告标题里
      if (missing.length && !boardOk) {
        return { ok: false, error: `表头里没认出「公司/岗位」或「公告标题」列（现有列：${header.join('、') || '空'}）——请在文档里调整列名后重试`, header };
      }
      const keyCol = boardOk ? idx.title : null;
      const valid = r.rows.filter((cells) => keyCol !== null
        ? clean(cells[keyCol]?.text)
        : (clean(cells[idx.company]?.text) && clean(cells[idx.position]?.text)));
      return {
        ok: true, title: r.title, header, rowCount: valid.length, canonical: parsed.canonical,
        sample: valid.slice(0, 3).map((cells) => header.map((_, i) => clean(cells[i]?.text))),
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

// 添加用户文档源:试读确认后入库并立即同步一次。同一文档重复添加返回已有 id。
export async function addDocSource(url, { headed = false, log = () => {} } = {}) {
  const preview = await previewDocSource(url, { headed });
  if (!preview.ok) return preview;
  const st = readJobState();
  const dupe = st.sources.find((s) => s.type === 'doc' && parseDocUrl(s.url)?.docId === parseDocUrl(preview.canonical).docId);
  if (dupe) return { ok: false, error: '这份文档已经在岗位源列表里', id: dupe.id };
  const id = 'doc-' + stableJobId(preview.canonical, 'source', '').slice(4, 12);
  st.sources.push({ id, type: 'doc', url: preview.canonical, label: preview.title || '腾讯文档表', addedAt: nowIso() });
  saveJobState(st);
  log(`📋 岗位源已添加：${preview.title || preview.canonical}`);
  const r = await syncSource(id, { headed, log });
  return { ok: r.ok, id, count: r.count, error: r.error };
}

export function removeDocSource(id) {
  const st = readJobState();
  const src = st.sources.find((s) => s.id === id);
  if (!src) throw new Error('岗位源不存在');
  if (src.id === MAIN_DOC_ID) throw new Error('维护者主文档源不可删除（可用 ats jobs sync 更新）');
  if (src.type === 'manual') throw new Error('手动收录源不可删除（可在列表里逐条清理岗位）');
  st.sources = st.sources.filter((s) => s.id !== id);
  const before = st.jobs.length;
  st.jobs = st.jobs.filter((j) => j.src !== id);
  saveJobState(st);
  return { removed: src.label || id, jobsRemoved: before - st.jobs.length };
}

// 同步单个岗位源:pack=读远程/内置快照;doc=无头读取智能表格。分源整表替换,其他来源不动,标记保留。
export async function syncSource(id, { log = () => {}, headed = false } = {}) {
  const st = readJobState();
  const src = st.sources.find((s) => s.id === id);
  if (!src) throw new Error('岗位源不存在');
  const finish = (ok, extra = {}) => {
    st.lastSync = { at: nowIso(), count: st.jobs.length, error: ok ? null : (extra.error || '同步失败') };
    saveJobState(st);
    return { ok, source: id, count: st.jobs.length, ...extra };
  };
  if (src.type === 'pack') {
    try {
      const payload = await readPackSource(src.packUrl, log);
      const jobs = applyJobPack(payload, st.jobs.filter((j) => j.src === 'pack')).map((j) => ({ ...j, src: 'pack' }));
      const prevIds = new Set(st.jobs.filter((j) => j.src === 'pack').map((j) => j.id));
      const added = jobs.filter((j) => !prevIds.has(j.id)).length;
      const removed = st.jobs.filter((j) => j.src === 'pack' && !jobs.some((x) => x.id === j.id)).length;
      st.jobs = [...st.jobs.filter((j) => j.src !== 'pack'), ...jobs];
      if (payload.generatedAt) st.packAt = payload.generatedAt;
      return finish(true, { count: jobs.length, added, removed });
    } catch (e) {
      const msg = String(e?.message || e);
      log(`⚠️ 岗位包同步失败：${msg}`);
      return finish(false, { error: msg, needLogin: false });
    }
  }
  const parsed = parseDocUrl(src.url);
  if (!parsed) return finish(false, { error: '文档地址无效（需 docs.qq.com/smartsheet/… 含 tab 参数）' });
  const ctx = await launch('docsqq', { headless: !headed });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(DOCS_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const r = await page.evaluate(READ_SHEET, { docId: parsed.docId, subId: parsed.subId, viewId: parsed.viewId });
    if (r.needLogin) {
      log(`⚠️ ${src.label || '文档源'}：${r.error}`);
      return finish(false, { error: r.error, needLogin: true });
    }
    if (!r.ok) throw new Error(r.error || '读取文档失败');
    log(`📄 ${src.label || '文档源'} 表头：${r.header.map(clean).join('、')}`);
    const prev = st.jobs.filter((j) => j.src === id);
    const { jobs, error } = mapRowsToJobs(r.header, r.rows, prev);
    if (error) return finish(false, { error });
    const prevIds = new Set(prev.map((j) => j.id));
    const added = jobs.filter((j) => !prevIds.has(j.id)).length;
    const removed = prev.filter((j) => !jobs.some((x) => x.id === j.id)).length;
    st.jobs = [...st.jobs.filter((j) => j.src !== id), ...jobs.map((j) => ({ ...j, src: id }))];
    src.lastSync = { at: nowIso(), count: jobs.length, error: null };
    log(`📋 ${src.label || '岗位源'} 已同步：共 ${jobs.length} 条（新增 ${added}，移除 ${removed}）`);
    return finish(true, { count: jobs.length, added, removed });
  } catch (e) {
    const msg = String(e?.message || e);
    log(`⚠️ ${src.label || '文档源'} 同步失败：${msg}`);
    return finish(false, { error: msg });
  } finally {
    await ctx.close().catch(() => {});
  }
}

// 跨源去重:同一岗位(同 id)出现在多个来源时,保留 sources 列表顺序靠前的
function dedupeBySourceOrder(st) {
  const seen = new Set();
  for (const src of st.sources) {
    st.jobs = st.jobs.filter((j) => {
      if (j.src !== src.id) return true;
      if (seen.has(j.id)) return false;
      seen.add(j.id);
      return true;
    });
  }
}

// 同步全部岗位源(顺序执行);指定 id 时只同步该源
export async function syncJobs({ log = () => {}, headed = false, id } = {}) {
  const st = readJobState();
  const targets = id ? [id] : st.sources.map((s) => s.id);
  let failed = null;
  for (const tid of targets) {
    try {
      await syncSource(tid, { log, headed });
      const cur = readJobState();
      dedupeBySourceOrder(cur);
      saveJobState(cur);
    } catch (e) { failed = String(e?.message || e); }
  }
  const st2 = readJobState();
  return { ok: !failed, error: failed, count: st2.jobs.length, sources: st2.sources.length };
}

// 本地标记(已投/不投/关注):只写覆盖层,永不写回岗位源
export function setJobMark(id, patch) {
  const st = readJobState();
  if (!st.jobs.some((j) => j.id === id)) throw new Error('岗位不存在（可能已被同步移除）');
  const next = { ...(st.marks[id] || {}) };
  for (const k of ['applied', 'skip', 'star']) if (k in patch) next[k] = !!patch[k];
  next.at = nowIso();
  st.marks[id] = next;
  saveJobState(st);
  return next;
}

// 编辑岗位条目:仅限本机自有源(manual 手动收录 / import 台账导入)——同步镜像源(doc/pack)整表替换,本机改了必被覆盖,拒绝
export function updateJob(id, patch = {}) {
  const st = readJobState();
  const job = st.jobs.find((j) => j.id === id);
  if (!job) throw new Error('岗位不存在（可能已被同步移除）');
  const src = st.sources.find((s) => s.id === job.src);
  if (!src || (src.type !== 'manual' && src.type !== 'import')) {
    throw new Error('该岗位来自同步源（腾讯文档/岗位包），本机编辑会在下次同步时被覆盖——请直接修改上游表格');
  }
  if (patch.company !== undefined) {
    const c = clean(patch.company);
    if (!c) throw new Error('公司不能为空');
    job.company = c;
  }
  if (patch.position !== undefined) {
    const p = clean(patch.position);
    if (!p) throw new Error('岗位不能为空');
    job.position = p;
  }
  if (patch.city !== undefined) job.city = clean(patch.city);
  if (patch.deadlineRaw !== undefined) {
    const raw = clean(patch.deadlineRaw);
    const d = parseDeadline(raw);
    job.deadline = d;
    job.deadlineRaw = d === raw ? '' : raw; // 标准日期无需存原文
  }
  if (patch.link !== undefined) job.link = normalizeUrl(patch.link);
  for (const k of ['note', 'referralCode', 'referrer', 'batch']) {
    if (patch[k] !== undefined) job[k] = clean(patch[k]);
  }
  job.updatedAt = nowIso();
  saveJobState(st);
  return job;
}

// 识别收录入库:岗位进「手动收录」源(src='manual'),同 id(公司|岗位|链接)重复收录=整行更新
export function saveCapturedJob({ company, position, city, link }) {
  const st = readJobState();
  company = clean(company);
  position = clean(position);
  if (!company || !position) throw new Error('公司与岗位不能为空');
  const url = normalizeUrl(link);
  const id = stableJobId(company, position, url);
  const prev = st.jobs.find((j) => j.id === id);
  const job = {
    id, company, position, link: url,
    city: clean(city), deadline: '', deadlineRaw: '',
    note: prev?.note || '', referralCode: prev?.referralCode || '', referrer: prev?.referrer || '', batch: prev?.batch || '',
    addedAt: prev?.addedAt || nowIso(),
    updatedAt: nowIso(),
    src: 'manual',
  };
  st.jobs = prev ? st.jobs.map((j) => (j.id === id ? job : j)) : [...st.jobs, job];
  const manual = st.sources.find((s) => s.id === 'manual');
  if (manual) manual.lastSync = { at: nowIso(), count: st.jobs.filter((j) => j.src === 'manual').length, error: null };
  saveJobState(st);
  return { id, updated: !!prev };
}

// ===== 登录通道:docsqq profile 扫码一次,全部文档源读取升级为「该账号可见的一切」 =====
// (公开表匿名可读;仅自己/仅成员可见的表需要这一步。登录态落持久 profile,关窗即存)
export async function openDocsLogin(log = () => {}) {
  const { launch: launchBrowser } = await import('./session.mjs');
  const ctx = await launchBrowser('docsqq', { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(DOCS_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  log('已打开腾讯文档：请扫码/登录后关闭该窗口——登录态会保存，之后同步/试读会带上它');
  return {
    async close() { await ctx.close().catch(() => {}); },
  };
}

// ===== 岗位包(对外分发的岗位快照;只含维护者主文档源,不含文档地址与本地标记) =====

// 链接里的内推参数(recommendCode/referralCode 只是归属标记,去掉不影响投递);
// SPA 路由的查询串常挂在 hash 里(#/path?referralCode=…),两处都要洗
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

// 从主文档源构建岗位包。默认剥离 referralCode/referrer 字段并清洗链接里的内推参数
// (内推是别人给的资源,不随开源扩散),ID 按清洗后的内容重算——文档里换内推码不会让包使用方的岗位 ID 漂移。
// --full 保留全部原始内容。
export function buildJobPack({ full = false } = {}) {
  const st = readJobState();
  const mainJobs = st.jobs.filter((j) => j.src === MAIN_DOC_ID);
  if (!mainJobs.length) throw new Error('主文档源没有岗位——先在维护者机器上 ats jobs sync');
  let stripped = 0;
  const jobs = mainJobs.map((j) => {
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

// 岗位包落盘(默认仓库根目录 jobs-pack.json,随仓库/安装包分发)
export function writeJobPack({ full = false, out } = {}) {
  const { pack, stripped } = buildJobPack({ full });
  const target = out || BUNDLED_PACK;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pack, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return { target, count: pack.count, stripped };
}

// 读岗位包:远程优先(默认公开仓库的 raw 直链,维护者 push 后用户点同步即最新),失败回落本地内置包(离线可用)
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

// 校验并应用岗位包:白名单字段、缺 id 重算、按 id 去重、保留既有 addedAt
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

// ===== 发布防呆 + 自动发布流水线(维护者;只消费主文档源) =====

// 发布防呆:绝对下限 + 相对上一版跌幅过半即拦截——文档被清空/误删时绝不把坏包发出去
export function evaluatePublish({ count, prevCount, minCount = 100 } = {}) {
  if (!Number.isFinite(count) || count < minCount) return { ok: false, reason: `岗位数 ${count ?? '无'} 低于发布下限 ${minCount}` };
  if (Number.isFinite(prevCount) && prevCount > 0 && count < prevCount * 0.5) {
    return { ok: false, reason: `岗位数从 ${prevCount} 骤降到 ${count}（超过一半），疑似文档异常` };
  }
  return { ok: true };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

// 发布岗位包:同步主文档源 → 防呆 → 导出 → 只提交 jobs-pack.json(工作区其他改动不掺和) → 推送当前分支。
// push:false 时只提交本地(--no-push:先人工确认再手动推)。推送失败时已提交本地,靠返回值/通知提醒人工补推。
export async function publishJobs({ log = () => {}, minCount, push = true } = {}) {
  const st0 = readJobState();
  if (!st0.sources.some((s) => s.type === 'doc' && s.id === MAIN_DOC_ID)) {
    throw new Error('只有维护者（配有主文档源）的机器能发布岗位包');
  }
  const r = await syncSource(MAIN_DOC_ID, { log });
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
