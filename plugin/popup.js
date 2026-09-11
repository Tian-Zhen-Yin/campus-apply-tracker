// 岗位收录助手:在当前岗位详情页提取公司/岗位/城市,人工确认后 POST 到本机控制台。
// 提取与推断引擎同源自控制台 src/jobcapture.mjs(同源移植自台账一键收录插件),保持三端一致。
const CONSOLE = 'http://127.0.0.1:7788';
const $ = (id) => document.getElementById(id);

// ===== 页内提取(在活动标签页上下文执行,与 jobcapture.mjs EXTRACT_JOB_PAGE 同源) =====
const EXTRACT_JOB_PAGE = () => {
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

// ===== 推断(与 jobcapture.mjs normalizeCaptured 同源) =====
const tidy = (v) => String(v || '').replace(/\s+/g, ' ').replace(/^招聘[:：]?\s*/, '').trim();
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '重庆', '武汉', '西安', '长沙', '天津', '厦门', '合肥', '郑州', '青岛', '济南', '宁波', '无锡', '珠海', '佛山', '东莞', '福州', '昆明', '南昌', '大连', '沈阳', '哈尔滨', '石家庄', '太原', '贵阳', '南宁', '海口', '兰州', '乌鲁木齐', '呼和浩特', '长春', '香港', '澳门'];
const inferCity = (text, hostname = '') => {
  const labeled = String(text || '').match(/(?:工作地点|工作城市|意向城市|所在城市|城市|地点)\s*[:：]?\s*[①②③④⑤]?\s*([^\n，。|]{1,12})/);
  const labeledCity = labeled ? CITIES.find((c) => labeled[1].includes(c)) : '';
  if (labeledCity) return labeledCity;
  return CITIES.find((c) => text.includes(c)) || '';
};
const GENERIC_POSITION = /^(?:应聘记录|申请记录|我的申请|职位申请|校园招聘|社会招聘|招聘官网|职位列表|岗位列表|职位详情|岗位详情|首页)$/i;
const POSITION_WORDS = /工程师|经理|运营|设计师|分析师|顾问|开发|算法|产品|销售|商务|市场|营销|商业化|策略|行业|客户|供应链|财务|人力|法务|测试|数据|项目(?:经理|管理|运营|策划|专员)|采购|管培|校招生|实习生|专员|研究员|策划|编辑|审计|助理|负责人/;
const POSITION_NOISE = /编辑短信|发送短信|修改志愿|查看详情|个人资料|我的简历|投递记录|撤回投递|更新简历|重新投递|取消申请|官网主投|初筛中|筛选中|已投递|申请时间|投递时间|发布|全职|兼职|第\d志愿|^(?:招聘)?项目\s*[:：]|招聘批次|校招项目|应届生项目|^(?:产品|技术|设计|运营|职能|销售|市场|研发)类$/;
const inferPosition = (text, proposed, headingTexts = []) => {
  const clean = (value) => tidy(value).replace(/^(?:岗位|职位)(?:名称)?\s*[:：]\s*/, '').replace(/第\s*\d+\s*志愿/g, '').replace(/(?:撤回投递|更新简历|重新投递|取消申请|官网主投|初筛中|筛选中|已投递)+/g, '').trim();
  const direct = clean(proposed).split(/\s[-_|｜·]\s|招聘职位|职位详情|校园招聘/)[0].trim();
  if (direct && !GENERIC_POSITION.test(direct) && !POSITION_NOISE.test(direct) && POSITION_WORDS.test(direct) && direct.length <= 80) return direct;
  const sources = [...headingTexts.map((v) => ({ value: clean(v), prominence: 5 })), ...String(text || '').split(/\n+/).map((v) => ({ value: clean(v), prominence: 0 }))];
  const best = new Map();
  sources.filter((i) => i.value && i.value.length >= 2 && i.value.length <= 80)
    .filter((i) => !GENERIC_POSITION.test(i.value) && POSITION_WORDS.test(i.value) && !POSITION_NOISE.test(i.value))
    .forEach((i) => {
      const score = i.prominence + 3 + (/【|届|实习|校招/.test(i.value) ? 1 : 0) - (/登录|搜索|筛选|导航/.test(i.value) ? 3 : 0);
      if (!best.has(i.value) || best.get(i.value).score < score) best.set(i.value, { value: i.value, score });
    });
  const candidates = [...best.values()].sort((a, b) => b.score - a.score || a.value.length - b.value.length);
  return candidates.length ? candidates[0].value : '';
};
const knownCompany = (hostname) => {
  if (/(?:^|\.)xiaomi\.jobs\.f\.mioffice\.cn$/i.test(hostname || '')) return '小米集团';
  if (/(?:^|\.)campus\.kuaishou\.cn$/i.test(hostname || '')) return '快手';
  if (/(?:^|\.)campus\.anta\.com$/i.test(hostname || '')) return '安踏集团';
  return '';
};
const normalizeCaptured = (raw) => {
  let proposed = tidy(raw.title);
  const titleIsShell = !proposed || proposed === tidy(raw.pageTitle) || /招聘中心|招聘官网|校园招聘$/.test(proposed);
  if (titleIsShell) {
    const line = String(raw.pageText || '').split(/\n+/).slice(0, 40).find((l) => l.length >= 4 && l.length <= 80 && POSITION_WORDS.test(l) && !POSITION_NOISE.test(l));
    if (line) proposed = line;
  }
  const position = inferPosition(raw.pageText, proposed, Array.isArray(raw.headingTexts) ? raw.headingTexts : []);
  let company = knownCompany(raw.hostname) || tidy(raw.company);
  if (!company || /^(?:官网|网站)$|BOSS直聘|猎聘|智联招聘|前程无忧|拉勾|牛客|实习僧|应届生求职网|招聘官网|招聘网站|校园招聘|社会招聘|应聘记录|申请记录/i.test(company)) {
    const parts = tidy(raw.pageTitle).split(/[_|｜·-]/).map((s) => s.trim()).filter(Boolean);
    company = parts.find((p) => p !== position && !/招聘|职位|官网|应聘|申请|BOSS|猎聘|智联|前程|拉勾|牛客|实习僧/.test(p)) || '';
  }
  const cityRaw = tidy(raw.city || inferCity(`${raw.pageTitle}\n${raw.pageText}`, raw.hostname));
  const city = (CITIES.find((c) => cityRaw.includes(c)) || cityRaw).slice(0, 30);
  return { company: company.slice(0, 60), position: position.slice(0, 80), city, url: raw.url };
};

