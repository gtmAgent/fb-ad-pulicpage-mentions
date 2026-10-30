/**
 * Facebook 公共主页：对最新可见帖评论一次，再到「提及」页发帖一次。
 * 每个主页最多 1 条评论 + 1 条提及；跨任务用 store 记录已触达，避免重复。
 * 文案/图片按索引配对；缺一侧则只发另一侧；两边都空则跳过该步骤。
 *
 * store keys: contacted:page:{pageIdentityKey} — 成功后写入；清空 store 后仍可正常执行（仅失去去重记忆）。
 */
import type { TaskRunConfig } from './config.types';
import { canonicalizePageUrl, contactedStoreKey } from './page_identity';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  scriptStoreGet,
  scriptStoreSet,
  splitConfigLines,
  XportBrowserClient,
} from 'xport-browser-sdk';

/** 帖子时间戳（点日期进入评论列表 / permalink）。勿 .inViewport：需先滚到帖子区。 */
const postDateLinkPath = nodePath().css(
  'a[href*="permalink.php"]',
  'a[href*="story_fbid"]',
  'a[href*="/posts/"]',
  'a[href*="pfbid"]',
);

const noPostsHintPath = nodePath()
  .css('div', 'span', 'h1', 'h2')
  .containAnyText(
    'No posts yet',
    'This Page has no posts',
    'When they post',
    '还没有帖子',
    '尚無貼文',
    '還沒有貼文',
  );

/**
 * permalink 弹窗或 Feed 内联评论框均可。
 * 新版 UI 多为「Comment as {name}」；旧版为 Write a comment…
 */
const commentTextboxPath = nodePath()
  .css(
    'div[aria-label^="Comment as"]',
    'div[aria-label*="Write a comment"]',
    'div[aria-label="Write a comment…"]',
    'div[aria-label="Write a comment..."]',
    'div[aria-label*="的身份评论"]',
    'div[aria-label*="的身份留言"]',
    'div[aria-label*="身分留言"]',
    'div[aria-label*="身分評論"]',
    'div[aria-label="写评论…"]',
    'div[aria-label="写评论..."]',
    'div[aria-label="寫留言…"]',
    'div[aria-label="寫評論…"]',
  )
  .one();

/**
 * 评论配图：优先弹窗/表单内隐藏 file input。
 * 勿点「Attach a photo / 相机」——会弹出 Windows 系统选文件框。
 */
const commentFileInputPath = nodePath()
  .css(
    'div[role="dialog"] form input[type="file"]',
    'div[role="dialog"] input[type="file"]',
    'form input[type="file"][accept*="image"]',
    'input[type="file"][accept*="image"]:not([multiple])',
    'input[type="file"][accept*="image"]',
  )
  .one();

const postCommentPath = nodePath()
  .css(
    'div[role="dialog"] div[aria-label="Post comment"]',
    'div[aria-label="Post comment"]',
    'div[aria-label="发布评论"]',
    'div[aria-label="發佈留言"]',
    'div[aria-label="發佈評論"]',
    'div[aria-label="发布留言"]',
  )
  .one();

const sleepModeOkPath = nodePath()
  .css('div[role="dialog"]')
  .then()
  .css('div[role="button"]')
  .containAnyText('OK', '好', '好的', '确定', '確定');

const sleepModeHintPath = nodePath()
  .css('div', 'span', 'h1', 'h2')
  .containAnyText("You're in sleep mode", 'sleep mode', '睡眠模式');

const dialogClosePath = nodePath()
  .css('div[role="dialog"]')
  .then()
  .css('div[aria-label="Close"]', 'div[aria-label="关闭"]', 'div[aria-label="關閉"]')
  .inViewport();

const leavePagePath = nodePath().css(
  '[aria-label="Leave Page"]',
  '[aria-label="离开此页"]',
  '[aria-label="離開頁面"]',
  'div[role="button"] ::-p-text(Leave Page,离开此页,離開頁面)',
);

/**
 * Mentions 页「写点什么」入口。
 * 文案随账号语言变；印尼语现场为 span「Tulis sesuatu…」（未必挂在 button 文案选择器上），
 * 故同时匹配 button / span，点击时 preferClickableAncestor。
 */
const mentionOpenComposerPath = nodePath().css(
  'div[role="button"] ::-p-text(Write something to)',
  'div[role="button"] ::-p-text(Écrivez quelque chose)',
  'div[role="button"] ::-p-text(Escribe algo)',
  'div[role="button"] ::-p-text(Schreib etwas)',
  'div[role="button"] ::-p-text(Scrivi qualcosa)',
  'div[role="button"] ::-p-text(Escreva algo)',
  'div[role="button"] ::-p-text(Escreva alguma coisa)',
  'div[role="button"] ::-p-text(Tulis sesuatu)',
  'div[role="button"] ::-p-text(कुछ लिखें)',
  'div[role="button"] ::-p-text(Viết gì)',
  'div[role="button"] ::-p-text(เขียนอะไร)',
  'div[role="button"] ::-p-text(何か書)',
  'div[role="button"] ::-p-text(남길 글)',
  'div[role="button"] ::-p-text(Напишите)',
  'div[role="button"] ::-p-text(اكتب شي)',
  'div[role="button"] ::-p-text(Schrijf iets)',
  'div[role="button"] ::-p-text(Napisz coś)',
  'div[role="button"] ::-p-text(bir şeyler yaz)',
  'div[role="button"] ::-p-text(Sumulat ng)',
  'div[role="button"] ::-p-text(写点什么)',
  'div[role="button"] ::-p-text(寫點什麼)',
  'div[role="button"] ::-p-text(有什么新鲜事)',
  'div[role="button"] ::-p-text(有什麼新鮮事)',
  'span ::-p-text(Write something to)',
  'span ::-p-text(Écrivez quelque chose)',
  'span ::-p-text(Escribe algo)',
  'span ::-p-text(Escreva algo)',
  'span ::-p-text(Escreva alguma coisa)',
  'span ::-p-text(Tulis sesuatu)',
  'span ::-p-text(कुछ लिखें)',
  'span ::-p-text(Viết gì)',
  'span ::-p-text(เขียนอะไร)',
  'span ::-p-text(写点什么)',
  'span ::-p-text(寫點什麼)',
  'span ::-p-text(有什么新鲜事)',
  'span ::-p-text(有什麼新鮮事)',
);

