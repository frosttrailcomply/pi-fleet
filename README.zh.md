<!-- 语言: [English](README.md) · [Русский](README.ru.md) · 中文 · [Deutsch](README.de.md) -->

# pi-fleet

[Pi coding agent](https://github.com/earendil-works/pi) 的扩展，为 Pi 提供一支**自愈的模型舰队**：它会发现兼容 OpenAI 与 Ollama 的端点、跟踪其健康状况，并把每个请求路由到当前最佳端点，出错时透明切换。此外还提供可选的 **Mixture of Agents** 与一套**会学习的记忆**。

一切都与 Pi 自带的 provider 并行运行，后者照常工作。pi-fleet 是一个扩展包，而非分叉。

## 功能一览

- **动态舰队** —— 后台发现（本地种子地址、无需密钥的 Censys 抓取，或 Censys API）、存活与延迟/吞吐探测、按端点的断路器，以及按模型能力、延迟、吞吐、健康度、可靠性和上下文窗口加权的路由。
- **透明故障转移** —— 命中缓慢或损坏端点的请求会在次优端点上重试；连续失败后断路器打开，并自行恢复。
- **Mixture of Agents（MoA）** —— 可选。并行运行多个模型，由聚合器综合出一个答案。可跨本地与外部 provider 工作，worker 失败时优雅降级。
- **记忆** —— 从工具结果中学习陷阱与规避方法，并在一轮开始前注入相关内容。有界且可回滚的**自我演化**会依据可度量的指标调整舰队配置。可用时以 [Hindsight](https://github.com/vectorize-io/hindsight) 为后端，否则使用零依赖的本地 SQLite 存储。

## 安装

```bash
pi install git:github.com/<you>/pi-fleet      # 或: pi install npm:pi-fleet
# 或直接加载扩展：
pi -e /path/to/pi-fleet/src/ext/fleet-extension.ts
```

需要 Node ≥ 22（使用内置的 `node:sqlite`）。Pi 通过 `package.json` 中的 `pi` 键发现该扩展。

## 配置

把 `fleet.config.json` 放到工作目录、`~/.pi/agent/`，或用 `PI_FLEET_CONFIG` 指向它。所有字段均可选；默认值见 [`examples/fleet.config.json`](examples/fleet.config.json)。最常改动的部分：

```jsonc
{
  "gatewayPort": 47600,             // Pi 通信所用的本地端口（见「工作原理」）
  "discovery": {
    "seeds": ["127.0.0.1:11434"],   // 本地 Ollama，以及任何属于你的 host:port
    "censys": {
      "enabled": true,
      "query": "host.services.software.product = \"ollama\" or web.software.product = \"ollama\"",
      "browser": { "enabled": true } // 无需密钥的实时抓取（默认）—— 见下文
    }
  },
  "routing": { "capability": 1.0, "latency": 0.8, "throughput": 0.5, "health": 1.2, "reliability": 1.0, "context": 0.3 },
  "moa": { "enabled": false, "workers": 3, "policy": "diverse", "aggregatorModel": "", "minWorkers": 1 },
  "memory": { "enabled": true, "backend": "hindsight", "fallbackToNative": true },
  "evolution": { "enabled": false, "autoApply": false },
  "providers": [                    // 加入池中的外部 / 本地 OpenAI 兼容端点
    { "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "$OPENROUTER_API_KEY",
      "models": [{ "id": "meta-llama/llama-3.1-70b-instruct", "sizeB": 70, "contextWindow": 131072 }] }
  ]
}
```

### 发现（默认无需密钥）

Censys 的网页界面位于 Cloudflare 与登录墙之后，普通 HTTP 请求只会返回一个验证页。因此 pi-fleet 通过 [browser-search](https://github.com/Johell1NS/browser-search) 技术栈（Camofox / camoufox 隐身浏览器）渲染结果，并从渲染后的 HTML 中解析 host:port —— **无需 Censys API 密钥**。

**安装** —— 安装 browser-search 技术栈并启动其 Camofox 容器：

```bash
npm run setup:browser-search   # 克隆并安装 browser-search，在 127.0.0.1:9377 启动 Camofox
```

它也会在 `npm install` 时自动运行（仅代码 —— 克隆并安装 browser-search，但不启动容器；在 CI 中或设置 `PI_FLEET_SKIP_SETUP=1` 时跳过）。需要 `git`，以及用于容器的 `podman` 或 `docker`。完成后会打印需要导出的凭据：

```bash
export CAMOFOX_API_KEY=<生成的密钥>   # 必须与运行中的 Camofox 容器一致
```

这是无密钥路径唯一需要的凭据。`BROWSER_SEARCH_DIR` 会自动写好，而 `PI_FLEET_DIR`（用于定位默认抓取命令）由扩展与 CLI 自动设置。

任何能打印渲染后 HTML 的抓取器都可用 —— 在 `discovery.censys.browser.command` 中指定即可。例如 Firecrawl：

```jsonc
"command": ["firecrawl", "scrape", "{url}", "--format", "html", "--wait-for", "9000"],
"resultPath": ""
```

各发现来源可叠加：`discovery.seeds`、通过 `discovery.censys.htmlImports` 导入已保存的 Censys 页面，以及设置了 `CENSYS_API_ID` / `CENSYS_API_SECRET` 时的 Censys API。发现到的主机会被探测（`/api/tags` → 一次真实的 chat completion），只有验证通过的端点才会加入舰队。一次无密钥的真实运行通过该路径发现了 70+ 个可达端点。

> 只把发现指向你有权使用的端点。

### 记忆后端

`memory.backend` 默认为 `"hindsight"`。启动时 pi-fleet 会探测 Hindsight 服务（`memory.hindsight.baseUrl`）；若有响应，则在其中保存与召回经验。若无响应且 `fallbackToNative` 为真（默认），则改用本地 SQLite 存储 —— 记忆无需外部服务即可工作。无论如何本地存储始终运行，因为自我演化依赖它。

请按 Hindsight 的文档自行运行（Docker/Postgres），然后设置 `memory.hindsight.baseUrl`，必要时设置 `HINDSIGHT_API_KEY`。

## 在 Pi 中使用

将舰队选作模型：

```bash
pi --provider fleet --model auto                          # 加权路由 + 故障转移
pi --provider fleet --model moa                           # Mixture of Agents（当 moa.enabled 时）
pi --provider fleet --model "127.0.0.1:11434/llama3.1:70b" # 固定某个已发现的模型
```

命令：

| 命令 | 作用 |
|---|---|
| `/fleet` | 端点、健康、断路器状态、模型、记忆后端 |
| `/fleet-refresh` | 立即强制一次发现 + 健康刷新 |
| `/fleet-moa on\|off` | 开关 Mixture of Agents |
| `/fleet-evolve` | 立即运行一次有界的自我演化 |
| `/fleet-remember <文本>` | 保存一条环境事实 / 经验 |

## 独立 CLI

无需启动 Pi 即可操作舰队：

```bash
npm run fleetctl -- discover        # 一次发现 + 健康检查，打印状态
npm run fleetctl -- status
npm run fleetctl -- import page.html   # 从已保存的 Censys 页面提取 host:port
npm run fleetctl -- chat "你好"      # 把一个请求路由到舰队
npm run fleetctl -- memory          # 列出已保存的经验
```

## 工作原理

Pi 把一个小型本地**网关**（`gatewayPort`）当作普通的 OpenAI 兼容 provider 来通信。网关将每个请求经引擎路由，因此 Pi 的模型处理始终走其受支持的路径：

```
发现（种子 / 浏览器抓取 / Censys API）→ 探测 → 注册表（EWMA 统计 + 断路器）
                                                        │
        请求 ──► 路由器（加权评分）──► 故障转移执行器 ──► 端点
                                            └► MoA：并行 worker → 聚合器
观测 ──► 记忆（Hindsight 或本地 SQLite）──► 自我改进 / 自我演化
```

- **断路器** —— `failureThreshold` 次连续失败会打开端点；`cooldownMs` 后进入半开做一次试探；`recoveryThreshold` 次成功后重新闭合。
- **自我演化** —— 有界且可回滚。仅自动应用能可度量地改善指标的*配置*更改（隔离不稳定端点、微调路由权重），否则回滚。任何触及代码或技能的更改都会写成受 git 跟踪、仅供评审的提案，放在 `.pi/fleet-evolution/`。

临时状态位于 `~/.pi/agent/fleet/`（本地记忆数据库、演化产物）。任何敏感内容都不会提交。

## 测试

```bash
npm test          # 单元 + 集成 + 端到端（进程内 mock 端点；不接触外部主机）
npm run typecheck
```

端到端套件（`test/e2e.test.ts`）覆盖发现与刷新、健康状态转换、路由、透明故障转移、端点恢复、本地与外部互通、MoA 成功与部分 worker 失败、经验的持久化与召回、定时循环、自我演化的接受与回滚，以及带持久化状态的干净重启。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