// ===== popup 主流程 =====
const setMsg = (text, cls = '') => { $('msg').textContent = text; $('msg').className = cls; };
const b64url = (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

(async () => {
  // 控制台连通性:绿点=在运行;红点提示先开控制台
  try {
    const r = await fetch(`${CONSOLE}/api/state`, { method: 'GET' });
    $('dot').classList.toggle('ok', r.ok);
    if (!r.ok) throw new Error('控制台未响应');
  } catch {
    setMsg('✗ 控制台未运行——先打开它（安装目录双击启动，或 http://127.0.0.1:7788）', 'err');
    $('save').disabled = true;
    $('saveDirect').disabled = true;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
    $('host').textContent = '当前不是网页，无法识别';
    $('save').disabled = true;
    $('saveDirect').disabled = true;
    return;
  }
  $('host').textContent = tab.url.length > 64 ? tab.url.slice(0, 64) + '…' : tab.url;

  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: EXTRACT_JOB_PAGE });
  const r = normalizeCaptured(res?.result || {});
  $('company').value = r.company || '';
  $('position').value = r.position || '';
  $('city').value = r.city || '';
  if (!r.company || !r.position) setMsg('没认全公司/岗位——可直接在框里手动补齐再收录', 'err');

  // 主路径:带着识别结果跳转控制台大界面确认(?capture= 参数,控制台自动弹窗预填)
  $('save').addEventListener('click', async () => {
    const company = $('company').value.trim();
    const position = $('position').value.trim();
    if (!company || !position) { setMsg('公司和岗位不能为空', 'err'); return; }
    const payload = b64url({ company, position, city: $('city').value.trim(), url: r.url || tab.url });
    await chrome.tabs.create({ url: `${CONSOLE}/console?capture=${payload}` });
    window.close();
  });

  // 捷径:弹窗内直接收录,不跳转
  $('saveDirect').addEventListener('click', async () => {
    const company = $('company').value.trim();
    const position = $('position').value.trim();
    if (!company || !position) { setMsg('公司和岗位不能为空', 'err'); return; }
    $('saveDirect').disabled = true;
    setMsg('收录中…');
    try {
      const resp = await fetch(`${CONSOLE}/api/jobs/capture/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company, position, city: $('city').value.trim(), link: r.url || tab.url }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
      setMsg(data.updated ? '✓ 已收录（更新了同内容岗位）' : '✓ 已收录进「手动收录」岗位源', 'ok');
    } catch (e) {
      setMsg(`✗ 收录失败：${e.message}——控制台在运行吗？`, 'err');
      $('saveDirect').disabled = false;
    }
  });
})();