const mentionDialogTextboxPath = nodePath()
  .css(
    "div[aria-label=\"What's on your mind?\"]",
    "div[aria-label=\"What's on your mind\"]",
    'div[aria-label="Create a public post"]',
    'div[aria-label="Create post"]',
    'div[aria-label="Créer une publication"]',
    'div[aria-label="Créer une publication publique"]',
    'div[aria-label="À quoi pensez-vous ?"]',
    'div[aria-label="À quoi pensez-vous?"]',
    'div[aria-label="Crear una publicación"]',
    'div[aria-label="Crear una publicación pública"]',
    'div[aria-label="¿Qué estás pensando?"]',
    'div[aria-label="Was machst du gerade?"]',
    'div[aria-label="A cosa stai pensando?"]',
    'div[aria-label="No que você está pensando?"]',
    'div[aria-label^="Tulis sesuatu"]',
    'div[aria-label^="Write something"]',
    'div[aria-label^="Escreva algo"]',
    'div[aria-label^="Escreva alguma"]',
    'div[aria-label^="कुछ लिख"]',
    'div[aria-label="有什么新鲜事？"]',
    'div[aria-label="有什麼新鮮事？"]',
    // 结构兜底：不依赖文案语种
    'div[role="dialog"][aria-modal="true"] div[role="textbox"]',
    'div[role="dialog"][aria-modal="true"] [contenteditable="true"]',
    'div[role="dialog"] div[role="textbox"]',
    'div[role="dialog"] [contenteditable="true"]',
  )
  .one();

/**
 * 提及发帖配图：只对 dialog 内隐藏 file input 注入。
 * 禁止点 Photo/video 快捷入口或弹窗内「照片」按钮（会弹系统选文件框）。
 */
const mentionDialogFileInputPath = nodePath()
  .css(
    'div[role="dialog"] form[method="POST"] input[type="file"]',
    'div[role="dialog"] input[type="file"][multiple]',
    'div[role="dialog"] input[type="file"][accept*="image"]',
    'div[role="dialog"] input[type="file"]',
  )
  .one();

const mentionPostPath = nodePath()
  .css(
    'div[aria-label="Post"]',
    'div[aria-label="Publier"]',
    'div[aria-label="Publicar"]',
    'div[aria-label="Veröffentlichen"]',
    'div[aria-label="Pubblica"]',
    'div[aria-label="Kirim"]',
    'div[aria-label="โพสต์"]',
    'div[aria-label="Đăng"]',
    'div[aria-label="投稿する"]',
    'div[aria-label="게시"]',
    'div[aria-label="Опубликовать"]',
    'div[aria-label="Отправить"]',
    'div[aria-label="نشر"]',
    'div[aria-label="पोस्ट करें"]',
    'div[aria-label="Paylaş"]',
    'div[aria-label="Plaatsen"]',
    'div[aria-label="Opublikuj"]',
    'div[aria-label="Siarkan"]',
    'div[aria-label="I-post"]',
    'div[aria-label="发布"]',
    'div[aria-label="發布"]',
    'div[aria-label="發佈"]',
    'div[role="dialog"][aria-modal="true"] div[aria-label="Post"]',
    'div[role="dialog"][aria-modal="true"] div[aria-label="Kirim"]',
    'div[role="dialog"][aria-modal="true"] div[aria-label="Publicar"]',
  )
  .one();

type PublishItem = { text: string; image: string };

function normalizeResources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

/**
 * 单页只配对一条：取文案/图片池的第 1 项（分发侧已按主页轮询拆成单条；此处再截断防旧任务连发）。
 * 任一侧为空池则只发另一侧。
 */
function pairSinglePublishItem(texts: string[], images: string[]): PublishItem[] {
  if (texts.length === 0 && images.length === 0) return [];
  const text = texts.length > 0 ? texts[0]! : '';
  const image = images.length > 0 ? images[0]! : '';
  if (!text && !image) return [];
  return [{ text, image }];
}

function pageSk(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).searchParams.get('sk');
  } catch {
    return null;
  }
}

/**
 * 同一公共主页（含数字 ID ↔ profile.php?id）且 sk 一致则视为已在目标页。
 * 注意：canonicalizePageUrl 会删掉 sk（身份去重用），此处 sk 必须用原始 URL 比较，
 * 否则 vanity 主页 posts ↔ mentions 会被误判为同一页而 skip goto。
 */
