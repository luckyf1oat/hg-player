// 黄果漫剧 第三方播放器 - CF Workers 完整版
// 功能: 无广告 + 解锁VIP + 收藏/观看历史(KV) + HLS 播放
const UPSTREAM = "https://ai.cuct.ccwu.cc";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) return handleAPI(request, url, env);
    if (path === "/proxy-stream") return handleProxyStream(request, url);
    if (path === "/img") return proxyImage(url);
    return handlePage(url);
  }
};

// ============ API ============
async function handleAPI(request, url, env) {
  const path = url.pathname;
  const deviceId = getDeviceId(request, env);

  // 内容转发(cover 统一改走本 worker 图片代理)
  if (path === "/api/home") return proxyUpstreamWithRewrite(url, "/proxy/api/app/home");
  if (path === "/api/filter") return proxyUpstreamWithRewrite(url, "/proxy/api/app/filter");
  // 搜索: 上游只接受 q 参数(2026-09-02 实测 keyword 被忽略返回空)
  if (path === "/api/search") {
    const kw = url.searchParams.get("keyword") || url.searchParams.get("q") || "";
    url.searchParams.delete("keyword");
    url.searchParams.set("q", kw);
    return proxyUpstreamWithRewrite(url, "/proxy/api/app/search");
  }
  if (path === "/api/categories") return proxyUpstreamWithRewrite(url, "/proxy/api/app/categories");
  if (path === "/api/drama") {
    const id = url.searchParams.get("id");
    const d1 = await (await proxyUpstreamRaw(`/proxy/api/app/dramas/${id}`)).json();
    const d2 = await (await proxyUpstreamRaw(`/proxy/api/app/dramas/${id}/episodes`)).json();
    d1.episodes = d2.list || [];
    if (d1.cover) d1.cover = "/img?url=" + encodeURIComponent(d1.cover);
    (d1.related || []).forEach(r => { if (r.cover) r.cover = "/img?url=" + encodeURIComponent(r.cover); });
    return json(d1);
  }
  if (path === "/api/stream") {
    const drama = url.searchParams.get("drama");
    const ep = url.searchParams.get("ep");
    const epId = url.searchParams.get("epId");
    // 强制 vip=1 解锁所有剧集(vip=0 会被原站拒绝返回 no_anchor)
    const r = await fetch(`${UPSTREAM}/resolve/${epId}?drama=${drama}&ep=${ep}&vip=1`, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": UPSTREAM },
    });
    const d = await r.json();
    // 流走本 worker 代理(全站资源代理)
    if (d.stream && d.stream.startsWith("/")) {
      const abs = UPSTREAM + d.stream;
      d.stream = "/proxy-stream?url=" + encodeURIComponent(abs);
    }
    return json(d);
  }

  // 流代理:转发 m3u8/ts,改写 m3u8 相对路径,全 CORS
  if (path === "/proxy-stream") {
    return handleProxyStream(request, url);
  }

  // 下载:HLS → MP4 合并(流式)
  if (path === "/api/download") {
    const drama = url.searchParams.get("drama");
    const ep = url.searchParams.get("ep");
    const epId = url.searchParams.get("epId");
    const title = url.searchParams.get("title") || "episode";
    try {
      const r = await fetch(`${UPSTREAM}/resolve/${epId}?drama=${drama}&ep=${ep}&vip=1`, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": UPSTREAM },
      });
      const d = await r.json();
      if (!d.stream) return json({ error: "no source", verified: d.verified }, 404);
      const streamUrl = d.stream.startsWith("/") ? UPSTREAM + d.stream : d.stream;

      // 拉 m3u8
      const m3u8Res = await fetch(streamUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": UPSTREAM },
      });
      const m3u8Text = await m3u8Res.text();
      const base = new URL(streamUrl);
      const baseDir = base.pathname.substring(0, base.pathname.lastIndexOf("/") + 1);

      // 解析所有 ts 分片 URL
      const segments = m3u8Text.split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"))
        .map(line => {
          if (line.startsWith("http")) return line;
          if (line.startsWith("/")) return base.origin + line;
          return base.origin + baseDir + line;
        });
      if (segments.length === 0) return json({ error: "no segments" }, 404);

      // 流式合并:拉每个 ts 并拼接返回
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for (const seg of segments) {
              const segRes = await fetch(seg, {
                headers: { "User-Agent": "Mozilla/5.0", "Referer": UPSTREAM },
              });
              if (segRes.ok) {
                const buf = await segRes.arrayBuffer();
                controller.enqueue(new Uint8Array(buf));
              }
            }
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "video/mp2t",
          "Content-Disposition": `attachment; filename="${safeTitle}_EP${ep}.mp4"`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // 收藏
  if (path === "/api/favs") {
    const key = `favs:${deviceId}`;
    if (request.method === "GET") return json({ list: JSON.parse(await env.KV.get(key) || "[]") });
    const body = await request.json();
    let list = JSON.parse(await env.KV.get(key) || "[]");
    if (request.method === "POST") {
      if (!list.find(x => x.id === body.id)) list.unshift(body);
      list = list.slice(0, 200);
      await env.KV.put(key, JSON.stringify(list));
      return json({ ok: true, list });
    }
    if (request.method === "DELETE") {
      list = list.filter(x => x.id !== body.id);
      await env.KV.put(key, JSON.stringify(list));
      return json({ ok: true, list });
    }
  }

  // 观看历史
  if (path === "/api/history") {
    const key = `hist:${deviceId}`;
    if (request.method === "GET") return json({ list: JSON.parse(await env.KV.get(key) || "[]") });
    if (request.method === "POST") {
      const body = await request.json();
      let list = JSON.parse(await env.KV.get(key) || "[]");
      list = list.filter(x => !(x.id === body.id && x.ep === body.ep));
      list.unshift({ ...body, t: Date.now() });
      list = list.sort((a, b) => b.t - a.t).slice(0, 100);
      await env.KV.put(key, JSON.stringify(list));
      return json({ ok: true, list });
    }
  }

  return json({ error: "not found" }, 404);
}

