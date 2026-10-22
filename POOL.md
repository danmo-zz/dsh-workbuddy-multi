# dsh-workbuddy-multi（WorkBuddy Multi · 账号池版）

本目录是 **dsh-workbuddy-connect** 的本地二次开发版。原项目：https://github.com/corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）。

原版权与许可证完整保留，见 [LICENSE](LICENSE)、[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) 与 [NOTICE-fork.md](NOTICE-fork.md)。

## 功能

在原版「把 WorkBuddy 桌面 App 的模型接入 DSH」之上，增加了账号维度的能力：

| 功能 | 说明 |
|---|---|
| 多账号池 | `workbuddy-accounts/` 目录下每个 JSON 是一个账号登录态，启动时载入 |
| 额度耗尽自动切换 | 上游 402/429/401 时换号重试；只在响应尚未开始时切换 |
| 手动切换 | 面板每个账号带「切换」按钮，指定下一次请求的账号 |
| 浏览器添加账号 | 面板「添加账号」生成登录链接，登录后凭证自动落盘 |
| 每账号积分 | 各账号单独显示剩余积分 |
| Token 用量统计 | 输入/输出 Token、缓存命中、推理 Token、消耗积分、请求次数 |

## 账号池

```
<DSH home>/workbuddy-accounts/     # 或 $WORKBUDDY_ACCOUNTS_DIR
    a.json
    b.json
```

文件格式与 Hermes 的 `login_account.py` 一致：

```json
{ "auth": { "accessToken": "...", "refreshToken": "...", "expiresIn": 31536000, "domain": "www.workbuddy.ai" },
  "account": { "uid": "...", "nickname": "..." } }
```

`expiresIn`（剩余秒数）以文件 mtime 为基准推算绝对过期时间；也接受 `expiresAt`（毫秒）。

### 命令行

```bash
node lib/account-cli.js status     # 账号、有效期、冷却
node lib/account-cli.js check      # 逐个账号联网校验，不消耗积分
node lib/account-cli.js import <dir> --region global
node lib/account-cli.js path
```

### 切换规则

| 上游失败 | 冷却 | 是否换号 |
|---|---|---|
| `hard_credit`（402 额度耗尽） | 60 分钟 | 是 |
| `soft_rate`（429 限流） | 60 秒 | 是 |
| `session_dead`（401 登录失效） | 10 分钟 | 是 |
| `not_found` / `5xx` / `4xx` | 20 秒 | 否（与账号无关） |

- 换号只发生在**响应首字节写出之前**，已开始的流不会重放，客户端不会收到两段回答。
- 全部账号冷却时返回 `503 no_account`。
- 池为空时完全不介入，走原版单账号逻辑。
- 手动「切换」设置的账号优先于自动排序；该账号进入冷却后自动解除。

## 浏览器添加账号

复刻 VSCode 插件的登录协议，**不依赖桌面 App**：

```
POST /v2/plugin/auth/state?platform=VSCode   -> { state, authUrl }
浏览器打开 authUrl 完成登录
GET  /v2/plugin/auth/token?state=…           -> token（未登录时 code 11217）
GET  /v2/plugin/login/account?state=…        -> { uid, nickname, … }
写入 workbuddy-accounts/<uid 前 8 位>.json
```

`platform=VSCode` 是关键：它签发的凭证正是对话接口接受的那一代。会话只存内存、10 分钟过期、登录成功即失效。

## Token 用量统计

`streamUpstream` 旁路解析 SSE：按换行切分、保留跨 chunk 的半行，取最后一次 `usage` 记录。写入 `<DSH home>/.workbuddy-usage.json`（只存计数，无 prompt / 回复 / 凭证）。

记录字段：`prompt`、`completion`、`total`、`cacheHit`、`reasoning`、`credit`、`requests`，按账号分桶并汇总。

## 改动清单

对原版发布产物做锚点补丁，脚本在工作区 `plugins/*.mjs`：

| 文件 | 改动 |
|---|---|
| `lib/host-heartbeat-*.js` | 导出语句追加两个可读别名 |
| `lib/index.js` | 账号池、流式轮换、切换/登录控制动作、status 文档增加 `pool` 与 `usage` |
| `lib/client.js` | 内联侧栏面板，注册 `main` + `sidebar.panellist` |
| `lib/multi-account.js` | 新增：凭证池、冷却、手动切换、按账号积分 |
| `lib/usage-store.js` | 新增：SSE usage 解析与持久化 |
| `lib/account-login.js` | 新增：浏览器登录协议与会话管理 |
| `lib/account-cli.js` | 新增：账号池命令行 |
| `lib/pool-panel.runtime.js` | 面板组件（补丁输入，已内联进 `client.js`） |

每个补丁脚本都断言锚点唯一、幂等、写入前校验语法与编码，失败即拒绝写入。

## 未改动的标识

以下保持不变，改动会导致数据丢失或 provider 变化：

- provider id：`workbuddy` / `workbuddy-ai`
- 设置命名空间：`settings.workbuddy`
- 状态文件：`.workbuddy-catalog.json`、`.workbuddy-probe.json`、`.workbuddy-model-visibility.json` 等
- 账号池目录名：`workbuddy-accounts`

## 测试

```bash
node ../../tools/test-account-pool.mjs    # 解析、冷却、区域过滤
node ../../tools/test-rotation-logic.mjs  # 熔断轮换决策
node ../../tools/test-switch.mjs          # 手动切换与固定优先级
node ../../tools/test-usage.mjs           # usage 解析与持久化
node ../../tools/test-usage-e2e.mjs       # 跨 chunk 的端到端累计
node ../../tools/test-login.mjs           # 登录协议（联网）
node ../../tools/test-status-contract.mjs # 面板依赖的 status 字段
```

## 已知限制

- 上游为逆向协议，非官方 API，随时可能变化。
- 同机多账号共用 `X-Machine-Id`，上游可关联；可用但不建议作为主要容量来源。
- 版本须与 DSH 内核匹配（本分支基于 `0.7.9` / 内核 `0.2.1-rc.2`）。
- 原项目已停止维护，本分支同样不提供支持承诺。