function isSamePageTarget(currentUrl: string, targetUrl: string): boolean {
  const curSk = pageSk(currentUrl) || null;
  const wantSk = pageSk(targetUrl) || null;
  if (curSk !== wantSk) return false;

  const curId = extractPageId(currentUrl);
  const wantId = extractPageId(targetUrl);
  if (curId && wantId) return curId === wantId;

  try {
    const a = new URL(canonicalizePageUrl(currentUrl));
    const b = new URL(canonicalizePageUrl(targetUrl));
    return (
      a.origin === b.origin &&
      a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

/** 评论须在 Posts；host 若带 sk=mentions/about 等会找不到帖子。 */
function toPostsUrl(pageUrl: string): string {
  try {
    const u = new URL(canonicalizePageUrl(pageUrl));
    const sk = u.searchParams.get('sk');
    if (sk && sk !== 'posts') u.searchParams.delete('sk');
    u.hash = '';
    return u.toString();
  } catch {
    return pageUrl.split('#')[0] ?? pageUrl;
  }
}

function toMentionsUrl(pageUrl: string): string {
  try {
    const u = new URL(canonicalizePageUrl(pageUrl));
    u.searchParams.set('sk', 'mentions');
    u.hash = '';
    return u.toString();
  } catch {
    const base = canonicalizePageUrl(pageUrl).split('#')[0] ?? pageUrl;
    return base.includes('?') ? `${base}&sk=mentions` : `${base}?sk=mentions`;
  }
}

function extractPageId(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    const id = u.searchParams.get('id');
    if (id && /^\d+$/.test(id)) return id;
    const m = u.pathname.match(/\/(?:people\/[^/]+\/(\d+)|(\d{5,}))/);
    if (m?.[1] || m?.[2]) return m[1] || m[2] || null;
  } catch {
    /* ignore */
  }
  return null;
}

async function wasPageAlreadyContacted(pageUrl: string): Promise<boolean> {
  const key = contactedStoreKey(pageUrl);
  try {
    const [ok, , row] = await scriptStoreGet(key);
    if (!ok || !row) return false;
    const v = String(row.value ?? '').trim().toLowerCase();
    return v === '1' || v === 'done' || v === 'true';
  } catch {
    return false;
  }
}

async function markPageContacted(pageUrl: string): Promise<void> {
  const key = contactedStoreKey(pageUrl);
  try {
    await scriptStoreSet({
      key,
      value: '1',
      extra1: canonicalizePageUrl(pageUrl),
    });
  } catch {
    /* store 可选；写入失败不影响任务成功 */
  }
}

/**
 * 打开主页/Tab：已在目标则跳过；pageGoTo 误报 URL unchanged 时若已在同页则继续。
 * force=true 时不做 skip（提及 Tab 在评论后必须强制切页，避免停在 Posts/permalink）。
 */
async function openPageUrl(
  client: XportBrowserClient,
  url: string,
  opts?: { force?: boolean },
): Promise<{ ok: true } | { ok: false; msg: string }> {
  if (!opts?.force) {
    const [, , cur] = await client.getPageUrl();
    if (cur && isSamePageTarget(cur, url)) {
      client.taskLog(`already on target, skip goto: ${url}`);
      return { ok: true };
    }
  } else {
    client.taskLog(`force goto: ${url}`);
  }
  const [goOk, goMsg] = await client.pageGoTo(0, {
    url,
    timeoutMs: 60_000,
    wait: 'domcontentloaded',
  });
  if (goOk) return { ok: true };
  const [, , after] = await client.getPageUrl();
  if (after && isSamePageTarget(after, url)) {
    client.taskLog(
      `pageGoTo reported fail but landed on target (${after}); continue. msg=${goMsg ?? ''}`,
    );
    return { ok: true };
  }
  return { ok: false, msg: goMsg || 'pageGoTo failed' };
}

/**
 * 主页/提及不可用：删除、权限、坏链等。
 * 标题多语须覆盖现场已见变体（印尼 Halaman/Konten、英、中、法、阿…）；
 * 另用「回动态」主按钮 + 无发帖入口 作结构兜底，避免未知语种漏检再报 ELEMENT_NOT_FOUND。
 */
async function isFacebookPageUnavailable(client: XportBrowserClient): Promise<boolean> {
  const [, , hit] = await client.evaluateInPage(
    0,
    `(() => {
      const tx = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 8000) : '';
      const heading = /Halaman Ini Tidak Tersedia|Konten Ini Tidak Tersedia|This Page Isn.?t Available|This content isn.?t available|内容暂时无法显示|內容暫時無法顯示|Ce contenu n.est pas disponible|هذا المحتوى غير متوفر|Este contenido no est[aá] disponible|Este conte[uú]do n[aã]o est[aá] dispon[ií]vel|Dieser Inhalt ist (momentan )?nicht verf[uü]gbar|Questo contenuto non [eè] (al momento )?disponibile|Dit content is nu niet beschikbaar|Этот контент сейчас недоступен|Bu i[cç]erik [sş]u anda mevcut de[gğ]il|यह कॉन्टेंट अभी उपलब्ध नहीं|এই কনটেন্ট এখন উপলব্ধ নয়|เนื้อหานี้ไม่พร้อมใช้งาน|Nội dung này hiện không khả dụng/i;
      if (heading.test(tx)) return '1';
      const feedCta = /Go to Feed|Go to News Feed|前往动态|前往動態|Buka Kabar Beranda|Acc[eé]der au Fil|انتقال إلى الموجز|Ir al Feed|Ir para o Feed|Zur Startseite|Vai al Feed|Ga naar Feed|Перейти к ленте|Feed.e git|फ़ीड पर जाएं/i;
      const explain = /deleted|supprim|dihapus|一小群|一小群用戶|grup yang kecil|small group|petit groupe|مجموعة صغيرة|borrado|exclu[ií]do|gelöscht|eliminato|verwijderd|удал|silinmi[sş]|हटा|ลบ|đã xóa/i;
      const hasComposer = /Write something to |Tulis sesuatu |Escreva algo |[EÉé]crivez quelque|写点什么|寫點什麼|कुछ लिख|Viết gì |ماذا يدور|Was machst du|A cosa stai/i.test(tx);
      if (feedCta.test(tx) && explain.test(tx) && !hasComposer) return '1';
      return '0';
    })()`,
  );
  return String(hit) === '1';
}

/** 是否已落到提及 Tab（URL sk=mentions 或页面出现 Mentions 分区标题）。 */
async function isMentionsTabLoaded(client: XportBrowserClient): Promise<boolean> {
  const [, , url] = await client.getPageUrl();
  if (url && /[?&]sk=mentions\b/i.test(url)) return true;
  const [, , hit] = await client.evaluateInPage(
    0,
    `(() => {
      const tx = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 5000) : '';
      return /\\bMentions\\b|\\bMenciones\\b|\\bPenyebutan\\b|\\bMentions\\b|提及|標記|Mentions/i.test(tx) ? '1' : '0';
    })()`,
  );
  return String(hit) === '1';
}

/**
 * 部分主页把 Mentions 收进 More；URL 虽带 sk=mentions 仍可能停在 All。
 * 尝试 More → Mentions（多语已见 More/Más/Lainnya）。
 */
async function openMentionsFromMoreMenu(client: XportBrowserClient): Promise<boolean> {
  const [, , moreClicked] = await client.evaluateInPage(
    0,
    `(() => {
      const tabs = [...document.querySelectorAll('[role="tab"], [role="button"], a')];
      const more = tabs.find((el) => {
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        return /^(More|Más|Lainnya|更多|もっと見る|더 보기)(\\s*[▼▾])?$/i.test(t);
      });
      if (!more) return '0';
      more.scrollIntoView({ block: 'center', inline: 'nearest' });
      more.click();
      return '1';
    })()`,
  );
  if (String(moreClicked) !== '1') return false;
  await sleep(600);
  const [, , mentClicked] = await client.evaluateInPage(
    0,
    `(() => {
      const nodes = [...document.querySelectorAll('[role="menuitem"], [role="tab"], a, span, div')];
      const ment = nodes.find((el) => {
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        return /^(Mentions|Menciones|Penyebutan|提及|標記)$/i.test(t);
      });
      if (!ment) return '0';
      const clickable =
        ment.closest('a, [role="menuitem"], [role="tab"], [role="button"]') || ment;
      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      clickable.click();
      return '1';
    })()`,
  );
  if (String(mentClicked) !== '1') return false;
  await sleep(900);
  return true;
}

function toPermalinkUrl(pageUrl: string, storyFbid: string): string {
  const pageId = extractPageId(pageUrl);
  if (pageId) {
    return `https://www.facebook.com/permalink.php?story_fbid=${storyFbid}&id=${pageId}`;
  }
  return `https://www.facebook.com/permalink.php?story_fbid=${storyFbid}`;
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step,
    reason,
    code,
    labels,
  });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
  });
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
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

