/**
 * Facebook 广告资料库：按地区(国家代码) + 关键词搜索 → Most recent →
 * 随机滚动积累候选池 → Fisher-Yates 洗牌后取 max_count 条公共主页链接。
 */
import type { IntermediateDataRow, TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  ingestIntermediateRows,
  loadAutomationManifest,
  loadTaskRunConfig,
  parsePositiveIntConfig,
  parseTaskGroupIdFromEnv,
  parseTaskIdFromEnv,
  prepareIntermediateStorage,
  resolveAiDesktopBaseUrl,
  XportBrowserClient,
} from 'xport-browser-sdk';

type TaskRunConfigWire = TaskRunConfig & { _gid?: unknown };

type AdLibraryPageState = 'auth' | 'empty' | 'has_pages' | 'unknown';

type ScrollMetrics = { before: number; after: number; moved: boolean };

/**
 * 结果区广告主公共主页链（语言无关）：
 * 卡片内 `a[target=_blank][href*=facebook.com/]`，排除外链跳转 /ads。
 * 勿用 aria-label / 「主页」文案（随界面语言变）。
 */
const PAGE_LINK_SELECTOR =
  'a[target="_blank"][href*="facebook.com/"]:not([href*="l.facebook.com"]):not([href*="/ads/"]):not([href*="login"])';

/**
 * 广告资料库结果区滚动：优先滚可滚动容器，否则 window.scrollBy。
 * delta 由外层注入（随机约 800～3500），勿写死固定步长。
 * 返回滚动前后位置，供「划不动」判定（勿依赖 waitForNetworkIdle——FB 长连接常永不空闲）。
 */
function buildScrollResultsJs(deltaPx: number): string {
  const delta = Math.max(200, Math.floor(deltaPx));
  return `(() => {
  const delta = ${delta};
  const readY = (el) => {
    if (!el || el === window || el === document || el === document.documentElement || el === document.body) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return el.scrollTop || 0;
  };
  const doScroll = (el, d) => {
    if (!el || el === window || el === document || el === document.documentElement || el === document.body) {
      window.scrollBy(0, d);
      return;
    }
    el.scrollTop = (el.scrollTop || 0) + d;
  };
  let target = null;
  let best = 0;
  for (const el of document.querySelectorAll('div, main, section')) {
    const st = window.getComputedStyle(el);
    const oy = st.overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    const room = (el.scrollHeight || 0) - (el.clientHeight || 0);
    if (room > best + 80) {
      best = room;
      target = el;
    }
  }
  const before = readY(target);
  doScroll(target, delta);
  const after = readY(target);
  return JSON.stringify({ before, after, moved: after > before + 8, delta });
})()`;
}

/**
 * 从广告卡片抽取公共主页（语言无关结构优先）。
 * 主路径：`a[target=_blank][href*=facebook.com/]` + 相邻 `div._8nrv`（赞助标记容器，不读文案）。
 * 名称取链内首个 span 文本，避免整卡 CTA 多语脏数据。
 */
const EXTRACT_PAGES_JS = `(() => {
  const decode = (s) => {
    const el = document.createElement('textarea');
    el.innerHTML = s;
    return el.value;
  };
  const RESERVED = new Set([
    'ads', 'ad_library', 'adsmanager', 'privacy', 'policies', 'help', 'login',
    'checkpoint', 'confirmemail', 'recover', 'watch', 'reel', 'reels', 'groups',
    'marketplace', 'gaming', 'events', 'friends', 'messages', 'settings', 'pages',
    'permalink.php', 'story.php', 'photo.php', 'video.php', 'sharer', 'share',
    'dialog', 'plugins', 'tr', 'ajax', 'api', 'graphql', 'language', 'donate',
  ]);
  const normalizeUrl = (href) => {
    if (!href) return '';
    try {
      let raw = String(href).trim();
      if (raw.startsWith('//')) raw = 'https:' + raw;
      const u = new URL(raw, 'https://www.facebook.com');
      const host = u.hostname.replace(/^www\\./i, '').toLowerCase();
      if (host === 'l.facebook.com' || host === 'lm.facebook.com') return '';
      if (!/(^|\\.)facebook\\.com$/i.test(u.hostname)) return '';
      const idParam = u.searchParams.get('id');
      if (/\\/profile\\.php$/i.test(u.pathname) && idParam && /^\\d+$/.test(idParam)) {
        return 'https://www.facebook.com/profile.php?id=' + idParam;
      }
      const path = u.pathname.replace(/\\/+$/, '') || '';
      const num = path.match(/^\\/(\\d+)$/);
      if (num) return 'https://www.facebook.com/' + num[1];
      const vanity = path.match(/^\\/([A-Za-z0-9][A-Za-z0-9._-]{1,100})$/);
      if (vanity) {
        const slug = vanity[1];
        if (RESERVED.has(slug.toLowerCase())) return '';
        if (/^\\d+$/.test(slug)) return 'https://www.facebook.com/' + slug;
        return 'https://www.facebook.com/' + slug;
      }
      return '';
    } catch {
      return '';
    }
  };
  const readName = (a) => {
    const span = a.querySelector('span');
    const raw = (span && span.textContent) || a.textContent || '';
    return decode(String(raw).trim().replace(/\\s+/g, ' '));
  };
  const isAdvertiserAnchor = (a) => {
    const sib = a.nextElementSibling;
    if (sib && sib.tagName === 'DIV' && /(?:^|\\s)_8nrv(?:\\s|$)/.test(sib.className || '')) {
      return true;
    }
    // 无 _8nrv 时：链内有可见 span 名 + 可规范化主页 URL 仍收录（改版兜底）
    return Boolean(a.querySelector('span'));
  };
  const isNoiseName = (t) =>
    !t ||
    t.length < 2 ||
    t.length > 120 ||
    /^https?:\\/\\//i.test(t) ||
    /^FB\\.ME$/i.test(t);
  const byUrl = new Map();
  const nameToUrl = new Map();
  const consider = (href, nameRaw, prefer) => {
    const url = normalizeUrl(href);
    if (!url) return;
    const name = String(nameRaw || '').trim();
    if (isNoiseName(name)) return;
    const nameKey = name.toLowerCase();
    const existingUrl = nameToUrl.get(nameKey);
    if (existingUrl && existingUrl !== url) return;
    const prev = byUrl.get(url);
    if (!prev || (prefer && !prev._prefer) || name.length > prev.page_name.length) {
      byUrl.set(url, { page_name: name, page_url: url, _prefer: Boolean(prefer) });
      nameToUrl.set(nameKey, url);
    }
  };
  for (const a of document.querySelectorAll('a[target="_blank"][href*="facebook.com/"]')) {
    const href = a.getAttribute('href') || a.href || '';
    if (!href || /l\\.facebook\\.com/i.test(href)) continue;
    if (!isAdvertiserAnchor(a)) continue;
    const sib = a.nextElementSibling;
    const prefer = Boolean(
      sib && sib.tagName === 'DIV' && /(?:^|\\s)_8nrv(?:\\s|$)/.test(sib.className || ''),
    );
    consider(href, readName(a), prefer);
  }
  return JSON.stringify(
    Array.from(byUrl.values()).map(({ page_name, page_url }) => ({ page_name, page_url })),
  );
})()`;

