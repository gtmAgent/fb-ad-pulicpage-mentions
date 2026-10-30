/**
 * Facebook 账号巡检：打开当前浏览器的 Facebook，按看到的页面状态打「账户失效」/「网络异常」/「无法识别」，或确保界面为英文。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  XportBrowserClient,
} from 'xport-browser-sdk';

const LABEL_INVALID = '账户失效';
const LABEL_NETWORK = '网络异常';
const LABEL_UNRECOGNIZED = '无法识别';
const LANGUAGE_SETTINGS_URL = 'https://www.facebook.com/settings/?tab=language';
/** Puppeteer wait must stay under SDK HTTP default (60s) so failures return [false,msg] instead of throw. */
const NAV_PAGE_TIMEOUT_MS = 40_000;
const NAV_RECOVER_TIMEOUT_MS = 25_000;
const NAV_MAX_ATTEMPTS = 3;

type Outcome =
  | 'logged_in_english'
  | 'language_switched'
  | 'language_skipped'
  | 'tagged_invalid'
  | 'tagged_network'
  | 'tagged_unrecognized'
  | 'already_valid';

type AccountStatus = 'valid' | 'invalid' | 'network' | 'unrecognized';

/** AYMH profile CTAs to skip (EN / ID / ES / FR / PT / …). */
const AYMH_SKIP_CTA =
  /^(Use another profile|Gunakan profil lain|Usar otro perfil|Utiliser un autre profil|Usar outro perfil|Create new account|Create account|Buat akun baru|Buat akun|Criar nova conta|Crear cuenta nueva|Crear una cuenta|Crear cuenta|Créer un compte|Créer un nouveau compte)$/i;

