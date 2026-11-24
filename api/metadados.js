/* Rádio Mundo · servidor de metadados
 * Funciona na Vercel (arquivo api/metadados.js no repositório) ou como Cloudflare Worker.
 *
 * O que faz: o iPhone não consegue ler o nome da música direto das rádios
 * (elas bloqueiam o navegador). Este servidor lê no lugar dele e devolve
 * em JSON, liberado para o app.
 *
 *   GET ?url=<endereço do stream>           -> { titulo, fonte }
 *   GET ?artista=<a>&musica=<m>             -> { plain, instrumental, fonte }   (letra)
 *
 * Fontes do nome da música, em ordem: metadados ICY dentro do próprio stream,
 * página de status do Icecast, páginas do SHOUTcast e etiquetas de HLS (ID3).
 * Letras: base aberta LRCLIB (lrclib.net).
 */

const UA = 'RadioMundo/1.0 (+https://github.com)';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    try {
      if (u.searchParams.has('musica') || /\/letra\/?$/.test(u.pathname)) {
        return cached(req, ctx, 86400, () => letra(u.searchParams.get('artista') || '', u.searchParams.get('musica') || ''));
      }
      const stream = u.searchParams.get('url');
      if (!stream) return json({ ok: true, servico: 'Rádio Mundo · metadados' }, 0);
      if (!/^https?:\/\//i.test(stream)) return json({ erro: 'url inválida' }, 0, 400);
      return cached(req, ctx, 10, () => agora(stream));
    } catch (e) {
      return json({ titulo: null, erro: String(e && e.message || e) }, 0);
    }
  }
};

/* ---------- utilidades ---------- */
function json(obj, maxAge = 0, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' }
  });
}
async function cached(req, ctx, maxAge, fn) {
  const cache = globalThis.caches && caches.default;
  const key = new Request(req.url, { method: 'GET' });
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  const resp = json(await fn(), maxAge);
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, resp.clone()));
  return resp;
}
function timed(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, abort: () => c.abort(), done: () => clearTimeout(t) };
}
function decode(bytes) {
  let txt = new TextDecoder('utf-8').decode(bytes);
  if (txt.includes('�')) txt = new TextDecoder('iso-8859-1').decode(bytes);
  return txt.replace(/\0/g, '').trim();
}
const limpo = s => (s == null ? null : String(s).replace(/\s+/g, ' ').trim());

/* ---------- nome da música ---------- */
async function agora(url) {
  if (/\.m3u8(\?|$)/i.test(url)) {
    const h = await hls(url).catch(() => null);
    return { titulo: limpo(h), fonte: h != null ? 'hls' : null };
  }
  const tentativas = [['icy', icy], ['icecast', icecastStatus], ['shoutcast', shoutcast]];
  for (const [nome, fn] of tentativas) {
    const t = await fn(url).catch(() => null);
    if (t === HLS) { const h = await hls(url).catch(() => null); return { titulo: limpo(h), fonte: 'hls' }; }
    if (t != null) return { titulo: limpo(t), fonte: nome };
  }
  return { titulo: null, fonte: null };
}
const HLS = Symbol('hls');

// Metadados ICY: a cada "icy-metaint" bytes de áudio vem um bloco com StreamTitle='...'
async function icy(url) {
  const t = timed(8000);
  try {
    const r = await fetch(url, { headers: { 'Icy-MetaData': '1', 'User-Agent': UA }, signal: t.signal, redirect: 'follow' });
    const ct = r.headers.get('content-type') || '';
    if (/mpegurl/i.test(ct)) { t.abort(); return HLS; }
    const mi = parseInt(r.headers.get('icy-metaint') || '0', 10);
    if (!r.ok || !mi || !r.body) { t.abort(); return null; }
    const rd = r.body.getReader();
    let skip = mi, need = -1, total = 0;
    const buf = [];
    while (total < mi * 3 + 8192) {
      const { value, done } = await rd.read();
      if (done) break;
      total += value.length;
      let p = 0;
      while (p < value.length) {
        if (skip > 0) { const n = Math.min(skip, value.length - p); skip -= n; p += n; continue; }
        if (need < 0) { need = value[p++] * 16; if (need === 0) { skip = mi; need = -1; } continue; }
        const n = Math.min(need - buf.length, value.length - p);
        for (let k = 0; k < n; k++) buf.push(value[p + k]);
        p += n;
        if (buf.length >= need) {
          t.abort();
          const m = decode(new Uint8Array(buf)).match(/StreamTitle='(.*?)';/s);
          return m ? m[1] : '';
        }
      }
    }
    t.abort();
    return null;
  } catch (e) { t.abort(); return null; } finally { t.done(); }
}