/**
 * 判定广告资料库页态（结构优先，少依赖界面语言）。
 * has_pages：卡片广告主链（target=_blank + 可选相邻 _8nrv）。
 * empty：已观察多语文案 OR（搜索栏已就绪且 0 广告主链时由外层超时收口，此处仅早退文案）。
 * auth：URL 优先，文案仅作已观察语兜底。
 */
const DETECT_PAGE_STATE_JS = `(() => {
  const href = String(location.href || '');
  if (/confirmemail|\\/login\\b|\\/checkpoint\\b|two_factor|auth_platform|\\/recover\\b/i.test(href)) {
    return 'auth';
  }
  const bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 12000);
  if (/enter the confirmation code|confirmation code|to confirm your account|确认你的帐户|確認你的帳戶|验证码|驗證碼|confirm you're human|enter the text from the image|captcha challenge|确认你是真人/i.test(bodyText)) {
    return 'auth';
  }
  const countAdvertiserPages = () => {
    let n = 0;
    for (const a of document.querySelectorAll('a[target="_blank"][href*="facebook.com/"]')) {
      const h = a.getAttribute('href') || '';
      if (!h || /l\\.facebook\\.com/i.test(h) || /\\/ads\\//i.test(h)) continue;
      try {
        const u = new URL(h, location.origin);
        if (!/(^|\\.)facebook\\.com$/i.test(u.hostname)) continue;
        const path = u.pathname.replace(/\\/+$/, '');
        const okPath =
          /^\\/\\d+$/.test(path) ||
          (/\\/profile\\.php$/i.test(u.pathname) && u.searchParams.get('id')) ||
          /^\\/[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(path);
        if (!okPath) continue;
      } catch {
        continue;
      }
      const sib = a.nextElementSibling;
      const badge = sib && sib.tagName === 'DIV' && /(?:^|\\s)_8nrv(?:\\s|$)/.test(sib.className || '');
      if (badge || a.querySelector('span')) n += 1;
    }
    return n;
  };
  if (countAdvertiserPages() > 0) return 'has_pages';
  // 空结果：仅用已观察多语文案早退（加载中勿用「0 链」当 empty）
  if (
    /no ads match your search criteria|aucune publicité ne correspond|没有符合.*搜索条件|沒有符合.*搜尋條件|未找到符合.*广告|没有找到广告|try searching for another keyword|tentez de rechercher un autre mot-clé|请尝试搜索其他关键词|请尝试用其他关键字/i.test(
      bodyText,
    )
  ) {
    return 'empty';
  }
  return 'unknown';
})()`;

async function resolveTaskGroupId(
  client: XportBrowserClient,
  taskConfig: TaskRunConfigWire,
): Promise<number | undefined> {
  const fromEnv = parseTaskGroupIdFromEnv();
  if (fromEnv != null && fromEnv > 0) return fromEnv;

  const fromConfig = Number(taskConfig._gid);
  if (Number.isInteger(fromConfig) && fromConfig > 0) return fromConfig;

  const taskId = parseTaskIdFromEnv() ?? client.taskId;
  if (taskId == null || taskId <= 0) return undefined;

  try {
    const url = `${resolveAiDesktopBaseUrl()}/automation/failure/task-snapshot?taskId=${taskId}`;
    const resp = await fetch(url);
    const json = (await resp.json()) as { succ?: boolean; data?: unknown };
    if (!json.succ || json.data == null) return undefined;
    let payload: unknown = json.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return undefined;
      }
    }
    const gid = Number((payload as { gid?: unknown })?.gid);
    if (Number.isInteger(gid) && gid > 0) return gid;
  } catch (e) {
    client.taskLog(`resolveTaskGroupId snapshot failed: ${String(e)}`);
  }
  return undefined;
}

function normalizeCountryCode(raw: string): string {
  const t = raw.trim();
  if (!t) return 'CN';
  return t.toUpperCase();
}

/** Ad Library：地区(国家代码) + 关键词 + Most recent 排序。 */
function buildAdLibraryUrl(country: string, keyword: string): string {
  const params = new URLSearchParams({
    active_status: 'all',
    ad_type: 'all',
    country,
    is_targeted_country: 'false',
    media_type: 'all',
    q: keyword,
    search_type: 'keyword_unordered',
  });
  // Most recent（录制确认：relevancy_monthly_grouped）
  return (
    `https://www.facebook.com/ads/library/?${params.toString()}` +
    '&sort_data[mode]=relevancy_monthly_grouped&sort_data[direction]=desc'
  );
}

function isLoginUrl(u: string): boolean {
  return /\/login\b|\/checkpoint\b|confirmemail|two_factor|auth_platform|\/recover\b/i.test(u);
}

/** browser/cmd HTTP 层超时或选择器等待超时（瞬时网络/卡顿勿当硬失败）。 */
function isTransientBrowserTimeout(msg: string): boolean {
  return /HTTP timeout|WAIT_FOR_SELECTOR|timed?\s*out|timeout after|TimeoutError|Navigation timeout/i.test(
    msg || '',
  );
}

