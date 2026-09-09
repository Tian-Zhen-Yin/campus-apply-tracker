// 单元测试:合并逻辑 / 身份键 / 修正覆盖层 / 邮件关联 / 邮件行 id。
// 运行:npm test(node --test)。涉及文件的用例使用独立临时 ATS_STATUS_HOME,互不沾真实数据。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
process.env.ATS_STATUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-test-'));

const { mergePageHits } = await import(`${SRC}status.mjs`);
const { recordKey, extractApplications, normalizeStatus } = await import(`${SRC}extract.mjs`);
const { setCorrection, setArchived, applyToRecords, readCorrections, readArchived } = await import(`${SRC}corrections.mjs`);
const { enrichMailRows, bindMail, unbindMail, candidatesFor } = await import(`${SRC}maillinks.mjs`);
const { mailId, classifyMail, extractScheduleTip } = await import(`${SRC}mail.mjs`);

const ex = (t) => extractApplications(t);
const one = (job, dept, status) => JSON.stringify({ content: [{ jobName: job, deptName: dept, statusName: status }] });

test('mergePageHits:重复记录保留最新状态,翻页合并不丢', () => {
  const r = mergePageHits([one('J', 'D', '笔试通过'), one('J', 'D', '面试中')], ex);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].statusRaw, '面试中', '新命中优先');
  assert.equal(ex(r.text).records[0].statusRaw, '面试中', 'bestText 取最新有效命中');
  const p = mergePageHits([one('A', '', 'x'), one('B', '', 'y')], ex);
  assert.equal(p.records.length, 2, '不同岗位跨命中合并');
});

test('recordKey:岗位+部门构成身份;同名不同部门是两条', () => {
  assert.equal(recordKey({ job: 'J', dept: 'D' }), 'J|D');
  assert.equal(recordKey({ job: 'J' }), 'J|');
  const r = mergePageHits([one('J', 'd1', 'x')], ex);
  assert.equal(r.records.length, 1);
});

test('修正覆盖层:双键兼容(部门键优先,旧 site|job 键兜底,还原清双键)', () => {
  const recs = [{ job: 'J', dept: 'd1' }, { job: 'J', dept: 'd2' }];
  setCorrection('kuaishou', 'J', 'OFFER'); // 旧式无部门写入
  let out = applyToRecords('kuaishou', recs);
  assert.equal(out.filter((x) => x.corrected).length, 2, '旧键对同名两条都生效');
  setCorrection('kuaishou', 'J', 'TEST', 'd2');
  out = applyToRecords('kuaishou', recs);
  assert.equal(out.find((x) => x.dept === 'd2').status, 'TEST', '部门键优先');
  assert.equal(out.find((x) => x.dept === 'd1').status, 'OFFER', '其余回落旧键');
  setCorrection('kuaishou', 'J', null, 'd2');
  assert.ok(!readCorrections()['kuaishou|J|d2'] && !readCorrections()['kuaishou|J'], '还原清双键');
  setArchived('kuaishou', 'J', true, 'd1');
  assert.ok(readArchived()['kuaishou|J|d1']);
  setArchived('kuaishou', 'J', false, 'd1');
});

test('邮件关联:无歧义自动/歧义给候选/平台系标签永不自动/绑定校验部门', () => {
  fs.mkdirSync(path.join(process.env.ATS_STATUS_HOME, 'out'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ATS_STATUS_HOME, 'out', 'kuaishou.json'),
    JSON.stringify({ records: [{ job: 'J1' }, { job: 'J1', dept: 'D' }] }), 'utf8');
  fs.writeFileSync(path.join(process.env.ATS_STATUS_HOME, 'out', 'xiaohongshu.json'),
    JSON.stringify({ records: [{ job: '唯一岗' }] }), 'utf8');
  const xhs = { company: '小红书' };
  assert.equal(enrichMailRows([xhs])[0].link?.site, 'xiaohongshu', '唯一记录自动关联');
  const ks = { company: '快手' };
  let e = enrichMailRows([ks])[0];
  assert.equal(e.link, null);
  assert.equal(e.candidates.length, 2, '同名两条给候选');
  assert.equal(candidatesFor('Moka 系（携程/知乎等）').length, 0, '平台系标签不自动关联');
  const m = { id: 'mail|x', company: '快手' };
  bindMail(m.id, { kind: 'site', site: 'kuaishou', company: '快手', job: 'J1', dept: 'D' });
  assert.equal(enrichMailRows([m])[0].link?.dept, 'D', '绑定可指定部门');
  assert.throws(() => bindMail('mail|y', { kind: 'site', site: 'kuaishou', company: '快手', job: 'J1', dept: '幽灵' }), /不存在/);
  unbindMail(m.id);
});

test('mailId 幂等且随内容变化;classifyMail 噪声过滤', () => {
  const r = { at: 't', from: 'f', subject: 's' };
  assert.equal(mailId(r), mailId({ ...r }));
  assert.notEqual(mailId(r), mailId({ ...r, subject: 's2' }));
  assert.equal(classifyMail({ fromAddr: 'x', fromName: '', subject: '登录提醒验证码' }), null);
  assert.equal(classifyMail({ fromAddr: 'campus@kuaishou.com', fromName: '', subject: '面试邀请' }).kind, 'INTERVIEW');
});

test('extractScheduleTip:日期+时间齐全才产出', () => {
  const tip = extractScheduleTip('面试安排:2026年9月12日 15:30 腾讯会议', new Date('2026-09-10'));
  assert.equal(tip?.kind, '面试');
  assert.equal(tip?.iso, '2026-09-12T15:30');
  assert.equal(tip?.place, '腾讯会议');
  assert.equal(extractScheduleTip('面试详见邮件正文', new Date('2026-09-10')), null, '无时间不产出');
});

test('normalizeStatus 中文归一', () => {
  assert.equal(normalizeStatus('已投递'), 'APPLIED');
  assert.equal(normalizeStatus('面试未通过'), 'REJECTED');
});
