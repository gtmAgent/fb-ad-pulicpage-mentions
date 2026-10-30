/**
 * 按账号串行：巡检通过 → 按开关采齐「天数×每天主页数」（关键词搜主页 / 广告资料库，共用关键词随机抽）
 * → 可选评论 + 可选提及；第 1 天逐页 runAutomation 等发完再下一项/下一账号，第 2 天起 planStartAt 隔天排期。
 * 失效账号打标并跳过；网络/代理类失败 soft-skip 记成功；关键词无主页 soft-skip 换词。
 * 结果页统计互动（评论/提及）任务成功/失败数。
 */
import type { WorkflowRunConfig } from './config.types';
import {
  loadWorkflowManifest,
  loadWorkflowRunConfig,
  type AutomationRunResult,
  type AutomationStepResult,
  type WorkflowContext,
  XportWorkflowClient,
} from 'xport-workflow-sdk';

const CHECK_CMD = 'fb-auto-check';
const AD_COLLECT_CMD = 'fb-ad-publicpage-collection';
const KEYWORD_COLLECT_CMD = 'fb-keywords-page';
const ENGAGE_CMD = 'fb-page-comment-mentions';

const COUNTRY_ALIASES: Record<string, string> = {
  中国: 'CN',
  中國: 'CN',
  china: 'CN',
  prc: 'CN',
  cn: 'CN',
  美国: 'US',
  美國: 'US',
  usa: 'US',
  'united states': 'US',
  us: 'US',
  日本: 'JP',
  japan: 'JP',
  jp: 'JP',
  韩国: 'KR',
  韓國: 'KR',
  korea: 'KR',
  kr: 'KR',
  英国: 'GB',
  英國: 'GB',
  uk: 'GB',
  gb: 'GB',
  台湾: 'TW',
  台灣: 'TW',
  taiwan: 'TW',
  tw: 'TW',
  香港: 'HK',
  hk: 'HK',
  新加坡: 'SG',
  singapore: 'SG',
  sg: 'SG',
  泰国: 'TH',
  泰國: 'TH',
  thailand: 'TH',
  th: 'TH',
  越南: 'VN',
  vietnam: 'VN',
  vn: 'VN',
  印尼: 'ID',
  indonesia: 'ID',
  id: 'ID',
  马来西亚: 'MY',
  馬來西亞: 'MY',
  malaysia: 'MY',
  my: 'MY',
  德国: 'DE',
  德國: 'DE',
  germany: 'DE',
  de: 'DE',
  法国: 'FR',
  法國: 'FR',
  france: 'FR',
  fr: 'FR',
  巴西: 'BR',
  brazil: 'BR',
  br: 'BR',
  印度: 'IN',
  india: 'IN',
  in: 'IN',
};