/**
 * 网络 / 代理类异常（含 Chromium net::ERR_*、资料库白屏未加载、browser/cmd 超时）。
 * 编排侧要求：此类失败软成功跳过（succ:true），勿标 failed；登录/选择器等其它失败仍硬失败。
 */
function isNetworkOrProxyFailure(msg: string): boolean {
  const m = msg || '';
  if (isTransientBrowserTimeout(m)) return true;
  return /net::ERR_|ERR_PROXY|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET|ERR_NETWORK|ERR_TIMED_OUT|ERR_ADDRESS|ERR_SOCKS|ERR_TUNNEL|PROXY_CONNECTION|proxy.{0,40}(fail|error|refused|unavailable)|网络\s*\/?\s*代理|未加载出内容|页面响应超时|页面无法加载|无法加载|Navigation failed|NS_ERROR_PROXY|connection.{0,20}(refused|reset|closed|failed)|Could not connect|ERR_ABORTED/i.test(
    m,
  );
}

/** 网络/代理异常 → 软成功跳过（collected_count=0，msg 说明原因）。 */
function networkSkipResult(
  keyword: string,
  country: string,
  searchUrl: string,
  finalUrl: string,
  detail: string,
): AutomationRunResult {
  const clipped = (detail || '').trim().slice(0, 200);
  const reason = clipped
    ? `网络或代理异常，已跳过本次采集（${clipped}）`
    : '网络或代理异常，已跳过本次采集';
  return emptySuccessResult(keyword, country, searchUrl, finalUrl, reason);
}

/** CDP 未连接：连续关键词任务中浏览器可能被关掉或瞬时断连，可尝试 browserStart 拉起。 */
function isBrowserNotConnected(msg: string): boolean {
  return /Browser not connected|please launch browser first|not connected/i.test(msg || '');
}

/**
 * 打开广告库前 / 导航报断连时：查 CDP 状态，未连接则 browserStart 并短轮询就绪。
 * 有限次重试；仍失败则返回 false（由调用方结构化 fail，勿无限拉起）。
 */
async function ensureBrowserConnected(
  client: XportBrowserClient,
  label: string,
  maxStarts = 3,
): Promise<{ ok: boolean; msg: string }> {
  const [statusOk, statusMsg, status] = await client.browserConnectionStatus();
  if (statusOk && status?.connected) {
    client.taskLog(`${label} browser already connected`);
    return { ok: true, msg: '' };
  }
  client.taskLog(
    `${label} browser not connected statusOk=${statusOk} msg=${statusMsg || '(none)'} connected=${status?.connected ?? 'n/a'}`,
  );

  let lastMsg = statusMsg || 'Browser not connected';
  for (let start = 1; start <= maxStarts; start++) {
    client.taskLog(`${label} browserStart attempt=${start}/${maxStarts}`);
    const [startOk, startMsg] = await client.browserStart();
    if (!startOk) {
      lastMsg = startMsg || lastMsg;
      client.taskLog(`${label} browserStart failed: ${lastMsg}`);
    } else {
      client.taskLog(`${label} browserStart ok, polling connection`);
    }
    // 拉起后短轮询 CDP（未连接时也可调 connectionStatus）
    for (let poll = 0; poll < 10; poll++) {
      await Bun.sleep(800 + poll * 150);
      const [ok, msg, st] = await client.browserConnectionStatus();
      if (ok && st?.connected) {
        client.taskLog(`${label} browser connected after start=${start} poll=${poll}`);
        await Bun.sleep(500);
        return { ok: true, msg: '' };
      }
      if (!ok && msg) lastMsg = msg;
    }
    await Bun.sleep(1_000 + start * 400);
  }
  return { ok: false, msg: lastMsg || 'Browser not connected, please launch browser first' };
}

/**
 * 广告资料库搜索栏定位（结构优先，语言无关）。
 * 单次长 waitForSelector 易拖满 browser/cmd 60s HTTP 上限并抛异常 → 改分段短等 + count。
 */
const AD_LIBRARY_SEARCH_SELECTOR =
  'input[type="search"], input[role="combobox"], input[placeholder], [role="combobox"], [role="search"] input, [role="search"]';

const AD_LIBRARY_SEARCH_PROBE_SELECTORS = [
  'input[type="search"]',
  'input[role="combobox"]',
  '[role="combobox"]',
  'input[placeholder]',
  '[role="search"] input',
  '[role="search"]',
] as const;

function isAdLibraryUrl(u: string): boolean {
  return /facebook\.com\/ads\/library/i.test(u);
}

/** 当前页是否已是目标关键词 + 国家的广告资料库结果 URL。 */
function isTargetAdLibraryUrl(u: string, country: string, keyword: string): boolean {
  if (!u || !isAdLibraryUrl(u)) return false;
  try {
    const parsed = new URL(u);
    const q = (parsed.searchParams.get('q') || '').trim();
    const c = (parsed.searchParams.get('country') || '').trim().toUpperCase();
    if (c && c !== country.toUpperCase()) return false;
    return q === keyword.trim();
  } catch {
    return false;
  }
}

/**
 * 打开广告资料库搜索页。
 * FB 从旧关键词 SPA 切到新关键词时，pageGoTo 常报 ERR_ABORTED / URL unchanged，
 * 但稍后可能落地；超时后也可能已跳转 checkpoint。须：空白页打断 SPA → 重试 → 按落地 URL/页态判定。
 * 连续关键词任务中 CDP 可能瞬时断连：打开前 ensure 连接，遇「Browser not connected」有限次 browserStart 再导航。
 */