// Icecast: /status-json.xsl lista o título de cada ponto de montagem
async function icecastStatus(url) {
  const u = new URL(url);
  const t = timed(5000);
  try {
    const r = await fetch(u.origin + '/status-json.xsl', { headers: { 'User-Agent': UA }, signal: t.signal });
    if (!r.ok) return null;
    const j = JSON.parse((await r.text()).replace(/"title":\s*-\s*,/g, '"title":null,'));
    let src = j && j.icestats && j.icestats.source;
    if (!src) return null;
    if (!Array.isArray(src)) src = [src];
    const m = src.find(x => x.listenurl && new URL(x.listenurl, u.origin).pathname === u.pathname) || (src.length === 1 ? src[0] : null);
    if (!m) return null;
    const title = m.title || m.yp_currently_playing || '';
    return m.artist && title && !title.includes(' - ') ? m.artist + ' - ' + title : title;
  } catch (e) { return null; } finally { t.done(); }
}

// SHOUTcast v2: /stats?sid=1&json=1  ·  v1/v2: /currentsong?sid=1
async function shoutcast(url) {
  const u = new URL(url);
  for (const path of ['/stats?sid=1&json=1', '/currentsong?sid=1']) {
    const t = timed(4000);
    try {
      const r = await fetch(u.origin + path, { headers: { 'User-Agent': UA }, signal: t.signal });
      if (!r.ok) continue;
      const txt = (await r.text()).trim();
      if (path.includes('json')) { try { const j = JSON.parse(txt); if (j.songtitle != null) return j.songtitle; } catch (e) {} continue; }
      if (txt && txt.length < 300 && !/<html|<!doctype/i.test(txt)) return txt;
    } catch (e) {} finally { t.done(); }
  }
  return null;
}

// HLS: título na lista (#EXTINF ...,title="..."), senão etiquetas ID3 no início do último segmento
async function hls(url) {
  const get = async (u, ms = 6000, extra = {}) => {
    const t = timed(ms);
    try { return await fetch(u, { headers: { 'User-Agent': UA, ...extra }, signal: t.signal }); } finally { t.done(); }
  };
  let pl = await (await get(url)).text(), base = url;
  if (/#EXT-X-STREAM-INF/.test(pl)) {
    const v = pl.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (!v) return null;
    base = new URL(v, url).href;
    pl = await (await get(base)).text();
  }
  const lines = pl.split('\n').map(l => l.trim());
  const infs = lines.filter(l => l.startsWith('#EXTINF'));
  const last = infs[infs.length - 1];
  if (last) {
    const after = last.slice(last.indexOf(',') + 1);
    const tt = after.match(/title="([^"]*)"/i), ar = after.match(/artist="([^"]*)"/i);
    if (tt) return ar && ar[1] ? ar[1] + ' - ' + tt[1] : tt[1];
    if (after && !/=/.test(after)) return after;
  }
  const segs = lines.filter(l => l && !l.startsWith('#'));
  if (!segs.length) return null;
  const r = await get(new URL(segs[segs.length - 1], base).href, 6000, { Range: 'bytes=0-32767' });
  const bytes = new Uint8Array(await r.arrayBuffer()).subarray(0, 65536);
  const tags = id3(bytes);
  if (tags.TIT2) return tags.TPE1 ? tags.TPE1 + ' - ' + tags.TIT2 : tags.TIT2;
  return null;
}
function id3(b) {
  const out = {};
  const ss = (i) => ((b[i] & 127) << 21) | ((b[i + 1] & 127) << 14) | ((b[i + 2] & 127) << 7) | (b[i + 3] & 127);
  let i = 0;
  while (i + 10 < b.length && b[i] === 0x49 && b[i + 1] === 0x44 && b[i + 2] === 0x33) {
    const ver = b[i + 3], end = i + 10 + ss(i + 6);
    let p = i + 10;
    while (p + 10 <= Math.min(end, b.length)) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      const fs = ver === 4 ? ss(p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
      if (!/^[A-Z0-9]{4}$/.test(id) || !fs) break;
      if (id === 'TIT2' || id === 'TPE1') out[id] = texto(b.subarray(p + 10, p + 10 + fs));
      p += 10 + fs;
    }
    i = end;
  }
  return out;
}
function texto(d) {
  const enc = d[0], body = d.subarray(1);
  const dec = enc === 0 ? 'iso-8859-1' : enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
  return new TextDecoder(dec).decode(body).replace(/\0/g, '').trim();
}

/* ---------- letra (LRCLIB) ---------- */
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function letra(artista, musica) {
  artista = artista.trim(); musica = musica.trim();
  if (!artista || !musica) return { plain: null };
  const t = timed(8000);
  try {
    const q = new URLSearchParams({ artist_name: artista, track_name: musica });
    const r = await fetch('https://lrclib.net/api/search?' + q, { headers: { 'User-Agent': UA }, signal: t.signal });
    if (!r.ok) return { plain: null };
    const lista = await r.json();
    const a = norm(artista), m = norm(musica);
    const boas = (Array.isArray(lista) ? lista : []).filter(x => x && (x.plainLyrics || x.instrumental));
    const melhor = boas.find(x => norm(x.artistName || '').includes(a) && norm(x.trackName || '') === m)
      || boas.find(x => norm(x.artistName || '').includes(a) || a.includes(norm(x.artistName || '')))
      || null;
    if (!melhor) return { plain: null };
    return { plain: melhor.plainLyrics || '', instrumental: !!melhor.instrumental, fonte: 'LRCLIB' };
  } catch (e) { return { plain: null }; } finally { t.done(); }
}