async function failStep(
  client: XportBrowserClient,
  step: string,
  code: string,
  msg: string,
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  let incidentId: string | undefined;
  try {
    const [, , captured] = await client.captureIncident({
      step,
      reason: msg,
      code,
      labels,
    });
    incidentId = captured?.incidentId;
  } catch (e) {
    client.taskLog(
      `captureIncident skipped after fail: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return automationFailWithContext(msg, {
    code,
    step,
    incidentId,
    labels,
  });
}

function isNavTimeoutMsg(msg: string): boolean {
  return /HTTP timeout|timeout after\s*\d+ms|TimeoutException|Navigation timeout|waiting for (function|selector|navigation) failed/i.test(
    msg || '',
  );
}

/** Network / proxy / chrome-error style failures — soft-skip the task (succ:true), never hard-fail. */
function isNetworkOrProxyErrorMsg(msg: string): boolean {
  const m = msg || '';
  if (isNavTimeoutMsg(m)) return true;
  return /ERR_PROXY|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_SSL|ERR_ADDRESS|DNS_PROBE|chrome-error|chromewebdata|net::ERR_|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|proxy\s*(error|fail|refused|closed)|代理失败|代理不可用|网络异常|This site can.?t be reached|took too long to respond/i.test(
    m,
  );
}

function softSkipNetworkMsg(detail: string): string {
  const base = (detail || '').trim();
  if (!base) return '因网络/代理异常跳过本任务';
  if (/因网络\/代理/.test(base)) return base;
  return `${base}（因网络/代理原因跳过）`;
}

function normalizeUrlForCompare(url: string): string {
  try {
    const u = new URL((url || '').trim());
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '') || '/';
    // Treat /settings and /settings/ the same; keep query for tab=language etc.
    return `${u.origin.toLowerCase()}${path.toLowerCase()}${u.search}`;
  } catch {
    return (url || '').trim().toLowerCase().replace(/\/+$/, '');
  }
}

function urlMatchesTarget(actual: string, target: string): boolean {
  if (!actual || isChromeErrorUrl(actual)) return false;
  const a = normalizeUrlForCompare(actual);
  const t = normalizeUrlForCompare(target);
  if (!a || !t) return false;
  if (a === t) return true;
  // Home: facebook.com / www.facebook.com / with trailing junk
  if (/facebook\.com\/?(\?|$)/i.test(target) && /facebook\.com\/?(\?|#|$)/i.test(actual.split('?')[0] ?? actual)) {
    return true;
  }
  // Language settings: tolerate settings vs settings/ and tab order
  if (/settings\/?\?tab=language/i.test(target) && /facebook\.com\/settings\/?/i.test(actual) && /[?&]tab=language\b/i.test(actual)) {
    return true;
  }
  return a.startsWith(t) || t.startsWith(a);
}

/** After a hung PAGE_GO_TO: reset API cache, optionally reload or open a fresh tab. */
async function recoverNavSession(client: XportBrowserClient, attemptIndex: number): Promise<void> {
  try {
    await client.requestReset();
    client.taskLog('nav recover: requestReset ok');
  } catch (e) {
    client.taskLog(`nav recover: requestReset failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const [stOk, , st] = await client.browserConnectionStatus();
    client.taskLog(`nav recover: connected=${stOk ? String(st?.connected) : 'unknown'}`);
  } catch (e) {
    client.taskLog(`nav recover: connectionStatus failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (attemptIndex === 1) {
    try {
      await client.pageReload(0, { timeoutMs: NAV_RECOVER_TIMEOUT_MS, wait: 'domContentLoaded' });
      client.taskLog('nav recover: pageReload attempted');
    } catch (e) {
      client.taskLog(`nav recover: pageReload threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (attemptIndex >= 2) {
    try {
      await client.newPage();
      await Bun.sleep(600);
      // Close hung tab 0 so the new tab becomes index 0 for subsequent pageGoTo(0).
      await client.closePage(0);
      await Bun.sleep(500);
      client.taskLog('nav recover: opened new page and closed previous tab 0');
    } catch (e) {
      client.taskLog(`nav recover: newPage/closePage failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

type GotoResult = { ok: boolean; soft: boolean; msg: string; url: string };

/**
 * Robust navigation: page timeout under HTTP 60s, catch throws, soft-OK if already on target,
 * retry with requestReset / reload / fresh tab.
 */
async function gotoWithRetry(
  client: XportBrowserClient,
  url: string,
  opts?: { attempts?: number; label?: string },
): Promise<GotoResult> {
  const attempts = opts?.attempts ?? NAV_MAX_ATTEMPTS;
  const label = opts?.label || url;
  let lastMsg = '';
  let lastUrl = '';

  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      client.taskLog(`goto retry ${i + 1}/${attempts} (${label})`);
      await recoverNavSession(client, i);
      await Bun.sleep(700 + i * 400);
    }

    try {
      const [ok, msg] = await client.pageGoTo(0, {
        url,
        timeoutMs: NAV_PAGE_TIMEOUT_MS,
        wait: 'domContentLoaded',
      });
      lastMsg = msg || '';
      lastUrl = await currentUrl(client);
      if (ok) {
        return { ok: true, soft: false, msg: lastMsg, url: lastUrl };
      }
      if (urlMatchesTarget(lastUrl, url)) {
        client.taskLog(`goto soft-ok after false (${label}): url=${lastUrl}; msg=${lastMsg}`);
        return { ok: true, soft: true, msg: lastMsg, url: lastUrl };
      }
      client.taskLog(`goto false try=${i + 1} (${label}): ${lastMsg || 'no msg'}; url=${lastUrl}`);
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
      client.taskLog(`goto threw try=${i + 1} (${label}): ${lastMsg}`);
      lastUrl = await currentUrl(client);
      if (urlMatchesTarget(lastUrl, url)) {
        client.taskLog(`goto soft-ok after throw (${label}): url=${lastUrl}`);
        return { ok: true, soft: true, msg: lastMsg, url: lastUrl };
      }
    }
  }

  lastUrl = lastUrl || (await currentUrl(client));
  return { ok: false, soft: false, msg: lastMsg || 'pageGoTo failed', url: lastUrl };
}

async function nodeCount(client: XportBrowserClient, path: ReturnType<typeof nodePath>): Promise<number> {
  try {
    const [ok, , n] = await client.getNodeCount(0, path);
    return ok && typeof n === 'number' ? n : 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    client.taskLog(`getNodeCount threw: ${msg}`);
    throw e;
  }
}

async function clickFirst(
  client: XportBrowserClient,
  path: ReturnType<typeof nodePath>,
): Promise<boolean> {
  if ((await nodeCount(client, path)) < 1) return false;
  const [ok] = await client.clickNode(0, path);
  return ok;
}

/** Human-like pause only — never waitForNetworkIdle on Facebook (long-lived connections hang). */
async function settle(_client: XportBrowserClient, extraMs = 800): Promise<void> {
  await Bun.sleep(extraMs);
}

async function pageHtml(client: XportBrowserClient): Promise<string> {
  const [ok, , html] = await client.getPageContent(0, 'ai');
  return ok && html ? html : '';
}

async function currentUrl(client: XportBrowserClient): Promise<string> {
  try {
    const [ok, , url] = await client.getPageUrl();
    return ok && url ? url : '';
  } catch (e) {
    client.taskLog(`getPageUrl threw: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

function oneTapForm(index = 0) {
  return nodePath()
    .css('form')
    .containAnySelector('input[name="credential_type"][value="one_tap_login"]')
    .one(index);
}

function oneTapButton(index = 0) {
  return oneTapForm(index).then().css('[role="button"]').one();
}

/**
 * New AYMH login: profile rows sit outside the hidden one_tap form.
 * Supports both desktop right-column and centered single-column layouts.
 */
async function listAymhProfiles(client: XportBrowserClient): Promise<{ count: number; texts: string[] }> {
  const js = `(() => {
    const skip = ${AYMH_SKIP_CTA.toString()};
    const vw = window.innerWidth;
    const buttons = Array.from(document.querySelectorAll('[role="button"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 140 || r.height < 36 || r.height > 120) return false;
      if (r.bottom < 0 || r.top > window.innerHeight) return false;
      // Desktop right column OR centered card (skip far-left marketing column only).
      if (r.left < vw * 0.18 && r.width < vw * 0.35) return false;
      const t = (el.innerText || '').trim();
      if (!t || skip.test(t.split(/\\n/)[0].trim()) || skip.test(t)) return false;
      // Bottom full-width CTAs are usually wider than profile name rows in the card.
      if (r.width > Math.min(520, vw * 0.55) && /akun|account|profil|profile|compte|cuenta/i.test(t)) {
        return false;
      }
      const lines = t.split(/\\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length < 1 || lines.length > 3) return false;
      if (lines[0].length < 2 || lines[0].length > 80) return false;
      // Prefer rows that look like a name (not a sentence CTA).
      if (/[.?!：:]/.test(lines[0]) && lines[0].length > 40) return false;
      return true;
    });
    buttons.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const texts = buttons.map((el) => (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60));
    return JSON.stringify({ count: buttons.length, texts });
  })()`;
  const [ok, , raw] = await client.evaluateInPage(0, js);
  if (!ok) return { count: 0, texts: [] };
  try {
    const parsed = JSON.parse(raw || '{}') as { count?: number; texts?: string[] };
    return { count: parsed.count ?? 0, texts: parsed.texts ?? [] };
  } catch {
    return { count: 0, texts: [] };
  }
}

async function countAymhProfiles(client: XportBrowserClient): Promise<number> {
  return (await listAymhProfiles(client)).count;
}

async function clickAymhProfile(client: XportBrowserClient, index: number): Promise<boolean> {
  const js = `(() => {
    const skip = ${AYMH_SKIP_CTA.toString()};
    const vw = window.innerWidth;
    const buttons = Array.from(document.querySelectorAll('[role="button"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 140 || r.height < 36 || r.height > 120) return false;
      if (r.bottom < 0 || r.top > window.innerHeight) return false;
      if (r.left < vw * 0.18 && r.width < vw * 0.35) return false;
      const t = (el.innerText || '').trim();
      if (!t || skip.test(t.split(/\\n/)[0].trim()) || skip.test(t)) return false;
      if (r.width > Math.min(520, vw * 0.55) && /akun|account|profil|profile|compte|cuenta/i.test(t)) {
        return false;
      }
      const lines = t.split(/\\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length < 1 || lines.length > 3) return false;
      if (lines[0].length < 2 || lines[0].length > 80) return false;
      if (/[.?!：:]/.test(lines[0]) && lines[0].length > 40) return false;
      return true;
    });
    buttons.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (${index} >= buttons.length) {
      return JSON.stringify({ ok: false, count: buttons.length });
    }
    const el = buttons[${index}];
    const text = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    el.click();
    return JSON.stringify({ ok: true, text, count: buttons.length });
  })()`;
  const [ok, msg, raw] = await client.evaluateInPage(0, js);
  if (!ok) {
    client.taskLog(`clickAymhProfile evaluate failed: ${msg}`);
    return false;
  }
  client.taskLog(`clickAymhProfile: ${raw}`);
  try {
    return !!(JSON.parse(raw || '{}') as { ok?: boolean }).ok;
  } catch {
    return false;
  }
}

async function savedAccountCount(client: XportBrowserClient): Promise<number> {
  const classic = await nodeCount(
    client,
    nodePath()
      .css('form')
      .containAnySelector('input[name="credential_type"][value="one_tap_login"]')
      .many(),
  );
  const aymh = await countAymhProfiles(client);
  // New AYMH often has 1 hidden one_tap form for N visible profiles.
  if (aymh > 0) return aymh;
  return classic;
}

async function isPasswordDialog(client: XportBrowserClient): Promise<boolean> {
  return (
    (await nodeCount(
      client,
      nodePath().css('div[role="dialog"]').then().css('input[type="password"]').one(),
    )) > 0
  );
}

async function isLoggedIn(client: XportBrowserClient): Promise<boolean> {
  // Checkpoint / lock pages also have logout.php + banner — never treat them as usable login.
  if (await isRestricted(client)) return false;

  // Feed / nav labels vary by UI language (EN / PT / ES / ID / FR …).
  const probes = [
    '[aria-label="Home"]',
    '[aria-label="Página inicial"]',
    '[aria-label="Inicio"]',
    '[aria-label="Beranda"]',
    '[aria-label="Accueil"]',
    '[aria-label="Your profile"]',
    '[aria-label="Seu perfil"]',
    '[aria-label="Tu perfil"]',
    '[aria-label="Profil Anda"]',
    '[aria-label="Votre profil"]',
    '[aria-label="Create a post"]',
    '[aria-label="Criar um post"]',
    '[aria-label="Crear una publicación"]',
    '[aria-label="Buat postingan"]',
    '[aria-label="Créer une publication"]',
  ];
  for (const sel of probes) {
    if ((await nodeCount(client, nodePath().css(sel).one())) > 0) return true;
  }
  // Structural: logged-in feed shell has logout form + banner, but not checkpoint chrome.
  const hasLogout =
    (await nodeCount(client, nodePath().css('form[action*="logout.php"]').one())) > 0;
  const hasBanner = (await nodeCount(client, nodePath().css('div[role="banner"]').one())) > 0;
  if (hasLogout && hasBanner) return true;
  return false;
}

async function isEnglishUi(client: XportBrowserClient): Promise<boolean> {
  if ((await nodeCount(client, nodePath().css('[aria-label="Home"]').one())) > 0) return true;
  if ((await nodeCount(client, nodePath().css('[aria-label="Create a post"]').one())) > 0) return true;
  if ((await nodeCount(client, nodePath().css('[aria-label="Your profile"]').one())) > 0) return true;
  const html = await pageHtml(client);
  if (/\baria-label="What's on your mind/i.test(html)) return true;
  // Prefer explicit English chrome over bare lang=en (some locales still set en wrongly).
  const langMatch = html.match(/<html[^>]*\slang=["']([^"']+)["']/i);
  const lang = (langMatch?.[1] ?? '').toLowerCase();
  if (lang === 'en' || lang.startsWith('en-')) {
    const nonEnHome = [
      '[aria-label="Página inicial"]',
      '[aria-label="Inicio"]',
      '[aria-label="Beranda"]',
      '[aria-label="Accueil"]',
    ];
    for (const sel of nonEnHome) {
      if ((await nodeCount(client, nodePath().css(sel).one())) > 0) return false;
    }
    return true;
  }
  return false;
}

async function isEmptyLogin(client: XportBrowserClient): Promise<boolean> {
  if ((await savedAccountCount(client)) > 0) return false;
  const hasEmail =
    (await nodeCount(client, nodePath().css('input[name="email"]', 'input#email', 'input[type="email"]').one())) > 0;
  const hasCreate =
    (await nodeCount(
      client,
      nodePath()
        .pText([
          'Create new account',
          'Create account',
          'Buat akun baru',
          'Criar nova conta',
          'Crear cuenta nueva',
          'Crear una cuenta',
        ])
        .one(),
    )) > 0;
  return hasEmail || hasCreate;
}

/**
 * Soft automated-behaviour warning (dismissable — must NOT tag「账户失效」).
 * Detect by Facebook checkpoint flow id (language-independent), not UI copy
 * (EN title may use behavior/behaviour and localizes).
 * Observed live: /checkpoint/601051028565049/ + single primary CTA in [role=main].
 */
const SOFT_AUTOMATED_BEHAVIOUR_CHECKPOINT_ID = '601051028565049';

function isSoftAutomatedBehaviourUrl(url: string): boolean {
  const u = (url || '').toLowerCase();
  return u.includes(`/checkpoint/${SOFT_AUTOMATED_BEHAVIOUR_CHECKPOINT_ID}`);
}

/** Primary CTA inside main — structure only (no button text / aria-label language). */
const SOFT_WARNING_DISMISS_PATH = () =>
  nodePath().css('[role="main"] [role="button"][tabindex="0"]').one();

async function isAutomatedBehaviourWarning(client: XportBrowserClient): Promise<boolean> {
  if (isSoftAutomatedBehaviourUrl(await currentUrl(client))) return true;
  // Same flow sometimes keeps the CTA while URL briefly lags; require both markers.
  if ((await nodeCount(client, SOFT_WARNING_DISMISS_PATH())) < 1) return false;
  const html = await pageHtml(client);
  return html.includes(`/checkpoint/${SOFT_AUTOMATED_BEHAVIOUR_CHECKPOINT_ID}`);
}

/**
 * Click the soft-warning primary CTA (Dismiss); never treat as invalid.
 * Returns true if the warning was present and is gone after click.
 */
async function dismissAutomatedBehaviourWarning(client: XportBrowserClient): Promise<boolean> {
  if (!(await isAutomatedBehaviourWarning(client))) return false;
  client.taskLog('soft automated-behaviour checkpoint → click main CTA (not invalid)');

  let clicked = await clickFirst(client, SOFT_WARNING_DISMISS_PATH());

  if (!clicked) {
    // DOM evaluate: first focusable role=button under [role=main] — no text match.
    const js = `(() => {
      const main = document.querySelector('[role="main"]');
      if (!main) return JSON.stringify({ ok: false, reason: 'no_main' });
      const btn = main.querySelector('[role="button"][tabindex="0"]');
      if (!btn) return JSON.stringify({ ok: false, reason: 'no_cta' });
      btn.click();
      return JSON.stringify({ ok: true });
    })()`;
    const [ok, msg, raw] = await client.evaluateInPage(0, js);
    if (!ok) {
      client.taskLog(`dismissAutomatedBehaviour evaluate failed: ${msg}`);
    } else {
      client.taskLog(`dismissAutomatedBehaviour evaluate: ${raw}`);
      try {
        clicked = !!(JSON.parse(raw || '{}') as { ok?: boolean }).ok;
      } catch {
        clicked = false;
      }
    }
  }

  if (!clicked) {
    client.taskLog('soft-warning CTA click missed; leave for caller');
    return false;
  }
  // Splash → home can take a moment after dismiss.
  await settle(client, 1800);
  for (let i = 0; i < 4; i++) {
    if (!(await isAutomatedBehaviourWarning(client))) {
      client.taskLog('after soft-warning CTA: cleared');
      return true;
    }
    await settle(client, 800);
  }
  const still = await isAutomatedBehaviourWarning(client);
  client.taskLog(`after soft-warning CTA stillWarning=${still}`);
  return !still;
}

async function isRestricted(client: XportBrowserClient): Promise<boolean> {
  // Soft automated-behaviour warning is dismissable — not a hard lock.
  if (await isAutomatedBehaviourWarning(client)) return false;

  const url = (await currentUrl(client)).toLowerCase();
  if (
    url.includes('/checkpoint') ||
    url.includes('/captcha') ||
    url.includes('recover/code') ||
    url.includes('/two_factor') ||
    url.includes('two_step_verification') ||
    url.includes('confirmemail') ||
    url.includes('confirmphone')
  ) {
    return true;
  }
  const texts = [
    "Confirm you're human",
    'Start video selfie',
    'Start security steps',
    'Your account was locked',
    'account was locked',
    'unlock your Meta Account',
    'Enter the text from the image',
    'Hear this code',
    'Enter the confirmation code',
    'Entrez le code de confirmation',
    'confirmation code',
    'Code de confirmation',
    'Masukkan kode konfirmasi',
    'Introduza o código de confirmação',
  ];
  for (const t of texts) {
    if ((await nodeCount(client, nodePath().pText(t).one())) > 0) return true;
  }
  // Aria on locked-account CTA (language-stable enough on EN checkpoint; also used as fallback).
  if ((await nodeCount(client, nodePath().css('[aria-label="Start security steps"]').one())) > 0) {
    return true;
  }
  const html = (await pageHtml(client)).toLowerCase();
  if (html.includes('/images/checkpoint/')) return true;
  if (html.includes('confirm you') && html.includes('human')) return true;
  if (html.includes('video selfie')) return true;
  if (html.includes('account was locked')) return true;
  if (html.includes('unlock your meta account')) return true;
  if (html.includes('start security steps')) return true;
  if (html.includes('confirmemail.php')) return true;
  if (html.includes('code de confirmation') || html.includes('confirmation code')) return true;
  return false;
}

async function closePasswordDialog(client: XportBrowserClient): Promise<boolean> {
  const closed = await clickFirst(
    client,
    nodePath()
      .css('div[role="dialog"]')
      .then()
      .css(
        '[aria-label="Close"]',
        '[aria-label="Fechar"]',
        '[aria-label="Tutup"]',
        '[aria-label="Cerrar"]',
      )
      .one(),
  );
  if (closed) {
    await settle(client, 600);
    return true;
  }
  const [escOk] = await client.pressKey(0, 'escape');
  if (escOk) await settle(client, 600);
  return !(await isPasswordDialog(client));
}

function labelsInclude(labels: readonly string[] | null | undefined, want: string): boolean {
  const v = want.trim();
  return !!v && (labels ?? []).some((x) => x === v);
}

/**
 * Mutually exclusive status tags: invalid / network / unrecognized / clear all when valid.
 * Always verify via read-back — mutate succ alone is not enough (UI can show success with empty labels).
 */
async function applyLabels(
  client: XportBrowserClient,
  kind: AccountStatus,
): Promise<[boolean, string, string[]]> {
  const mutateOpts =
    kind === 'invalid'
      ? { add: [LABEL_INVALID], remove: [LABEL_NETWORK, LABEL_UNRECOGNIZED] }
      : kind === 'network'
        ? { add: [LABEL_NETWORK], remove: [LABEL_INVALID, LABEL_UNRECOGNIZED] }
        : kind === 'unrecognized'
          ? { add: [LABEL_UNRECOGNIZED], remove: [LABEL_INVALID, LABEL_NETWORK] }
          : { remove: [LABEL_INVALID, LABEL_NETWORK, LABEL_UNRECOGNIZED] };

  let lastMsg = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [ok, msg, mutated] = await client.mutateDeviceLabels(mutateOpts);
    lastMsg = msg || '';
    if (!ok) {
      client.taskLog(`mutateDeviceLabels attempt=${attempt} fail: ${lastMsg}`);
      continue;
    }

    let labels = mutated?.labels ?? null;
    if (!labels) {
      const [gOk, gMsg, gInfo] = await client.getDeviceLabels();
      if (!gOk) {
        lastMsg = gMsg || 'getDeviceLabels failed after mutate';
        client.taskLog(`getDeviceLabels attempt=${attempt}: ${lastMsg}`);
        continue;
      }
      labels = gInfo?.labels ?? [];
    }

    const hasInvalid = labelsInclude(labels, LABEL_INVALID);
    const hasNetwork = labelsInclude(labels, LABEL_NETWORK);
    const hasUnrecognized = labelsInclude(labels, LABEL_UNRECOGNIZED);
    const okState =
      kind === 'invalid'
        ? hasInvalid && !hasNetwork && !hasUnrecognized
        : kind === 'network'
          ? hasNetwork && !hasInvalid && !hasUnrecognized
          : kind === 'unrecognized'
            ? hasUnrecognized && !hasInvalid && !hasNetwork
            : !hasInvalid && !hasNetwork && !hasUnrecognized;

    if (okState) {
      return [true, lastMsg, labels];
    }

    lastMsg = `label verify failed kind=${kind} got=[${labels.join(', ')}]`;
    client.taskLog(`applyLabels attempt=${attempt}: ${lastMsg}`);
    await Bun.sleep(400);
  }
  return [false, lastMsg || 'mutateDeviceLabels failed', []];
}

async function finish(
  client: XportBrowserClient,
  opts: {
    accountStatus: AccountStatus;
    outcome: Outcome;
    scenario: string;
    languageAction: string;
    msg: string;
  },
): Promise<AutomationRunResult> {
  const [labelOk, labelMsg, labels] = await applyLabels(client, opts.accountStatus);
  if (!labelOk) {
    return failStep(client, 'update_labels', 'UNKNOWN', `无法更新设备标签：${labelMsg || 'mutateDeviceLabels failed'}`, {
      scenario: opts.scenario,
      accountStatus: opts.accountStatus,
    });
  }
  // chrome-error / hung pages: getPageTitle can HTTP-timeout and wipe an already-correct outcome.
  let finalUrl = '';
  let title = '';
  try {
    const [urlOk, , url] = await client.getPageUrl();
    if (urlOk && url) finalUrl = url;
  } catch (e) {
    client.taskLog(`finish getPageUrl threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    if (!isChromeErrorUrl(finalUrl)) {
      const [titleOk, , t] = await client.getPageTitle();
      if (titleOk && t) title = t;
    }
  } catch (e) {
    client.taskLog(`finish getPageTitle threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  const labelsText = labels.join(', ');
  client.taskLog(`done scenario=${opts.scenario} status=${opts.accountStatus} labels=${labelsText}`);
  return {
    succ: true,
    msg: opts.msg,
    data: {
      accountStatus: opts.accountStatus,
      outcome: opts.outcome,
      scenario: opts.scenario,
      languageAction: opts.languageAction,
      labels: labelsText,
      finalUrl,
      title,
    },
  };
}

async function taggedInvalid(client: XportBrowserClient, scenario: string, msg: string): Promise<AutomationRunResult> {
  return finish(client, {
    accountStatus: 'invalid',
    outcome: 'tagged_invalid',
    scenario,
    languageAction: 'skipped',
    msg,
  });
}

/**
 * Network / proxy soft-skip: always return succ:true so workflows continue.
 * Still best-effort apply「网络异常」label; label failure must not hard-fail the task.
 */
async function taggedNetwork(client: XportBrowserClient, scenario: string, msg: string): Promise<AutomationRunResult> {
  let labels: string[] = [];
  let labelNote = '';
  try {
    const [labelOk, labelMsg, got] = await applyLabels(client, 'network');
    if (labelOk) {
      labels = got;
    } else {
      labelNote = labelMsg ? `；标签未更新：${labelMsg}` : '；标签未更新';
      client.taskLog(`taggedNetwork applyLabels soft-fail: ${labelMsg}`);
      try {
        const [gOk, , gInfo] = await client.getDeviceLabels();
        if (gOk && gInfo?.labels) labels = gInfo.labels;
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    labelNote = `；标签更新异常：${em}`;
    client.taskLog(`taggedNetwork applyLabels threw: ${em}`);
  }

  let finalUrl = '';
  let title = '';
  try {
    const [urlOk, , url] = await client.getPageUrl();
    if (urlOk && url) finalUrl = url;
  } catch (e) {
    client.taskLog(`taggedNetwork getPageUrl threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    if (!isChromeErrorUrl(finalUrl)) {
      const [titleOk, , t] = await client.getPageTitle();
      if (titleOk && t) title = t;
    }
  } catch (e) {
    client.taskLog(`taggedNetwork getPageTitle threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  const labelsText = labels.join(', ');
  const outMsg = softSkipNetworkMsg(msg) + labelNote;
  client.taskLog(`soft-skip network scenario=${scenario} labels=${labelsText}`);
  return {
    succ: true,
    msg: outMsg,
    data: {
      accountStatus: 'network',
      outcome: 'tagged_network',
      scenario,
      languageAction: 'skipped',
      labels: labelsText,
      finalUrl,
      title,
    },
  };
}

async function taggedUnrecognized(client: XportBrowserClient, scenario: string, msg: string): Promise<AutomationRunResult> {
  return finish(client, {
    accountStatus: 'unrecognized',
    outcome: 'tagged_unrecognized',
    scenario,
    languageAction: 'skipped',
    msg,
  });
}

function isChromeErrorUrl(url: string): boolean {
  const u = (url || '').trim().toLowerCase();
  return u.startsWith('chrome-error://') || u.includes('chromewebdata') || u.startsWith('chrome://network-error');
}

async function isNetworkErrorPage(client: XportBrowserClient): Promise<boolean> {
  const url = await currentUrl(client);
  if (isChromeErrorUrl(url)) return true;

  const html = await pageHtml(client);
  if (!html) return false;
  if (/\bneterror\b/i.test(html)) return true;
  if (/\bERR_[A-Z0-9_]+\b/.test(html)) return true;
  if (/This site can.?t be reached/i.test(html)) return true;
  if (/ unexpectedly closed the connection/i.test(html)) return true;
  if (/took too long to respond/i.test(html)) return true;
  if (/DNS_PROBE|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_PROXY|ERR_NETWORK|ERR_SSL|ERR_ADDRESS/i.test(html)) {
    return true;
  }
  return false;
}

async function ensureEnglish(client: XportBrowserClient): Promise<AutomationRunResult | 'already' | 'switched' | 'skipped'> {
  await dismissAutomatedBehaviourWarning(client);
  if (await isRestricted(client)) {
    return taggedInvalid(client, 'checkpoint_before_language', '账号需要验证或已被锁定，已标记账户失效');
  }
  if (await isEnglishUi(client)) {
    client.taskLog('UI already English');
    return 'already';
  }

  const skipLanguage = (reason: string): 'skipped' => {
    client.taskLog(`language switch skipped: ${reason}`);
    return 'skipped';
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      client.taskLog('language picker not ready; reload settings and retry');
      const reload = await gotoWithRetry(client, LANGUAGE_SETTINGS_URL, {
        label: 'language_settings_reload',
        attempts: 2,
      });
      if (!reload.ok) {
        if (
          isChromeErrorUrl(reload.url) ||
          (await isNetworkErrorPage(client)) ||
          isNetworkOrProxyErrorMsg(reload.msg)
        ) {
          return taggedNetwork(
            client,
            'network_error_language',
            reload.msg
              ? `打开语言设置失败（网络/代理异常）：${reload.msg}`
              : '打开语言设置失败（网络/代理异常），已标记「网络异常」',
          );
        }
      }
      await settle(client, 1500);
    } else {
      client.taskLog(`open language settings ${LANGUAGE_SETTINGS_URL}`);
      const go = await gotoWithRetry(client, LANGUAGE_SETTINGS_URL, {
        label: 'language_settings',
        attempts: NAV_MAX_ATTEMPTS,
      });
      if (!go.ok) {
        if (
          isChromeErrorUrl(go.url) ||
          (await isNetworkErrorPage(client)) ||
          isNetworkOrProxyErrorMsg(go.msg)
        ) {
          return taggedNetwork(
            client,
            'network_error_language',
            go.msg
              ? `打开语言设置失败（网络/代理异常）：${go.msg}`
              : '打开语言设置失败（网络/代理异常），已标记「网络异常」',
          );
        }
        return skipLanguage(go.msg || '无法打开语言设置页');
      }
      await settle(client, 1200);
    }

    if (await isNetworkErrorPage(client)) {
      return taggedNetwork(
        client,
        'network_error_language',
        '打开语言设置时出现网络/代理异常，已标记「网络异常」',
      );
    }

    // Mid-flow lock / challenge: treat as invalid instead of failing on language UI.
    if (await isRestricted(client)) {
      return taggedInvalid(client, 'checkpoint_during_language', '打开语言设置时进入验证或锁定页，已标记账户失效');
    }

    if (!(await waitForLanguageSettingsReady(client))) {
      if (attempt === 0) continue;
      return taggedNetwork(
        client,
        'network_error_language_settings',
        '语言设置页长时间未加载完成（网络/代理），已标记「网络异常」',
      );
    }

    // Language-agnostic: first multi-line settings row in the center card (Account language).
    const opened = await openAccountLanguageRowByStructure(client);
    if (!opened) {
      if (attempt === 0) continue;
      return skipLanguage('找不到账号语言入口');
    }
    await settle(client, 1000);

    const pickerReady = await waitForLanguagePickerReady(client);
    if (pickerReady !== 'ready') {
      client.taskLog(`language picker state=${pickerReady}`);
      if (attempt === 0) continue;
      return taggedNetwork(
        client,
        'network_error_language_picker',
        '语言选择弹窗内容未加载完成（网络/代理），已标记「网络异常」',
      );
    }

    let picked =
      (await pickEnglishInLanguageDialog(client)) || (await pickEnglishOptionByStructure(client));

    if (!picked) {
      const typed = await typeLanguageSearch(client, 'English');
      if (!typed) {
        if (attempt === 0) continue;
        return skipLanguage('语言弹窗里找不到搜索框，且列表中没有 English (US)');
      }
      await Bun.sleep(1000);
      picked =
        (await pickEnglishInLanguageDialog(client)) || (await pickEnglishOptionByStructure(client));
    }

    if (!picked) {
      if (attempt === 0) continue;
      return skipLanguage('找不到 English (US) 选项');
    }
    await settle(client, 800);

    // Confirm dialog may appear after the radio pick — wait briefly then click.
    let confirmClicked = false;
    for (let c = 0; c < 6; c++) {
      confirmClicked = await clickLanguageRefreshConfirm(client);
      if (confirmClicked) break;
      await Bun.sleep(700);
    }
    if (confirmClicked) {
      await settle(client, 2500);
    } else {
      client.taskLog('no confirm button after English pick; continue to verify UI language');
      await settle(client, 1500);
    }

    const home = (Bun.env.SOCIAL_HOME ?? 'https://www.facebook.com').trim() || 'https://www.facebook.com';
    const homeNav = await gotoWithRetry(client, home, { label: 'home_after_language', attempts: 2 });
    if (homeNav.ok) {
      await settle(client, 1500);
    } else {
      client.taskLog(
        `home after language soft-continue (nav failed): ${homeNav.msg}; url=${homeNav.url}`,
      );
      await settle(client, 800);
    }

    if (await isEnglishUi(client)) return 'switched';

    client.taskLog('verify_english failed after pick; will retry language flow once');
    if (attempt === 0) continue;
    // Per product rule: language switch failure is non-fatal — keep account valid.
    return skipLanguage('已尝试改为英文，但页面仍不是英文界面');
  }

  return skipLanguage('语言切换未完成');
}

/** Wait until settings?tab=language leaves the Meta splash / empty shell. */
async function waitForLanguageSettingsReady(client: XportBrowserClient): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    if (await isRestricted(client)) return true;
    if (await isNetworkErrorPage(client)) return false;
    const js = `(() => {
      const body = (document.body && document.body.innerText) || '';
      if (/Bahasa dan wilayah|Language and region|Idioma e região|Langue et région|Idioma y región|言語と地域/i.test(body)) {
        return 'ready';
      }
      if (/Pengaturan|Settings|Definições|Paramètres|设置|設定/i.test(body) && body.length > 80) {
        return 'ready';
      }
      const centerLogo = document.querySelector('img[alt="Facebook"], svg[aria-label="Facebook"]');
      const textLen = body.replace(/\\s+/g, '').length;
      if (textLen < 40 && /from\\s*Meta/i.test(body)) return 'splash';
      if (!centerLogo && textLen > 120) return 'ready';
      return 'wait';
    })()`;
    const [ok, , raw] = await client.evaluateInPage(0, js);
    const state = ok ? (raw || '').trim() : 'wait';
    client.taskLog(`language settings ready? ${state} (try ${i + 1})`);
    if (state === 'ready') return true;
    if (state === 'splash' && i >= 6) return false;
    await Bun.sleep(900);
  }
  return false;
}

/**
 * Prefer the centered language picker dialog — not notification flyouts or chat-error toasts.
 */
async function languageDialogProbe(client: XportBrowserClient): Promise<{
  ready: boolean;
  hasSearch: boolean;
  hasEnglish: boolean;
  reason?: string;
}> {
  const js = `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const scored = [];
    for (const dlg of dialogs) {
      const r = dlg.getBoundingClientRect();
      if (r.width < 280 || r.height < 140) continue;
      if (r.top > vh * 0.55) continue;
      if (r.left > vw * 0.75) continue;
      const t = ((dlg.innerText || '') + ' ' + (dlg.getAttribute('aria-label') || '')).toLowerCase();
      if (/tidak bisa memuat obrolan|impossible de charger les discussions|unable to load|muat ulang|actualiser|reload chat|notifikasi|notifications/.test(t) && r.height < 320) {
        continue;
      }
      scored.push({ dlg, area: r.width * r.height, text: t.slice(0, 120) });
    }
    scored.sort((a, b) => b.area - a.area);
    if (!scored.length) return JSON.stringify({ ready: false, hasSearch: false, hasEnglish: false, reason: 'no_dialog' });
    const dlg = scored[0].dlg;
    const text = (dlg.innerText || '').trim();
    const hasSearch = !!dlg.querySelector('input[type="search"], input[placeholder*="Search" i], input[aria-label*="Search" i], input[placeholder*="Cari" i], input[placeholder*="Pesquis" i], input[placeholder*="Recherc" i]');
    const hasEnglish = /English\\s*\\(US\\)|English\\s*\\(USA\\)/i.test(text);
    const radios = dlg.querySelectorAll('[role="radio"], [role="option"]').length;
    const skeletonOnly = text.length < 24 && !hasSearch && radios < 1;
    const ready = hasSearch || hasEnglish || radios >= 1 || text.length > 40;
    return JSON.stringify({
      ready: ready && !skeletonOnly,
      hasSearch,
      hasEnglish,
      reason: skeletonOnly ? 'skeleton' : ready ? 'ok' : 'loading',
      textLen: text.length,
    });
  })()`;
  const [ok, , raw] = await client.evaluateInPage(0, js);
  if (!ok) return { ready: false, hasSearch: false, hasEnglish: false, reason: 'eval_fail' };
  try {
    const parsed = JSON.parse(raw || '{}') as {
      ready?: boolean;
      hasSearch?: boolean;
      hasEnglish?: boolean;
      reason?: string;
    };
    return {
      ready: !!parsed.ready,
      hasSearch: !!parsed.hasSearch,
      hasEnglish: !!parsed.hasEnglish,
      reason: parsed.reason,
    };
  } catch {
    return { ready: false, hasSearch: false, hasEnglish: false, reason: 'bad_json' };
  }
}

async function waitForLanguagePickerReady(client: XportBrowserClient): Promise<'ready' | 'timeout'> {
  for (let i = 0; i < 10; i++) {
    const probe = await languageDialogProbe(client);
    client.taskLog(`language picker probe try=${i + 1} ${JSON.stringify(probe)}`);
    if (probe.ready) return 'ready';
    await Bun.sleep(900);
  }
  return 'timeout';
}

async function pickEnglishInLanguageDialog(client: XportBrowserClient): Promise<boolean> {
  const js = `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const scored = [];
    for (const dlg of dialogs) {
      const r = dlg.getBoundingClientRect();
      if (r.width < 280 || r.height < 140) continue;
      if (r.top > vh * 0.55) continue;
      const t = ((dlg.innerText || '') + ' ' + (dlg.getAttribute('aria-label') || '')).toLowerCase();
      if (/tidak bisa memuat obrolan|impossible de charger les discussions|unable to load|muat ulang|actualiser|notifikasi|notifications/.test(t) && r.height < 320) {
        continue;
      }
      scored.push({ dlg, area: r.width * r.height });
    }
    scored.sort((a, b) => b.area - a.area);
    if (!scored.length) return JSON.stringify({ ok: false, reason: 'no_dialog' });
    const dlg = scored[0].dlg;
    const nodes = Array.from(dlg.querySelectorAll('[role="radio"], [role="button"], [role="option"], label, div[tabindex="0"], span'));
    for (const el of nodes) {
      const t = (el.innerText || el.getAttribute('aria-label') || '');
      if (/^English\\s*\\(US\\)$|^English\\s*\\(USA\\)$/i.test(t.trim()) || /English\\s*\\(US\\)|English\\s*\\(USA\\)/i.test(t)) {
        const clickable = el.closest('[role="radio"], [role="button"], [role="option"], label, div[tabindex="0"]') || el;
        clickable.click();
        return JSON.stringify({ ok: true, text: t.replace(/\\s+/g, ' ').trim().slice(0, 80) });
      }
    }
    return JSON.stringify({ ok: false, reason: 'no_english' });
  })()`;
  const [ok, , raw] = await client.evaluateInPage(0, js);
  if (!ok) return false;
  client.taskLog(`pickEnglishInLanguageDialog: ${raw}`);
  try {
    return !!(JSON.parse(raw || '{}') as { ok?: boolean }).ok;
  } catch {
    return false;
  }
}

async function typeLanguageSearch(client: XportBrowserClient, text: string): Promise<boolean> {
  const js = `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const scored = [];
    for (const dlg of dialogs) {
      const r = dlg.getBoundingClientRect();
      if (r.width < 280 || r.height < 140) continue;
      if (r.top > vh * 0.55) continue;
      const t = ((dlg.innerText || '') + ' ' + (dlg.getAttribute('aria-label') || '')).toLowerCase();
      if (/tidak bisa memuat obrolan|impossible de charger les discussions|unable to load|muat ulang|actualiser|notifikasi|notifications/.test(t) && r.height < 320) {
        continue;
      }
      scored.push({ dlg, area: r.width * r.height });
    }
    scored.sort((a, b) => b.area - a.area);
    if (!scored.length) return JSON.stringify({ ok: false, reason: 'no_dialog' });
    const dlg = scored[0].dlg;
    const input = dlg.querySelector('input[type="search"], input[placeholder*="Search" i], input[aria-label*="Search" i], input[placeholder*="Cari" i], input[placeholder*="Pesquis" i], input[placeholder*="Recherc" i]');
    if (!input) return JSON.stringify({ ok: false, reason: 'no_search' });
    input.focus();
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (proto && proto.set) proto.set.call(input, ${JSON.stringify(text)});
    else input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    return JSON.stringify({ ok: true });
  })()`;
  const [ok, msg, raw] = await client.evaluateInPage(0, js);
  if (!ok) {
    client.taskLog(`typeLanguageSearch evaluate failed: ${msg}`);
    return false;
  }
  client.taskLog(`typeLanguageSearch: ${raw}`);
  try {
    return !!(JSON.parse(raw || '{}') as { ok?: boolean }).ok;
  } catch {
    return false;
  }
}

/**
 * Open account-language row without translated labels.
 * Anchor: settings?tab=language → center card → topmost tall multi-line row.
 */
async function openAccountLanguageRowByStructure(client: XportBrowserClient): Promise<boolean> {
  const js = `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const nodes = Array.from(document.querySelectorAll('[role="button"], [role="link"], div[tabindex="0"], a[tabindex="0"]'));
    const hits = [];
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width < Math.min(280, vw * 0.22) || r.height < 48 || r.height > 200) continue;
      if (r.left < vw * 0.28 || r.right > vw * 0.96) continue;
      if (r.top < 90 || r.top > vh * 0.82) continue;
      const raw = (el.innerText || '').trim();
      if (!raw || raw.length < 12) continue;
      const lines = raw.split(/\\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      if (lines[0].length > 80) continue;
      hits.push({ el, top: r.top, left: r.left, title: lines[0].slice(0, 60) });
    }
    hits.sort((a, b) => a.top - b.top || a.left - b.left);
    if (!hits.length) return JSON.stringify({ ok: false, reason: 'no_row' });
    hits[0].el.click();
    return JSON.stringify({ ok: true, title: hits[0].title, candidates: hits.slice(0, 5).map((h) => h.title) });
  })()`;
  const [ok, msg, raw] = await client.evaluateInPage(0, js);
  if (!ok) {
    client.taskLog(`openAccountLanguageRow evaluate failed: ${msg}`);
    return false;
  }
  try {
    const parsed = JSON.parse(raw || '{}') as { ok?: boolean };
    client.taskLog(`openAccountLanguageRow structure: ${raw}`);
    return !!parsed.ok;
  } catch {
    client.taskLog(`openAccountLanguageRow bad json: ${raw}`);
    return false;
  }
}

async function pickEnglishOptionByStructure(client: XportBrowserClient): Promise<boolean> {
  const js = `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const scored = [];
    for (const dlg of dialogs) {
      const r = dlg.getBoundingClientRect();
      if (r.width < 280 || r.height < 140) continue;
      if (r.top > vh * 0.55) continue;
      const t = ((dlg.innerText || '') + ' ' + (dlg.getAttribute('aria-label') || '')).toLowerCase();
      if (/tidak bisa memuat obrolan|impossible de charger les discussions|unable to load|muat ulang|actualiser|notifikasi|notifications/.test(t) && r.height < 320) {
        continue;
      }
      scored.push({ dlg, area: r.width * r.height });
    }
    scored.sort((a, b) => b.area - a.area);
    const dlg = scored[0]?.dlg;
    if (!dlg) return JSON.stringify({ ok: false, reason: 'no_dialog' });
    const nodes = Array.from(dlg.querySelectorAll('[role="radio"], [role="button"], [role="option"], label, div[tabindex="0"]'));
    for (const el of nodes) {
      const t = (el.innerText || el.getAttribute('aria-label') || '');
      if (/English\\s*\\(US\\)|English\\s*\\(USA\\)/i.test(t)) {
        el.click();
        return JSON.stringify({ ok: true, text: t.replace(/\\s+/g, ' ').trim().slice(0, 80) });
      }
    }
    return JSON.stringify({ ok: false, reason: 'no_english' });
  })()`;
  const [ok, , raw] = await client.evaluateInPage(0, js);
  if (!ok) return false;
  try {
    const parsed = JSON.parse(raw || '{}') as { ok?: boolean };
    client.taskLog(`pickEnglishOptionByStructure: ${raw}`);
    return !!parsed.ok;
  } catch {
    return false;
  }
}

/** Confirm refresh dialog by footer layout (rightmost primary), not translated OK text. */
async function clickLanguageRefreshConfirm(client: XportBrowserClient): Promise<boolean> {
  const quickLabels = [
    'OK',
    'Ok',
    'Aceptar',
    'Aceitar',
    'Oke',
    'Ya',
    'Tamam',
    '确定',
    '確認',
    '확인',
    'ตกลง',
    'Continuer',
    'Actualiser',
    'Mettre à jour',
    'Refresh',
    'Update',
    'Simpan',
    'Simpan perubahan',
  ];
  const dialog = () => nodePath().css('div[role="dialog"]');
  if (
    (await clickFirst(
      client,
      dialog()
        .then()
        .css(...quickLabels.map((t) => `[aria-label="${t}"]`))
        .one(),
    )) ||
    (await clickFirst(client, dialog().then().pText(quickLabels).one()))
  ) {
    return true;
  }

  const js = `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const scored = [];
    for (const dlg of dialogs) {
      const r = dlg.getBoundingClientRect();
      if (r.width < 200 || r.height < 80) continue;
      if (r.top > vh * 0.7) continue;
      const t = ((dlg.innerText || '') + ' ' + (dlg.getAttribute('aria-label') || '')).toLowerCase();
      if (/tidak bisa memuat obrolan|impossible de charger les discussions|unable to load|muat ulang|actualiser|notifikasi|notifications/.test(t) && r.height < 320 && !/langue|language|idioma|bahasa|refresh|actualis|mettre à jour|ok\\b/.test(t)) {
        continue;
      }
      // Prefer smaller confirm/refresh dialogs over the big language list.
      const preferConfirm = /refresh|actualis|mettre à jour|\\bok\\b|ubah bahasa|change language|changer de langue|cambiar idioma/i.test(t);
      scored.push({ dlg, area: r.width * r.height, preferConfirm });
    }
    scored.sort((a, b) => {
      if (a.preferConfirm !== b.preferConfirm) return a.preferConfirm ? -1 : 1;
      return a.area - b.area;
    });
    const dlg = scored[0]?.dlg;
    if (!dlg) return JSON.stringify({ ok: false, reason: 'no_dialog' });
    const dlgR = dlg.getBoundingClientRect();
    const buttons = Array.from(dlg.querySelectorAll('[role="button"], button')).filter((b) => {
      const r = b.getBoundingClientRect();
      if (r.width < 40 || r.height < 24 || r.height > 80) return false;
      if (r.width > 420) return false;
      if (r.top < dlgR.top + dlgR.height * 0.25) return false;
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
      if (/^×$|^x$/i.test(label)) return false;
      if (/english\\s*\\(us\\)|english\\s*\\(usa\\)/i.test(label)) return false;
      return true;
    });
    if (!buttons.length) return JSON.stringify({ ok: false, reason: 'no_footer_btn' });
    // Prefer explicit confirm labels, else rightmost footer button.
    const preferred = buttons.find((b) => {
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
      return /^(OK|Ok|Aceptar|Aceitar|Oke|Continuer|Actualiser|Mettre à jour|Refresh|Update|Simpan|确定|確認)$/i.test(label);
    });
    buttons.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    const btn = preferred || buttons[0];
    const info = {
      text: (btn.innerText || '').trim().slice(0, 40),
      aria: (btn.getAttribute('aria-label') || '').slice(0, 40),
    };
    btn.click();
    return JSON.stringify({ ok: true, ...info });
  })()`;
  const [ok, msg, raw] = await client.evaluateInPage(0, js);
  if (!ok) {
    client.taskLog(`clickLanguageRefreshConfirm evaluate failed: ${msg}`);
    return false;
  }
  client.taskLog(`clickLanguageRefreshConfirm structure: ${raw}`);
  try {
    return !!(JSON.parse(raw || '{}') as { ok?: boolean }).ok;
  } catch {
    return false;
  }
}

async function handleLoggedIn(
  client: XportBrowserClient,
  scenario: string,
  ensureEnglishFlag: boolean,
): Promise<AutomationRunResult> {
  if (!ensureEnglishFlag) {
    return finish(client, {
      accountStatus: 'valid',
      outcome: 'already_valid',
      scenario,
      languageAction: 'skipped_by_config',
      msg: '账号可用（未启用改为英文）',
    });
  }
  const lang = await ensureEnglish(client);
  if (lang !== 'already' && lang !== 'switched' && lang !== 'skipped') return lang;
  if (lang === 'skipped') {
    return finish(client, {
      accountStatus: 'valid',
      outcome: 'language_skipped',
      scenario,
      languageAction: 'skipped_failed',
      msg: '账号可用（改为英文未成功，已跳过）',
    });
  }
  return finish(client, {
    accountStatus: 'valid',
    outcome: lang === 'switched' ? 'language_switched' : 'logged_in_english',
    scenario,
    languageAction: lang === 'switched' ? 'switched' : 'already_english',
    msg: lang === 'switched' ? '账号可用，已将界面改为英文' : '账号可用，界面已是英文',
  });
}

async function trySavedAccounts(
  client: XportBrowserClient,
  ensureEnglishFlag: boolean,
): Promise<AutomationRunResult> {
  const listed = await listAymhProfiles(client);
  const classic = await nodeCount(
    client,
    nodePath()
      .css('form')
      .containAnySelector('input[name="credential_type"][value="one_tap_login"]')
      .many(),
  );
  const total = listed.count > 0 ? listed.count : classic;
  client.taskLog(
    `saved accounts=${total} aymh=${listed.count} classic=${classic} texts=${JSON.stringify(listed.texts.slice(0, 8))}`,
  );
  if (total <= 0) {
    return taggedInvalid(client, 'no_saved_account', '登出且没有可登录账号，已标记账户失效');
  }

  for (let i = 0; i < total; i++) {
    client.taskLog(`try saved account index=${i}`);
    // Re-count each round: closing password dialog / wrong CTA can shrink the list.
    const live = await listAymhProfiles(client);
    const liveTotal = live.count > 0 ? live.count : await savedAccountCount(client);
    if (liveTotal <= 0) {
      if (await isEmptyLogin(client)) {
        return taggedInvalid(client, 'no_saved_account', '登出且没有可登录账号，已标记账户失效');
      }
      break;
    }
    const idx = Math.min(i, liveTotal - 1);
    const clicked =
      (await clickAymhProfile(client, idx)) ||
      (await clickFirst(client, oneTapButton(idx))) ||
      (await clickFirst(client, oneTapForm(idx)));
    if (!clicked) {
      // Per product rule: unclickable / abnormal login chrome → invalid, not hard fail.
      return taggedInvalid(
        client,
        'click_saved_account',
        `无法点击第 ${i + 1} 个已保存账号，已标记账户失效`,
      );
    }
    await settle(client, 1500);

    await dismissAutomatedBehaviourWarning(client);
    if (await isRestricted(client)) {
      return taggedInvalid(client, 'checkpoint_after_login', '登录后出现验证或限制页，已标记账户失效');
    }
    if (await isLoggedIn(client)) {
      return handleLoggedIn(
        client,
        total > 1 ? 'saved_account_logged_in' : 'one_tap_logged_in',
        ensureEnglishFlag,
      );
    }
    if (await isPasswordDialog(client)) {
      client.taskLog(`account ${i} requires password`);
      await closePasswordDialog(client);
      continue;
    }
    // "Use another profile" / empty email form after a bad click.
    if (await isEmptyLogin(client)) {
      return taggedInvalid(client, 'empty_login_after_click', '点击已保存账号后进入空登录页，已标记账户失效');
    }
  }

  return taggedInvalid(
    client,
    total > 1 ? 'multi_account_password' : 'password_required',
    total > 1 ? '已保存账号均需密码，已标记账户失效' : '需要输入密码才能登录，已标记账户失效',
  );
}

/** Open Facebook home with retry / tab recover; soft-continue when already on FB. */
async function openFacebookHome(
  client: XportBrowserClient,
  home: string,
): Promise<AutomationRunResult | null> {
  const go = await gotoWithRetry(client, home, { label: 'facebook_home', attempts: NAV_MAX_ATTEMPTS });

  if (go.ok) {
    await settle(client, go.soft ? 1200 : 1800);
    return null;
  }

  const afterUrl = go.url || (await currentUrl(client));
  const onFb = /facebook\.com/i.test(afterUrl) && !isChromeErrorUrl(afterUrl);
  if (onFb) {
    client.taskLog(`pageGoTo reported fail (${go.msg}) but url=${afterUrl}; continue classify`);
    await settle(client, 1200);
    return null;
  }
  if (isChromeErrorUrl(afterUrl) || (await isNetworkErrorPage(client)) || isNetworkOrProxyErrorMsg(go.msg)) {
    return taggedNetwork(
      client,
      'network_error_nav',
      go.msg
        ? `无法打开 Facebook（网络/代理异常）：${go.msg}`
        : '无法打开 Facebook（网络/代理异常），已标记「网络异常」',
    );
  }
  return taggedNetwork(
    client,
    'network_error_nav',
    go.msg
      ? `无法打开 Facebook（网络/代理异常）：${go.msg}`
      : '无法打开 Facebook（网络/代理异常），已标记「网络异常」',
  );
}

async function runAutomation(client: XportBrowserClient, taskConfig: TaskRunConfig): Promise<AutomationRunResult> {
  const ensureEnglishFlag = Number(taskConfig.ensure_english) === 1;
  const home = (Bun.env.SOCIAL_HOME ?? 'https://www.facebook.com').trim() || 'https://www.facebook.com';
  client.taskLog(`open ${home}; ensure_english=${ensureEnglishFlag ? 1 : 0}`);

  try {
    const alreadyUrl = await currentUrl(client);
    if (isChromeErrorUrl(alreadyUrl) || (await isNetworkErrorPage(client))) {
      client.taskLog(`already on network error page url=${alreadyUrl}`);
      return taggedNetwork(client, 'network_error', '页面无法加载（网络/代理异常），已标记「网络异常」');
    }

    const alreadyOnFb =
      /facebook\.com/i.test(alreadyUrl) &&
      !isChromeErrorUrl(alreadyUrl);

    // Soft warning: click Dismiss, then continue (do not tag invalid).
    const dismissedSoft = await dismissAutomatedBehaviourWarning(client);
    if (dismissedSoft) {
      client.taskLog('dismissed automated behaviour warning; open home to continue classify');
      const navAfterDismiss = await openFacebookHome(client, home);
      if (navAfterDismiss) return navAfterDismiss;
      await settle(client, 1000);
      await dismissAutomatedBehaviourWarning(client);
    }

    // Already on a hard restriction page: do not force home navigation (often hangs / no-op timeout).
    if (alreadyOnFb && !dismissedSoft && (await isRestricted(client))) {
      client.taskLog(`already on restriction url=${alreadyUrl}; skip navigation`);
      return taggedInvalid(client, 'checkpoint', '账号需要验证码、人脸验证或已被锁定，已标记账户失效');
    }

    const urlAfterSoft = await currentUrl(client);
    const onHomeLike =
      /facebook\.com\/?(\?|#|$)/i.test(urlAfterSoft.split('?')[0] ?? urlAfterSoft) &&
      !/\/checkpoint/i.test(urlAfterSoft);

    if (!dismissedSoft && alreadyOnFb && onHomeLike) {
      // Already on feed/home — classify in place (avoids redundant nav timeouts).
      client.taskLog(`already on Facebook home url=${urlAfterSoft}; skip fresh navigation`);
      await settle(client, 800);
    } else if (!dismissedSoft) {
      const navFail = await openFacebookHome(client, home);
      if (navFail) return navFail;
    }

    if (await isNetworkErrorPage(client)) {
      return taggedNetwork(client, 'network_error', '页面无法加载（网络/代理异常），已标记「网络异常」');
    }

    await dismissAutomatedBehaviourWarning(client);

    // Prefer URL/content restriction checks before any "logged in" structural heuristics.
    if (await isRestricted(client)) {
      return taggedInvalid(client, 'checkpoint', '账号需要验证码、人脸验证或已被锁定，已标记账户失效');
    }
    if (await isPasswordDialog(client)) {
      return taggedInvalid(client, 'password_required', '需要输入密码才能登录，已标记账户失效');
    }
    if (await isLoggedIn(client)) {
      return handleLoggedIn(client, 'already_logged_in', ensureEnglishFlag);
    }
    if ((await savedAccountCount(client)) > 0) {
      return trySavedAccounts(client, ensureEnglishFlag);
    }
    if (await isEmptyLogin(client)) {
      return taggedInvalid(client, 'no_saved_account', '登出且没有可登录账号，已标记账户失效');
    }

    return taggedUnrecognized(
      client,
      'classify_page',
      '无法识别当前 Facebook 页面状态，已标记「无法识别」',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Network / proxy / nav timeout → soft-skip (succ:true); never hard-fail or UNKNOWN.
    if (isNetworkOrProxyErrorMsg(msg)) {
      client.taskLog(`inspect network/proxy → soft-skip: ${msg}`);
      try {
        return await taggedNetwork(
          client,
          'browser_cmd_timeout',
          msg ? `巡检遇网络/代理异常：${msg}` : '巡检遇网络/代理异常，已标记「网络异常」',
        );
      } catch (tagErr) {
        const tagMsg = tagErr instanceof Error ? tagErr.message : String(tagErr);
        client.taskLog(`taggedNetwork after network error also failed: ${tagMsg}`);
        return {
          succ: true,
          msg: softSkipNetworkMsg(msg ? `巡检遇网络/代理异常：${msg}` : '巡检遇网络/代理异常'),
          data: {
            accountStatus: 'network',
            outcome: 'tagged_network',
            scenario: 'browser_cmd_timeout',
            languageAction: 'skipped',
            labels: '',
            finalUrl: '',
            title: '',
          },
        };
      }
    }
    try {
      return await failStep(client, 'inspect', 'UNKNOWN', `巡检过程出现未预期错误：${msg}`);
    } catch {
      return automationFailWithContext(`巡检过程出现未预期错误：${msg}`, {
        code: 'UNKNOWN',
        step: 'inspect',
      });
    }
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
