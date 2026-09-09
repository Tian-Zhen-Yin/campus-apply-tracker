// 邮件事件 ↔ 投递记录 的关联层。术语见 CONTEXT.md（挂载/绑定/歧义/未关联池），
// 取舍见 ADR-0003：只挂载不回写；自动匹配仅在公司无歧义（恰好一条投递记录）时成立。
import fs from 'node:fs';
import path from 'node:path';
import { SITES, COMPANY_ALIASES } from './config.mjs';
import { readApps } from './apps.mjs';
import { HOME, outFile } from './paths.mjs';
import { readJson, writeJson } from './util.mjs';
import { readMailLog } from './mail.mjs';

const linksFile = () => path.join(HOME, 'mail-links.json');

// 平台系标签：一个标签罩多家公司（如「Moka 系（携程/知乎等）」），永不自动关联
const isPlatformLabel = (c) => /系（/.test(String(c || ''));
const norm = (s) => String(s || '').trim().toLowerCase();

// 当前全部可作为关联目标的投递记录：自动站点 + 手工登记（apps.json）。
// dept 参与目标身份：同名岗位投不同部门（阿里）是两条不同的投递。
export function recordTargets() {
  const targets = [];
  for (const [site, cfg] of Object.entries(SITES)) {
    const data = readJson(outFile(site));
    if (!data || !Array.isArray(data.records)) continue;
    for (const r of data.records) {
      if (!r || !r.job) continue;
      targets.push({ kind: 'site', site, company: cfg.label, job: String(r.job), dept: String(r.dept || '') });
    }
  }
  for (const a of readApps()) {
    if (!a || !a.job) continue;
    targets.push({ kind: 'apps', company: String(a.company || ''), job: String(a.job), dept: '' });
  }
  return targets;
}

// 公司级匹配：严格别名/精确同串（大小写与首尾空白不敏感）
export function candidatesFor(mailCompany, targets = recordTargets()) {
  if (isPlatformLabel(mailCompany)) return [];
  return targets.filter((t) => {
    if (t.kind === 'site') {
      const aliases = [t.company, ...(COMPANY_ALIASES[t.site] || [])];
      return aliases.some((a) => norm(a) === norm(mailCompany));
    }
    return norm(t.company) === norm(mailCompany);
  });
}

const sameTarget = (a, b) => a.kind === b.kind && String(a.job) === String(b.job) && String(a.dept || '') === String(b.dept || '')
  && (a.kind === 'site' ? a.site === b.site : norm(a.company) === norm(b.company));

function readBindings() {
  try { return JSON.parse(fs.readFileSync(linksFile(), 'utf8')).bindings || {}; } catch { return {}; }
}
function writeBindings(b) {
  writeJson(linksFile(), { version: 1, bindings: b });
}

// 人工绑定：目标必须是当前存在的投递记录（绑定到已消失的岗位没有意义）
export function bindMail(id, target) {
  if (!id) throw new Error('需要邮件 id');
  if (!recordTargets().some((t) => sameTarget(t, target))) throw new Error('目标投递记录不存在（先查状态或登记）');
  const b = readBindings();
  b[id] = { kind: target.kind, site: target.site || '', company: target.company || '', job: target.job, dept: String(target.dept || '') };
  writeBindings(b);
  return b[id];
}
export function unbindMail(id) {
  const b = readBindings();
  delete b[id];
  writeBindings(b);
}

// 给邮件行补关联信息：link（人工绑定优先，其次无歧义自动命中）或 candidates（待人工选）
export function enrichMailRows(rows) {
  const bindings = readBindings();
  const targets = recordTargets();
  const cache = new Map();
  const cands = (company) => {
    if (!cache.has(company)) cache.set(company, candidatesFor(company, targets));
    return cache.get(company);
  };
  return rows.map((row) => {
    if (!row) return row;
    const manual = row.id ? bindings[row.id] : null;
    if (manual) return { ...row, link: { src: 'manual', ...manual } };
    const list = cands(row.company);
    if (list.length === 1) return { ...row, link: { src: 'auto', ...list[0] } };
    return { ...row, link: null, candidates: list.slice(0, 10) };
  });
}

// 状态包用：最近邮件事件及其关联（只读快照，不动 updates/records 语义）
export function buildMailEvents(limit = 30) {
  return enrichMailRows(readMailLog(limit)).filter(Boolean).map(({ id, at, company, kind, subject, link, tip }) => ({
    id, at, company, kind,
    subject: String(subject || '').slice(0, 80),
    linkedTo: link ? { kind: link.kind, site: link.site || '', company: link.company, job: link.job, dept: String(link.dept || '') } : null,
    tip: tip || null,
  }));
}
