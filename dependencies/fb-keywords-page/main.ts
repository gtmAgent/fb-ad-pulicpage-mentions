/**
 * Facebook 按关键词采集公共主页：
 * 直达 `/search/pages?q=`（语言无关）→ 读结果列表链接 → 滚动补齐至上限 → 入库。
 */
import type { IntermediateDataRow, TaskRunConfig } from './config.types';
import {
  type AutomationFailureCategory,
  type AutomationFailureCode,
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  parsePositiveIntConfig,
  prepareIntermediateStorage,
  XportBrowserClient,
} from 'xport-browser-sdk';

const socialHome = () =>
  String(Bun.env.SOCIAL_HOME || 'https://www.facebook.com').replace(/\/$/, '');

/** 搜索结果主区：主页名称链接（role=presentation，与 UI 语言无关）。 */
const pageResultLinksPath = nodePath()
  .css('div[role="main"] a[role="presentation"]')
  .many();

const pageMainPath = nodePath().css('div[role="main"]').one();

const pageScrollPath = nodePath().css('body');

type PageHit = { pageName: string; pageUrl: string };

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: AutomationFailureCode | string,
  labels?: Record<string, string>,
  category?: AutomationFailureCategory,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step,
    reason,
    code,
    labels,
    category,
  });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
    category,
  });
}

function cleanPageName(raw: string): string {
  return String(raw || '')
    .replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '')
    .replace(/已认证账户$/u, '')
    .trim();
}

function normalizePageUrl(href: string): string | null {
  const raw = String(href || '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, socialHome());
  } catch {
    return null;
  }
  if (!/facebook\.com$/i.test(url.hostname) && !/\.facebook\.com$/i.test(url.hostname)) {
    return null;
  }
  // 排除非主页路径
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (
    path.startsWith('/search') ||
    path.startsWith('/watch') ||
    path.startsWith('/groups') ||
    path.startsWith('/marketplace') ||
    path.startsWith('/events') ||
    path.startsWith('/reel') ||
    path.startsWith('/stories') ||
    path.startsWith('/notifications') ||
    path.startsWith('/messages') ||
    path === '/'
  ) {
    return null;
  }
  url.hash = '';
  url.search = '';
  // profile.php 保留 id
  if (path === '/profile.php') {
    const id = new URL(raw, socialHome()).searchParams.get('id');
    if (!id) return null;
    return `${url.origin}/profile.php?id=${id}`;
  }
  return `${url.origin}${path}`;
}

function isSearchPagesUrl(url: string): boolean {
  return /facebook\.com\/search\/pages/i.test(url);
}

function isLoginUrl(url: string): boolean {
  return /\/login/i.test(url) || /\/checkpoint\/.*login/i.test(url);
}

function isCheckpointUrl(url: string): boolean {
  return /\/checkpoint\//i.test(url);
}

async function readCurrentUrl(client: XportBrowserClient): Promise<string> {
  const [ok, , pageUrl] = await client.getPageUrl();
  return ok && pageUrl ? String(pageUrl) : '';
}

/**
 * 导航后拦截账号/网络异常态，避免误报「无公共主页」。
 * 返回 null 表示可继续采集；否则为结构化 fail 结果。
 */
async function failIfBlockedState(
  client: XportBrowserClient,
  step: string,
  labels: Record<string, string>,
  pageUrl?: string,
): Promise<AutomationRunResult | null> {
  const url = pageUrl ?? (await readCurrentUrl(client));
  if (isLoginUrl(url)) {
    return await failStep(
      client,
      step,
      'Browser is not logged in to Facebook. Please log in on this fingerprint profile first.',
      'NOT_LOGGED_IN',
      labels,
      'auth',
    );
  }
  if (isCheckpointUrl(url)) {
    return await failStep(
      client,
      step,
      'Facebook account is locked or requires security verification (checkpoint). Unlock the account on this browser, then retry.',
      'ACCOUNT_RESTRICTED',
      labels,
      'auth',
    );
  }
  return null;
}

