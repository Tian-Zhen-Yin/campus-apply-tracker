// 台账迁移:把「校招投递管理」(campus-recruitment-tracker)的数据迁移进控制台。
// 两种入口共用本模块——文件式(台账「导出数据」的 JSON,仅含投递记录)与
// 一键式(托管台账页内按钮,带完整岗位库)。映射(ADR-0006 追记三):
//   台账投递记录 → apps.json 手工登记(按 公司|岗位 幂等:已存在=更新阶段/日期/链接);
//   台账岗位库   → 专用岗位源 tracker-import(整桶替换,可一键移除),排在源列表末位
//                  (跨源去重时现有源优先,不会与已有岗位重复显示);
//   岗位 skip    → 控制台岗位标记(按迁移时重算的岗位 id 写入,保留)。
// 台账的 syncKey/绑定/同步状态不迁移——控制台侧用户重新拍板即可,迁移会制造幽灵关联。
import fs from 'node:fs';
import { appsFile } from './paths.mjs';
import { readJson, writeJson, nowIso } from './util.mjs';
import { readJobState, saveJobState, stableJobId, parseDeadline, normalizeUrl } from './jobs.mjs';
import { readApps } from './apps.mjs';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const IMPORT_SOURCE = { id: 'tracker-import', type: 'import', label: '台账岗位库' };

// 解析台账侧载荷:兼容导出文件 envelope({schemaVersion,appVersion,records}) 与一键载荷({records, jobPool})
export function parseTrackerPayload(payload) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!data || typeof data !== 'object') throw new Error('不是有效的台账数据（JSON 解析失败）');
  const records = Array.isArray(data.records) ? data.records : null;
  if (!records) throw new Error('没找到投递记录——请用台账「导出数据」生成的文件,或用台账里的「迁移到控制台」按钮');
  return {
    records,
    jobPool: Array.isArray(data.jobPool) ? data.jobPool : [],
    from: Array.isArray(data.jobPool) && data.jobPool.length ? 'one-click' : 'file',
  };
}

// 记录 → apps 条目(幂等:同 公司|岗位 已存在则更新,否则追加)
function mergeApps(incoming) {
  const apps = readApps();
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    const company = clean(r.company);
    const job = clean(r.position);
    if (!company || !job) continue;
    const entry = {
      company, job,
      statusRaw: clean(r.stage),
      appliedAt: clean(r.applicationDate),
      link: normalizeUrl(r.applicationUrl),
    };
    const hit = apps.find((a) => clean(a.company) === company && clean(a.job) === job);
    if (hit) {
      Object.assign(hit, { statusRaw: entry.statusRaw || hit.statusRaw, appliedAt: entry.appliedAt || hit.appliedAt, link: entry.link || hit.link });
      updated += 1;
    } else {
      apps.push({ ...entry, status: '', addedAt: nowIso() });
      added += 1;
    }
  }
  if (added || updated) writeJson(appsFile(), apps);
  return { added, updated };
}

// 岗位库 → tracker-import 源(整桶替换,幂等),skip → 岗位标记
function mergeJobPool(pool) {
  const st = readJobState();
  if (!st.sources.some((s) => s.id === IMPORT_SOURCE.id)) st.sources.push({ ...IMPORT_SOURCE, addedAt: nowIso() });
  const before = st.jobs.length;
  st.jobs = st.jobs.filter((j) => j.src !== IMPORT_SOURCE.id);
  let imported = 0;
  let skipped = 0;
  for (const j of pool) {
    const company = clean(j.company);
    const position = clean(j.position);
    if (!company || !position) continue;
    const link = normalizeUrl(j.applicationUrl);
    const deadlineRaw = clean(j.deadline);
    const job = {
      id: stableJobId(company, position, link),
      company, position, link,
      city: clean(j.city), deadline: parseDeadline(deadlineRaw), deadlineRaw,
      note: clean(j.industry), referralCode: '', referrer: '', batch: clean(j.category),
      addedAt: clean(j.addedAt) || nowIso(),
      updatedAt: nowIso(),
      src: IMPORT_SOURCE.id,
    };
    st.jobs.push(job);
    imported += 1;
    if (j.skip === true) {
      st.marks[job.id] = { ...(st.marks[job.id] || {}), skip: true, at: nowIso() };
      skipped += 1;
    }
  }
  const src = st.sources.find((s) => s.id === IMPORT_SOURCE.id);
  src.lastSync = { at: nowIso(), count: imported, error: null };
  saveJobState(st);
  return { imported, skipped, jobsReplaced: before - (st.jobs.length - imported) };
}

export function importTrackerPayload(payload) {
  const { records, jobPool } = parseTrackerPayload(payload);
  const appsResult = mergeApps(records);
  const poolResult = jobPool.length ? mergeJobPool(jobPool) : { imported: 0, skipped: 0, jobsReplaced: 0 };
  return {
    ok: true,
    recordsAdded: appsResult.added,
    recordsUpdated: appsResult.updated,
    jobsImported: poolResult.imported,
    skipMarks: poolResult.skipped,
    withJobPool: jobPool.length > 0,
  };
}
