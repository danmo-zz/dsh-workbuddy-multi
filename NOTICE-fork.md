# 二次开发声明 / Fork Notice

## 原项目

本项目是 **dsh-workbuddy-connect** 的二次开发版本，原项目由 **Corrine Hu** 开发：

- 仓库：https://github.com/corrinehu/dsh-workbuddy-connect
- 原包名：`dsh-workbuddy-connect`
- 原许可证：MIT（见同目录 `LICENSE`，Copyright (c) 2026 Corrine Hu）

原项目的全部版权、许可证与免责声明**完整保留**，未做任何删改：

| 文件 | 状态 |
|---|---|
| `LICENSE` | 原样保留，未修改 |
| `THIRD_PARTY_NOTICES.txt` | 原样保留，未修改（含 DeepSeek 的 MIT 声明） |

`package.json` 的 `repository` / `homepage` / `bugs` 仍指向原项目，便于追溯来源。

## 本二改版名称

**WorkBuddy Multi（账号池版）**，包名 `dsh-workbuddy-multi`。

## 相对原版的改动

| 功能 | 说明 |
|---|---|
| **多账号池** | 同一份配置下管理多个 WorkBuddy 登录态，逐个账号记录 Token 有效期与冷却状态 |
| **额度耗尽自动切换** | 上游返回 402（额度耗尽）、429（限流）、401（登录失效）时自动换号重试；仅在响应尚未开始传输时切换，不会拼接两段回答 |
| **手动切换** | 面板中每个账号带「切换」按钮，指定下一次请求使用哪个账号 |
| **浏览器添加账号** | 面板中「添加账号」直接生成登录链接，在浏览器完成登录后凭证自动写入账号池，无需操作桌面 App |
| **账号积分显示** | 每个账号单独显示剩余积分与积分包构成 |
| **Token 用量统计** | 记录输入/输出 Token、缓存命中、推理 Token、消耗积分与请求次数，按账号分桶并持久化 |

改动方式为对原版发布产物（`lib/` 下的打包文件）做锚点补丁，改动脚本见仓库外的 `plugins/*.mjs`。
原文的模块级注释、错误信息前缀保留原写法以便对照上游。

## 未改动的部分

以下标识保持不变，因为改动会导致数据丢失或 provider 变化：

- provider id：`workbuddy`、`workbuddy-ai`
- 设置命名空间：`settings.workbuddy`
- 状态文件名：`.workbuddy-catalog.json`、`.workbuddy-probe.json`、`.workbuddy-model-visibility.json` 等
- 账号池目录：`workbuddy-accounts`

## 使用限制与免责

- 本二改版**仅供个人学习与研究**，沿用原项目的使用限制。
- 多账号轮换涉及同一机器多账号使用，可能违反上游服务条款；由使用者自行承担风险。
- 本二改版**未经原作者的审查或背书**，原作者不对本版本的问题负责；相关问题上请勿提交至原项目 issue 追踪。