/**
 * 配图：只走 SDK 注入，禁止点上传/照片/相机（会弹 Windows「打开」选文件框）。
 * 1) 隐藏 input[type=file] + uploadFile(md5)
 * 2) 若无 file input 或注入失败 → 聚焦输入框 pasteClipboardBinary(md5)
 */
async function attachMediaWithoutOsDialog(
  client: XportBrowserClient,
  opts: {
    fileInputPath: ReturnType<typeof nodePath>;
    composerPath: ReturnType<typeof nodePath>;
    imageMd5: string;
    step: string;
    index: number;
    labels: Record<string, string>;
  },
): Promise<AutomationRunResult | null> {
  const { fileInputPath, composerPath, imageMd5, step, index, labels } = opts;
  const idxLabels = { ...labels, index: String(index) };

  await client.scrollNodeIntoView(0, composerPath);
  await sleep(200);
  await client.focusNode(0, composerPath);
  await sleep(300);

  const fileReady = await waitForCount(client, fileInputPath, (n) => n >= 1, 6_000);
  if (fileReady >= 1) {
    const [upOk, upMsg] = await client.uploadFile(0, fileInputPath, imageMd5);
    if (upOk) {
      client.taskLog(`${step}: uploadFile ok for #${index}`);
      await sleep(1400);
      return null;
    }
    client.taskLog(`${step}: uploadFile failed (${upMsg || 'unknown'}), fallback paste`);
  } else {
    client.taskLog(`${step}: no file input yet for #${index}, fallback pasteClipboardBinary`);
  }

  await client.focusNode(0, composerPath);
  await sleep(200);
  const [pasteOk, pasteMsg] = await client.pasteClipboardBinary(0, composerPath, imageMd5);
  if (!pasteOk) {
    return await failStep(
      client,
      step,
      pasteMsg ||
        `failed to attach image #${index} (uploadFile/paste). Do not click Attach/Photo — use resource md5.`,
      'ELEMENT_NOT_FOUND',
      idxLabels,
    );
  }
  client.taskLog(`${step}: pasteClipboardBinary ok for #${index}`);
  await sleep(1600);
  return null;
}

async function dismissLeavePageIfAny(client: XportBrowserClient): Promise<void> {
  const [ok, , count] = await client.getNodeCount(0, leavePagePath);
  if (ok && (count ?? 0) >= 1) {
    await client.clickNode(0, leavePagePath);
    await sleep(600);
  }
}

async function closeDialogIfAny(client: XportBrowserClient): Promise<void> {
  const [ok, , count] = await client.getNodeCount(0, dialogClosePath);
  if (ok && (count ?? 0) >= 1) {
    await client.clickNode(0, dialogClosePath);
    await sleep(500);
    await dismissLeavePageIfAny(client);
  }
}

async function dismissFacebookBlockers(client: XportBrowserClient): Promise<void> {
  for (let round = 0; round < 2; round++) {
    const [hintOk, , hintCount] = await client.getNodeCount(0, sleepModeHintPath);
    if (hintOk && (hintCount ?? 0) >= 1) {
      const [okBtn, , okCount] = await client.getNodeCount(0, sleepModeOkPath);
      if (okBtn && (okCount ?? 0) >= 1) {
        const [clicked] = await client.clickNode(0, sleepModeOkPath);
        if (clicked) {
          await sleep(500);
          client.taskLog('dismissed Facebook sleep mode dialog');
        }
      }
    }

    await client.pressKey(0, 'Escape');
    await sleep(200);

    const [, , removed] = await client.evaluateInPage(
      0,
      `(() => {
        let n = 0;
        for (const d of [...document.querySelectorAll('[role="dialog"]')]) {
          const t = d.innerText || '';
          if (!/daily limit|sleep mode|使用时长|睡眠模式/i.test(t)) continue;
          let node = d;
          for (let i = 0; i < 8 && node.parentElement; i++) {
            const p = node.parentElement;
            const cls = (p.className || '').toString();
            if (
              p.getAttribute('role') === 'presentation' ||
              cls.includes('__fb') ||
              p.childElementCount <= 3
            ) {
              node = p;
            } else break;
          }
          node.remove();
          n++;
        }
        return String(n);
      })()`,
    );
    if (String(removed ?? '') !== '' && String(removed) !== '0') {
      await sleep(300);
      client.taskLog(`dismissed Facebook blocker overlay(s): ${removed}`);
    } else if (round === 0) {
      break;
    }
  }
}

