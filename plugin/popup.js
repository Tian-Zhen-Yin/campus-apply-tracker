// 岗位收录助手 popup:识别引擎见 common.js(popup.html 先于本文件加载,悬浮球共用)。
const $ = (id) => document.getElementById(id);
const setMsg = (text, cls = '') => { $('msg').textContent = text; $('msg').className = cls; };

const ALL_ORIGINS = { origins: ['http://*/*', 'https://*/*'] };
const FLOAT_CS_ID = 'jca-float';

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

  // ===== 悬浮球开关:默认关闭;开启 = optional_host_permissions 二次授权 + 动态注册 content script =====
  try {
    $('floatToggle').checked = await chrome.permissions.contains(ALL_ORIGINS);
  } catch { $('floatToggle').disabled = true; }
  $('floatToggle').addEventListener('change', async (e) => {
    const want = e.target.checked;
    try {
      if (want) {
        const granted = await chrome.permissions.request(ALL_ORIGINS);
        if (!granted) { e.target.checked = false; setMsg('未授权——悬浮球需要「读取网站」权限（仅本机判定用，不外发数据）', 'err'); return; }
        const registered = await chrome.scripting.getRegisteredContentScripts();
        if (!registered.some((s) => s.id === FLOAT_CS_ID)) {
          await chrome.scripting.registerContentScripts([{
            id: FLOAT_CS_ID, matches: ['http://*/*', 'https://*/*'],
            js: ['common.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true,
          }]);
        }
        setMsg('✓ 悬浮球已开启——刷新岗位页，右下角见 ⌕', 'ok');
      } else {
        await chrome.scripting.unregisterContentScripts({ ids: [FLOAT_CS_ID] }).catch(() => {});
        await chrome.permissions.remove(ALL_ORIGINS);
        setMsg('已关闭悬浮球，并撤回「读取网站」权限', 'ok');
      }
    } catch (err) { e.target.checked = !want; setMsg(`✗ ${err.message}`, 'err'); }
  });

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

  // 主路径:带着识别结果跳转控制台大界面确认(?capture= 参数,控制台自动弹窗预填;勾选状态一并带过去)
  $('save').addEventListener('click', async () => {
    const company = $('company').value.trim();
    const position = $('position').value.trim();
    if (!company || !position) { setMsg('公司和岗位不能为空', 'err'); return; }
    const payload = b64url({ company, position, city: $('city').value.trim(), url: r.url || tab.url, applied: $('markApplied').checked });
    await chrome.tabs.create({ url: `${CONSOLE}/console?capture=${payload}` });
    window.close();
  });

  // 捷径:弹窗内直接收录,不跳转(默认同时记为已投递,取消勾选则只进岗位库)
  $('saveDirect').addEventListener('click', async () => {
    const company = $('company').value.trim();
    const position = $('position').value.trim();
    if (!company || !position) { setMsg('公司和岗位不能为空', 'err'); return; }
    const applied = $('markApplied').checked;
    $('saveDirect').disabled = true;
    setMsg('收录中…');
    try {
      const resp = await fetch(`${CONSOLE}/api/jobs/capture/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company, position, city: $('city').value.trim(), link: r.url || tab.url, applied }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
      if (!applied) setMsg(data.updated ? '✓ 已收录（更新了同内容岗位，未记投递）' : '✓ 已收录进岗位库（未记投递）', 'ok');
      else if (data.record?.created) setMsg('✓ 已收录，并记入投递总览', 'ok');
      else if (data.record?.existed) setMsg('✓ 已收录；总览已有该岗位记录——仅标已投', 'ok');
      else setMsg(data.updated ? '✓ 已收录（更新了同内容岗位）' : '✓ 已收录进「手动收录」岗位源', 'ok');
    } catch (e) {
      setMsg(`✗ 收录失败：${e.message}——控制台在运行吗？`, 'err');
      $('saveDirect').disabled = false;
    }
  });
})();
