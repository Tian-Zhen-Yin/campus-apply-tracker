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
const { parseDocUrl, stableJobId, parseDeadline, mapRowsToJobs, setJobMark, readJobState, saveJobState, buildJobPack, applyJobPack, readPackSource, evaluatePublish, recentJobs, removeDocSource, syncSource } = await import(`${SRC}jobs.mjs`);

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

// ===== 岗位库（岗位源：腾讯智能表格；jobs.json 落在临时 ATS_STATUS_HOME）=====

test('parseDocUrl: 只认智能表格且必须带 tab，剥噪声参数', () => {
  const p = parseDocUrl('https://docs.qq.com/smartsheet/DTkRMUVhoUWJXZEhJ?tab=tTNjGc&login_t=1789059829896&viewId=vmLdET');
  assert.equal(p.docId, 'DTkRMUVhoUWJXZEhJ');
  assert.equal(p.subId, 'tTNjGc');
  assert.equal(p.viewId, 'vmLdET');
  assert.equal(p.canonical, 'https://docs.qq.com/smartsheet/DTkRMUVhoUWJXZEhJ?tab=tTNjGc&viewId=vmLdET');
  assert.equal(parseDocUrl('https://docs.qq.com/sheet/abc?tab=x'), null, '普通在线表格不支持');
  assert.equal(parseDocUrl('https://example.com/smartsheet/a?tab=b'), null, '外域不支持');
  assert.equal(parseDocUrl('https://docs.qq.com/smartsheet/a'), null, '缺 tab 不算');
  assert.equal(parseDocUrl(''), null);
});

test('stableJobId: 内容不变 id 不变，链接一变即变', () => {
  assert.equal(stableJobId('字节', '算法', 'https://a.com'), stableJobId('字节', '算法', 'https://a.com'));
  assert.notEqual(stableJobId('字节', '算法', 'https://a.com'), stableJobId('字节', '算法', 'https://b.com'));
  assert.ok(stableJobId('字节', '算法', '').startsWith('job-'));
});

test('parseDeadline: 常见写法归一，认不出返回空串', () => {
  const now = new Date('2026-09-11T12:00:00');
  assert.equal(parseDeadline('2026-10-31', now), '2026-10-31');
  assert.equal(parseDeadline('2026/10/31 23:59', now), '2026-10-31');
  assert.equal(parseDeadline('2026 06 30', now), '2026-06-30', '空格分隔');
  assert.equal(parseDeadline('2026年10月31日', now), '2026-10-31');
  assert.equal(parseDeadline('2026-10', now), '2026-10-31', '年月归月底');
  assert.equal(parseDeadline('10月底', now), '2026-10-31');
  assert.equal(parseDeadline('10-31', now), '2026-10-31');
  assert.equal(parseDeadline('1-15', now), '2027-01-15', '无年份已过则顺延一年');
  assert.equal(parseDeadline('尽快', now), '');
  assert.equal(parseDeadline('', now), '');
});