async function findLatestStoryFbid(client: XportBrowserClient): Promise<string | null> {
  const [ok, , raw] = await client.evaluateInPage(
    0,
    `(() => {
      const html = document.documentElement.innerHTML;
      const m = html.match(/story_fbid[=:"]+(pfbid[A-Za-z0-9]+|\\d+)/);
      return m && m[1] ? m[1] : '';
    })()`,
  );
  if (!ok) return null;
  const id = String(raw ?? '').trim();
  return /^(pfbid[A-Za-z0-9]+|\d+)$/.test(id) ? id : null;
}

/** 滚到帖子区；点日期进入评论列表，失败则用 story_fbid 打开 permalink。无帖返回 no_posts。 */
async function openLatestPostComments(
  client: XportBrowserClient,
  pageUrl: string,
  opts?: { needFileInput?: boolean },
): Promise<'opened' | 'no_posts'> {
  await dismissFacebookBlockers(client);
  const needFileInput = opts?.needFileInput === true;

  let storyId: string | null = null;
  for (let i = 0; i < 8; i++) {
    const [noOk, , noCount] = await client.getNodeCount(0, noPostsHintPath);
    if (noOk && (noCount ?? 0) >= 1 && i >= 2) {
      return 'no_posts';
    }

    storyId = await findLatestStoryFbid(client);
    const [dateOk, , dateCount] = await client.getNodeCount(0, postDateLinkPath);
    const [boxOk, , boxCount] = await client.getNodeCount(0, commentTextboxPath);

    if (boxOk && (boxCount ?? 0) >= 1) {
      if (!needFileInput) {
        client.taskLog('comment composer already visible on feed');
        return 'opened';
      }
      await client.scrollNodeIntoView(0, commentTextboxPath);
      await sleep(200);
      await client.focusNode(0, commentTextboxPath);
      await sleep(400);
      const fileReady = await waitForCount(client, commentFileInputPath, (n) => n >= 1, 4_000);
      if (fileReady >= 1) {
        client.taskLog('comment composer + file input ready on feed');
        return 'opened';
      }
      client.taskLog(
        'feed comment box has no file input for images; try permalink / date open',
      );
    }

    if (dateOk && (dateCount ?? 0) >= 1) {
      await client.scrollNodeIntoView(0, postDateLinkPath);
      await sleep(400);
      const [clickOk] = await client.clickNode(0, postDateLinkPath);
      if (clickOk) {
        client.taskLog('clicked post date/permalink to open comments');
        await sleep(1200);
        await dismissFacebookBlockers(client);
        const ready = await waitForCount(client, commentTextboxPath, (n) => n >= 1, 15_000);
        if (ready >= 1) {
          if (!needFileInput) return 'opened';
          await client.focusNode(0, commentTextboxPath);
          await sleep(300);
          const fileReady = await waitForCount(client, commentFileInputPath, (n) => n >= 1, 5_000);
          if (fileReady >= 1 || ready >= 1) return 'opened';
        }
      }
    }

    if (storyId) break;

    await client.mouseWheel(0, nodePath().css('html'), { deltaX: 0, deltaY: 420 });
    await sleep(700);
  }

  if (!storyId) {
    storyId = await findLatestStoryFbid(client);
  }
  if (!storyId) {
    return 'no_posts';
  }

  const permalink = toPermalinkUrl(pageUrl, storyId);
  client.taskLog(`open permalink for comments: ${permalink}`);
  const [goOk] = await client.pageGoTo(0, { url: permalink, timeoutMs: 60_000 });
  if (!goOk) return 'no_posts';
  await client.waitForNetworkIdle(0, 8000);
  await dismissFacebookBlockers(client);
  const ready = await waitForCount(client, commentTextboxPath, (n) => n >= 1, 20_000);
  if (ready < 1) return 'no_posts';
  if (needFileInput) {
    await client.focusNode(0, commentTextboxPath);
    await sleep(300);
    await waitForCount(client, commentFileInputPath, (n) => n >= 1, 5_000);
  }
  return 'opened';
}

