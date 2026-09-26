export const config = { runtime: 'edge' };

function isAllowed(u) {
  try {
    const x = new URL(u);
    if (!['http:', 'https:'].includes(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false;
    return true;
  } catch { return false; }
}

function proxify(base, raw) {
  try { return new URL(raw, base).toString(); } catch { return raw; }
}

async function rewriteM3U8(text, base, reqUrl, referrer, userAgent) {
  const proxy = (u) => {
    const q = new URLSearchParams({ url: proxify(base, u) });
    if (referrer) q.set('referrer', referrer);
    if (userAgent) q.set('userAgent', userAgent);
    return `${new URL('/api/proxy', reqUrl).origin}/api/proxy?${q.toString()}`;
  };
  return text.split(/\r?\n/).map(line => {
    const t=line.trim();
    if (!t || t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_,u)=>`URI="${proxy(u)}"`);
    }
    return proxy(t);
  }).join('\n');
}

export default async function handler(req) {
  const incoming = new URL(req.url);
  const target = incoming.searchParams.get('url');
  if (!target || !isAllowed(target)) return new Response('Invalid URL', {status:400});
  const referrer = incoming.searchParams.get('referrer') || '';
  const userAgent = incoming.searchParams.get('userAgent') || '';
  const headers = new Headers();
  const range=req.headers.get('range');
  if (range) headers.set('Range',range);
  headers.set('Accept','*/*');
  if (referrer) headers.set('Referer',referrer);
  if (userAgent) headers.set('User-Agent',userAgent);
  else headers.set('User-Agent','Mozilla/5.0');
  try {
    const r=await fetch(target,{headers,redirect:'follow'});
    const ct=(r.headers.get('content-type')||'').toLowerCase();
    const isM3U=ct.includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(new URL(target).pathname);
    const outHeaders=new Headers();
    outHeaders.set('Access-Control-Allow-Origin','*');
    outHeaders.set('Access-Control-Allow-Headers','*');
    outHeaders.set('Access-Control-Expose-Headers','Content-Length,Content-Range,Accept-Ranges');
    if (isM3U) {
      const body=await r.text();
      outHeaders.set('Content-Type','application/vnd.apple.mpegurl');
      return new Response(await rewriteM3U8(body,target,incoming,referrer,userAgent),{status:r.status,headers:outHeaders});
    }
    ['content-type','content-length','content-range','accept-ranges','cache-control','etag'].forEach(k=>{const v=r.headers.get(k);if(v)outHeaders.set(k,v)});
    return new Response(r.body,{status:r.status,headers:outHeaders});
  } catch(e) { return new Response('Upstream stream error',{status:502,headers:{'Access-Control-Allow-Origin':'*'}}); }
}
