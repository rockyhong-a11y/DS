'use strict';
const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── data ──────────────────────────────────────────────────────────────────────
const devices     = JSON.parse(fs.readFileSync(path.join(__dirname,'data','devices.json'), 'utf8'));
const marketShare = JSON.parse(fs.readFileSync(path.join(__dirname,'data','market-share.json'), 'utf8'));

// ── Korean → English token map ───────────────────────────────────────────────
const KO_EN = {
  '삼성':'samsung','애플':'apple','구글':'google','화웨이':'huawei','샤오미':'xiaomi',
  '원플러스':'oneplus','소니':'sony','모토로라':'motorola','에이수스':'asus','노키아':'nokia',
  '오포':'oppo','비보':'vivo','리얼미':'realme','페어폰':'fairphone',
  '갤럭시':'galaxy','아이폰':'iphone','픽셀':'pixel','노트':'note',
  '울트라':'ultra','프로':'pro','맥스':'max','플러스':'plus','미니':'mini',
  '폴드':'fold','플립':'flip','엣지':'edge','윙':'wing','벨벳':'velvet',
  '스냅드래곤':'snapdragon','엑시노스':'exynos','텐서':'tensor','다이멘시티':'dimensity','키린':'kirin',
  '안드로이드':'android','아이오에스':'ios','원유아이':'one ui','옥시젠':'oxygenos','미유아이':'miui',
  '폴더블':'foldable','접이식':'foldable','5지':'5g','4지':'4g',
};
function koToEn(str) {
  let s = str.toLowerCase();
  for (const [k,v] of Object.entries(KO_EN)) s = s.replaceAll(k, v);
  return s;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function matchQuery(d, raw) {
  if (!raw) return true;
  const q   = koToEn(raw);
  const hay = `${d.brand} ${d.brandKo} ${d.name} ${d.chip} ${d.ux} ${d.os}`.toLowerCase();
  const hayEn = koToEn(hay);
  return hayEn.includes(q) || hay.includes(raw.toLowerCase());
}

// ── routes ────────────────────────────────────────────────────────────────────
app.get('/api/brands', (_req, res) => {
  const brands = [...new Set(devices.map(d => d.brand))].sort();
  res.json(brands);
});

app.get('/api/search', (req, res) => {
  const { q='', brand='', year='', os='', sort='year', page='1', limit='60' } = req.query;
  let list = devices.filter(d => {
    if (brand && d.brand !== brand)               return false;
    if (year  && d.year !== +year)                return false;
    if (os    && !d.os.toLowerCase().includes(os.toLowerCase())) return false;
    return matchQuery(d, q);
  });

  if (sort==='year')    list.sort((a,b)=>b.year-a.year||a.name.localeCompare(b.name));
  else if (sort==='name')    list.sort((a,b)=>a.name.localeCompare(b.name));
  else if (sort==='display') list.sort((a,b)=>b.disp.inch-a.disp.inch);
  else if (sort==='ppi')     list.sort((a,b)=>b.disp.ppi-a.disp.ppi);
  else if (sort==='antutu')  list.sort((a,b)=>(b.bench?.antutu||0)-(a.bench?.antutu||0));

  const p   = Math.max(1, +page);
  const lim = Math.min(120, Math.max(1, +limit));
  const total = list.length;
  const slice = list.slice((p-1)*lim, p*lim);
  res.json({ total, page: p, limit: lim, devices: slice });
});

app.get('/api/device/:id', (req, res) => {
  const d = devices.find(x => x.id === +req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(d);
});

// namu.wiki proxy – scrape info for a device title
app.get('/api/namu', async (req, res) => {
  const encodedTitle = encodeURIComponent(req.query.title || '');
  const url = `https://namu.wiki/w/${encodedTitle}`;
  try {
    const { data: html } = await axios.get(url, {
      timeout: 14000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Referer': 'https://namu.wiki/',
      },
    });
    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim()
      || $('meta[property="og:title"]').attr('content')
      || '';

    const img = $('.wiki-image img, figure img').first().attr('src') || '';

    const sections = [];
    $('table').each((_, tbl) => {
      const rows = [];
      $(tbl).find('tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length >= 2) {
          const key = $(tds[0]).text().trim().replace(/\s+/g, ' ');
          const val = $(tds[1]).text().trim().replace(/\s+/g, ' ');
          if (key && val && key.length < 60) rows.push({ key, val });
        }
      });
      if (rows.length >= 3) sections.push({ title: '', rows });
    });

    res.json({ ok: true, title, img, url, sections });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message, url });
  }
});

// namu.wiki search proxy
app.get('/api/namu-search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, items: [] });

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    'Referer': 'https://namu.wiki/',
  };

  // 1순위: 나무위키 자동완성 API (JSON 직접 반환)
  try {
    const r = await axios.get(`https://namu.wiki/api/autocomplete?query=${encodeURIComponent(q)}`, {
      timeout: 8000, headers: { ...HEADERS, 'Accept': 'application/json' }
    });
    if (r.data && Array.isArray(r.data)) {
      const items = r.data.slice(0, 20).map(t => ({
        name: String(t), slug: '/w/' + encodeURIComponent(String(t)), sub: ''
      })).filter(i => i.name);
      if (items.length) return res.json({ ok: true, items });
    }
  } catch(e) {}

  // 2순위: 검색 페이지 HTML → __NEXT_DATA__ JSON 파싱
  try {
    const { data: html } = await axios.get(
      `https://namu.wiki/Search?q=${encodeURIComponent(q)}`,
      { timeout: 12000, headers: HEADERS }
    );
    // Next.js 방식: __NEXT_DATA__ script 태그
    const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      const data = JSON.parse(m[1]);
      const raw = data?.props?.pageProps?.searchResult
        || data?.props?.pageProps?.searchResults
        || data?.props?.pageProps?.result
        || data?.props?.pageProps?.items
        || data?.props?.pageProps?.data;
      if (Array.isArray(raw) && raw.length) {
        const items = raw.slice(0, 20).map(item => {
          const t = item.title || item.name || item.key || String(item);
          return { name: t, slug: '/w/' + encodeURIComponent(t), sub: item.snippet || '' };
        }).filter(i => i.name.length > 1);
        if (items.length) return res.json({ ok: true, items });
      }
    }
    // 폴백: a[href^="/w/"] 링크 수집 (검색결과 영역만)
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();
    // 검색결과 컨테이너 우선 탐색
    $('[class*="search"] a[href^="/w/"], [class*="result"] a[href^="/w/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const name = $(a).text().trim().replace(/\s+/g, ' ');
      if (name && name.length > 1 && href && !seen.has(href)) {
        seen.add(href);
        items.push({ name, slug: href, sub: '' });
      }
    });
    if (items.length) return res.json({ ok: true, items });
    // 최후 폴백: 모든 /w/ 링크
    $('a[href^="/w/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const name = $(a).text().trim().replace(/\s+/g, ' ');
      if (name && name.length > 1 && href && !seen.has(href)) {
        seen.add(href);
        items.push({ name, slug: href, sub: '' });
      }
    });
    return res.json({ ok: true, items: items.slice(0, 20) });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message, items: [] });
  }
});

app.get('/api/market-share', (_req, res) => res.json(marketShare));

// serve static frontend
app.use(express.static(path.join(__dirname)));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname,'index.html')));

app.listen(PORT, () => console.log(`✅  http://localhost:${PORT}`));