async function publishComments(
  client: XportBrowserClient,
  items: PublishItem[],
  labels: Record<string, string>,
  pageUrl: string,
): Promise<AutomationRunResult | number> {
  if (items.length === 0) {
    client.taskLog('comment step skipped (no texts/images)');
    return 0;
  }

  const needFileInput = items.some((it) => Boolean(it.image));
  const open = await openLatestPostComments(client, pageUrl, { needFileInput });
  if (open === 'no_posts') {
    client.taskLog('page has no posts, skip comment step');
    return 0;
  }

  const boxReady = await waitForCount(client, commentTextboxPath, (n) => n >= 1, 12_000);
  if (boxReady < 1) {
    return await failStep(
      client,
      'wait_comment_textbox',
      'Comment textbox did not appear after opening latest post',
      'ELEMENT_NOT_FOUND',
      labels,
    );
  }

  await client.scrollNodeIntoView(0, commentTextboxPath);
  await sleep(400);

  let published = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    client.taskLog(`comment #${i + 1}: textLen=${item.text.length} image=${item.image ? 'yes' : 'no'}`);

    if (item.text) {
      await client.scrollNodeIntoView(0, commentTextboxPath);
      await sleep(200);
      const [typeOk, typeMsg] = await client.typeInNode(0, commentTextboxPath, item.text);
      if (!typeOk) {
        return await failStep(
          client,
          'type_comment',
          typeMsg || `failed to type comment #${i + 1}`,
          'UNKNOWN',
          { ...labels, index: String(i + 1) },
        );
      }
      await sleep(400);
    }

    if (item.image) {
      const attachFail = await attachMediaWithoutOsDialog(client, {
        fileInputPath: commentFileInputPath,
        composerPath: commentTextboxPath,
        imageMd5: item.image,
        step: 'upload_comment_image',
        index: i + 1,
        labels,
      });
      if (attachFail) return attachFail;
    }

    const submitReady = await waitForCount(client, postCommentPath, (n) => n >= 1, 10_000);
    if (submitReady < 1) {
      return await failStep(
        client,
        'find_post_comment',
        `Post comment button not found for #${i + 1}`,
        'ELEMENT_NOT_FOUND',
        { ...labels, index: String(i + 1) },
      );
    }
    const [postOk, postMsg] = await client.clickNode(0, postCommentPath);
    if (!postOk) {
      return await failStep(
        client,
        'submit_comment',
        postMsg || `failed to submit comment #${i + 1}`,
        'UNKNOWN',
        { ...labels, index: String(i + 1) },
      );
    }
    published += 1;
    await sleep(1500);
    await waitForCount(client, commentTextboxPath, (n) => n >= 1, 10_000);
  }

  await closeDialogIfAny(client);
  return published;
}

/** 发帖弹窗是否已出现（多语言 aria-label / dialog textbox）。 */
async function isMentionDialogOpen(client: XportBrowserClient, timeoutMs = 2_000): Promise<boolean> {
  const box = await waitForCount(client, mentionDialogTextboxPath, (n) => n >= 1, timeoutMs);
  if (box >= 1) return true;
  const [, , alt] = await client.evaluateInPage(
    0,
    `(() => {
      const el = [...document.querySelectorAll('[role="textbox"], [contenteditable="true"]')].find((n) => {
        const a = ((n.getAttribute('aria-label') || '') + ' ' + (n.innerText || '')).trim();
        return /mind|pensez-vous|pensando|Create a public|Cr[eé]er une publication|Crear una publicaci[oó]n|Create post|Was machst du|A cosa stai|写点什么|有什么新鲜|想说什么|No que voc|Tulis sesuatu|Escreva |कुछ लिख|Viết gì|เขียนอะไร|Buat postingan|Create a post/i.test(a);
      });
      if (el) return '1';
      const dlg = document.querySelector(
        'div[role="dialog"][aria-modal="true"] [role="textbox"], div[role="dialog"][aria-modal="true"] [contenteditable="true"], div[role="dialog"] [role="textbox"], div[role="dialog"] [contenteditable="true"]',
      );
      return dlg ? '1' : '0';
    })()`,
  );
  return String(alt) === '1';
}

/**
 * Mentions 发帖入口：多语言「写点什么」打开 Create post。
 * 禁止用 Photo/video 快捷入口兜底——会弹出系统选文件框导致任务卡住。
 * 未知语种：结构兜底（短占位文案以 …/... 结尾的 compose button）。
 */
async function openMentionComposer(client: XportBrowserClient): Promise<boolean> {
  await dismissFacebookBlockers(client);
  if (await isMentionDialogOpen(client, 1_500)) return true;

  for (let attempt = 0; attempt < 3; attempt++) {
    await dismissFacebookBlockers(client);
    await client.evaluateInPage(0, `(() => { window.scrollTo(0, 0); return '1'; })()`);
    await sleep(350 + attempt * 250);

    // 1) JS：多语言「写点什么给…」+ 结构兜底；优先最短匹配（避免点到含 Photo 的大卡片）
    const [, , clicked] = await client.evaluateInPage(
      0,
      `(() => {
        const entryRe = /Write something to |[EÉé]crivez quelque chose |Escribe algo |Schreib etwas |Scrivi qualcosa |Escreva algo |Escreva alguma coisa |Tulis sesuatu |कुछ लिखें|कुछ लिख |Viết gì |เขียนอะไร |何か書|남길 글|Напишите |اكتب شي|Schrijf iets |Napisz coś |bir şeyler yaz |Sumulat ng |写点什么|寫點什麼|有什么新鲜事|有什麼新鮮事/i;
        const photoRe = /Photo\\/\\s*Vid|Foto\\/\\s*V[ií]d|Foto\\/video|照片\\/视频|相片\\/影片|Foto\\/Video|รูปภาพ|Ảnh\\/video/i;
        const closeRe = /^(Close|Tutup|Fermer|Cerrar|Fechar|Schließen|Chiudi|关闭|關閉|닫기|閉じる)$/i;
        const norm = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
        const buttons = [...document.querySelectorAll('[role="button"]')]
          .map((el) => ({ el, tx: norm(el) }))
          .filter((x) => x.tx.length > 0 && entryRe.test(x.tx) && !photoRe.test(x.tx))
          .sort((a, b) => a.tx.length - b.tx.length);
        let b = buttons[0]?.el || null;
        if (!b) {
          const leaf = [...document.querySelectorAll('span, div')].find((el) => {
            const tx = norm(el);
            return tx.length > 8 && tx.length < 140 && entryRe.test(tx) && !photoRe.test(tx);
          });
          b = leaf ? (leaf.closest('[role="button"]') || leaf) : null;
        }
        // 未知语种结构兜底：Mentions 入口常为短占位句且以省略号结尾
        if (!b) {
          const structural = [...document.querySelectorAll('[role="button"]')]
            .map((el) => ({ el, tx: norm(el) }))
            .filter((x) => {
              if (x.tx.length < 8 || x.tx.length > 140) return false;
              if (photoRe.test(x.tx) || closeRe.test(x.tx)) return false;
              if (!/(\\.{2,}|…)$/.test(x.tx)) return false;
              // 排除多行操作条（含换行拆开后仍很长/多段）
              const lines = (x.el.innerText || '').split(/\\n/).map((s) => s.trim()).filter(Boolean);
              return lines.length <= 2;
            })
            .sort((a, b) => a.tx.length - b.tx.length);
          b = structural[0]?.el || null;
        }
        if (!b) return '0';
        b.scrollIntoView({ block: 'center', inline: 'nearest' });
        b.click();
        return '1';
      })()`,
    );

    // 2) nodePath 多语言文案（仍不点 Photo；span 命中时点可点击祖先）
    if (String(clicked) !== '1') {
      const ready = await waitForCount(client, mentionOpenComposerPath, (n) => n >= 1, 8_000);
      if (ready >= 1) {
        await client.scrollNodeIntoView(0, mentionOpenComposerPath);
        await sleep(250);
        const [ok] = await client.clickNode(0, mentionOpenComposerPath, -1, {
          preferClickableAncestor: true,
        });
        if (!ok) client.taskLog(`mention entry clickNode failed (attempt ${attempt + 1})`);
      } else {
        client.taskLog(`mention entry not found yet (attempt ${attempt + 1})`);
      }
    }

    if (await isMentionDialogOpen(client, 12_000)) return true;
    client.taskLog(`mention composer dialog not open after attempt ${attempt + 1}`);
    await sleep(600);
  }
  return false;
}

