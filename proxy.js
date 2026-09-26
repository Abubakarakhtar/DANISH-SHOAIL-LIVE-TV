function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local") ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h);
}

function proxyUrl(target, params = {}) {
  const q = new URLSearchParams({ url: target });
  if (params.referrer) q.set("referrer", params.referrer);
  if (params.userAgent) q.set("userAgent", params.userAgent);
  return `/api/proxy?${q.toString()}`;
}

function rewritePlaylist(text, targetUrl, params) {
  const base = new URL(targetUrl);

  return text.split(/\r?\n/).map(line => {
    line = line.replace(/URI="([^"]+)"/gi, (_, uri) => {
      try {
        const absolute = new URL(uri, base).href;
        return `URI="${proxyUrl(absolute, params)}"`;
      } catch {
        return `URI="${uri}"`;
      }
    });

    const t = line.trim();
    if (!t || t.startsWith("#")) return line;

    try {
      const absolute = new URL(t, base).href;
      return proxyUrl(absolute, params);
    } catch {
      return line;
    }
  }).join("\n");
}

export default async function handler(request) {
  const reqUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,HEAD,OPTIONS",
        "access-control-allow-headers": "Range,Content-Type,Origin,Accept"
      }
    });
  }

  try {
    const target = reqUrl.searchParams.get("url");
    const referrer = reqUrl.searchParams.get("referrer") || "";
    const userAgent =
      reqUrl.searchParams.get("userAgent") ||
      "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36";

    if (!target) return new Response("Missing ?url=", { status: 400 });

    const upstreamUrl = new URL(target);

    if (!/^https?:$/.test(upstreamUrl.protocol) ||
        isPrivateHost(upstreamUrl.hostname)) {
      return new Response("Target not allowed", { status: 400 });
    }

    const headers = new Headers({
      "accept": "*/*",
      "user-agent": userAgent
    });

    if (referrer) headers.set("referer", referrer);

    // Preserve byte-range requests for media segments where supplied.
    const range = request.headers.get("range");
    if (range) headers.set("range", range);

    const upstream = await fetch(upstreamUrl.href, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      redirect: "follow",
      headers
    });

    const common = {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "Content-Length,Content-Range,Accept-Ranges,Content-Type",
      "cache-control": "no-store"
    };

    if (!upstream.ok) {
      return new Response(`Upstream ${upstream.status}`, {
        status: upstream.status,
        headers: common
      });
    }

    const contentType = upstream.headers.get("content-type") || "";
    const looksLikeM3U =
      /mpegurl|m3u8/i.test(contentType) ||
      /\.m3u8(?:$|[?#])/i.test(upstreamUrl.href);

    if (looksLikeM3U && request.method !== "HEAD") {
      const body = await upstream.text();

      return new Response(
        rewritePlaylist(body, upstreamUrl.href, { referrer, userAgent }),
        {
          status: 200,
          headers: {
            ...common,
            "content-type": "application/vnd.apple.mpegurl; charset=utf-8"
          }
        }
      );
    }

    const pass = {
      ...common,
      "content-type": contentType || "application/octet-stream"
    };

    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) pass[name] = value;
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: pass
    });
  } catch (err) {
    return new Response(`Proxy error: ${err?.message || "unknown"}`, {
      status: 502,
      headers: { "access-control-allow-origin": "*" }
    });
  }
}
