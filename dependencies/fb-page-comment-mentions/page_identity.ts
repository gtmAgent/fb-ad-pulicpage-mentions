/**
 * 公共主页身份归一化：用于分发去重与跨次「已触达」记录。
 * 数字 ID 路径与 profile.php?id= 视为同一页；忽略 sk/hash；统一 www 主机。
 */

function normalizeFacebookHost(hostname: string): string {
  const h = hostname.toLowerCase();
  if (h === 'facebook.com' || h === 'm.facebook.com' || h === 'web.facebook.com') {
    return 'www.facebook.com';
  }
  return h;
}

export function canonicalizePageUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    u.hostname = normalizeFacebookHost(u.hostname);
    u.protocol = 'https:';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const idFromQuery = u.searchParams.get('id');
    if (path === '/profile.php' && idFromQuery && /^\d+$/.test(idFromQuery)) {
      u.hash = '';
      // 身份键忽略 Tab（sk=mentions 等）
      u.searchParams.delete('sk');
      return u.toString();
    }
    const numeric = path.match(/^\/(\d{5,})$/);
    const people = path.match(/^\/people\/[^/]+\/(\d{5,})$/);
    const id = numeric?.[1] || people?.[1] || null;
    if (!id) {
      u.hash = '';
      u.searchParams.delete('sk');
      return u.toString();
    }
    const out = new URL('https://www.facebook.com/profile.php');
    out.searchParams.set('id', id);
    out.hash = '';
    return out.toString();
  } catch {
    return pageUrl.split('#')[0] ?? pageUrl;
  }
}

export function extractPageId(pageUrl: string): string | null {
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

/** 稳定身份键：优先数字 id，否则 host+pathname（小写、去尾斜杠、无 sk）。 */
export function pageIdentityKey(pageUrl: string): string {
  const canonical = canonicalizePageUrl(pageUrl.trim());
  const id = extractPageId(canonical);
  if (id) return `id:${id}`;
  try {
    const u = new URL(canonical);
    const path = u.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    return `path:${normalizeFacebookHost(u.hostname)}${path}`;
  } catch {
    return `raw:${pageUrl.trim().toLowerCase()}`;
  }
}

/** store keys: contacted:page:{pageIdentityKey} */
export function contactedStoreKey(pageUrl: string): string {
  return `contacted:page:${pageIdentityKey(pageUrl)}`;
}