/** Keywords: allow comma /顿号 as separators (users often paste lists). */
function splitKeywords(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\r\n\/、，,;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Comment / mention copy: split on newlines (and ; /) only.
 * Do NOT split on Chinese/English commas — lines like「感谢博主分享，干货满满！」are one post.
 */
function splitLines(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNoPublicPagesMsg(msg: string): boolean {
  const m = msg.trim();
  if (!m) return false;
  return (
    m.includes('未找到广告结果中的公共主页') ||
    m.includes('没有公共主页') ||
    m.includes('未匹配到广告') ||
    m.includes('未采集到') ||
    m.includes('没有找到') ||
    /no public (page|pages)/i.test(m) ||
    /no pages? (found|collected)/i.test(m)
  );
}

/** 采集/互动时账号掉登录或需验证：后续天跳过该浏览器，避免反复硬失败。 */
function isAuthBlockedMsg(msg: string): boolean {
  const m = msg.trim();
  if (!m) return false;
  return (
    m.includes('需验证') ||
    m.includes('未登录') ||
    m.includes('NOT_LOGGED_IN') ||
    /not logged in|login required|checkpoint|verification/i.test(m)
  );
}

/** 浏览器未启动/断连：跳过该账号。 */
function isTransientBrowserMsg(msg: string): boolean {
  const m = msg.trim();
  if (!m) return false;
  return (
    m.includes('Browser not connected') ||
    m.includes('please launch browser first') ||
    /browser\s*not\s*connected/i.test(m)
  );
}

/**
 * 无网络 / 代理异常：跳过当前任务并记成功，不影响后续天。
 * 含 NAV_FAILED、代理失败、连接关闭、资料库未加载、HTTP 超时等。
 */
function isNetworkOrProxyMsg(msg: string): boolean {
  const m = msg.trim();
  if (!m) return false;
  return (
    m.includes('网络异常') ||
    m.includes('页面无法加载') ||
    m.includes('未加载出内容') ||
    m.includes('广告资料库页面响应超时') ||
    m.includes('NAV_FAILED') ||
    m.includes('ERR_PROXY') ||
    m.includes('ERR_CONNECTION') ||
    m.includes('browser/cmd HTTP timeout') ||
    m.includes('代理') ||
    /net::err_|proxy.?connection|connection.?closed|connection.?failed|navigation\s*timeout|page_go_to.*timeout/i.test(
      m,
    )
  );
}

/** 采集硬跳过账号：仅登录阻断或浏览器未连；网络/代理改为软跳过当前词。 */
function shouldSkipBrowserOnCollect(msg: string): boolean {
  if (isNetworkOrProxyMsg(msg)) return false;
  return isAuthBlockedMsg(msg) || isTransientBrowserMsg(msg);
}

/** 子任务失败但应按成功跳过（不计入失败、不取消后续）。 */
function isSoftSkipSuccess(msg: string): boolean {
  return isNetworkOrProxyMsg(msg);
}

/** 第 day（0=今天）批次的计划开始时间：隔天 = 当前 Unix 秒 + day×86400；第 1 天不传。 */
function planStartAtForDay(day: number): number | undefined {
  if (day <= 0) return undefined;
  return Math.floor(Date.now() / 1000) + day * 86400;
}

function parseBrowserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
}

function parseMd5List(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((s) => s.trim());
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function parseSwitch(raw: unknown, fallback: 0 | 1): boolean {
  if (raw === true || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 0 || raw === '0') return false;
  return fallback === 1;
}

function normalizeCountry(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return 'CN';
  const mapped = COUNTRY_ALIASES[s.toLowerCase()] ?? COUNTRY_ALIASES[s];
  if (mapped) return mapped;
  if (/^[a-z]{2}$/i.test(s)) return s.toUpperCase();
  return s.toUpperCase();
}

function pickCycled<T>(items: T[], index: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[index % items.length];
}

function pickRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

function pageUrlFromRow(row: Record<string, unknown>): string {
  const url = row.page_url ?? row.pageUrl ?? row.url ?? row.host;
  return typeof url === 'string' ? url.trim() : '';
}

/** Numeric facebook.com/123… URLs SPA-redirect; canonicalize before engage to avoid pageGoTo flakes. */
function canonicalizePageUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed);
    const idFromQuery = u.searchParams.get('id');
    if (/profile\.php$/i.test(u.pathname) && idFromQuery && /^\d+$/.test(idFromQuery)) {
      return `https://www.facebook.com/profile.php?id=${idFromQuery}`;
    }
    const m = u.pathname.match(/^\/(\d+)\/?$/);
    if (m) {
      return `https://www.facebook.com/profile.php?id=${m[1]}`;
    }
  } catch {
    /* keep original */
  }
  return trimmed;
}