test('mapRowsToJobs: 固定列精确映射 + 别名兜底 + 残行跳过 + 同 id 去重 + addedAt 保留', () => {
  const header = ['公司', '岗位', '城市', '截止时间', '投递链接', '备注'];
  const rows = [
    [{ text: '字节' }, { text: '大模型算法' }, { text: '北京' }, { text: '2026-10-31' }, { text: '点此投递', link: 'https://docs.qq.com/link?url=https%3A%2F%2Fjobs.bytedance.com' }, { text: 'Seed 计划' }],
    [{ text: '' }, { text: '没填公司的行' }, { text: '' }, { text: '' }, {}, { text: '残行应被跳过' }],
    [{ text: '米哈游' }, { text: '算法工程师' }, { text: '上海' }, { text: '10月底' }, { text: 'https://mihoyo.com/campus', link: '' }, { text: '' }],
    [{ text: '字节' }, { text: '大模型算法' }, { text: '北京' }, { text: '2026-10-31' }, { text: '点此投递', link: 'https://docs.qq.com/link?url=https%3A%2F%2Fjobs.bytedance.com' }, { text: '与第 1 行同内容，应去重' }],
  ];
  const first = mapRowsToJobs(header, rows);
  assert.ok(!first.error, first.error);
  assert.equal(first.jobs.length, 2, '残行跳过、同 id 去重');
  const bytedance = first.jobs.find((j) => j.company === '字节');
  assert.equal(bytedance.link, 'https://jobs.bytedance.com', 'docs.qq.com/link 跳转包装解包');
  assert.equal(bytedance.deadline, '2026-10-31');
  assert.equal(first.jobs.find((j) => j.company === '米哈游').deadline, '2026-10-31');
  const again = mapRowsToJobs(header, rows, first.jobs);
  assert.equal(again.jobs.find((j) => j.company === '字节').addedAt, bytedance.addedAt, '重同步同内容保留入库时间');
  const alias = mapRowsToJobs(
    ['公司名称', '招聘岗位', '工作地点', '招聘截止日期', '投递链接or推文', '备注', '内推码', '内推联系人', '批次', '更新日期'],
    [[{ text: '百度' }, { text: '机器学习' }, { text: '北京' }, { text: '2026-11-30' }, { text: 'https://talent.baidu.com' }, { text: '重点' }, { text: 'NT2026' }, { text: '张三' }, { text: '正式批' }, { text: '2026-09-10T08:00:00.000Z' }]],
  );
  assert.ok(!alias.error, alias.error);
  assert.equal(alias.jobs[0].city, '北京');
  assert.equal(alias.jobs[0].deadline, '2026-11-30');
  assert.equal(alias.jobs[0].link, 'https://talent.baidu.com');
  assert.equal(alias.jobs[0].note, '重点', '备注列只存原始备注');
  assert.equal(alias.jobs[0].referralCode, 'NT2026', '内推信息结构化保存');
  assert.equal(alias.jobs[0].referrer, '张三');
  assert.equal(alias.jobs[0].batch, '正式批');
  assert.equal(alias.jobs[0].updatedAt, '2026-09-10T08:00:00.000Z', '更新日期列映射为 updatedAt');
  // 文档没填更新日期的行（同 id 内容不变）：回落到上次同步值，不随同步漂移
  const noUpdRow = [{ text: '百度' }, { text: '机器学习' }, { text: '北京' }, { text: '2026-11-30' }, { text: 'https://talent.baidu.com' }, { text: '重点' }, { text: 'NT2026' }, { text: '张三' }, { text: '正式批' }];
  const noUpd = mapRowsToJobs(['公司名称', '招聘岗位', '工作地点', '招聘截止日期', '投递链接or推文', '备注', '内推码', '内推联系人', '批次'], [noUpdRow], alias.jobs).jobs[0];
  assert.equal(noUpd.id, alias.jobs[0].id, '同内容同 id');
  assert.equal(noUpd.updatedAt, '2026-09-10T08:00:00.000Z', '同 id 沿用上次值');
  assert.ok(mapRowsToJobs(['列甲', '列乙'], [[{ text: 'x' }]]).error, '公司/岗位认不出宁缺毋滥');
});

test('岗位标记:覆盖层独立于岗位内容,重同步整表替换后仍保留', () => {
  saveJobState({ docUrl: 'https://docs.qq.com/smartsheet/AbCd1234?tab=Tab1', lastSync: null, jobs: [{ id: 'job-x', company: 'A', position: 'P' }], marks: {} });
  setJobMark('job-x', { applied: true, star: true });
  // 模拟重同步：岗位整表替换，marks 不动
  const st2 = readJobState();
  st2.jobs = [{ id: 'job-y', company: 'B', position: 'Q' }];
  saveJobState(st2);
  assert.equal(readJobState().marks['job-x'].applied, true, '旧岗位的标记保留');
  assert.throws(() => setJobMark('job-ghost', { skip: true }), /不存在/);
});