/** 提及弹窗内发布按钮：多语 aria-label；未知语种再按 dialog 底部主按钮结构找。 */
async function findAndClickMentionPost(client: XportBrowserClient): Promise<boolean> {
  const postReady = await waitForCount(client, mentionPostPath, (n) => n >= 1, 10_000);
  if (postReady >= 1) {
    await client.scrollNodeIntoView(0, mentionPostPath);
    await sleep(250);
    const [ok] = await client.clickNode(0, mentionPostPath, -1, { preferClickableAncestor: true });
    if (ok) return true;
  }

  const [, , clicked] = await client.evaluateInPage(
    0,
    `(() => {
      const dlg = document.querySelector('div[role="dialog"][aria-modal="true"]')
        || document.querySelector('div[role="dialog"]');
      if (!dlg) return '0';
      const postRe = /^(Post|Publier|Publicar|Veröffentlichen|Pubblica|Kirim|โพสต์|Đăng|投稿する|게시|Опубликовать|Отправить|نشر|पोस्ट करें|Paylaş|Plaatsen|Opublikuj|Siarkan|I-post|发布|發布|發佈)$/i;
      const skipRe = /Close|Tutup|Fermer|Cerrar|Fechar|Schließen|Chiudi|关闭|關閉|Photo|Foto|GIF|Tag|Feeling|Emoji|Ai label|Label AI/i;
      const buttons = [...dlg.querySelectorAll('[role="button"]')]
        .map((el) => {
          const label = (el.getAttribute('aria-label') || '').trim();
          const tx = (el.innerText || '').replace(/\\s+/g, ' ').trim();
          return { el, key: label || tx };
        })
        .filter((x) => x.key && !skipRe.test(x.key) && (postRe.test(x.key) || (x.key.length <= 16 && !/\\//.test(x.key))));
      const byLabel = buttons.find((x) => postRe.test(x.key));
      let b = byLabel?.el || null;
      if (!b) {
        // 结构：弹窗底部较短的主操作按钮（常为发布）
        const bottom = buttons
          .filter((x) => x.key.length <= 16)
          .sort((a, b) => b.el.getBoundingClientRect().bottom - a.el.getBoundingClientRect().bottom);
        b = bottom[0]?.el || null;
      }
      if (!b) return '0';
      b.scrollIntoView({ block: 'center', inline: 'nearest' });
      b.click();
      return '1';
    })()`,
  );
  return String(clicked) === '1';
}