async function waitForCount(
  client: XportBrowserClient,
  path: ReturnType<typeof nodePath>,
  pred: (n: number) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const [ok, , count] = await client.getNodeCount(0, path);
    last = ok && typeof count === 'number' ? count : 0;
    if (pred(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function readPageHits(client: XportBrowserClient): Promise<PageHit[]> {
  const [ok, , table] = await client.getNodeData(0, pageResultLinksPath, [
    'attribute:href',
    'text',
  ]);
  if (!ok || !table) return [];
  const hrefs = (table['attribute:href'] ?? table.href ?? []) as string[];
  const texts = (table.text ?? []) as string[];
  const out: PageHit[] = [];
  const n = Math.max(hrefs.length, texts.length);
  for (let i = 0; i < n; i++) {
    const pageUrl = normalizePageUrl(hrefs[i] ?? '');
    if (!pageUrl) continue;
    const pageName = cleanPageName(texts[i] ?? '') || pageUrl;
    out.push({ pageName, pageUrl });
  }
  return out;
}

async function collectPages(
  client: XportBrowserClient,
  maxCount: number,
): Promise<PageHit[]> {
  const byUrl = new Map<string, PageHit>();
  let staleRounds = 0;

  for (let round = 0; round < 40; round++) {
    const hits = await readPageHits(client);
    let added = 0;
    for (const hit of hits) {
      if (byUrl.has(hit.pageUrl)) continue;
      byUrl.set(hit.pageUrl, hit);
      added += 1;
      if (byUrl.size >= maxCount) {
        return [...byUrl.values()].slice(0, maxCount);
      }
    }

    if (added === 0) {
      staleRounds += 1;
      if (staleRounds >= 3) break;
    } else {
      staleRounds = 0;
    }

    // 滚动超时/设备卡住时：已采到的结果仍保留，勿整任务失败
    try {
      const [wheelOk] = await client.mouseWheel(0, pageScrollPath, { deltaY: 900 });
      if (!wheelOk) {
        client.taskLog(`mouseWheel failed at round=${round}; stop scrolling with ${byUrl.size} pages`);
        break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      client.taskLog(`mouseWheel error at round=${round}: ${msg}; keep ${byUrl.size} pages`);
      break;
    }
    await sleep(900);
    try {
      await client.waitForDomQuiet(0, { stableMs: 400, timeoutMs: 4000 });
    } catch {
      // ignore quiet wait errors; next round will re-read
    }
  }

  return [...byUrl.values()].slice(0, maxCount);
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  const keyword = String(taskConfig.keyword ?? '').trim();
  const maxCount = parsePositiveIntConfig(taskConfig.max_count ?? 20, 20);
  const labels = {
    keyword,
    maxCount: String(maxCount),
  };

  client.taskLog(`keyword=${keyword || '(empty)'} max_count=${maxCount}`);

  if (!keyword) {
    return automationFailWithContext('keyword is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_keyword',
    });
  }
  if (maxCount < 1) {
    return automationFailWithContext('max_count must be at least 1', {
      code: 'UNKNOWN',
      step: 'validate_max_count',
    });
  }

  try {
    const searchUrl = `${socialHome()}/search/pages?q=${encodeURIComponent(keyword)}`;
    const [goOk, goMsg] = await client.pageGoTo(0, { url: searchUrl, timeoutMs: 60_000 });
    await sleep(800);

    const pageUrlAfterNav = await readCurrentUrl(client);
    const blockedAfterNav = await failIfBlockedState(
      client,
      'open_search',
      labels,
      pageUrlAfterNav,
    );
    if (blockedAfterNav) return blockedAfterNav;

    if (!goOk) {
      // SPA/代理慢：若已落到搜索页则继续；否则按导航失败处理
      if (isSearchPagesUrl(pageUrlAfterNav)) {
        client.taskLog(`pageGoTo reported fail but landed on search pages; continue. msg=${goMsg || ''}`);
      } else {
        return await failStep(
          client,
          'open_search',
          goMsg ||
            'Failed to open Facebook Pages search. Check proxy/network on this browser, then retry.',
          'NAV_FAILED',
          labels,
          'network',
        );
      }
    }

    const readyCount = await waitForCount(client, pageResultLinksPath, (n) => n >= 1, 20_000);
    client.taskLog(`initial result links=${readyCount}`);

    // 等待期间可能跳转到 checkpoint
    const urlAfterWait = await readCurrentUrl(client);
    const blockedAfterWait = await failIfBlockedState(
      client,
      'collect_pages',
      labels,
      urlAfterWait,
    );
    if (blockedAfterWait) return blockedAfterWait;

    if (readyCount < 1) {
      const [mainOk, , mainCount] = await client.getNodeCount(0, pageMainPath);
      const hasMain = mainOk && typeof mainCount === 'number' && mainCount >= 1;
      if (!hasMain) {
        // 代理 404「Not Found」、Meta 启动白屏等：页面壳未就绪
        return await failStep(
          client,
          'open_search',
          'Facebook search page did not load (blank / Not Found). Check this browser proxy and network, then retry.',
          'NAV_FAILED',
          labels,
          'network',
        );
      }
    }

    const pages = await collectPages(client, maxCount);
    client.taskLog(`collected ${pages.length} pages for keyword=${keyword}`);

    if (pages.length === 0) {
      // 再次确认不是中途被踢到 checkpoint / 登录阻断
      const urlFinal = await readCurrentUrl(client);
      const blockedFinal = await failIfBlockedState(client, 'collect_pages', labels, urlFinal);
      if (blockedFinal) return blockedFinal;

      // 业务空结果（页面已就绪但无公共主页）：succ + collectedCount=0，勿标 failed
      const [, , finalUrlEmpty] = await client.getPageUrl();
      return {
        succ: true,
        msg: `No public pages found for keyword "${keyword}". Try another keyword or check the account/region.`,
        data: {
          keyword,
          collectedCount: 0,
          finalUrl: finalUrlEmpty ?? searchUrl,
        },
      };
    }

    const rows: IntermediateDataRow[] = pages.map((p) => ({
      keyword,
      pageName: p.pageName,
      pageUrl: p.pageUrl,
    }));

    const [ingOk, ingMsg] = await client.ingestIntermediate(rows);
    if (!ingOk) {
      return await failStep(
        client,
        'ingest_rows',
        ingMsg || 'ingestIntermediate failed',
        'UNKNOWN',
        labels,
      );
    }

    const [, , finalUrl] = await client.getPageUrl();

    return {
      succ: true,
      msg: `collected ${pages.length} pages`,
      data: {
        keyword,
        collectedCount: pages.length,
        finalUrl: finalUrl ?? searchUrl,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await failStep(client, 'unexpected', reason, 'UNKNOWN', labels);
  }
}

const manifest = await loadAutomationManifest();
if (manifest.intermediateDataSchema) {
  const [prepOk, prepMsg] = await prepareIntermediateStorage(manifest);
  if (!prepOk) {
    process.exit(
      await XportBrowserClient.run(async () =>
        automationFailWithContext(prepMsg || 'prepareIntermediateStorage failed', {
          code: 'UNKNOWN',
          step: 'prepare_storage',
        }),
      ),
    );
  }
}

const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(
  await XportBrowserClient.run((client) => runAutomation(client, taskConfig)),
);