test('岗位包:默认剥离内推码/联系人并清洗链接内推参数(--full 保留),应用端白名单清洗、保 addedAt、拒非法包', () => {
  saveJobState({
    source: 'doc', docUrl: 'https://docs.qq.com/smartsheet/AbCd1234?tab=Tab1', lastSync: null, marks: { 'job-a': { applied: true } },
    jobs: [
      { id: 'job-a', company: 'A公司', position: '算法', link: 'https://app.mokahr.com/x/123?recommendCode=DS123&lang=zh#/jobs', note: '备注x', referralCode: 'NT1', referrer: '张三', batch: '正式批', deadline: '2026-10-31', deadlineRaw: '2026-10-31', city: '北京', addedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-10T08:00:00.000Z' },
      { id: 'job-b', company: 'B公司', position: '工程', link: '', note: '', referralCode: '', referrer: '', batch: '', addedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' },
    ],
  });
  const { pack, stripped } = buildJobPack({});
  assert.equal(pack.kind, 'campus-apply-tracker-job-pack');
  assert.equal(pack.count, 2);
  assert.equal(stripped, 1, '一条含内推信息被剥离');
  assert.ok(!('referralCode' in pack.jobs[0]) && !('referrer' in pack.jobs[0]), '默认剥离内推码/联系人字段');
  assert.ok(!/recommendcode/i.test(pack.jobs[0].link), '链接里的内推参数一并清洗');
  assert.ok(/lang=zh/.test(pack.jobs[0].link), '无关参数保留');
  assert.notEqual(pack.jobs[0].id, 'job-a', 'ID 按清洗后内容重算');
  assert.equal(pack.jobs[0].batch, '正式批', '批次保留');
  assert.equal(pack.jobs[0].note, '备注x');
  const fullPack = buildJobPack({ full: true }).pack;
  assert.equal(fullPack.jobs[0].referralCode, 'NT1', '--full 保留字段');
  assert.ok(/recommendCode=DS123/.test(fullPack.jobs[0].link), '--full 保留原始链接');
  const applied = applyJobPack(pack, [{ id: pack.jobs[0].id, addedAt: '2026-09-01T00:00:00.000Z' }]);
  assert.equal(applied.length, 2);
  assert.equal(applied[0].addedAt, '2026-09-01T00:00:00.000Z', '重同步保留入库时间');
  assert.ok(!applied[0].referrer, '应用端同样不带内推联系人');
  assert.throws(() => applyJobPack({ kind: '别的' }), /不是有效的岗位包/);
  const rebuilt = applyJobPack({ kind: 'campus-apply-tracker-job-pack', jobs: [{ company: 'C公司', position: 'P岗' }, { position: '没公司的行' }] });
  assert.equal(rebuilt.length, 1, '缺公司跳过');
  assert.ok(rebuilt[0].id.startsWith('job-'), '缺 id 按内容重算');
});

test('岗位源推断:全新用户走岗位包,只有 docUrl 视为维护者文档,v2 以 sources 数组为准', () => {
  fs.rmSync(path.join(process.env.ATS_STATUS_HOME, 'jobs.json'), { force: true });
  assert.equal(readJobState().source, 'pack', '全新用户默认岗位包');
  saveJobState({ docUrl: 'https://docs.qq.com/smartsheet/X1?tab=Y1', lastSync: null, jobs: [], marks: {} });
  assert.equal(readJobState().source, 'doc', '旧数据(仅 docUrl)兼容为文档模式');
  saveJobState({ version: 2, sources: [{ id: 'pack', type: 'pack' }], docUrl: 'https://docs.qq.com/smartsheet/X1?tab=Y1', lastSync: null, jobs: [], marks: {} });
  assert.equal(readJobState().source, 'pack', 'v2 以 sources 数组为唯一事实,docUrl 仅作遗留字段');
});

test('多源模型:分源同步只替换本源岗位,标记与他源保留;跨源同 id 靠前来源优先;移除源不伤标记', async () => {
  // 需要真实 fetch 拉远程/内置包:本地造一个假远程失败→回落内置包(若内置包不存在则注入)
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('离线'); };
  try {
    saveJobState({
      version: 2,
      sources: [
        { id: 'doc', type: 'doc', url: 'https://docs.qq.com/smartsheet/Main?tab=M1', label: '我的岗位表', addedAt: now(0) },
        { id: 'pack', type: 'pack' },
        { id: 'doc-user1', type: 'doc', url: 'https://docs.qq.com/smartsheet/U1?tab=T1', label: '同学的表', addedAt: now(0) },
        { id: 'doc-user2', type: 'doc', url: 'https://docs.qq.com/smartsheet/U2?tab=T2', label: '另一张表', addedAt: now(0) },
      ],
      lastSync: null, marks: { 'job-pack-a': { star: true }, 'job-user1-x': { applied: true } },
      jobs: [
        { id: 'job-pack-a', src: 'pack', company: '原厂A', position: '算法岗', link: '' },
        { id: 'job-user1-x', src: 'doc-user1', company: '同学表B', position: '后端开发', link: '' },
        { id: 'job-user2-y', src: 'doc-user2', company: '另一张C', position: '测试岗', link: '' },
      ],
    });
    function now(h) { return new Date(Date.now() - h * 3600000).toISOString(); }

    // 移除 user2 源:其岗位移除,pack 与 user1 不动,标记保留
    const rm = removeDocSource('doc-user2');
    assert.equal(rm.jobsRemoved, 1);
    const st = readJobState();
    assert.equal(st.jobs.length, 2);
    assert.equal(st.marks['job-user1-x'].applied, true, '标记不受移除影响');
    assert.throws(() => removeDocSource('doc'), /主文档源不可删除/, '维护者主文档源受保护');
    assert.throws(() => removeDocSource('doc-ghost'), /岗位源不存在/, '移除不存在的源报错');
    assert.equal(st.jobs.find((j) => j.id === 'job-pack-a').src, 'pack');

    // 分源同步 pack:只替换 pack 岗位,doc 源岗位不动(离线→回落内置包;若内置包缺失则跳过该断言组)
    if (fs.existsSync(new URL('../jobs-pack.json', import.meta.url).pathname)) {
      const r = await syncSource('pack', { log: () => {} });
      assert.ok(r.ok, '回落内置包同步成功');
      const st2 = readJobState();
      assert.ok(st2.jobs.some((j) => j.src === 'pack'), 'pack 岗位已刷新');
      assert.ok(st2.jobs.some((j) => j.src === 'doc-user1'), 'doc 源岗位未被 pack 同步波及');
      assert.equal(st2.marks['job-user1-x'].applied, true);
    }
  } finally { globalThis.fetch = origFetch; }
});

test('构建岗位包只含主文档源:用户自助源岗位不外泄', () => {
  saveJobState({
    version: 2,
    sources: [
      { id: 'doc', type: 'doc', url: 'https://docs.qq.com/smartsheet/Main?tab=M1' },
      { id: 'doc-user1', type: 'doc', url: 'https://docs.qq.com/smartsheet/U1?tab=T1' },
    ],
    lastSync: null, marks: {},
    jobs: [
      { id: 'job-main-1', src: 'doc', company: '主文档公司', position: '算法', link: 'https://main.com/x?recommendCode=LEAK1', updatedAt: '2026-09-10' },
      { id: 'job-user1-1', src: 'doc-user1', company: '同学表公司', position: '后端', link: '', updatedAt: '2026-09-11' },
    ],
  });
  const { pack } = buildJobPack({});
  assert.ok(pack.jobs.every((j) => j.company !== '同学表公司'), '用户自助源岗位不进岗位包');
  assert.equal(pack.jobs.length, 1);
  assert.ok(!/recommendcode/i.test(pack.jobs[0].link), '主文档链接的内推参数照常清洗');
});

test('岗位包读取:远程优先,失败回落本地内置包', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('模拟断网'); };
  try {
    const payload = await readPackSource('', () => {});
    assert.equal(payload.kind, 'campus-apply-tracker-job-pack', '远程失败回落本地内置包');
  } finally { globalThis.fetch = origFetch; }
  const remote = { kind: 'campus-apply-tracker-job-pack', schemaVersion: 1, jobs: [] };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => remote });
  try {
    assert.equal(await readPackSource('https://example.com/pack.json', () => {}), remote, '自定义远程地址可达时直接用远程');
  } finally { globalThis.fetch = origFetch; }
});

