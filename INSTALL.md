# WorkBuddy Multi（账号池版）· 安装说明

本包是 **dsh-workbuddy-connect** 的二次开发版，在「把 WorkBuddy 模型接入 DeepSeek Harness」的基础上增加了**多账号池、额度耗尽自动切换、手动切换账号、浏览器添加账号、Token 用量统计**。

原项目：https://github.com/corrinehu/dsh-workbuddy-connect （MIT，Copyright (c) 2026 Corrine Hu）
原许可证完整保留，见 `LICENSE`；二改说明见 `NOTICE-fork.md`。

---

## 一、适用条件

| 项 | 要求 |
|---|---|
| DSH 内核 | **`0.2.1-rc.2`**（本包按此版本构建，其他版本可能无法启动） |
| DSH 形态 | 桌面版（Electron App）或 Web 版均可 |
| Node | `^22.19.0` 或 `>=24.0.0` |
| WorkBuddy 账号 | 至少一个（可用面板里的「添加账号」现场登录） |

**内核版本怎么看**：桌面版看「关于」页；Web 版看 `dsh --version`。

---

## 二、安装

### 方式 A：交给 DSH 的插件管理界面（最省事）

如果 DSH 自带插件管理 / 插件市场，直接把本目录（或打好的 `tgz`）装进去即可。装完重启 DSH。

### 方式 B：命令行安装到 desktop profile

> 注意：`desktop` profile 由桌面 App 独占管理，命令行直接改可能被拒绝。**推荐方式 A**。
> 若使用 Web / TUI profile，可按下例：

```bash
# 1. 进入 profile 目录（示例）
cd ~/.dsh/profiles/desktop      # Windows: %USERPROFILE%\.dsh\profiles\desktop

# 2. 备份
cp package.json package.json.bak

# 3. 把本包放到任意目录后，添加为本地依赖（改成本包实际路径）
#    Windows 路径注意用正斜杠
```

编辑 `package.json`：

```json
{
  "dependencies": {
    "dsh-workbuddy-multi": "file:C:/path/to/dsh-workbuddy-multi"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-workbuddy-multi"
      ]
    }
  }
}
```

执行安装（用 App 自带的 pnpm）：

```bash
pnpm install --dir <profile 目录>
```

**4. 完全退出并重启 DSH。**

---

## 三、首次使用

1. 重启后，**侧边栏**会出现 **`WorkBuddy Multi`** 一行，点开是账号池面板。
2. 点 **「添加账号」** → 会生成一个登录链接。
3. **用无痕窗口**打开该链接，登录 WorkBuddy 账号。
4. 登录完成后面板自动刷新，账号出现在「账号池」里。
5. 在模型选择器里选择 WorkBuddy 分组下的模型即可对话。

> 重复第 2~4 步可以添加多个账号。同一账号重复登录只会刷新凭证，不会重复添加。

---

## 四、面板能做什么

| 区域 | 内容 |
|---|---|
| 当前账号 | 昵称、域名、令牌剩余有效期、剩余积分 |
| 账号池 | 每个账号的昵称、uid、令牌有效期、**各自的积分**、冷却状态 |
| 账号操作 | 每个账号一个 **「切换」** 按钮：下一次请求使用该账号 |
| 用量统计 | 总 Token、输入/输出 Token、缓存命中、推理 Token、请求次数、消耗积分 |
| 模型 | 当前可用模型列表、费率倍率、促销标记 |

### 自动切换规则

| 上游返回 | 冷却 | 行为 |
|---|---|---|
| 402 额度耗尽 | 60 分钟 | 自动换下一个账号重试 |
| 429 限流 | 60 秒 | 自动换下一个账号重试 |
| 401 登录失效 | 10 分钟 | 自动换下一个账号重试 |
| 模型不存在 / 5xx | 20 秒 | **不换号**，直接报错（与账号无关） |

- 切换只在**回答尚未开始输出**时发生，不会把两个账号的内容拼在一起。
- 所有账号都在冷却时提示 `503`，稍等再试。
- 手动「切换」优先于自动排序；该账号进入冷却后自动解除。

---

## 五、数据位置

| 数据 | 路径 |
|---|---|
| 账号登录态 | `~/.dsh/workbuddy-accounts/*.json` |
| Token 用量 | `~/.dsh/.workbuddy-usage.json` |
| 模型缓存 | `~/.dsh/.workbuddy-*.json` |

也可用环境变量 `WORKBUDDY_ACCOUNTS_DIR` 指定账号池目录。

**账号文件就是凭证**，请勿外传。分发时不要带上 `workbuddy-accounts/` 目录。

---

## 六、命令行工具

```bash
node lib/account-cli.js status        # 账号列表、有效期、冷却
node lib/account-cli.js check         # 逐个账号联网校验（不消耗积分）
node lib/account-cli.js import <dir>  # 从目录导入账号
node lib/account-cli.js path          # 打印账号池目录
```

---

## 七、常见问题

**Q：侧边栏没有 WorkBuddy Multi？**
A：先确认已完全退出 DSH 再启动（含托盘）。仍然没有时检查 `package.json` 的 `bundles` 里是否有 `dsh-workbuddy-multi`。

**Q：模型列表空了？**
A：说明 provider 没注册，通常是包名 / bundle id / `cordis.patch.yml` 三者不一致，或内核版本不匹配。本包已校验三者一致，请重点检查内核是否为 `0.2.1-rc.2`。

**Q：账号显示「查询失败」？**
A：积分接口需要有效令牌。等令牌刷新或重新登录该账号。

**Q：提示「登录链接已过期」？**
A：登录会话 10 分钟有效。重新点「添加账号」即可。

**Q：加了账号但没显示？**
A：登录后需要几秒轮询，面板会自动刷新。若仍不出现，重启 DSH。

---

## 八、卸载

1. 从 profile 的 `package.json` 里删除 `dsh-workbuddy-multi`（`dependencies` 与 `bundles` 两处）。
2. `pnpm install --dir <profile>`。
3. 重启 DSH。
4. 可选：删除 `~/.dsh/workbuddy-accounts/` 与 `~/.dsh/.workbuddy-usage.json`。

---

## 九、声明

- 本包为**非官方**二次开发版，未经原作者审查或背书。
- 使用 WorkBuddy 客户端接口，不属于官方开放 API，上游变更可能导致失效。
- 多账号轮换可能违反上游服务条款，风险自负。
- 仅供个人学习与研究，遵守原项目的 MIT 许可与免责条款。
