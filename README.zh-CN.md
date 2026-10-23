# Task Center · 任务中心

**任务中心 / Task Center** — 给 DeepSeek Harness 加上定时、HTTP 与手动触发的任务。
设置一次，到点（或被调用时）DSH 就新建会话，或者往指定会话里发一条消息。

<p align="center">
  <img src="docs/screenshots/01-panel.png" alt="任务中心：右侧边栏里的任务列表，每行带触发规则、投递目标、模型与权限" width="820">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ds-hu/dsh-auto-task-center"><img alt="npm" src="https://img.shields.io/npm/v/@ds-hu/dsh-auto-task-center?color=2E7DD1"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-2E7DD1"></a>
  <a href="README.md">English</a>
</p>

---

## 就在你干活的地方

任务中心是会话右侧边栏里的一个标签页：不用开新窗口，点开就在旁边。
每行回答三个问题——开着吗、下次什么时候跑、跑完发到哪。停用的任务留在列表里，设置和记录都还在。

## 一个任务，一个触发源

每个任务只由一种原因引起，列表里每行都写清楚是哪一种：

- **时间表**——单次、固定间隔、每天、每周、Cron。**未来 5 次运行**按你选的时区算好列出来，
  Cron 写错了一眼就能发现，不用等它跑空。
- **HTTP 请求**——自带密钥的 Webhook 地址，给 CI、GitHub 钩子或者一行 curl 用。
- **你**——手动任务既没有时间表也没有地址，只有你点**立即运行**时才会跑，别的时候一次都不跑。

<p align="center">
  <img src="docs/screenshots/02-trigger.png" alt="每天 09:00（Asia/Shanghai）触发，并列出未来 5 次运行时间" width="820">
</p>

手动触发一个定时任务，也算一次手动运行，记录会写明 *手动 · 会话 3f2a1c*，而不会假装时间表跑了。
Agent 同样能触发：`task_center` 工具提供了 `run` 动作。

<p align="center">
  <img src="docs/screenshots/05-manual.png" alt="手动任务：没有时间表，顶栏有「立即运行」，运行记录标为「手动」" width="760">
</p>

## 投递到哪里，用什么模型、什么权限

可以**新建一条会话**，也可以发到**已有会话**里。新建时这些都由任务决定：

- **工作区**与 **Agent 预设**；
- **模型**——想省钱就用便宜的那个，想深度推理就用最强的那个；
- **思考强度**——关闭 / 低 / 高 / 最高，具体几档由所选模型决定：写摘要用便宜模型配低强度，
  要动脑的重构用强模型拉满；
- **权限**——仅可查看 / 工作区内修改 / 完全权限，官方那套权限预设。
  它在第一次对话之前就生效，所以夜间任务从第一个动作起就被关在沙箱里。

<p align="center">
  <img src="docs/screenshots/03-delivery.png" alt="投递设置：新建会话、工作区、Agent 预设、模型与权限" width="720">
</p>

消息完全由你写，以普通用户消息的身份进入会话，所以斜杠指令照常生效：
`/goal` 让这次触发变成自主目标，`/技能名` 加载对应技能。

模型、思考强度与权限只在 Host 提供时才会出现在表单里；留空就是跟随部署默认。强度那一栏的选项来自
所选模型本身，不会出现它做不到的档位。哪天那个模型或预设被删了，任务不会被悄悄改成别的——
运行记录会写明失败原因，不会带病执行。

装好 [`dsh-better-workspaces`](https://github.com/ds-hu/dsh-better-workspaces) 之后，
新建会话还能落在**每次运行新建的 worktree** 里：从你指定的基分支拉一个新分支，夜里跑的 Agent 不碰你正打开的目录。

## HTTP 触发与运行记录

HTTP 任务有自己的地址与密钥，端口与 DSH 共用。请求体会替换消息里的 `{{payload}}`；
地址泄露了也不慌，**轮换密钥**一点，旧地址立刻失效。

```bash
curl -X POST "http://127.0.0.1:3080/task-center/hook/<task-id>/<secret>" -d '{"branch":"main"}'
```

每次运行都留一条记录，并写明它是被时间表、HTTP 还是手动引起的：投递成功、DSH 没开着所以跳过、
目标没了所以失败。连续失败的任务会被标成**需处理**，而不是安静地什么都不做。

<p align="center">
  <img src="docs/screenshots/04-history.png" alt="运行记录：两次投递，写清会话、所用模型与权限" width="820">
</p>

## 还给 Agent 准备了一个预设

装上插件，模式菜单里会多出**任务管理**：标准模式去掉官方提醒工具、加上 `task_center` 工具。
于是你可以直接说「每个工作日早上 9 点总结一下仓库」，由 Agent 自己把任务建好；
它也能列出、修改、删除任务，或者立刻跑一次。

界面跟随 DSH 的主题变量，深浅色两种模式下都像是原生的一部分。

---

## 安装

```bash
dsh plugin --profile web add @ds-hu/dsh-auto-task-center
```

重启 `dsh web`，打开任意会话，在右侧边栏的起始页里选 **Task Center**。
**任务管理**预设会出现在输入框的模式菜单里。

经过反向代理、隧道或者 Cloudflare Access 访问时面板照常可用：写操作校验的是浏览器实际使用的主机名，
而不是 DSH 绑定到的那串回环地址。

## 卸载

插件只在 `$DSH_HOME/task-center/` 下写数据，不注册安装脚本，移除后不会留下服务、定时器或被改过的配置。

```bash
dsh plugin --profile web remove @ds-hu/dsh-auto-task-center
dsh-auto-task-center purge --yes   # 可选：把保存的任务也删掉
```

卸载前先把还在用**任务管理**预设的会话切回别的预设；浏览器里会剩下一个点不动的标签页，点掉即可。
细节见[卸载](docs/TECHNICAL.md#uninstall)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/TECHNICAL.md](docs/TECHNICAL.md) | 架构、数据模型、HTTP 接口、调度规则、卸载 |
| [CONTEXT.md](CONTEXT.md) | 这个插件用到的术语 |
| [docs/adr](docs/adr) | 设计决策的来由 |

## 许可

MIT，见 [LICENSE](LICENSE)。