test('发布防呆:绝对下限拦异常清空,相对跌幅过半拦骤降,正常波动放行', () => {
  assert.ok(evaluatePublish({ count: 2246, prevCount: 2200 }).ok, '正常增长放行');
  assert.ok(evaluatePublish({ count: 2246 }).ok, '没有上一版也可发布');
  assert.ok(!evaluatePublish({ count: 80, prevCount: 2200 }).ok, '低于绝对下限拦截');
  assert.ok(!evaluatePublish({ count: 0 }).ok, '空库拦截');
  const drop = evaluatePublish({ count: 900, prevCount: 2246 });
  assert.ok(!drop.ok && /骤降/.test(drop.reason), '跌幅过半拦截并说明原因');
  assert.ok(evaluatePublish({ count: 1200, prevCount: 2246 }).ok, '跌幅未过半放行');
});

test('展示窗口:recentJobs 按更新时间取最近 N 条', () => {
  const st = { jobs: Array.from({ length: 300 }, (_, i) => ({ id: `j${i}`, company: `C${i}`, position: 'P', updatedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` })) };
  const win = recentJobs(st, 250);
  assert.equal(win.length, 250, '超出窗口截取');
  assert.equal(recentJobs({ jobs: st.jobs.slice(0, 100) }, 250).length, 100, '不足窗口全给');
  assert.ok(recentJobs(st, 3)[0].updatedAt >= recentJobs(st, 3)[2].updatedAt, '最新在前');
});
