// 人工修正覆盖层：官网抓取的状态偶有识别错误，允许用户在控制台手动改。
// 修正存独立文件（不写回抓取结果），下次自动抓取不会冲掉；删除修正即恢复官网原状。
import fs from 'node:fs';
import { correctionsFile } from './paths.mjs';

export const STATUS_LABELS = {
  APPLIED: '已投递', VIEWED: '已查看', SCREENING: '评估中', TEST: '笔试',
  INTERVIEW1: '面试', INTERVIEW2: '复试', HRFACE: 'HR面', OFFER: 'Offer',
  CLOSED: '已结束', REJECTED: '不合适', TALENT: '人才池', UNKNOWN: '未知',
};

export const STATUS_CHOICES = Object.entries(STATUS_LABELS).map(([code, label]) => ({ code, label }));

const readFile = () => {
  try { return JSON.parse(fs.readFileSync(correctionsFile(), 'utf8')); } catch { return {}; }
};
const readAll = () => readFile().corrections || {};

export function readCorrections() {
  return readFile().corrections || {};
}

// 归档覆盖层：不再关心的记录（如往届投递）从控制台总览隐藏。
// 与修正同存一个文件、同用 site|job 键；不写回抓取结果，不影响状态包，可随时取消归档。
export function readArchived() {
  return readFile().archived || {};
}

export function isValidStatus(code) {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, code);
}

// 两层覆盖一起落盘：只写其中一层会冲掉另一层
function saveOverlay(corrections, archived) {
  fs.mkdirSync(correctionsFile().replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(correctionsFile(), JSON.stringify({ corrections, archived }, null, 2));
}

// 覆盖层键：无部门 site|job（历史格式），有部门 site|job|dept（同名岗位投不同部门时区分）。
// 读取先查带部门键再回退旧键——存量按岗位存的修正/归档不失效；写入/删除两种键都清。
const keyOf = (site, job, dept) => (dept ? `${site}|${job}|${dept}` : `${site}|${job}`);
const legacyKey = (site, job) => `${site}|${job}`;

// 设置/删除一条修正；dept 用于同名岗位多部门时的区分
export function setCorrection(site, job, status, dept = '') {
  const all = readAll();
  const key = keyOf(site, job, dept);
  if (status === null) {
    delete all[key];
    delete all[legacyKey(site, job)];
  } else {
    if (!isValidStatus(status)) throw new Error(`未知状态码 ${status}`);
    all[key] = { status, statusRaw: STATUS_LABELS[status], at: new Date().toISOString() };
  }
  saveOverlay(all, readArchived());
  return all[key] || null;
}

// 归档/取消归档一条记录（可逆；底层抓取文件照常更新）
export function setArchived(site, job, archived, dept = '') {
  const arc = readArchived();
  const key = keyOf(site, job, dept);
  if (archived) arc[key] = new Date().toISOString();
  else { delete arc[key]; delete arc[legacyKey(site, job)]; }
  saveOverlay(readAll(), arc);
  return !!arc[key];
}

// 对单站抓取记录应用修正（返回新数组，不改原对象）
export function applyToRecords(site, records) {
  const all = readCorrections();
  if (!records || !Array.isArray(records)) return records;
  return records.map((r) => {
    const fix = all[keyOf(site, r.job, r.dept)] || all[legacyKey(site, r.job)];
    return fix ? { ...r, status: fix.status, statusRaw: fix.statusRaw, corrected: true } : r;
  });
}