async function publishMentions(
  client: XportBrowserClient,
  items: PublishItem[],
  labels: Record<string, string>,
): Promise<AutomationRunResult | number | 'skipped_no_composer'> {
  if (items.length === 0) {
    client.taskLog('mention step skipped (no texts/images)');
    return 0;
  }

  let published = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    client.taskLog(`mention #${i + 1}: textLen=${item.text.length} image=${item.image ? 'yes' : 'no'}`);

    if (await isFacebookPageUnavailable(client)) {
      client.taskLog(`mention #${i + 1}: page unavailable, stop mention step`);
      return published;
    }

    let opened = await openMentionComposer(client);
    if (!opened) {
      // Mentions 可能在 More 下；点开后再试一次发帖入口
      if (await openMentionsFromMoreMenu(client)) {
        client.taskLog('opened Mentions from More menu, retry composer');
        opened = await openMentionComposer(client);
      }
    }
    if (!opened) {
      if (await isFacebookPageUnavailable(client)) {
        client.taskLog(`mention #${i + 1}: page unavailable after open attempts, stop mention step`);
        return published;
      }
      // 已在提及 Tab 但无 Write something：账号无权/主页未开放访客提及发帖 → 跳过
      if (await isMentionsTabLoaded(client)) {
        client.taskLog(
          `mention #${i + 1}: Mentions tab loaded but no compose entry (page/account restriction), skip`,
        );
        return 'skipped_no_composer';
      }
      return await failStep(
        client,
        'open_mention_composer',
        `Mentions compose entry / dialog not found for #${i + 1}`,
        'ELEMENT_NOT_FOUND',
        { ...labels, index: String(i + 1) },
      );
    }

    if (item.text) {
      const [typeOk, typeMsg] = await client.typeInNode(0, mentionDialogTextboxPath, item.text);
      if (!typeOk) {
        return await failStep(
          client,
          'type_mention',
          typeMsg || `failed to type mention #${i + 1}`,
          'UNKNOWN',
          { ...labels, index: String(i + 1) },
        );
      }
      await sleep(400);
    }

    if (item.image) {
      const attachFail = await attachMediaWithoutOsDialog(client, {
        fileInputPath: mentionDialogFileInputPath,
        composerPath: mentionDialogTextboxPath,
        imageMd5: item.image,
        step: 'upload_mention_image',
        index: i + 1,
        labels,
      });
      if (attachFail) return attachFail;
    }

    const postOk = await findAndClickMentionPost(client);
    if (!postOk) {
      return await failStep(
        client,
        'find_mention_post',
        `Post button not found for mention #${i + 1}`,
        'ELEMENT_NOT_FOUND',
        { ...labels, index: String(i + 1) },
      );
    }
    published += 1;
    await sleep(2000);
    await closeDialogIfAny(client);
  }

  return published;
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  const hostRaw = String(taskConfig.host ?? '').trim();
  const host = hostRaw ? canonicalizePageUrl(hostRaw) : '';
  const commentTexts = splitConfigLines(taskConfig.comment_texts);
  const mentionTexts = splitConfigLines(taskConfig.mention_texts);
  const commentImages = normalizeResources(taskConfig.comment_images);
  const mentionImages = normalizeResources(taskConfig.mention_images);
  // 防御：旧任务若仍带多行文案，也只发第 1 条
  const commentItems = pairSinglePublishItem(commentTexts, commentImages);
  const mentionItems = pairSinglePublishItem(mentionTexts, mentionImages);

  const labels = {
    host,
    commentItems: String(commentItems.length),
    mentionItems: String(mentionItems.length),
  };

  client.taskLog(
    `host=${host || '(empty)'} comments=${commentItems.length} mentions=${mentionItems.length}`,
  );

  if (!host) {
    return automationFailWithContext('host is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_host',
    });
  }

  if (commentItems.length === 0 && mentionItems.length === 0) {
    return automationFailWithContext(
      'At least one comment or mention text/image is required',
      {
        code: 'UNKNOWN',
        step: 'validate_content',
      },
    );
  }

  if (await wasPageAlreadyContacted(host)) {
    client.taskLog(`skip: page already contacted once (${contactedStoreKey(host)})`);
    return {
      succ: true,
      msg: 'skipped: this page was already contacted once (dedup)',
      data: {
        host,
        finalUrl: '',
        commentCount: 0,
        mentionCount: 0,
      },
    };
  }

  try {
    const postsUrl = toPostsUrl(host);
    client.taskLog(`open posts: ${postsUrl}`);
    const openPosts = await openPageUrl(client, postsUrl);
    if (!openPosts.ok) {
      return await failStep(client, 'open_host', openPosts.msg, 'NAV_FAILED', labels);
    }

    const [idleOk, idleMsg] = await client.waitForNetworkIdle(0, 8000);
    if (!idleOk) client.taskLog(`waitForNetworkIdle: ${idleMsg}`);
    await dismissFacebookBlockers(client);

    const [urlOk, , pageUrl] = await client.getPageUrl();
    if (urlOk && /\/login/i.test(pageUrl ?? '')) {
      return await failStep(
        client,
        'check_login',
        'Browser is not logged in to Facebook. Please log in on this fingerprint profile first.',
        'NOT_LOGGED_IN',
        labels,
      );
    }

    const commentResult = await publishComments(client, commentItems, labels, postsUrl);
    if (typeof commentResult !== 'number') return commentResult;

    let mentionResult = 0;
    let mentionsSkippedUnavailable = false;
    if (mentionItems.length > 0) {
      const mentionsUrl = toMentionsUrl(host);
      client.taskLog(`open mentions: ${mentionsUrl}`);
      // 评论后常停在 Posts/permalink；vanity URL 旧逻辑会误 skip，这里强制进提及页
      const openMentions = await openPageUrl(client, mentionsUrl, { force: true });
      if (!openMentions.ok) {
        return await failStep(
          client,
          'open_mentions',
          openMentions.msg || 'failed to open Mentions tab',
          'NAV_FAILED',
          labels,
        );
      }
      await Bun.sleep(800);
      await dismissFacebookBlockers(client);
      if (await isFacebookPageUnavailable(client)) {
        // 与「无帖跳过评论」一致：主页提及 Tab 不可用时跳过，不整任务失败
        client.taskLog('mentions page unavailable (deleted/restricted), skip mention step');
        mentionsSkippedUnavailable = true;
        mentionResult = 0;
      } else {
        const mr = await publishMentions(client, mentionItems, labels);
        if (mr === 'skipped_no_composer') {
          mentionsSkippedUnavailable = true;
          mentionResult = 0;
          client.taskLog('mentions skipped: no compose entry on this page');
        } else if (typeof mr !== 'number') {
          return mr;
        } else {
          mentionResult = mr;
        }
      }
    }

    const [, , finalUrl] = await client.getPageUrl();
    const commentMsg =
      commentItems.length > 0 && commentResult === 0
        ? 'no posts to comment'
        : `published ${commentResult} comment(s)`;
    const mentionMsg = mentionsSkippedUnavailable
      ? 'mentions skipped (unavailable or no compose entry)'
      : `${mentionResult} mention post(s)`;
    // 仅在实际发出至少一条时记已触达；无帖跳过且未发提及时不记，便于下次再试
    if (commentResult > 0 || mentionResult > 0) {
      await markPageContacted(host);
    }
    return {
      succ: true,
      msg: `${commentMsg}, ${mentionMsg}`,
      data: {
        host,
        finalUrl: finalUrl ?? '',
        commentCount: commentResult,
        mentionCount: mentionResult,
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return await failStep(client, 'unexpected', reason, 'UNKNOWN', labels);
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(
  await XportBrowserClient.run((client) => runAutomation(client, taskConfig)),
);