async function openAdLibrary(
  client: XportBrowserClient,
  opts: { searchUrl: string; keyword: string; country: string },
): Promise<AutomationRunResult | null> {
  const { searchUrl, keyword, country } = opts;
  const authFail = async (pageUrl: string) =>
    failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
      code: 'NOT_LOGGED_IN',
      step: 'check_login',
      labels: { keyword, country, pageUrl, searchUrl },
    });
  /** 断连 / 打不开页：按网络类软跳过，勿标 failed（编排可继续下一关键词）。 */
  const disconnectSkip = (detail: string) => {
    client.taskLog(`open_ad_library network skip (disconnect): ${detail || '(none)'}`);
    return networkSkipResult(
      keyword,
      country,
      searchUrl,
      '',
      detail || '浏览器未连接或无法自动拉起',
    );
  };

  // 打开前确认 CDP 已连接（未连接则自动拉起）
  {
    const ensured = await ensureBrowserConnected(client, 'open_ad_library_pre');
    if (!ensured.ok) return disconnectSkip(ensured.msg);
  }

  const [urlOk, urlMsg, startUrl] = await client.getPageUrl();
  if (!urlOk && isBrowserNotConnected(urlMsg || '')) {
    const ensured = await ensureBrowserConnected(client, 'open_ad_library_url');
    if (!ensured.ok) return disconnectSkip(ensured.msg || urlMsg || '');
  }
  if (startUrl && isLoginUrl(startUrl)) return await authFail(startUrl);
  if (startUrl && isTargetAdLibraryUrl(startUrl, country, keyword)) {
    client.taskLog(`open_ad_library already on target: ${startUrl}`);
    return null;
  }

  const maxAttempts = 3;
  let lastMsg = '';
  let lastUrl = startUrl || '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 每轮导航前再确认连接（连续关键词场景下可能中途断连）
    {
      const ensured = await ensureBrowserConnected(client, `open_ad_library_attempt_${attempt}`);
      if (!ensured.ok) {
        lastMsg = ensured.msg;
        if (attempt >= maxAttempts) return disconnectSkip(ensured.msg);
        await Bun.sleep(1_000);
        continue;
      }
    }

    // 已在资料库页时先 blank，避免 SPA 同路径换参导致 ERR_ABORTED / 仍停在旧关键词
    const needBlank = attempt > 1 || (lastUrl ? isAdLibraryUrl(lastUrl) : false);
    if (needBlank) {
      client.taskLog(`open_ad_library prep blank attempt=${attempt}`);
      const [blankOk, blankMsg] = await client.pageGoTo(0, {
        url: 'about:blank',
        timeoutMs: 15_000,
        wait: 'domcontentloaded',
      });
      if (!blankOk) {
        client.taskLog(`open_ad_library blank: ${blankMsg}`);
        if (isBrowserNotConnected(blankMsg || '')) {
          lastMsg = blankMsg || lastMsg;
          const ensured = await ensureBrowserConnected(client, `open_ad_library_blank_reconnect_${attempt}`);
          if (!ensured.ok) {
            lastMsg = ensured.msg || lastMsg;
            if (attempt >= maxAttempts) return disconnectSkip(lastMsg);
            await Bun.sleep(800);
            continue;
          }
          // 拉起后本轮重走 blank→目标，避免半开会话
          await Bun.sleep(500);
          continue;
        }
      }
      await Bun.sleep(500);
    }

    const [goOk, goMsg] = await client.pageGoTo(0, {
      url: searchUrl,
      timeoutMs: 60_000,
      wait: 'domcontentloaded',
    });
    lastMsg = goMsg || '';
    client.taskLog(`open_ad_library attempt=${attempt} goOk=${goOk} msg=${lastMsg || '(ok)'}`);

    if (!goOk && isBrowserNotConnected(lastMsg)) {
      const ensured = await ensureBrowserConnected(client, `open_ad_library_goto_reconnect_${attempt}`);
      if (!ensured.ok) {
        lastMsg = ensured.msg || lastMsg;
        if (attempt >= maxAttempts) return disconnectSkip(lastMsg);
        await Bun.sleep(800);
        continue;
      }
      await Bun.sleep(600);
      continue;
    }

    await Bun.sleep(900);

    // 轮询落地：goto 报失败时 URL 仍可能随后切到目标 / checkpoint
    let disconnectedDuringPoll = false;
    for (let poll = 0; poll < 10; poll++) {
      const [pollUrlOk, pollUrlMsg, pageUrl] = await client.getPageUrl();
      if (!pollUrlOk && isBrowserNotConnected(pollUrlMsg || '')) {
        client.taskLog(`open_ad_library poll disconnect poll=${poll}: ${pollUrlMsg}`);
        lastMsg = pollUrlMsg || lastMsg;
        disconnectedDuringPoll = true;
        break;
      }
      lastUrl = pageUrl || lastUrl;
      if (pageUrl && isLoginUrl(pageUrl)) return await authFail(pageUrl);
      if (pageUrl && isTargetAdLibraryUrl(pageUrl, country, keyword)) {
        client.taskLog(`open_ad_library landed attempt=${attempt} poll=${poll} goOk=${goOk}`);
        return null;
      }
      // 页态兜底（URL 尚未带 q 时）；断连时勿空转 detectPageState
      if (poll >= 2) {
        const state = await detectPageState(client);
        if (state === 'auth') return await authFail(pageUrl || lastUrl || searchUrl);
      }
      await Bun.sleep(500);
    }

    if (disconnectedDuringPoll) {
      const ensured = await ensureBrowserConnected(client, `open_ad_library_poll_reconnect_${attempt}`);
      if (!ensured.ok) {
        lastMsg = ensured.msg || lastMsg;
        if (attempt >= maxAttempts) return disconnectSkip(lastMsg);
      }
      await Bun.sleep(800);
      continue;
    }

    // goOk 且已在资料库但关键词未对齐 → 继续重试
    if (goOk && lastUrl && isAdLibraryUrl(lastUrl) && !isTargetAdLibraryUrl(lastUrl, country, keyword)) {
      client.taskLog(`open_ad_library keyword mismatch after goOk: ${lastUrl}`);
    }
    await Bun.sleep(800);
  }

  {
    const ensured = await ensureBrowserConnected(client, 'open_ad_library_final');
    if (!ensured.ok) return disconnectSkip(ensured.msg || lastMsg);
  }

  const [, , finalUrl] = await client.getPageUrl();
  lastUrl = finalUrl || lastUrl;
  if (lastUrl && isLoginUrl(lastUrl)) return await authFail(lastUrl);
  const state = await detectPageState(client);
  if (state === 'auth') return await authFail(lastUrl || searchUrl);

  // 误报兜底：最终已是目标 URL 则继续
  if (lastUrl && isTargetAdLibraryUrl(lastUrl, country, keyword)) {
    client.taskLog(`open_ad_library recover by final url: ${lastUrl}`);
    return null;
  }

  const failMsg = isBrowserNotConnected(lastMsg)
    ? '浏览器未连接或无法自动拉起，请在桌面端确认该浏览器可启动后重试'
    : lastMsg || '打开广告资料库失败';
  // 打开失败（代理断开 / 连接关闭 / 超时等）→ 软跳过，勿标 failed
  client.taskLog(`open_ad_library network skip: ${failMsg}`);
  return networkSkipResult(keyword, country, searchUrl, lastUrl || '', failMsg);
}

