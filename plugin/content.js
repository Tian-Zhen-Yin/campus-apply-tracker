// 悬浮球:在「长得像岗位页」的页面右下角浮现,点开面板识别+收录——免去找工具栏图标。
// 默认不注入;由 popup 的「页面悬浮球」开关经 optional_host_permissions 授权后动态注册(manifest: js=[common.js, content.js])。
// 判定与识别全部在本机页面内完成,不外发任何数据;收录结果只 POST 本机控制台。
(() => {
  if (window.__jcaFloat__) return;
  window.__jcaFloat__ = true;
  if (location.origin === CONSOLE) return; // 控制台自身页面不浮现

  const POS_KEY = 'jcaFloatPos';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .ball {
      position: fixed; z-index: 2147483646; width: 44px; height: 44px; border-radius: 50%;
      background: #4f63e9; color: #fff; display: flex; align-items: center; justify-content: center;
      font-size: 20px; cursor: pointer; user-select: none;
      box-shadow: 0 4px 14px rgba(23, 32, 51, .35); opacity: .82; transition: opacity .15s;
    }
    .ball:hover { opacity: 1; }
    .ball.dragging { opacity: 1; cursor: grabbing; transition: none; }
    .panel {
      position: fixed; z-index: 2147483647; width: 300px; padding: 14px;
      background: #fff; border-radius: 12px; color: #172033;
      box-shadow: 0 12px 40px rgba(23, 32, 51, .28);
    }
    .panel h3 { margin: 0 0 4px; font-size: 13px; display: flex; align-items: center; gap: 6px; }
    .panel h3 .x { margin-left: auto; cursor: pointer; color: #98a2b3; font-weight: 400; font-size: 15px; }
    .panel .src { color: #667085; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px; }
    .panel label.f { display: block; font-size: 11px; font-weight: 700; color: #667085; margin: 8px 0 3px; }
    .panel input[type=text] { width: 100%; border: 1px solid #e4e8f2; border-radius: 8px; padding: 7px 9px; font: inherit; }
    .panel .applied { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12.5px; font-weight: 600; }
    .panel button { width: 100%; margin-top: 10px; padding: 9px; border: 0; border-radius: 9px; background: #4f63e9; color: #fff; font-weight: 800; font-size: 13px; cursor: pointer; }
    .panel button.sub { background: #64748b; margin-top: 8px; }
    .panel button:disabled { opacity: .55; cursor: not-allowed; }
    .panel .msg { margin-top: 8px; font-size: 12px; text-align: center; min-height: 15px; color: #667085; }
    .panel .msg.ok { color: #138a62; font-weight: 700; }
    .panel .msg.err { color: #b94747; }
  `;

  const loadPos = async () => {
    const def = { right: 20, bottom: 20 };
    try {
      const { [POS_KEY]: p } = await chrome.storage.local.get(POS_KEY);
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return def;
      return { x: clamp(p.x, 0, innerWidth - 44), y: clamp(p.y, 0, innerHeight - 44) };
    } catch { return def; }
  };

  const mount = async () => {
    const host = document.createElement('div');
    host.id = 'jca-float-host';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);

    const ball = document.createElement('div');
    ball.className = 'ball';
    ball.title = '岗位收录助手（拖动移位）';
    ball.textContent = '⌕';
    root.appendChild(ball);

    const pos = await loadPos();
    const place = (p) => {
      if (p.x != null) { ball.style.left = `${p.x}px`; ball.style.top = `${p.y}px`; }
      else { ball.style.right = `${p.right}px`; ball.style.bottom = `${p.bottom}px`; }
    };
    place(pos);

    // 拖动:位移超过 5px 视为拖拽不触发面板;位置记忆到 chrome.storage
    let sx = 0, sy = 0, bx = 0, by = 0, moved = false;
    ball.addEventListener('pointerdown', (e) => {
      sx = e.clientX; sy = e.clientY;
      const r = ball.getBoundingClientRect();
      bx = r.left; by = r.top; moved = false;
      ball.classList.add('dragging');
      ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener('pointermove', (e) => {
      if (!ball.classList.contains('dragging')) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      ball.style.right = 'auto'; ball.style.bottom = 'auto';
      ball.style.left = `${clamp(bx + dx, 0, innerWidth - 44)}px`;
      ball.style.top = `${clamp(by + dy, 0, innerHeight - 44)}px`;
    });
    ball.addEventListener('pointerup', async () => {
      ball.classList.remove('dragging');
      if (moved) {
        const r = ball.getBoundingClientRect();
        try { await chrome.storage.local.set({ [POS_KEY]: { x: r.left, y: r.top } }); } catch (_) {}
        return;
      }
      openPanel();
    });

    let panel = null;
    const closePanel = () => { panel?.remove(); panel = null; };

    const openPanel = () => {
      if (panel) { closePanel(); return; } // 再点球=切换
      let r;
      try { r = normalizeCaptured(EXTRACT_JOB_PAGE()); } catch { r = { company: '', position: '', city: '', url: location.href }; }
      panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = `
        <h3>⌕ 岗位收录助手<span class="x">✕</span></h3>
        <div class="src">${location.hostname}${r.url && r.url.length > 42 ? ' · ' + r.url.slice(0, 42) + '…' : ''}</div>
        <label class="f">公司</label><input type="text" data-k="company" value="${(r.company || '').replace(/"/g, '&quot;')}">
        <label class="f">岗位</label><input type="text" data-k="position" value="${(r.position || '').replace(/"/g, '&quot;')}">
        <label class="f">城市（可改/可空）</label><input type="text" data-k="city" value="${(r.city || '').replace(/"/g, '&quot;')}">
        <label class="applied"><input type="checkbox" data-k="applied" checked> 同时记为已投递（进投递总览）</label>
        <button class="go">在控制台确认收录 →</button>
        <button class="sub direct">直接收录（不跳转）</button>
        <div class="msg">${r.company && r.position ? '' : '没认全公司/岗位——手动补齐再收录'}</div>`;
      root.appendChild(panel);
      const msg = panel.querySelector('.msg');
      const setMsg = (t, cls = '') => { msg.textContent = t; msg.className = 'msg ' + cls; };
      const fields = () => ({
        company: panel.querySelector('[data-k=company]').value.trim(),
        position: panel.querySelector('[data-k=position]').value.trim(),
        city: panel.querySelector('[data-k=city]').value.trim(),
        applied: panel.querySelector('[data-k=applied]').checked,
      });
      panel.querySelector('.x').addEventListener('click', closePanel);
      panel.querySelector('.go').addEventListener('click', () => {
        const f = fields();
        if (!f.company || !f.position) { setMsg('公司和岗位不能为空', 'err'); return; }
        window.open(`${CONSOLE}/console?capture=${b64url({ ...f, url: location.href })}`, '_blank');
        closePanel();
      });
      panel.querySelector('.direct').addEventListener('click', async (e) => {
        const f = fields();
        if (!f.company || !f.position) { setMsg('公司和岗位不能为空', 'err'); return; }
        e.currentTarget.disabled = true;
        setMsg('收录中…');
        try {
          const resp = await fetch(`${CONSOLE}/api/jobs/capture/save`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ company: f.company, position: f.position, city: f.city, link: location.href, applied: f.applied }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
          if (!f.applied) setMsg(data.updated ? '✓ 已收录（未记投递）' : '✓ 已收录进岗位库（未记投递）', 'ok');
          else if (data.record?.created) setMsg('✓ 已收录，并记入投递总览', 'ok');
          else if (data.record?.existed) setMsg('✓ 已收录；总览已有该岗位记录——仅标已投', 'ok');
          else setMsg(data.updated ? '✓ 已收录（更新了同内容岗位）' : '✓ 已收录', 'ok');
        } catch (err) {
          setMsg(`✗ 收录失败：${err.message}——控制台在运行吗？`, 'err');
          e.currentTarget.disabled = false;
        }
      });
      // 面板贴着球,视口内翻转防出界
      const br = ball.getBoundingClientRect();
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = `${clamp(br.left - 260 + 44, 8, innerWidth - 308)}px`;
      panel.style.top = br.top > 300 ? `${br.top - 330}px` : `${Math.min(br.bottom + 10, innerHeight - 340)}px`;
    };
    document.documentElement.appendChild(host);
  };

  // SPA 兜底:先查一次,未命中则低频轮询(最多 ~30 秒),命中即浮现并停查
  let shown = false;
  const check = () => { if (!shown && looksLikeJobPage()) { shown = true; mount(); return true; } return false; };
  if (check()) return;
  let n = 0;
  const timer = setInterval(() => { if (check() || ++n > 20) clearInterval(timer); }, 1500);
})();