function uniqueUrls(urls: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

/** 仅「账户失效」跳过；网络异常 / 无法识别 / 有效账号均继续。 */
function isTaggedInvalidAccount(step: AutomationStepResult): boolean {
  const status = String(step.data?.accountStatus ?? '').trim().toLowerCase();
  if (status === 'invalid') return true;
  const outcome = String(step.data?.outcome ?? '').trim().toLowerCase();
  return outcome === 'tagged_invalid';
}

type LaterDaySchedule = {
  browserId: number;
  day: number;
  checkTaskId: number;
  collectTaskId: number;
  collectCmd: string;
  engageTaskIds: number[];
  sendEngageFromCollect: boolean;
};

type EngageContent = {
  commentTexts: string[];
  commentImages: string[];
  mentionTexts: string[];
  mentionImages: string[];
  enableMention: boolean;
};

/** 巡检通过才继续；失效或失败都视为不通过。 */
function isCheckPassed(step: AutomationStepResult): boolean {
  if (isTaggedInvalidAccount(step)) return false;
  return step.succ;
}

function wantsEngage(content: EngageContent): boolean {
  const hasComment = content.commentTexts.length > 0 || content.commentImages.length > 0;
  const hasMention =
    content.enableMention && (content.mentionTexts.length > 0 || content.mentionImages.length > 0);
  return hasComment || hasMention;
}

function engageConfigForIndex(content: EngageContent, index: number): {
  comment_texts: string;
  comment_images: string[];
  mention_texts: string;
  mention_images: string[];
} {
  const commentText = pickCycled(content.commentTexts, index) ?? '';
  const commentImage = pickCycled(content.commentImages, index);
  const mentionText = content.enableMention ? (pickCycled(content.mentionTexts, index) ?? '') : '';
  const mentionImage = content.enableMention ? pickCycled(content.mentionImages, index) : undefined;
  return {
    comment_texts: commentText,
    comment_images: commentImage ? [commentImage] : [],
    mention_texts: mentionText,
    mention_images: mentionImage ? [mentionImage] : [],
  };
}

/** 尽力取消待执行任务（桌面若无取消接口则仅打日志）。 */
async function tryCancelPendingTasks(
  ctx: WorkflowContext,
  taskIds: number[],
  reason: string,
): Promise<void> {
  const uniq = [...new Set(taskIds.filter((id) => id > 0))];
  for (const taskId of uniq) {
    const attempts: Array<{ url: string; body: Record<string, unknown> }> = [
      { url: `${ctx.baseUrl}/workflow/task/${taskId}/cancel`, body: { gid: ctx.gid, reason } },
      { url: `${ctx.baseUrl}/workflow/tasks/cancel`, body: { taskId, gid: ctx.gid, reason } },
    ];
    let ok = false;
    for (const a of attempts) {
      try {
        const res = await fetch(a.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(a.body),
        });
        const text = (await res.text()).slice(0, 160);
        ctx.workflowLog(`cancel #${taskId} ${a.url}: HTTP ${res.status} ${text}`);
        if (res.ok) {
          ok = true;
          break;
        }
      } catch (e) {
        ctx.workflowLog(`cancel #${taskId} ${a.url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!ok) ctx.workflowLog(`cancel #${taskId} unavailable; may still run (${reason})`);
  }
}

async function collectAdPageUrls(
  ctx: WorkflowContext,
  opts: { deviceId: number; keyword: string; country: string; maxCount: number },
): Promise<{ succ: boolean; msg: string; urls: string[] }> {
  const step = await ctx.runAutomation({
    cmd: AD_COLLECT_CMD,
    deviceId: opts.deviceId,
    target: 'browser',
    config: {
      keyword: opts.keyword,
      country: opts.country,
      max_count: opts.maxCount,
    },
  });
  if (!step.succ) return { succ: false, msg: step.msg || 'ad collection failed', urls: [] };
  const [ok, msg, all] = await ctx.fetchAllAutomationData(AD_COLLECT_CMD, { taskId: step.taskId });
  if (!ok) return { succ: false, msg: msg || 'failed to read ad collected pages', urls: [] };
  return { succ: true, msg: '', urls: uniqueUrls((all?.rows ?? []).map(pageUrlFromRow), opts.maxCount) };
}

async function collectKeywordPageUrls(
  ctx: WorkflowContext,
  opts: { deviceId: number; keyword: string; maxCount: number },
): Promise<{ succ: boolean; msg: string; urls: string[] }> {
  const step = await ctx.runAutomation({
    cmd: KEYWORD_COLLECT_CMD,
    deviceId: opts.deviceId,
    target: 'browser',
    config: {
      keyword: opts.keyword,
      max_count: opts.maxCount,
    },
  });
  if (!step.succ) return { succ: false, msg: step.msg || 'keyword collection failed', urls: [] };
  const [ok, msg, all] = await ctx.fetchAllAutomationData(KEYWORD_COLLECT_CMD, {
    taskId: step.taskId,
  });
  if (!ok) return { succ: false, msg: msg || 'failed to read keyword collected pages', urls: [] };
  return { succ: true, msg: '', urls: uniqueUrls((all?.rows ?? []).map(pageUrlFromRow), opts.maxCount) };
}

type CollectSource = 'keyword' | 'ad';

async function collectOnce(
  ctx: WorkflowContext,
  source: CollectSource,
  opts: { deviceId: number; keyword: string; country: string; maxCount: number },
): Promise<{ succ: boolean; msg: string; urls: string[] }> {
  if (source === 'keyword') {
    return collectKeywordPageUrls(ctx, {
      deviceId: opts.deviceId,
      keyword: opts.keyword,
      maxCount: opts.maxCount,
    });
  }
  return collectAdPageUrls(ctx, opts);
}

/**
 * 按开关用随机关键词凑满配额；关键词搜主页与广告资料库可同时开，轮流尝试。
 */
async function collectPagesForQuota(
  ctx: WorkflowContext,
  opts: {
    deviceId: number;
    keywords: string[];
    country: string;
    pageCount: number;
    dayLabel: string;
    emptyKeywords: Set<string>;
    priorSeen: Set<string>;
    enableKeyword: boolean;
    enableAd: boolean;
  },
): Promise<{ succ: boolean; msg: string; urls: string[] }> {
  const urls: string[] = [];
  const seen = new Set<string>(opts.priorSeen);
  let stagnant = 0;
  const sources: CollectSource[] = [];
  if (opts.enableKeyword) sources.push('keyword');
  if (opts.enableAd) sources.push('ad');
  if (sources.length === 0) {
    return { succ: false, msg: 'no collection source enabled', urls: [] };
  }
  let sourceCursor = 0;

  while (urls.length < opts.pageCount) {
    const usable = opts.keywords.filter((k) => !opts.emptyKeywords.has(k));
    if (usable.length === 0) {
      ctx.workflowLog(`${opts.dayLabel} browser ${opts.deviceId}: no usable keywords left`);
      break;
    }
    const keyword = pickRandom(usable)!;
    const source = sources[sourceCursor % sources.length]!;
    sourceCursor += 1;
    const need = opts.pageCount - urls.length;
    ctx.workflowLog(
      `${opts.dayLabel} browser ${opts.deviceId}: source=${source} keyword=${keyword} need=${need}`,
    );
    const collected = await collectOnce(ctx, source, {
      deviceId: opts.deviceId,
      keyword,
      country: opts.country,
      maxCount: need,
    });
    if (!collected.succ) {
      if (isNoPublicPagesMsg(collected.msg) || isSoftSkipSuccess(collected.msg)) {
        if (isNoPublicPagesMsg(collected.msg)) opts.emptyKeywords.add(keyword);
        stagnant = 0;
        ctx.workflowLog(
          `${opts.dayLabel} browser ${opts.deviceId}: source=${source} keyword=${keyword} soft-skip (${collected.msg})`,
        );
        continue;
      }
      return { succ: false, msg: collected.msg || 'collection failed', urls };
    }
    const fresh = collected.urls.filter((url) => url && !seen.has(url));
    if (collected.urls.length === 0) {
      opts.emptyKeywords.add(keyword);
      stagnant = 0;
      continue;
    }
    if (fresh.length === 0) {
      stagnant += 1;
      if (stagnant >= usable.length * sources.length) break;
      continue;
    }
    stagnant = 0;
    for (const url of fresh) {
      seen.add(url);
      opts.priorSeen.add(url);
      urls.push(url);
      if (urls.length >= opts.pageCount) break;
    }
  }
  return { succ: true, msg: '', urls };
}

/**
 * 第 1 天：逐页 runAutomation，等当前主页评论/提及跑完再下一页，再进下一账号。
 * 避免 enqueue 后编排继续往下跑、同一账号多条互动挤在队列里「还没发完就下一个」。
 */
async function runEngageTasksSequentially(
  ctx: WorkflowContext,
  opts: {
    browserId: number;
    dayLabel: string;
    hosts: string[];
    content: EngageContent;
    contentIndexStart: number;
  },
): Promise<{ engaged: number; failed: number; nextContentIndex: number }> {
  let contentIndex = opts.contentIndexStart;
  let engaged = 0;
  let failed = 0;
  for (const host of opts.hosts) {
    const cfg = engageConfigForIndex(opts.content, contentIndex);
    contentIndex += 1;
    const canonical = canonicalizePageUrl(host);
    ctx.workflowLog(
      `${opts.dayLabel} engage now browser=${opts.browserId} host=${canonical} (wait until done)`,
    );
    const step = await ctx.runAutomation({
      cmd: ENGAGE_CMD,
      deviceId: opts.browserId,
      target: 'browser',
      config: {
        host: canonical,
        ...cfg,
      },
    });
    if (step.succ || isSoftSkipSuccess(step.msg)) {
      engaged += 1;
      if (!step.succ) {
        ctx.workflowLog(`${opts.dayLabel} engage soft-skip host=${host}: ${step.msg}`);
      } else {
        ctx.workflowLog(`${opts.dayLabel} engage ok #${step.taskId} host=${host}`);
      }
    } else {
      failed += 1;
      ctx.workflowLog(`${opts.dayLabel} engage failed host=${host}: ${step.msg}`);
    }
  }
  return { engaged, failed, nextContentIndex: contentIndex };
}

/** 入队一批评论/提及；仅 day>0 隔天排期用（带 planStartAt）。 */
async function enqueueEngageTasks(
  ctx: WorkflowContext,
  opts: {
    browserId: number;
    dayLabel: string;
    hosts: string[];
    content: EngageContent;
    contentIndexStart: number;
    day?: number;
  },
): Promise<{ taskIds: number[]; nextContentIndex: number }> {
  let contentIndex = opts.contentIndexStart;
  const taskIds: number[] = [];
  const planStartAt = planStartAtForDay(opts.day ?? 0);
  for (const host of opts.hosts) {
    const cfg = engageConfigForIndex(opts.content, contentIndex);
    contentIndex += 1;
    const [mOk, mMsg, mData] = await ctx.enqueueTask({
      cmd: ENGAGE_CMD,
      deviceId: opts.browserId,
      target: 'browser',
      config: {
        host: canonicalizePageUrl(host),
        ...cfg,
      },
      ...(planStartAt != null ? { planStartAt } : {}),
    });
    if (!mOk || !mData) {
      ctx.workflowLog(`${opts.dayLabel} enqueue engage failed browser=${opts.browserId}: ${mMsg}`);
      continue;
    }
    taskIds.push(mData.taskId);
    ctx.workflowLog(
      `queued engage #${mData.taskId} ${opts.dayLabel} browser=${opts.browserId} host=${host}` +
        (planStartAt != null ? ` planStartAt=${planStartAt}` : ''),
    );
  }
  return { taskIds, nextContentIndex: contentIndex };
}

/**
 * 为某账号某一后续天入队：巡检 +（缺主页时）采集 + 互动。
 * 整包同一 planStartAt（隔天 = 当前 Unix 秒 + day×86400）。
 */
async function enqueueLaterDayBundle(
  ctx: WorkflowContext,
  opts: {
    browserId: number;
    day: number;
    days: number;
    keyword: string;
    country: string;
    pageCount: number;
    hosts: string[];
    content: EngageContent;
    contentIndexStart: number;
    enableKeyword: boolean;
    enableAd: boolean;
  },
): Promise<{ schedule: LaterDaySchedule; nextContentIndex: number }> {
  const { browserId, day, days, keyword, country, pageCount, hosts } = opts;
  let contentIndex = opts.contentIndexStart;
  let checkTaskId = 0;
  let collectTaskId = 0;
  let collectCmd = '';
  const engageTaskIds: number[] = [];
  const sendEngageFromCollect = hosts.length === 0 && wantsEngage(opts.content);
  const dayLabel = `day ${day + 1}/${days}`;
  const planStartAt = planStartAtForDay(day);
  const scheduleOpts = planStartAt != null ? { planStartAt } : {};

  const [chkOk, chkMsg, chkData] = await ctx.enqueueTask({
    cmd: CHECK_CMD,
    deviceId: browserId,
    target: 'browser',
    config: { ensure_english: 1 },
    ...scheduleOpts,
  });
  if (!chkOk || !chkData) {
    ctx.workflowLog(`enqueue later check failed ${dayLabel} browser=${browserId}: ${chkMsg}`);
  } else {
    checkTaskId = chkData.taskId;
    ctx.workflowLog(
      `queued check #${checkTaskId} ${dayLabel} browser=${browserId}` +
        (planStartAt != null ? ` planStartAt=${planStartAt}` : ''),
    );
  }

  // 已有预留主页则跳过重复采集，只入队巡检+互动
  if (sendEngageFromCollect) {
    const useAd = opts.enableAd;
    const useKw = !useAd && opts.enableKeyword;
    if (useAd) {
      collectCmd = AD_COLLECT_CMD;
      const [cOk, cMsg, cData] = await ctx.enqueueTask({
        cmd: AD_COLLECT_CMD,
        deviceId: browserId,
        target: 'browser',
        config: { keyword, country, max_count: pageCount },
        ...scheduleOpts,
      });
      if (!cOk || !cData) {
        ctx.workflowLog(`enqueue later ad collect failed ${dayLabel} browser=${browserId}: ${cMsg}`);
      } else {
        collectTaskId = cData.taskId;
        ctx.workflowLog(
          `queued ad collect #${collectTaskId} ${dayLabel} browser=${browserId}` +
            (planStartAt != null ? ` planStartAt=${planStartAt}` : ''),
        );
      }
    } else if (useKw) {
      collectCmd = KEYWORD_COLLECT_CMD;
      const [cOk, cMsg, cData] = await ctx.enqueueTask({
        cmd: KEYWORD_COLLECT_CMD,
        deviceId: browserId,
        target: 'browser',
        config: { keyword, max_count: pageCount },
        ...scheduleOpts,
      });
      if (!cOk || !cData) {
        ctx.workflowLog(
          `enqueue later keyword collect failed ${dayLabel} browser=${browserId}: ${cMsg}`,
        );
      } else {
        collectTaskId = cData.taskId;
        ctx.workflowLog(
          `queued keyword collect #${collectTaskId} ${dayLabel} browser=${browserId}` +
            (planStartAt != null ? ` planStartAt=${planStartAt}` : ''),
        );
      }
    }
    ctx.workflowLog(`${dayLabel} browser=${browserId}: no reserved hosts; engage after collect`);
  } else if (hosts.length > 0 && wantsEngage(opts.content)) {
    const enq = await enqueueEngageTasks(ctx, {
      browserId,
      dayLabel,
      hosts,
      content: opts.content,
      contentIndexStart: contentIndex,
      day,
    });
    engageTaskIds.push(...enq.taskIds);
    contentIndex = enq.nextContentIndex;
  }

  return {
    schedule: {
      browserId,
      day,
      checkTaskId,
      collectTaskId,
      collectCmd,
      engageTaskIds,
      sendEngageFromCollect,
    },
    nextContentIndex: contentIndex,
  };
}

async function sendEngageFromCollectTask(
  ctx: WorkflowContext,
  opts: {
    browserId: number;
    collectTaskId: number;
    collectCmd: string;
    pageCount: number;
    dayLabel: string;
    content: EngageContent;
    contentIndex: { value: number };
  },
): Promise<{ engaged: number; failed: number }> {
  let engaged = 0;
  let failed = 0;
  const cmd = opts.collectCmd || AD_COLLECT_CMD;
  const [ok, msg, all] = await ctx.fetchAllAutomationData(cmd, {
    taskId: opts.collectTaskId,
  });
  if (!ok) {
    ctx.workflowLog(`${opts.dayLabel} browser ${opts.browserId}: read collect failed: ${msg}`);
    return { engaged, failed };
  }
  const urls = uniqueUrls((all?.rows ?? []).map(pageUrlFromRow), opts.pageCount);
  if (urls.length === 0) {
    ctx.workflowLog(`${opts.dayLabel} browser ${opts.browserId}: collect has no page urls`);
    return { engaged, failed };
  }
  for (const host of urls) {
    const cfg = engageConfigForIndex(opts.content, opts.contentIndex.value);
    opts.contentIndex.value += 1;
    const step = await ctx.runAutomation({
      cmd: ENGAGE_CMD,
      deviceId: opts.browserId,
      target: 'browser',
      config: {
        host: canonicalizePageUrl(host),
        ...cfg,
      },
    });
    if (step.succ || isSoftSkipSuccess(step.msg)) {
      engaged += 1;
      if (!step.succ) {
        ctx.workflowLog(`${opts.dayLabel} engage soft-skip host=${host}: ${step.msg}`);
      }
    } else {
      failed += 1;
      ctx.workflowLog(`${opts.dayLabel} engage failed host=${host}: ${step.msg}`);
    }
  }
  return { engaged, failed };
}

async function runWorkflow(ctx: WorkflowContext, cfg: WorkflowRunConfig): Promise<AutomationRunResult> {
  const keywords = splitKeywords(cfg.keywords);
  const commentTexts = splitLines(cfg.comment_texts);
  const commentImages = parseMd5List(cfg.comment_images);
  const mentionTexts = splitLines(cfg.mention_texts);
  const mentionImages = parseMd5List(cfg.mention_images);
  const browserIds = parseBrowserIds(cfg.browsers);
  const country = normalizeCountry(cfg.country);
  const pageCount = parsePositiveInt(cfg.page_count, 3);
  const days = parsePositiveInt(cfg.days, 1);
  const enableKeyword = parseSwitch(cfg.enable_keyword_collect, 0);
  const enableAd = parseSwitch(cfg.enable_ad_collect, 1);
  const enableMention = parseSwitch(cfg.enable_mention, 1);

  if (keywords.length === 0) return { succ: false, msg: 'keywords is required' };
  if (!enableKeyword && !enableAd) {
    return { succ: false, msg: 'enable at least one collection: keyword Pages or Ad Library' };
  }
  if (enableMention && mentionTexts.length === 0 && mentionImages.length === 0) {
    return { succ: false, msg: 'mention_texts is required when Mentions is enabled' };
  }
  if (browserIds.length === 0) return { succ: false, msg: 'browsers is required' };

  const content: EngageContent = {
    commentTexts,
    commentImages,
    mentionTexts: enableMention ? mentionTexts : [],
    mentionImages: enableMention ? mentionImages : [],
    enableMention,
  };
  const doEngage = wantsEngage(content);

  const planned = days * pageCount * browserIds.length;
  ctx.workflowLog(
    `plan(per-account, calendar schedule): days=${days} pages/day/browser=${pageCount} ` +
      `browsers=${browserIds.length} planned≈${planned} country=${country} ` +
      `keywordCollect=${enableKeyword} adCollect=${enableAd} engage=${doEngage} mention=${enableMention} ` +
      `(day2+ planStartAt = now+N×86400; random keywords; network/proxy soft-skip)`,
  );

  const emptyKeywords = new Set<string>();
  const contentIndexRef = { value: 0 };
  let engaged = 0;
  let engageFailed = 0;
  let day0Engaged = 0;
  const schedules: LaterDaySchedule[] = [];
  const dayNotes: string[] = [];
  let collectedTotal = 0;

  // 按账号：巡检+采齐 → 第 1 天立即入队；第 2+ 天按 planStartAt 隔天排期
  for (let bi = 0; bi < browserIds.length; bi++) {
    const browserId = browserIds[bi]!;
    ctx.workflowLog(`account ${bi + 1}/${browserIds.length}: browser ${browserId} check now`);

    const checkStep = await ctx.runAutomation({
      cmd: CHECK_CMD,
      deviceId: browserId,
      target: 'browser',
      config: { ensure_english: 1 },
    });
    if (!isCheckPassed(checkStep)) {
      if (isSoftSkipSuccess(checkStep.msg)) {
        ctx.workflowLog(
          `browser ${browserId}: check network/proxy soft-skip (${checkStep.msg}); next account`,
        );
        continue;
      }
      ctx.workflowLog(
        `browser ${browserId}: check not passed / tagged invalid ` +
          `(succ=${checkStep.succ} msg=${checkStep.msg}); skip account`,
      );
      continue;
    }
    ctx.workflowLog(`browser ${browserId}: check ok → collect all days now`);

    const totalNeed = days * pageCount;
    const priorSeen = new Set<string>();
    const collected = await collectPagesForQuota(ctx, {
      deviceId: browserId,
      keywords,
      country,
      pageCount: totalNeed,
      dayLabel: `browser ${browserId} precollect`,
      emptyKeywords,
      priorSeen,
      enableKeyword,
      enableAd,
    });

    if (!collected.succ && shouldSkipBrowserOnCollect(collected.msg)) {
      ctx.workflowLog(`browser ${browserId}: collect blocked (${collected.msg}); skip account`);
      continue;
    }
    if (!collected.succ && isSoftSkipSuccess(collected.msg)) {
      ctx.workflowLog(
        `browser ${browserId}: collect network/proxy soft-skip (${collected.msg}); next account`,
      );
      continue;
    }
    if (collected.urls.length === 0) {
      ctx.workflowLog(`browser ${browserId}: no pages collected; skip engage/schedule`);
      continue;
    }
    collectedTotal += collected.urls.length;
    ctx.workflowLog(
      `browser ${browserId}: collected ${collected.urls.length}/${totalNeed}; ` +
        (doEngage
          ? `day1 engage sequential (wait each), day2+ with planStartAt`
          : `collect-only (no comment/mention)`),
    );

    if (!doEngage) {
      // 仅采集：后续天也不入队互动
      continue;
    }

    // 第 1 天：逐页等评论/提及完成，再下一页；本账号发完再进下一账号
    const day0Urls = collected.urls.slice(0, pageCount);
    const day0Run = await runEngageTasksSequentially(ctx, {
      browserId,
      dayLabel: `day 1/${days}`,
      hosts: day0Urls,
      content,
      contentIndexStart: contentIndexRef.value,
    });
    contentIndexRef.value = day0Run.nextContentIndex;
    engaged += day0Run.engaged;
    engageFailed += day0Run.failed;
    day0Engaged += day0Run.engaged;

    // 后续天：巡检+互动（有预留主页则不再采），planStartAt 隔天
    for (let day = 1; day < days; day++) {
      const dayUrls = collected.urls.slice(day * pageCount, (day + 1) * pageCount);
      const keyword = pickRandom(keywords)!;
      const { schedule, nextContentIndex } = await enqueueLaterDayBundle(ctx, {
        browserId,
        day,
        days,
        keyword,
        country,
        pageCount,
        hosts: dayUrls,
        content,
        contentIndexStart: contentIndexRef.value,
        enableKeyword,
        enableAd,
      });
      contentIndexRef.value = nextContentIndex;
      schedules.push(schedule);
    }
  }

  // 第 1 天已串行跑完；后续天统一等待：硬巡检失败才取消；网络/代理软跳过并记成功
  dayNotes.push(`D1 engage=${day0Engaged}`);
  const byDay = new Map<number, LaterDaySchedule[]>();
  for (const s of schedules) {
    const list = byDay.get(s.day) ?? [];
    list.push(s);
    byDay.set(s.day, list);
  }

  for (let day = 1; day < days; day++) {
    const dayLabel = `day ${day + 1}/${days}`;
    const list = byDay.get(day) ?? [];
    let dayEngaged = 0;

    for (const s of list) {
      if (s.checkTaskId > 0) {
        const checkStep = await ctx.waitForTask(s.checkTaskId);
        if (!isCheckPassed(checkStep)) {
          if (isSoftSkipSuccess(checkStep.msg)) {
            ctx.workflowLog(
              `${dayLabel} browser ${s.browserId}: check network/proxy soft-skip; keep follow-ups`,
            );
          } else {
            ctx.workflowLog(`${dayLabel} browser ${s.browserId}: check failed → cancel follow-ups`);
            await tryCancelPendingTasks(
              ctx,
              [s.collectTaskId, ...s.engageTaskIds],
              `${dayLabel} check failed`,
            );
            continue;
          }
        }
      }

      let collectOk = false;
      let collectSoftSkip = false;
      if (s.collectTaskId > 0) {
        const cStep = await ctx.waitForTask(s.collectTaskId);
        collectOk = cStep.succ;
        collectSoftSkip = !cStep.succ && isSoftSkipSuccess(cStep.msg);
        ctx.workflowLog(
          `${dayLabel} collect #${s.collectTaskId} browser=${s.browserId}: ` +
            `${cStep.succ ? 'ok' : collectSoftSkip ? `soft-skip ${cStep.msg}` : cStep.msg}`,
        );
      }

      if (s.engageTaskIds.length > 0) {
        for (const taskId of s.engageTaskIds) {
          const step = await ctx.waitForTask(taskId);
          if (step.succ || isSoftSkipSuccess(step.msg)) {
            engaged += 1;
            dayEngaged += 1;
            if (!step.succ) {
              ctx.workflowLog(`${dayLabel} engage #${taskId} soft-skip: ${step.msg}`);
            }
          } else {
            engageFailed += 1;
            ctx.workflowLog(`${dayLabel} engage #${taskId} failed: ${step.msg}`);
          }
        }
      } else if (s.sendEngageFromCollect) {
        if (!collectOk) {
          if (collectSoftSkip) {
            ctx.workflowLog(
              `${dayLabel} browser ${s.browserId}: collect soft-skip; skip engage (counted ok)`,
            );
          } else {
            ctx.workflowLog(`${dayLabel} browser ${s.browserId}: skip engage (collect failed)`);
          }
          continue;
        }
        const sent = await sendEngageFromCollectTask(ctx, {
          browserId: s.browserId,
          collectTaskId: s.collectTaskId,
          collectCmd: s.collectCmd,
          pageCount,
          dayLabel,
          content,
          contentIndex: contentIndexRef,
        });
        engaged += sent.engaged;
        engageFailed += sent.failed;
        dayEngaged += sent.engaged;
      }
    }
    dayNotes.push(`D${day + 1} engage=${dayEngaged}`);
  }

  const summary =
    `engage ok ${engaged}; failed ${engageFailed}; collected≈${collectedTotal}; ` +
    `planned≈${planned} (${days}d × ${pageCount} × ${browserIds.length}); ` +
    `kw=${enableKeyword ? 1 : 0} ad=${enableAd ? 1 : 0} mention=${enableMention ? 1 : 0}. ` +
    dayNotes.join('; ');

  const succ = doEngage ? engaged > 0 : collectedTotal > 0;
  return {
    succ,
    msg: doEngage
      ? engaged > 0
        ? `sent ${engaged} engage tasks`
        : 'no engage tasks sent'
      : collectedTotal > 0
        ? `collected ${collectedTotal} pages (engage off)`
        : 'no pages collected',
    data: { mentioned: engaged, failed: engageFailed, summary },
  };
}

const manifest = await loadWorkflowManifest();
const runConfig = await loadWorkflowRunConfig<WorkflowRunConfig>(manifest);

process.exit(await XportWorkflowClient.run((ctx) => runWorkflow(ctx, runConfig)));
