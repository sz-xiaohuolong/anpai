# 部署说明

- 部署平台：Cloudflare Workers + Durable Objects
- 账户：`szxiaohuolong@gmail.com`（Account ID `43c6be0217dc7e0e3c8fc0eaf4a90ef2`）
- workers.dev 子域：`xiaohuolong`
- 线上地址：`https://anpai.xiaohuolong.workers.dev`
- 首次部署：2026-10-18 11:49 UTC，版本 `caa76cec-d886-48d2-b66b-5e228672dfcd`
- 最近更新：2026-10-18 21:17 (UTC+8)，版本 `32b1f2f0-50c3-487a-b477-58fe21fa2a79`
  （部署 `070a94fd-c374-4972-8339-b524e48829c1`；含机器人均衡策略重写。已核实线上 JS 与本地 `dist` 逐字节一致）

## 当前状态：部署成功，但中国大陆网络不可达

**这不是部署问题，是网络封锁问题。** 2026-10-18 实测：

| 视角 | 结果 | 说明 |
|---|---|---|
| 墙外（r.jina.ai 抓取） | ✅ 200，正常渲染首页 | 部署本身是健康的 |
| 本机 DNS 解析 | ❌ `31.13.95.17` | Meta 的地址段，典型 DNS 投毒 |
| 本机强制真实 IP（`--resolve`） | ❌ exit 35（SSL 连接失败） | 绕开 DNS 仍失败 → **SNI 阻断** |
| TCP 到 Cloudflare anycast IP | ✅ 可连 | 说明 IP 没被封，封的是域名 |

`workers.dev` 整个域被污染（`workers.dev` 本身解析到 `199.59.150.40`，Twitter 的旧地址段）。

**结论：Cloudflare 的 IP 可达，`*.workers.dev` 域名不可达。** 这意味着换一个干净的域名就能通。

## 方案一：绑定自定义域名（推荐，公网可玩）

Cloudflare 的 IP 是通的，被拦的是 `workers.dev` 这个主机名。换一个没被拦的域名指向同一个 Worker 即可。

**步骤：**

1. 买一个域名（`.com` 约 ¥70/年；`.top` / `.xyz` 首年更便宜）。**优先 `.com`**，某些廉价后缀更容易被拦。
2. 在 Cloudflare 控制台「添加站点」，把域名的 NS 改成 Cloudflare 给的两个地址（在域名注册商那里改）。
3. 等 NS 生效（通常几分钟到几小时）。
4. 用自定义域名绑定 Worker，二选一：
   - **控制台**：Workers & Pages → `anpai` → Settings → Domains & Routes → Add → Custom Domain，填 `anpai.你的域名`。
   - **配置文件**：在 `wrangler.toml` 加

     ```toml
     routes = [
       { pattern = "anpai.你的域名", custom_domain = true }
     ]
     ```

     然后重新部署。

**同一账户下的 Worker 代码不用改。** 客户端用的是 `location.origin`，同源即可，换域名不影响。

**未验证**：自定义域名在本网络下能否访问，需要有域名才能实测。按「IP 可达 + 域名被拦」的证据推断应该可以，但这是推断，不是验证。

## 方案二：局域网（今晚就能玩）

不经过公网，零成本。

```bash
# 终端 1：房间服务，绑定所有网卡
npx wrangler dev --port 8787 --ip 0.0.0.0

# 终端 2：前端，暴露到局域网
pnpm dev --host
```

然后让朋友用手机访问 `http://<你的局域网 IP>:5173`。Vite 会把 `/parties` 代理到本机的 8787。

**注意：** HTTP 下 `navigator.clipboard` 不可用（非安全上下文），「复制房间码」按钮会失效，只能手抄房间码。这是浏览器限制。

**未验证**：这条路径没有实测过。

## 重新部署

```bash
pnpm run deploy
```

**两个坑：**

1. **必须写 `pnpm run deploy`，不能写 `pnpm deploy`。** `pnpm deploy` 是 pnpm 的内置命令（工作区部署），会报 `ERR_PNPM_CANNOT_DEPLOY`。
2. **本机有代理时 wrangler 会失败。** 环境里有 `HTTP_PROXY=http://127.0.0.1:7890`，wrangler 的 Node fetch 走这个代理访问 `api.cloudflare.com` 会 `fetch failed`。绕过方式：

   ```bash
   env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY \
       -u https_proxy -u http_proxy -u all_proxy -u NODE_USE_ENV_PROXY \
       pnpm run deploy
   ```

**用 API Token 部署（2026-10-18 实测）**：本机 `wrangler login` 的 OAuth 令牌会过期，且非交互环境无法刷新。改用 Token：

```bash
# Token 只注入本命令，不要写进任何文件
env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY \
    -u https_proxy -u http_proxy -u all_proxy -u NODE_USE_ENV_PROXY \
    CLOUDFLARE_API_TOKEN=<Token> \
    CLOUDFLARE_ACCOUNT_ID=43c6be0217dc7e0e3c8fc0eaf4a90ef2 \
    pnpm run deploy
```

**Token 必须这么配（两个实测坑，错一个就部署失败）：**

1. **权限**：`Account → Workers Scripts → Edit`。只读 Token 会在「资产上传」阶段报
   `No access to the specified resource.`（没有单独的 Assets 权限组，就是 Workers Scripts: Edit）。
2. **作用域**：Account Resources 必须 **Include 本账户**（`Szxiaohuolong@gmail.com's Account`）。
   选错账户时 `GET /accounts` 返回空、wrangler 报「Failed to automatically retrieve account IDs」；
   此时显式设 `CLOUDFLARE_ACCOUNT_ID` 可跳过检测，但部署仍会因无权而失败。
   最快路径：用模板 **「Edit Cloudflare Workers」** 创建。
3. **Token 出现在对话记录里就算已泄露**：部署完在控制台删除或轮换。

**线上核实（本机被 SNI 阻断，用外部抓取）**：

```bash
curl -s -H "X-Return-Format: html" "https://r.jina.ai/https://anpai.xiaohuolong.workers.dev/"
# 与本地 dist 比对资源 hash；再抓 JS 比对内容：
curl -s "https://r.jina.ai/https://anpai.xiaohuolong.workers.dev/assets/<js名>"
```

## 其他备忘

- **首次部署必须先注册 workers.dev 子域**，否则非交互模式会直接失败。本账户已注册为 `xiaohuolong`。
- **证书不是立刻生效的。** 新子域第一次访问可能报 `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`，等 1–2 分钟即可。
- **Durable Object 迁移标签是 `v1`。** 以后改 DO 类名或新增类时，必须追加新的迁移标签，不能改旧的。
- **免费额度**：10 万请求/天、13,000 GB-s/天。朋友局的实际用量是零头。
