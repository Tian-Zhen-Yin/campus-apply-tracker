// 岗位收录助手 · 公共引擎:页内提取 + 推断 + 编码,popup 与悬浮球(content script)共用。
// 同源自控制台 src/jobcapture.mjs(同源移植自台账一键收录插件),保持三端一致。
const CONSOLE = 'http://127.0.0.1:7788';

const b64url = (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ===== 页内提取(在页面上下文执行,与 jobcapture.mjs EXTRACT_JOB_PAGE 同源) =====
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
const PLATFORM_RE = /BOSS直聘|猎聘|智联招聘|前程无忧|拉勾|牛客|实习僧|应届生求职网|招聘官网|招聘网站|校园招聘|社会招聘|应聘记录|申请记录|Moka|北森|Beisen|飞书招聘/i;
const normalizeCaptured = (raw) => {
  let proposed = tidy(raw.title);
  const titleIsShell = !proposed || proposed === tidy(raw.pageTitle) || /招聘中心|招聘官网|校园招聘$/.test(proposed);
  if (titleIsShell) {
    const line = String(raw.pageText || '').split(/\n+/).slice(0, 40).find((l) => l.length >= 4 && l.length <= 80 && POSITION_WORDS.test(l) && !POSITION_NOISE.test(l));
    if (line) proposed = line;
  }
  const position = inferPosition(raw.pageText, proposed, Array.isArray(raw.headingTexts) ? raw.headingTexts : []);
  let company = knownCompany(raw.hostname) || tidy(raw.company);
  if (!company || PLATFORM_RE.test(company)) {
    const parts = tidy(raw.pageTitle).split(/[_|｜·-]/).map((s) => s.trim()).filter(Boolean);
    company = parts.find((p) => p !== position && !/招聘|职位|官网|应聘|申请|BOSS|猎聘|智联|前程|拉勾|牛客|实习僧/i.test(p)) || '';
    if (!company) {
      // 整题剥通用后缀:「深信服内部推荐官网」「鹏芯微校园招聘」「XX招聘官网」——公司名就在剥完之后
      const stripped = tidy(raw.pageTitle)
        .replace(/(?:内部)?推荐官网|招聘(?:官网|门户|网站)?|校园招聘|官方招聘|人才招聘|加入我们|官网|人才网/g, '').trim();
      if (stripped.length >= 2 && stripped.length <= 30 && stripped !== position && !PLATFORM_RE.test(stripped)) company = stripped;
    }
  }
  const cityRaw = tidy(raw.city || inferCity(`${raw.pageTitle}\n${raw.pageText}`, raw.hostname));
  const city = (CITIES.find((c) => cityRaw.includes(c)) || cityRaw).slice(0, 30);
  return { company: company.slice(0, 60), position: position.slice(0, 80), city, url: raw.url };
};

// ===== 悬浮球页面判定(轻量:JSON-LD JobPosting 直接命中;否则标题+正文前段命中招聘信号) =====
const looksLikeJobPage = () => {
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = node.textContent || '';
    if (text.includes('JobPosting')) return true;
  }
  const head = `${document.title} ${document.querySelector('h1')?.textContent || ''}`;
  if (/岗位详情|职位详情|校园招聘|校招|实习招聘|jobs?\b|careers?\b/i.test(head)) return true;
  const bodyHead = (document.body?.innerText || '').slice(0, 3000);
  return /工作(?:职责|地点|城市)|任职要求|职位描述|岗位要求/.test(bodyHead) && /招聘|岗位|职位/.test(bodyHead);
};
