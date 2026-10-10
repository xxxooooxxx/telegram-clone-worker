# Protocol Bridge（协议号小服务）

给 Telegram Clone Worker 提供**协议号（MTProto 用户账号）克隆**能力的独立小服务：
Telethon + FastAPI。session 文件落在**本机** `data/` 目录，Worker 通过 HTTP 调用它，
Worker 本身不存任何协议号凭证。

## 部署目标

**ccs-us**（Debian 13，root）。连接方式（二选一）：

- Tailscale：`ssh root@100.117.245.64`
- 备用：`ssh root@ssh.lyrnox.com`（按已有别名/配置）

> 本服务只监听 `127.0.0.1`，不直接暴露公网。Worker 经 Tailscale/内网访问时，
> 如需远程访问请自行在 ccs-us 上做反代或 SSH 端口转发（见下）。

## 部署步骤

```bash
# 1. 连上 ccs-us
ssh root@100.117.245.64

# 2. 准备目录并拷代码（bridge/ 整个目录）
mkdir -p /root/tgclone-bridge
# 把本地 bridge/ 下的文件传上去，例如：
# scp -r bridge/* root@100.117.245.64:/root/tgclone-bridge/

cd /root/tgclone-bridge

# 3. 建 venv 并装依赖
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

# 4. 生成并设置 secret（Worker 和 bridge 两边必须一致）
SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
echo "$SECRET"   # 记下来，后面填到 Worker 的 Bridge 配置里

# 5. 安装 systemd 服务
sed -i "s/__SET_ME__/$SECRET/" bridge.service
cp bridge.service /etc/systemd/system/tgclone-bridge.service
systemctl daemon-reload
systemctl enable --now tgclone-bridge

# 6. 验证
curl 127.0.0.1:18787/healthz
# 期望 {"ok":true}
```

## Worker 侧配置

在 Worker 网页控制台 → **Protocol Accounts** 页面 → Bridge 配置区填：

- Bridge URL：`http://<bridge 主机可达地址>:18787`（Worker 跑在 Cloudflare，
  需填 bridge 对公可达的地址；如只监听 127.0.0.1，用反代/隧道暴露后再填）
- Bridge Secret：上面生成的 `$SECRET`

> 注意：Cloudflare Worker 必须能直接访问到这个 URL。如果 bridge 只想留在内网，
> 在 ccs-us 上用 cloudflared tunnel 或 nginx 反代暴露一个带鉴权的地址，
> 然后再把公网地址填进 Worker。`X-Bridge-Secret` 头是唯一的鉴权手段，
> 公网暴露前务必确认 secret 足够随机。

## 协议号登录流程（在 Worker 网页上完成）

1. Protocol Accounts 页 → 添加账号（备注名 + 手机号，格式如 `+8613800000000`）
2. 点 **Send code**，按提示填 `api_id` / `api_hash`（来自 https://my.telegram.org）
   → Telegram 会把验证码发到该号
3. 把收到的验证码填入 **Confirm**（开了两步验证再加填 password）
4. 状态变为 authorized 即可建协议号克隆任务

说明：

- `api_id` / `api_hash` 只在登录请求的 body 里透传，**不存 Worker 数据库**；
  bridge 只在自己本机的 `data/accounts.json`（0600 权限）里保留一份，
  用于重连时恢复 client。
- 发码请求的上下文保存在 bridge 内存，**bridge 重启后需重新发码**。
- 不用了就点 **Logout**：删 session 文件并断开，bridge 本机不留痕迹。

## 接口一览（全部 JSON，请求头带 `X-Bridge-Secret`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活探针（免鉴权） |
| GET | `/health` | `{ok, accounts:[{phone, authorized}]}` |
| POST | `/accounts/login/send-code` | `{phone, api_id, api_hash}` 发验证码 |
| POST | `/accounts/login/confirm` | `{phone, api_id, api_hash, code, password?}` 完成登录 |
| POST | `/accounts/logout` | `{phone}` 删 session |
| POST | `/resolve` | `{phone, chat}` → `{id, title, type, username?}`，chat 可为 @用户名/邀请链接/数字 id |
| POST | `/latest-id` | `{phone, chat}` → `{latest_id}` |
| POST | `/forward-batch` | `{phone, source, dest, ids[], drop_author?}` → `{copied[], failed[{id,error}]}`，每批最多 50 |
| POST | `/sync` | `{phone, chat, since_id, limit?}` → `{messages:[{id,date,text,media}]}` |
| POST | `/send-test` | `{phone, chat, text}` → `{message_id}` |

错误格式统一为 `{ok:false, error, message, retry_after?}`，
其中 `error` 取值：`unauthorized` / `rate_limited` / `not_found` / `invalid_request` /
`2fa_required` / `misconfigured` / `unknown`，Worker 侧按此分类处理。