// 转发上游并改写 cover 为 worker 图片代理
async function proxyUpstreamWithRewrite(url, upstreamPath) {
  const u = new URL(UPSTREAM + upstreamPath);
  u.search = url.search;
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Referer": UPSTREAM } });
  try {
    const d = await r.json();
    const rewrite = (item) => {
      if (!item) return;
      if (item.cover) item.cover = "/img?url=" + encodeURIComponent(item.cover);
      if (item.latest) item.latest.forEach(rewrite);
      if (item.list) item.list.forEach(rewrite);
    };
    rewrite(d);
    return json(d);
  } catch (e) {
    return new Response(r.body, {
      status: r.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

async function proxyUpstream(url, upstreamPath) {
  const u = new URL(UPSTREAM + upstreamPath);
  u.search = url.search;
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Referer": UPSTREAM } });
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function proxyUpstreamRaw(upstreamPath) {
  const u = new URL(UPSTREAM + upstreamPath);
  return fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Referer": UPSTREAM } });
}

// 流代理:转发 m3u8/ts,改写 m3u8 相对路径,全 CORS
async function handleProxyStream(request, url) {
  const target = url.searchParams.get("url") || "";
  if (!target.startsWith("http")) return new Response("bad url", { status: 400 });
  const r = await fetch(target, {
    headers: { "User-Agent": "Mozilla/5.0", "Referer": UPSTREAM },
  });
  const ct = r.headers.get("Content-Type") || "";
  // m3u8:改写分片路径为 worker 代理
  if (ct.includes("mpegurl")) {
    const text = await r.text();
    const base = new URL(target);
    const baseDir = base.pathname.substring(0, base.pathname.lastIndexOf("/") + 1);
    const body = text.split("\n").map(line => {
      if (line.startsWith("#") || line.trim() === "") return line;
      if (line.startsWith("http")) return "/proxy-stream?url=" + encodeURIComponent(line);
      if (line.startsWith("/")) return "/proxy-stream?url=" + encodeURIComponent(base.origin + line);
      // 纯相对路径:基于 m3u8 的目录
      return "/proxy-stream?url=" + encodeURIComponent(base.origin + baseDir + line);
    }).join("\n");
    return new Response(body, {
      status: r.status,
      headers: { "Content-Type": ct, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" },
    });
  }
  // ts 分片/其他:直接转发
  return new Response(r.body, {
    status: r.status,
    headers: {
      "Content-Type": ct,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function proxyImage(url) {
  let target = url.searchParams.get("url") || "";
  // 相对路径 cover(如 uploads/...) 走官方 img 代理解析(官方能取到内部存储图)
  if (target && !target.startsWith("http")) {
    const r = await fetch(`https://ai.cuct.ccwu.cc/img?url=${encodeURIComponent(target)}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://ai.cuct.ccwu.cc/" },
    });
    return new Response(r.body, {
      status: r.status,
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  if (!target.startsWith("http")) return new Response("bad url", { status: 400 });
  const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" } });
  return new Response(r.body, {
    status: r.status,
    headers: {
      "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function getDeviceId(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/hg_dev=([a-f0-9-]+)/);
  if (m) return m[1];
  // 生成新 device_id 并通过 cookie 下发(简化:用 IP hash 代替)
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  let hash = 0;
  for (const ch of ip) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return "d" + hash.toString(16);
}

// ============ 页面 ============
function handlePage(url) {
  const path = url.pathname;
  let html = PAGE_HTML;
  if (path.startsWith("/drama/")) {
    const id = path.split("/")[2];
    html = html.replace("<!--APP-->", `<div id="app" data-page="drama" data-id="${id}"></div>`);
  } else if (path.startsWith("/player/")) {
    const parts = path.split("/");
    const epId = url.searchParams.get("epId") || "";
    html = html.replace("<!--APP-->", `<div id="app" data-page="player" data-drama="${parts[2]}" data-ep="${parts[3]}" data-epid="${epId}"></div>`);
  } else {
    html = html.replace("<!--APP-->", `<div id="app" data-page="home"></div>`);
  }
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// 页面 HTML(首页 + 详情 + 播放器)
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#14151A">
<title>漫剧影院</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13"></script>
<style>
:root{--gold:#E0AE36;--bg:#14151A;--bg2:#1E1F26;--card:#26272E;--txt:#EDEDEA;--sub:#9A9AA3}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--txt);font-family:system-ui,sans-serif}
header{position:sticky;top:0;z-index:10;background:rgba(20,21,26,.96);backdrop-filter:blur(8px);padding:10px 16px;display:flex;gap:12px;align-items:center;border-bottom:1px solid #2a2b33}
header h1{font-size:17px;color:var(--gold);cursor:pointer;white-space:nowrap}
header input{background:var(--bg2);border:1px solid #33343d;color:var(--txt);padding:8px 14px;border-radius:8px;flex:1;max-width:420px;outline:none;font-size:15px;min-width:0}
main{max-width:1400px;margin:0 auto;padding:14px 16px}
.tabs{display:flex;gap:8px;margin-bottom:12px;overflow-x:auto;scrollbar-width:none}
.tabs button{background:var(--bg2);border:1px solid #33343d;color:var(--txt);padding:7px 16px;border-radius:20px;cursor:pointer;font-size:13px;white-space:nowrap}
.tabs button.on{background:var(--gold);color:#14151a;border-color:var(--gold);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.card{background:var(--card);border-radius:10px;overflow:hidden;cursor:pointer;transition:transform .15s;position:relative}
.card:active{transform:scale(.97)}
.card img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:#000}
.card .info{padding:8px 10px}
.card .t{font-size:13px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .s{display:flex;justify-content:space-between;color:var(--sub);font-size:11px;margin-top:4px}
.badge{position:absolute;top:6px;left:6px;background:rgba(224,174,54,.92);color:#14151a;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px}
#moreBtn{display:none;margin:20px auto;background:var(--bg2);border:1px solid #33343d;color:var(--txt);padding:10px 32px;border-radius:20px;cursor:pointer;font-size:14px}
.empty{text-align:center;color:var(--sub);padding:60px 0;font-size:14px}
.detail{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.detail img{width:160px;border-radius:10px;aspect-ratio:3/4;object-fit:cover}
.detail .meta{flex:1;min-width:200px}
.detail h2{font-size:20px;margin-bottom:8px}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.tag{background:var(--bg2);border:1px solid #33343d;padding:3px 10px;border-radius:12px;font-size:12px;color:var(--sub)}
.btn{background:var(--gold);color:#14151a;border:none;padding:9px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:10px}
.btn.off{background:var(--bg2);color:var(--sub)}
.eps{display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:8px}
.eps button{background:var(--bg2);border:1px solid #33343d;color:var(--txt);padding:8px 0;border-radius:8px;cursor:pointer;font-size:13px}
.eps button.on{background:var(--gold);color:#14151a;border-color:var(--gold)}
.eps button.lock{color:var(--gold)}
.player-wrap{max-width:900px;margin:0 auto}
video{width:100%;border-radius:10px;background:#000;max-height:60vh}
.pnote{color:var(--sub);font-size:12px;text-align:center;padding:8px 0}
.back{background:none;border:none;color:var(--gold);font-size:14px;cursor:pointer;margin-bottom:12px;padding:4px 0}
.hist-item{display:flex;gap:10px;background:var(--card);border-radius:8px;padding:8px;margin-bottom:8px;cursor:pointer;align-items:center}
.hist-item img{width:48px;height:64px;object-fit:cover;border-radius:6px}
.hist-item .t{font-size:13px}
.hist-item .e{font-size:11px;color:var(--sub);margin-top:2px}
.hist-item .x{margin-left:auto;color:var(--sub);font-size:18px;padding:0 8px}
</style>
</head>
<body>
<header>
  <h1 onclick="location='/'">漫剧影院</h1>
  <input id="q" placeholder="搜索剧集…">
</header>
<main id="main"><!--APP--></main>
<script>
const $=id=>document.getElementById(id);
const app=$('app');
async function api(p,opt){const r=await fetch('/api/'+p,opt);if(!r.ok)throw new Error('api '+r.status);return r.json()}
function esc(s){return (s||'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}

let page=1, cat=0, q='', busy=false, hasMore=false, dramas=[], cats=[];

async function load(reset=true){
  if(busy)return; busy=true;
  if(reset){page=1;dramas=[]}
  const pp='page='+page+'&pageSize=30';
  let list=[];
  try{
    if(q){const d=await api('search?q='+encodeURIComponent(q)+'&'+pp);list=d.list||[];hasMore=!!d.hasMore}
    else if(cat){const d=await api('filter?category_id='+cat+'&'+pp);list=d.list||[];hasMore=!!d.hasMore}
    else{const d=await api('home?'+pp);list=d.latest||[];hasMore=!!d.hasMore}
    if(reset)dramas=list;else dramas.push(...list);
    renderGrid();
  }catch(e){$('main').innerHTML='<div class="empty">加载失败</div>'}
  busy=false;
}
function renderGrid(){
  $('main').innerHTML='<div class="tabs" id="tabs"></div><div class="grid" id="grid"></div><button id="moreBtn">加载更多</button>';
  $('tabs').innerHTML='<button class="'+(cat===0?'on':'')+'" onclick="setCat(0)">最新</button>'+
    cats.map(c=>'<button class="'+(cat===c.id?'on':'')+'" onclick="setCat('+c.id+')">'+esc(c.name)+'</button>').join('')+
    '<button onclick="showFavs()">★收藏</button><button onclick="showHist()">历史</button>';
  $('grid').innerHTML=dramas.map(d=>'<div class="card" onclick="openDrama('+d.id+')">'+(d.badge?'<span class="badge">'+esc(d.badge)+'</span>':'')+'<img loading="lazy" src="'+esc(d.cover||'')+'" onerror="this.style.visibility=&#39;hidden&#39;"><div class="info"><div class="t">'+esc(d.title)+'</div><div class="s"><span>'+(d.episode_count||0)+'集</span><span>🔥'+(d.heat||0)+'</span></div></div></div>').join('')||'<div class="empty">无结果</div>';
  $('moreBtn').onclick=()=>{page++;load(false)};
  $('moreBtn').style.display=hasMore?'block':'none';
}
function setCat(c){cat=c;load(true)}

async function openDrama(id){
  const d=await api('drama?id='+id);
  const favs=await api('favs');
  const faved=favs.list.some(f=>f.id===id);
  window._d=d;
  $('main').innerHTML='<button class="back" onclick="location=&#39;/&#39;">← 返回</button>'+
  '<div class="detail"><img src="'+esc(d.cover||'')+'" onerror="this.style.visibility=&#39;hidden&#39;"><div class="meta">'+
  '<h2>'+esc(d.title)+'</h2><div class="tags">'+
  (d.category?'<span class="tag">'+esc(d.category.name)+'</span>':'')+
  (d.status_text?'<span class="tag">'+esc(d.status_text)+'</span>':'')+
  (d.lang?'<span class="tag">'+esc(d.lang)+'</span>':'')+
  (d.year?'<span class="tag">'+esc(d.year)+'</span>':'')+
  '<span class="tag">'+(d.free_episodes||0)+'/'+(d.episode_count||0)+'集·全解锁</span>'+
  '</div><button class="btn '+(faved?'off':'')+'" id="favBtn" onclick="toggleFav()">'+(faved?'★ 已收藏':'☆ 收藏')+'</button></div></div>'+
  '<h3 style="margin-bottom:10px;font-size:15px">选集</h3><div class="eps" id="eps"></div>';
  $('eps').innerHTML=(d.episodes||[]).map(e=>'<button onclick="play('+d.id+','+e.ep+','+e.id+')">'+String(e.ep).padStart(2,'0')+'</button>').join('');
}
async function toggleFav(){
  const d=window._d, btn=$('favBtn');
  if(btn.classList.contains('off')){
    await api('favs',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:d.id})});
    btn.textContent='☆ 收藏';btn.classList.remove('off');
  }else{
    await api('favs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:d.id,title:d.title,cover:d.cover,episode_count:d.episode_count})});
    btn.textContent='★ 已收藏';btn.classList.add('off');
  }
}
function play(dramaId,ep,epId){location='/player/'+dramaId+'/'+ep+'?epId='+epId}

async function showFavs(){
  const d=await api('favs');
  $('main').innerHTML='<button class="back" onclick="location=&#39;/&#39;">← 返回</button><h3 style="margin-bottom:12px">我的收藏</h3>'+
  (d.list.length?d.list.map(f=>'<div class="hist-item" onclick="openDrama('+f.id+')"><img src="'+esc(f.cover||'')+'"><div><div class="t">'+esc(f.title)+'</div><div class="e">'+(f.episode_count||0)+'集</div></div><span class="x" onclick="event.stopPropagation();delFav('+f.id+')">×</span></div>').join(''):'<div class="empty">暂无收藏</div>');
}
async function delFav(id){await api('favs',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});showFavs()}
async function showHist(){
  const d=await api('history');
  $('main').innerHTML='<button class="back" onclick="location=&#39;/&#39;">← 返回</button><h3 style="margin-bottom:12px">观看历史</h3>'+
  (d.list.length?d.list.map(h=>'<div class="hist-item" onclick="play('+h.id+','+h.ep+','+h.epId+')"><img src="'+esc(h.cover||'')+'"><div><div class="t">'+esc(h.title)+'</div><div class="e">第'+h.ep+'集</div></div></div>').join(''):'<div class="empty">暂无历史</div>');
}

$('q').addEventListener('input',e=>{clearTimeout(window._qt);window._qt=setTimeout(()=>{q=e.target.value.trim();load(true)},500)});

// 初始化:分类 + 首页加载
(async()=>{
  try{const d=await api('categories');cats=d.list||[]}catch(e){}
  if(app.dataset.page==='home')load(true);
  if(app.dataset.page==='drama')openDrama(app.dataset.id);
})();

// 播放器页
if(app.dataset.page==='player'){
  const drama=app.dataset.drama, ep=app.dataset.ep, epId=app.dataset.epid;
  $('main').innerHTML='<button class="back" onclick="history.back()">← 返回</button><div class="player-wrap"><video id="v" controls autoplay></video><div class="pnote" id="pnote">解析中…</div><button class="btn" id="dlBtn" style="width:100%;margin-top:10px" onclick="downloadEp()">⬇ 下载本集</button></div>';
  window._epInfo={drama,ep,epId};
  (async()=>{
    try{
      const d=await api('stream?drama='+drama+'&ep='+ep+'&epId='+epId);
      if(!d.stream){$('pnote').textContent='无法解析';return}
      const v=$('v');
      if(Hls.isSupported()){const hls=new Hls();hls.loadSource(d.stream);hls.attachMedia(v)}
      else if(v.canPlayType('application/vnd.apple.mpegurl'))v.src=d.stream;
      $('pnote').textContent='第'+ep+'集';
      // 记录历史
      const dd=await api('drama?id='+drama);
      await api('history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:Number(drama),ep:Number(ep),epId:Number(epId),title:dd.title,cover:dd.cover})});
      window._epInfo.title=dd.title;
    }catch(e){$('pnote').textContent='加载失败:'+e.message}
  })();
}
function downloadEp(){
  const info=window._epInfo||{};
  const btn=$('dlBtn');
  btn.textContent='准备下载中…';btn.disabled=true;
  // 用 fetch 拉取合并流(流式下载到本地)
  const url='/api/download?drama='+info.drama+'&ep='+info.ep+'&epId='+info.epId+'&title='+encodeURIComponent(info.title||'episode');
  const a=document.createElement('a');
  a.href=url;
  a.download=(info.title||'episode')+'_EP'+info.ep+'.mp4';
  document.body.appendChild(a);
  a.click();
  a.remove();
  btn.textContent='⬇ 下载本集';btn.disabled=false;
}
</script>
</body>
</html>`;