async function failStep(
  client: XportBrowserClient,
  msg: string,
  opts: { code: string; step: string; labels?: Record<string, string> },
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step: opts.step,
    reason: msg,
    code: opts.code,
    labels: opts.labels,
  });
  return automationFailWithContext(msg, {
    code: opts.code,
    step: opts.step,
    incidentId: captured?.incidentId,
    labels: opts.labels,
  });
}

/** FB 导航中 evaluate 常报 Execution context was destroyed；短重试。 */
function isTransientEvalError(msg: string): boolean {
  return /Execution context was destroyed|Cannot find context|Target closed|frame was detached|navigat/i.test(
    msg || '',
  );
}

async function evaluateInPageRetry(
  client: XportBrowserClient,
  javaScript: string,
  label: string,
  attempts = 4,
): Promise<[boolean, string, string | null]> {
  let lastMsg = '';
  for (let i = 1; i <= attempts; i++) {
    const [ok, msg, raw] = await client.evaluateInPage(0, javaScript);
    if (ok && raw != null && String(raw).length > 0) return [true, msg || '', String(raw)];
    lastMsg = msg || 'empty';
    // CDP 未连接：空转 evaluate 无意义，立刻返回由上层 ensure/重试
    if (isBrowserNotConnected(lastMsg)) {
      client.taskLog(`${label} evaluate aborted (browser not connected): ${lastMsg}`);
      return [false, lastMsg, null];
    }
    if (!isTransientEvalError(lastMsg) && ok === false && i >= 2) break;
    client.taskLog(`${label} evaluate retry ${i}/${attempts}: ${lastMsg}`);
    await Bun.sleep(700 + i * 200);
  }
  return [false, lastMsg, null];
}

