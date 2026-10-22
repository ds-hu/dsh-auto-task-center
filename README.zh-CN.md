# Task Center · 任务中心

**任务中心 / Task Center** — 给 DeepSeek Harness 加上定时任务与 Webhook 任务。
设置一次，DSH 就会按时间新建会话，或往指定会话里发一条消息。

<p align="center">
  <img src="docs/screenshots/01-entry.png" alt="任务中心在 DSH 右侧边栏" width="820">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ds-hu/dsh-auto-task-center"><img alt="npm" src="https://img.shields.io/npm/v/@ds-hu/dsh-auto-task-center?color=2E7DD1"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-2E7DD1"></a>
  <a href="README.md">English</a>
</p>

---

## 就在你干活的地方

任务中心是会话右侧边栏里的一个标签页。不用开新窗口，也不用切应用：点开就在旁边，和当前会话待在一起。

<p align="center">
  <img src="docs/screenshots/02-list.png" alt="任务列表：状态、触发规则、下次运行时间" width="820">
</p>

每行回答三个问题：开着吗、下一次什么时候跑、跑完发到哪。
停用的任务留在列表里变灰，设置和运行记录都还在。

## 六种触发方式

单次、固定间隔、每天、每周、Cron 表达式、Webhook，按需要挑最简单的那一种。

<p align="center">
  <img src="docs/screenshots/04-trigger.png" alt="Cron 触发：可以直接看到未来 5 次运行时间" width="820">
</p>

**未来 5 次运行**按你选的时区算好列出来，Cron 写错了一眼就能看见，不用等它跑空。

<p align="center">
  <img src="docs/screenshots/03-new-task.png" alt="新建任务表单" width="820">
</p>

## 消息送到该去的地方

可以**新建一条会话**——工作区和 Agent 预设都随任务指定；也可以发到**已有的会话**里。

<p align="center">
  <img src="docs/screenshots/05-delivery.png" alt="选择一个已有会话作为投递目标" width="820">
</p>

消息内容完全由你写。它以普通用户消息的身份进入会话，所以斜杠指令照常生效：
`/goal` 让这次触发变成自主目标，`/技能名` 加载对应技能。

### 每次运行新建一个 worktree

装好 [`dsh-better-workspaces`](https://www.npmjs.com/package/dsh-better-workspaces) 之后，
投递目标还能选**新建 worktree**：每次触发都从你指定的基分支拉出一个新分支，在那个目录里干活，
夜里跑的 Agent 不会碰你正开着的工作区。

<p align="center">
  <img src="docs/screenshots/10-worktree.png" alt="开启“每次运行新建 worktree”，并选择基分支" width="820">
</p>

跑两次就是两个分支，运行记录里写清楚了每次在哪干活：

<p align="center">
  <img src="docs/screenshots/11-worktree-history.png" alt="两次运行分别落在两个 worktree 里" width="700">
</p>

没装那个插件时，这个选项根本不会出现，其他投递方式一切照旧；已经选了 worktree 的任务会保留开关并给出提示，
点一下就能改回普通工作区，不用去猜哪里坏了。

## Webhook 共用同一个端口

每个 Webhook 任务都有自己的地址和密钥，复制走就能贴进 GitHub、CI 或者一行 curl。

<p align="center">
  <img src="docs/screenshots/06-webhook.png" alt="Webhook 地址、复制与轮换密钥" width="820">
</p>

请求体会替换消息里的 `{{payload}}`。地址泄露了也不慌：**轮换密钥**一点，旧地址立刻失效。

## 看得懂的运行记录

<p align="center">
  <img src="docs/screenshots/07-history.png" alt="运行记录：已投递、已跳过、失败" width="820">
</p>

每次运行都留一条：投递成功、DSH 没开着所以跳过、目标会话没了所以失败。
连续失败的任务会被标成**需处理**，而不是安静地什么都不做。

## 跟随主题

<p align="center">
  <img src="docs/screenshots/08-dark.png" alt="深色模式下的任务中心" width="820">
</p>

深浅色都取自 DSH 自己的主题变量，两种模式下都像是原生的一部分。

## 还给 Agent 准备了一个预设

<p align="center">
  <img src="docs/screenshots/09-preset.png" alt="输入框里的「任务管理」预设" width="820">
</p>

装上插件，模式菜单里会多出**任务管理**：它是标准模式去掉官方提醒工具、加上 `task_center` 工具。
于是你可以直接说「每个工作日早上 9 点总结一下仓库」，由 Agent 自己把任务建好。

---

## 安装

```bash
dsh plugin --profile web add @ds-hu/dsh-auto-task-center
```

重启 `dsh web`，打开任意会话，在右侧边栏的起始页里选 **Task Center**。
**任务管理**预设会出现在输入框的模式菜单里。

## 卸载

和安装一样，把插件移除即可。它只在 `$DSH_HOME/task-center/` 下写数据，不注册安装脚本，
所以移除后不会留下服务、定时器或者被改过的配置。

```bash
dsh plugin --profile web remove @ds-hu/dsh-auto-task-center
dsh-auto-task-center purge --yes   # 可选：把保存的任务也删掉
```

卸载前有两件事要知道，细节见[卸载](docs/TECHNICAL.md#uninstall)：
先把还在用**任务管理**预设的会话切回别的预设；浏览器里会剩下一个点不动的标签页，点掉即可。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/TECHNICAL.md](docs/TECHNICAL.md) | 架构、数据模型、HTTP 接口、调度规则、卸载 |
| [CONTEXT.md](CONTEXT.md) | 这个插件用到的术语 |
| [docs/adr](docs/adr) | 设计决策的来由 |

## 许可

MIT，见 [LICENSE](LICENSE)。
