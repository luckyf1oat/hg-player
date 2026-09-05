# 漫剧影院 (hg-player)

基于 CF Workers + KV 的第三方漫剧播放器,数据源为黄果漫剧公开 API。

**在线地址**: https://hg.115567.xyz

## ✨ 功能

- 🎞️ 首页 / 分类 / 搜索 / 剧集详情
- 🔓 **全 VIP 解锁** — 强制 vip=1 绕过付费校验,付费剧集直接播放
- 🚫 **无广告** — 不加载原站广告位(博彩广告等)
- ⭐ **收藏** — KV 持久化,自动记忆设备
- 📜 **观看历史** — 自动记录播放进度
- ⬇️ **下载本集** — 播放器页一键下载 HLS 合并为 MP4
- 🛡️ **全站资源走代理** — API/图片/视频流均经 Worker 转发,隐藏原站

## 🏗️ 架构

```
用户浏览器
   ↓
hg.115567.xyz (CF Workers + KV)
   ├── /api/home|filter|search|categories  内容 API 转发(cover 改写走代理)
   ├── /api/drama?id=                     详情 + 剧集列表
   ├── /api/stream?drama&ep&epId          播放地址解析(强制 vip=1 解锁)
   ├── /api/download?drama&ep&epId        下载:HLS ts 合并流式返回
   ├── /api/favs (GET/POST/DELETE)        收藏(KV)
   ├── /api/history (GET/POST)            观看历史(KV)
   ├── /img?url=                          图片代理
   └── /proxy-stream?url=                 视频流代理(m3u8 分片改写)
   ↓
ai.cuct.ccwu.cc (上游数据源)
```

## 📁 文件结构

```
├── worker.js          # 主程序(单文件,含 Worker + 前端页面)
├── wrangler.toml      # Cloudflare 部署配置(含 KV + CPU 限制)
└── README.md          # 本文档
```

## 🚀 部署

### 前置

- Node.js + wrangler(`npx wrangler`)
- Cloudflare 账号(需有 KV 权限)

### 步骤

1. **创建 KV 命名空间**

```bash
npx wrangler kv namespace create hg-player-kv
```

2. **编辑 `wrangler.toml`**,填入 KV 命名空间 ID:

```toml
name = "hg-player"
main = "worker.js"
compatibility_date = "2024-09-01"

[[kv_namespaces]]
binding = "KV"
id = "你的-KV-命名空间-ID"

[limits]
cpu_ms = 300000
```

3. **部署**

```bash
npx wrangler deploy
```

4. **(可选)绑定自定义域名**

```bash
# 添加 DNS 记录(CNAME 到你的 worker 子域)
# 然后在 Cloudflare 控制台 Workers → 路由 添加:
# hg.example.com/* → hg-player
```

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `UPSTREAM` | 上游 API 地址 | `https://ai.cuct.ccwu.cc` |

如需切换数据源,修改 `worker.js` 顶部的 `UPSTREAM` 常量后重新部署。

## 🔧 配置说明

### CPU 限制

`wrangler.toml` 中 `[limits] cpu_ms = 300000`(5 分钟 CPU 配额,订阅版生效)。默认免费版上限为 10ms/请求,若下载长剧集超时,需确保账号为 Workers Paid/Subscription 计划。

### 前端页面

整个前端(HTML/CSS/JS)内嵌在 `worker.js` 的 `PAGE_HTML` 常量中,单文件免构建。

### 主要 API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/home?page=&pageSize=` | GET | 首页最新剧集 |
| `/api/filter?category_id=&page=` | GET | 分类筛选 |
| `/api/search?q=&page=` | GET | 搜索(注意:上游只接受 `q` 参数,`keyword` 会被忽略返回空) |
| `/api/categories` | GET | 分类列表 |
| `/api/drama?id=` | GET | 详情+剧集 |
| `/api/stream?drama=&ep=&epId=` | GET | 播放地址(vip=1) |
| `/api/download?drama=&ep=&epId=&title=` | GET | 下载整集 |
| `/api/favs` | GET/POST/DELETE | 收藏 |
| `/api/history` | GET/POST | 观看历史 |

## ⚠️ 已知限制

- **长视频下载超时**:CF Workers 单请求 CPU 限制 300s(需订阅计划),超长剧集仍可能超时;已配置 `cpu_ms=300000` 最大化配额
- **上游依赖**:数据源为第三方公开 API,无鉴权,可能随时失效或更换域名
- **内容合规**:数据源含成人内容,部署使用请自行评估合规风险
- **付费解锁原理**:原站 resolve 接口仅前端校验 vip 参数,后端不鉴权,强制 `vip=1` 即可获取流地址

## 📝 更新日志

### v1.1 (2026-09-02)
- 🔧 CPU 限制调整为 `300000ms`(wrangler.toml 加 `[limits] cpu_ms`)
- 🔍 搜索参数修复:上游实测只接受 `q` 参数(`keyword` 返回空),已改用 `q`
- 📄 文档更新(CPU 配额说明、搜索参数说明)

### v1.0 (2026-09-01)
- 首个版本:播放 + VIP 解锁 + 收藏 + 历史 + 下载 + 全站代理