async function extractPages(client: XportBrowserClient): Promise<IntermediateDataRow[]> {
  const [ok, msg, raw] = await evaluateInPageRetry(client, EXTRACT_PAGES_JS, 'extractPages');
  if (!ok || !raw) {
    client.taskLog(`extractPages evaluate failed: ${msg || 'empty'}`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as IntermediateDataRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    client.taskLog(`extractPages JSON parse failed: ${String(e)}`);
    return [];
  }
}

function randomIntInclusive(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 随机滚动距离（约 800～3500px），避免每次固定步长总停在列表顶部。 */
function randomScrollDelta(): number {
  return randomIntInclusive(800, 3500);
}

/** Fisher-Yates 洗牌（原地），使每次入库的主页更分散。 */
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/** 滚动广告结果列表；FB 长连接下勿用 waitForNetworkIdle。 */
async function scrollAdResults(
  client: XportBrowserClient,
  deltaPx?: number,
): Promise<ScrollMetrics> {
  const delta = deltaPx ?? randomScrollDelta();
  const [ok, msg, raw] = await evaluateInPageRetry(
    client,
    buildScrollResultsJs(delta),
    'scrollAdResults',
  );
  if (!ok || !raw) {
    client.taskLog(`scrollAdResults failed: ${msg || 'empty'}`);
    return { before: 0, after: 0, moved: false };
  }
  try {
    const parsed = JSON.parse(raw) as ScrollMetrics & { delta?: number };
    return {
      before: Number(parsed.before) || 0,
      after: Number(parsed.after) || 0,
      moved: Boolean(parsed.moved),
    };
  } catch (e) {
    client.taskLog(`scrollAdResults parse failed: ${String(e)}`);
    return { before: 0, after: 0, moved: false };
  }
}

/**
 * 连滚若干次（每次随机距离），任一次划不动则提前停。
 * 返回最后一次滚动指标；全部未动则 moved=false。
 */
async function scrollAdResultsBurst(
  client: XportBrowserClient,
  times: number,
): Promise<ScrollMetrics> {
  let last: ScrollMetrics = { before: 0, after: 0, moved: false };
  const n = Math.max(1, times);
  for (let i = 0; i < n; i++) {
    const delta = randomScrollDelta();
    last = await scrollAdResults(client, delta);
    client.taskLog(
      `scroll_burst i=${i + 1}/${n} delta=${delta} moved=${last.moved} y=${last.before}->${last.after}`,
    );
    await Bun.sleep(randomIntInclusive(700, 1300));
    if (!last.moved) break;
  }
  return last;
}

function normalizePageNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function detectPageState(client: XportBrowserClient): Promise<AdLibraryPageState> {
  const [ok, msg, raw] = await evaluateInPageRetry(client, DETECT_PAGE_STATE_JS, 'detectPageState');
  if (!ok || !raw) {
    client.taskLog(`detectPageState failed: ${msg || 'empty'}`);
    return 'unknown';
  }
  const s = String(raw).trim();
  if (s === 'auth' || s === 'empty' || s === 'has_pages') return s;
  return 'unknown';
}

function emptySuccessResult(
  keyword: string,
  country: string,
  searchUrl: string,
  finalUrl: string,
  reason: string,
): AutomationRunResult {
  return {
    succ: true,
    msg: reason,
    data: {
      keyword,
      country,
      collected_count: 0,
      final_url: finalUrl || searchUrl,
    },
  };
}

/**
 * 导航后等资料库搜索栏就绪（分段短等 + getNodeCount，捕获 HTTP 超时后重试）。
 * 已能判定 auth → 立刻 NOT_LOGGED_IN；已有结果/空结果 → 视为 chrome 够用；
 * 全程未就绪 → 软继续（由 waitForAdResults 再收口），勿把瞬时超时打成硬失败。
 */
async function waitForAdLibrarySearchChrome(
  client: XportBrowserClient,
  opts: { keyword: string; country: string; searchUrl: string },
): Promise<AutomationRunResult | null> {
  const authFail = async (pageUrl: string) =>
    failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
      code: 'NOT_LOGGED_IN',
      step: 'check_login',
      labels: { keyword: opts.keyword, country: opts.country, pageUrl, searchUrl: opts.searchUrl },
    });

  const deadline = Date.now() + 40_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;

    // 每轮优先检测登录/验证（稳定返回 NOT_LOGGED_IN，便于编排跳过该浏览器）
    const [, , pageUrl] = await client.getPageUrl();
    if (pageUrl && isLoginUrl(pageUrl)) return await authFail(pageUrl);
    const state = await detectPageState(client);
    if (state === 'auth') return await authFail(pageUrl || opts.searchUrl);
    if (state === 'has_pages' || state === 'empty') {
      client.taskLog(`ad_library_chrome ready state=${state} attempt=${attempt}`);
      return null;
    }

    // 1) 先用 getNodeCount 快探（不占长 HTTP 等待）
    for (const sel of AD_LIBRARY_SEARCH_PROBE_SELECTORS) {
      try {
        const [ok, msg, count] = await client.getNodeCount(0, [{ selectors: [sel] }]);
        if (ok && typeof count === 'number' && count > 0) {
          client.taskLog(`ad_library_chrome count hit sel=${sel} n=${count} attempt=${attempt}`);
          return null;
        }
        if (!ok && isTransientBrowserTimeout(msg || '')) {
          client.taskLog(`ad_library_chrome count transient: ${msg}`);
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        client.taskLog(`ad_library_chrome count throw: ${m}`);
      }
    }

    // 2) 分段短 waitForSelector（单段远低于 browser/cmd 60s HTTP 上限）
    try {
      const [uiOk, uiMsg] = await client.waitForSelector(0, {
        selector: AD_LIBRARY_SEARCH_SELECTOR,
        timeoutMs: 5_000,
        visible: true,
      });
      if (uiOk) {
        client.taskLog(`ad_library_chrome waitForSelector ok attempt=${attempt}`);
        return null;
      }
      client.taskLog(`ad_library_chrome wait miss attempt=${attempt}: ${uiMsg || 'not ready'}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      client.taskLog(`ad_library_chrome wait throw attempt=${attempt}: ${m}`);
      if (isTransientBrowserTimeout(m)) {
        await Bun.sleep(900);
        continue;
      }
    }

    await Bun.sleep(700);
  }

  client.taskLog('ad_library_chrome not ready within budget; soft-continue to wait_ad_results');
  return null;
}

/**
 * 等待广告结果就绪：区分账号拦截 / 真无结果 / 已出现主页链接。
 * 加载慢时轻量滚动以触发结果渲染。
 */
async function waitForAdResults(
  client: XportBrowserClient,
  opts: { keyword: string; country: string; searchUrl: string },
): Promise<{ state: AdLibraryPageState; pages: IntermediateDataRow[] } | AutomationRunResult> {
  const deadline = Date.now() + 35_000;
  let lastState: AdLibraryPageState = 'unknown';
  let scrollNudge = 0;

  while (Date.now() < deadline) {
    const [urlOk, , pageUrl] = await client.getPageUrl();
    if (urlOk && pageUrl && isLoginUrl(pageUrl)) {
      return await failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
        code: 'NOT_LOGGED_IN',
        step: 'check_login',
        labels: { keyword: opts.keyword, country: opts.country, pageUrl },
      });
    }

    lastState = await detectPageState(client);
    client.taskLog(`wait_ad_results state=${lastState}`);

    if (lastState === 'auth') {
      return await failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
        code: 'NOT_LOGGED_IN',
        step: 'check_login',
        labels: { keyword: opts.keyword, country: opts.country, searchUrl: opts.searchUrl },
      });
    }

    if (lastState === 'empty') {
      return { state: 'empty', pages: [] };
    }

    const pages = await extractPages(client);
    if (pages.length > 0 || lastState === 'has_pages') {
      return { state: 'has_pages', pages };
    }

    // 选择器兜底：有可见主页锚点但 evaluate 未解析出时，继续等一轮
    try {
      const [selOk] = await client.waitForSelector(0, {
        selector: PAGE_LINK_SELECTOR,
        timeoutMs: 1_200,
        visible: true,
      });
      if (selOk) {
        const again = await extractPages(client);
        if (again.length > 0) return { state: 'has_pages', pages: again };
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      client.taskLog(`wait_ad_results page_link wait throw: ${m}`);
      if (!isTransientBrowserTimeout(m)) {
        // 非超时：继续循环，勿硬失败
      }
    }

    if (scrollNudge < 3) {
      scrollNudge += 1;
      const scroll = await scrollAdResults(client);
      client.taskLog(`wait scroll nudge moved=${scroll.moved} y=${scroll.before}->${scroll.after}`);
      await Bun.sleep(900);
    }
    await Bun.sleep(600);
  }

  // 超时：明确空结果 → success 0；白屏/unknown 勿当成功（常见于代理挂掉）
  const [, , finalUrl] = await client.getPageUrl();
  lastState = await detectPageState(client);
  if (lastState === 'empty') {
    client.taskLog('wait_ad_results timeout → empty copy');
    return { state: 'empty', pages: [] };
  }
  if (lastState === 'auth') {
    return await failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
      code: 'NOT_LOGGED_IN',
      step: 'check_login',
      labels: { keyword: opts.keyword, country: opts.country, searchUrl: opts.searchUrl },
    });
  }
  const latePages = await extractPages(client);
  if (latePages.length > 0) return { state: 'has_pages', pages: latePages };

  // 语言无关收口：资料库搜索栏已就绪、仍 0 广告主链 → 视为真无结果（不依赖空结果文案语种）
  if (finalUrl && isAdLibraryUrl(finalUrl) && lastState === 'unknown') {
    let chromeOk = false;
    try {
      const [ok] = await client.waitForSelector(0, {
        selector: AD_LIBRARY_SEARCH_SELECTOR,
        timeoutMs: 1_500,
        visible: true,
      });
      chromeOk = Boolean(ok);
    } catch (e) {
      client.taskLog(`wait_ad_results chrome check throw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (chromeOk) {
      client.taskLog('wait_ad_results timeout → structural empty (chrome ready, 0 advertiser pages)');
      return { state: 'empty', pages: [] };
    }
    client.taskLog('wait_ad_results timeout unknown → soft reload once');
    await client.pageReload(0, { timeoutMs: 45_000, wait: 'domcontentloaded' });
    await Bun.sleep(2_000);
    lastState = await detectPageState(client);
    const again = await extractPages(client);
    if (again.length > 0) return { state: 'has_pages', pages: again };
    if (lastState === 'empty') return { state: 'empty', pages: [] };
    if (lastState === 'auth') {
      return await failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
        code: 'NOT_LOGGED_IN',
        step: 'check_login',
        labels: { keyword: opts.keyword, country: opts.country, searchUrl: opts.searchUrl },
      });
    }
    let chromeAfter = false;
    try {
      const [ok] = await client.waitForSelector(0, {
        selector: AD_LIBRARY_SEARCH_SELECTOR,
        timeoutMs: 2_000,
        visible: true,
      });
      chromeAfter = Boolean(ok);
    } catch (e) {
      client.taskLog(`wait_ad_results chromeAfter throw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (chromeAfter && (await extractPages(client)).length === 0) {
      client.taskLog('wait_ad_results after reload → structural empty');
      return { state: 'empty', pages: [] };
    }
    // 仍无搜索栏：多半白屏/资源未加载 → 网络类软跳过
    client.taskLog('wait_ad_results network skip: page chrome not ready (blank/proxy)');
    return networkSkipResult(
      opts.keyword,
      opts.country,
      opts.searchUrl,
      finalUrl || '',
      '广告资料库页面未加载出内容',
    );
  }

  return await failStep(client, '未找到广告结果中的公共主页链接，请确认页面已打开广告资料库或稍后重试', {
    code: 'ELEMENT_NOT_FOUND',
    step: 'wait_ad_results',
    labels: { keyword: opts.keyword, country: opts.country, searchUrl: opts.searchUrl },
  });
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfigWire,
  manifest: Awaited<ReturnType<typeof loadAutomationManifest>>,
): Promise<AutomationRunResult> {
  const keyword = String(taskConfig.keyword ?? '').trim();
  const country = normalizeCountryCode(String(taskConfig.country ?? ''));
  const maxCount = parsePositiveIntConfig(taskConfig.max_count, 50);
  client.taskLog(`keyword=${keyword || '(empty)'} country=${country} max_count=${maxCount}`);

  if (!keyword) {
    return automationFailWithContext('请填写搜索关键词', {
      code: 'UNKNOWN',
      step: 'validate_keyword',
    });
  }

  const searchUrl = buildAdLibraryUrl(country, keyword);

  try {
    const openFail = await openAdLibrary(client, { searchUrl, keyword, country });
    if (openFail) return openFail;
    // 导航后多等一会儿再读 DOM；勿 waitForNetworkIdle（FB 长连接易拖满超时）
    await Bun.sleep(1_200);

    // 打开后立刻再检一次登录（早于搜索框等待，稳定 NOT_LOGGED_IN）
    {
      const [, , earlyUrl] = await client.getPageUrl();
      if (earlyUrl && isLoginUrl(earlyUrl)) {
        return await failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
          code: 'NOT_LOGGED_IN',
          step: 'check_login',
          labels: { keyword, country, pageUrl: earlyUrl, searchUrl },
        });
      }
      const earlyState = await detectPageState(client);
      if (earlyState === 'auth') {
        return await failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
          code: 'NOT_LOGGED_IN',
          step: 'check_login',
          labels: { keyword, country, pageUrl: earlyUrl || '', searchUrl },
        });
      }
    }

    // 分段等搜索栏；瞬时 HTTP/选择器超时软继续，勿直接 UNKNOWN
    const chromeFail = await waitForAdLibrarySearchChrome(client, { keyword, country, searchUrl });
    if (chromeFail) return chromeFail;
    await Bun.sleep(600);

    const [urlOk, urlMsg, pageUrl] = await client.getPageUrl();
    if (!urlOk || !pageUrl) {
      if (isNetworkOrProxyFailure(urlMsg || '') || isBrowserNotConnected(urlMsg || '')) {
        return networkSkipResult(keyword, country, searchUrl, '', urlMsg || '无法读取当前页面 URL');
      }
      return await failStep(client, urlMsg || '无法读取当前页面 URL', {
        code: 'UNKNOWN',
        step: 'verify_page_url',
        labels: { keyword, country },
      });
    }
    if (isLoginUrl(pageUrl)) {
      return await failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
        code: 'NOT_LOGGED_IN',
        step: 'check_login',
        labels: { keyword, country, pageUrl },
      });
    }

    const waited = await waitForAdResults(client, { keyword, country, searchUrl });
    if ('succ' in waited) return waited;

    if (waited.state === 'empty') {
      const [, , finalUrl] = await client.getPageUrl();
      return emptySuccessResult(
        keyword,
        country,
        searchUrl,
        finalUrl || searchUrl,
        `关键词「${keyword}」在 ${country} 未匹配到广告，已返回 0 条公共主页`,
      );
    }

    // 候选池：尽量滚到 max_count×2～3（或滚不动），再 Fisher-Yates 洗牌取前 max_count
    const poolTarget = Math.max(maxCount, maxCount * randomIntInclusive(2, 3));
    const candidates: IntermediateDataRow[] = [];
    const seenUrls = new Set<string>();
    const seenNames = new Set<string>();
    let stagnantRounds = 0;
    let noScrollRounds = 0;
    const maxRounds = Math.max(36, Math.ceil(poolTarget / 2) + 20);

    const mergeBatch = (batch: IntermediateDataRow[]): number => {
      let added = 0;
      for (const row of batch) {
        const url = String(row.page_url ?? '').trim();
        const name = String(row.page_name ?? '').trim();
        const nameKey = normalizePageNameKey(name);
        if (!url) continue;
        // URL 或主页名任一已见 → 去重（同一广告主多张卡片）
        if (seenUrls.has(url) || (nameKey && seenNames.has(nameKey))) continue;
        seenUrls.add(url);
        if (nameKey) seenNames.add(nameKey);
        candidates.push({
          keyword,
          country,
          page_name: name,
          page_url: url,
        });
        added += 1;
        if (candidates.length >= poolTarget) break;
      }
      return added;
    };

    // 开始采集前随机下翻 0～5 次，视口落到列表中后段，避免总采顶部几条
    const preScrollTimes = randomIntInclusive(0, 5);
    client.taskLog(`pre_scroll times=${preScrollTimes} pool_target=${poolTarget} max_count=${maxCount}`);
    for (let i = 0; i < preScrollTimes; i++) {
      const delta = randomScrollDelta();
      const scroll = await scrollAdResults(client, delta);
      client.taskLog(
        `pre_scroll i=${i + 1}/${preScrollTimes} delta=${delta} moved=${scroll.moved} y=${scroll.before}->${scroll.after}`,
      );
      await Bun.sleep(randomIntInclusive(800, 1400));
      if (!scroll.moved) {
        client.taskLog('pre_scroll stuck early; continue collect');
        break;
      }
    }

    mergeBatch(waited.pages);
    // 预滚后 DOM 可能已换一批卡片，再抽一次
    mergeBatch(await extractPages(client));
    client.taskLog(`seed_pages=${waited.pages.length} pool=${candidates.length}`);

    for (let round = 0; round < maxRounds && candidates.length < poolTarget; round++) {
      const batch = await extractPages(client);
      const added = mergeBatch(batch);
      client.taskLog(
        `round=${round + 1} batch=${batch.length} added=${added} pool=${candidates.length}/${poolTarget}`,
      );

      if (candidates.length >= poolTarget) break;

      // 每轮随机距离；偶尔连滚 1～3 次再抽取
      const burst = Math.random() < 0.35 ? randomIntInclusive(1, 3) : 1;
      const scroll = await scrollAdResultsBurst(client, burst);
      // 等新卡片渲染；勿 waitForNetworkIdle（FB 长连接易卡满 HTTP 超时）
      await Bun.sleep(randomIntInclusive(900, 1400));

      if (!scroll.moved) {
        noScrollRounds += 1;
      } else {
        noScrollRounds = 0;
      }

      if (added === 0) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
      }

      // 划不动，或连续多轮无新主页且滚动也停了 → 结束
      if (noScrollRounds >= 3) {
        client.taskLog('scroll stuck; stopping pool accumulate');
        break;
      }
      if (stagnantRounds >= 6 && noScrollRounds >= 1) {
        client.taskLog('no new pages and little scroll progress; stopping pool accumulate');
        break;
      }
      if (stagnantRounds >= 10) {
        client.taskLog('no new unique pages after many rounds; stopping pool accumulate');
        break;
      }
    }

    if (candidates.length === 0) {
      // 页面在资料库但解析不到链接：再检测一次是否空结果文案
      const state = await detectPageState(client);
      const [, , finalUrl] = await client.getPageUrl();
      if (state === 'empty' || (finalUrl && isAdLibraryUrl(finalUrl))) {
        return emptySuccessResult(
          keyword,
          country,
          searchUrl,
          finalUrl || searchUrl,
          `关键词「${keyword}」在 ${country} 未采集到公共主页链接，已返回 0 条`,
        );
      }
      return await failStep(client, '未采集到公共主页链接，请更换关键词/地区或确认页面已展示广告列表', {
        code: 'ELEMENT_NOT_FOUND',
        step: 'collect_pages',
        labels: { keyword, country, searchUrl },
      });
    }

    shuffleInPlace(candidates);
    const toIngest = candidates.slice(0, maxCount);
    client.taskLog(`shuffle pool=${candidates.length} ingest=${toIngest.length}`);
    const gid = await resolveTaskGroupId(client, taskConfig);
    client.taskLog(`ingest gid=${gid ?? '(none)'} taskId=${client.taskId} rows=${toIngest.length}`);
    if (client.taskId > 0 && (gid == null || gid <= 0)) {
      client.taskLog('warning: no task group id; data may not show under 采集数据 for a task group');
    }
    const [ingOk, ingMsg] = await ingestIntermediateRows(manifest, toIngest, {
      deviceId: client.id,
      deviceType: 'browser',
      taskId: client.taskId,
      ...(gid != null && gid > 0 ? { gid } : {}),
    });
    if (!ingOk) {
      return await failStep(client, ingMsg || '写入采集数据失败', {
        code: 'UNKNOWN',
        step: 'ingest_pages',
        labels: { keyword, country, count: String(toIngest.length), gid: String(gid ?? 0) },
      });
    }

    const [, , finalUrl] = await client.getPageUrl();
    return {
      succ: true,
      msg: `已采集 ${toIngest.length} 个公共主页`,
      data: {
        keyword,
        country,
        collected_count: toIngest.length,
        final_url: finalUrl || searchUrl,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 登录相关异常勿落成 UNKNOWN，便于编排跳过该浏览器
    if (/\/login\b|\/checkpoint\b|not.?logged|需验证|未登录|confirmemail|two_factor|auth_platform/i.test(msg)) {
      return await failStep(client, '浏览器账号需验证或未登录 Facebook，请先在该浏览器完成验证/登录后再试', {
        code: 'NOT_LOGGED_IN',
        step: 'check_login',
        labels: { keyword, country },
      });
    }
    // 网络/代理/HTTP 超时：软成功跳过，勿标 failed
    if (isNetworkOrProxyFailure(msg) || isBrowserNotConnected(msg)) {
      client.taskLog(`runAutomation network skip: ${msg.slice(0, 240)}`);
      return networkSkipResult(keyword, country, searchUrl, '', msg);
    }
    return await failStep(client, `采集过程异常: ${msg}`, {
      code: 'UNKNOWN',
      step: 'unexpected',
      labels: { keyword, country },
    });
  }
}

const manifest = await loadAutomationManifest();
if (manifest.intermediateDataSchema) {
  const [prepOk, prepMsg] = await prepareIntermediateStorage(manifest);
  if (!prepOk) {
    console.error(`prepareIntermediateStorage failed: ${prepMsg}`);
    process.exit(1);
  }
}
const taskConfig = await loadTaskRunConfig<TaskRunConfigWire>(manifest);

process.exit(
  await XportBrowserClient.run((client) => runAutomation(client, taskConfig, manifest)),
);
