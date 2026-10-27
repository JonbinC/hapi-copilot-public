# HAPI Copilot v0.4.1 开源版：接入指南

本项目为面向自建 HAPI 的模型中立个人操作台与 MCP 桥接器。本版本为公开开源版本（基于已验证的稳定 v0.4.1 基线，不宣称 v0.4.2 未发布特性），已审查，未发现明显的已知秘密，但不保证没有遗漏。

## 设计目标

- **模型中立**：由用户授权的通用助手代理，不按品牌锁定单一“执行者”或“审查者”。
- **正交配置**：机器、工作目录、客户端类型（AGY / Codex / Cursor 等）、模型、权限模式与任务角色各自独立选择。
- **权限与边界**：Owner 模式覆盖当前 HAPI 认证命名空间中可见的机器与会话，受限于 Runner 宿主操作系统的权限与 HAPI 配置的 workspace roots。
- **零破坏集成**：官方 HAPI 不打补丁；现有 Tunnel 与 Runner 无缝复用。
- **额度实事求是**：额度信息仅基于时间戳与确凿 CLI 证据（如 CodexBar 输出或明确用户上报）进行记录；无来源或过期时严格判定为 `unknown`，绝不虚构 API 余额或猜测付费额度。

## 运行与验证

在环境（推荐 Node.js 22.16+ / 24 LTS）中运行：

```sh
npm run test:all
npm run smoke
```

自动化测试涵盖 124 项测试（98 项新特性测试 + 26 项回归测试），离线发现 53 个 MCP 工具。

## 快速上手与配置

1. 配置文件准备：
   - 先复制 `config/observer.example.json` 作为观察者只读策略。Owner 策略仅适用于已验证的私有单用户连接。
   - 配置 `.env` 环境变量：`HAPI_API_URL`、`HAPI_ACCESS_TOKEN_FILE`、私有状态目录 `HAPI_COPILOT_STATE_DIR` 和策略路径 `HAPI_OPERATOR_POLICY_FILE`。Node 不会自动读取 `.env`；先导出环境变量，或使用 Node 22+ 的 `node --env-file=.env server/index.mjs`。
2. 启动服务：
   - 现代服务通过 stdio 运行 `node server/index.mjs`，提供 53 个离线发现的工具。
   - `server/legacy/remote.mjs` 是旧版有限工具集，仅有静态 Bearer 令牌鉴权，不实现 OAuth。ChatGPT 网页需要由所有者另行建立并保护连接现代 stdio 服务的 OAuth 兼容 HTTPS MCP 桥接器；本项目未提供或验证该桥接器。
3. 详细文档：
   - 完整自建安装与远程访问限制：见 [INSTALLATION.md](INSTALLATION.md)。
   - 工具与协议定义：见 [TOOLS.md](TOOLS.md) 与 [TOOLS.json](TOOLS.json)。
   - 验证报告：见 [VERIFICATION.md](VERIFICATION.md)。
