# dsh-a2a-notify

[English](README.md)

DeepSeek Harness (DSH) host 插件：当**任意工作区**的会话发生生命周期事件（新建 / 开始运行 / 运行结束 / 出错）时，弹出 Windows 系统通知。

解决的问题：A2A / headless / 任务板把任务投递到你当前没有打开的工作区时，会话在后台跑完你不知道。本插件在 Host 进程内订阅与官方 session-controller 相同的 Cordis 事件总线（`api-session/added | status | error`，已在 `@deepseek-ai/dsh-api-session-controller` 源码中核实），跨工作区感知所有会话；另带会话存储目录监听兜底，覆盖 headless 独立进程创建的会话。

## 事件

| 事件 | 通知 | 说明 |
| --- | --- | --- |
| `api-session/added` | 「DSH new session」 | 任意工作区新建会话（标题 + 所在文件夹） |
| `api-session/status` → running | 「DSH session running」 | 会话开始执行 turn（按会话去重） |
| `api-session/status` → idle | 「DSH session finished」 | turn 结束 |
| `api-session/error` | 「DSH session error」 | Agent 报错 |
| `api-session/activity` | 不通知 | 每条用户消息都触发，太频繁 |

日志（append-only）：`~/.dsh/logs/a2a-notify.log`——每条通知 fired 都有记录，方便核对。

## 通知实现说明（计划任务通道）

DSH 的进程树（Host 及其派生的 powershell.exe）处于桌面隔离的沙箱中——实测其中弹出的气球通知（无论 WinForms 还是 WinRT）都到不了用户桌面，通知中心也无记录。因此本插件采用**计划任务派发**：

1. 插件把 `{title, message}` 写入信箱目录 `~/.dsh/a2a-notify/pending/pending-*.json`
2. 触发每用户计划任务 `a2a-notify-dispatch`（插件首次运行时自动注册，指向 `lib/dispatcher.ps1`）
3. dispatcher 以交互桌面身份运行：原子认领（rename）各请求文件 → 弹气球 → 删除

为什么不用 WinRT `ToastNotificationManager`：沙箱子进程没有 MSIX package identity，`CreateToastNotifier` 以 `0x80073D54` 拒绝，`SetCurrentProcessExplicitAppUserModelID` 也绕不过（已实测）。为什么不让 Host 直接弹 WinForms 气球：桌面隔离，横幅画不出（已实测）。计划任务以登录用户身份跑在交互桌面上，不受此限。

手动注册 / 删除计划任务：

```sh
schtasks /create /tn "a2a-notify-dispatch" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-a2a-notify\lib\dispatcher.ps1" /sc once /st 23:59 /f
schtasks /delete /tn "a2a-notify-dispatch" /f
```

（安装路径含空格时插件自动回退为直接派生 powershell——该环境下气球可能不显示，建议装在默认无空格路径。）

## 安装

```sh
dsh plugin add github:<you>/dsh-a2a-notify
```

或从 release 归档安装。安装后**重启 DSH** 生效（Host 重启才会重新加载插件容器；ESM 模块缓存使热重载不可靠）。

Windows 10/11 专用（dispatcher 需要 PowerShell 5.1 + WinForms，系统自带）。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 中覆盖（缺省全部开启）：

```yaml
- id: a2a-notify
  name: dsh-a2a-notify
  config:
    notifyOn:
      added: true
      running: false   # 不想每次 turn 都弹就关掉这个
      finished: true
      error: true
    notifyWorkspaces:            # cwd 前缀白名单；留空 = 全部通知
      - C:\Users\<you>\.workbuddy
      - C:\Users\<you>\WorkBuddy
```

`notifyWorkspaces` 用于静音你自己的 GUI 会话（比如你正在打字的工作区），只让外部投递器响。cwd 未知的会话一律通知。

## 已知限制

- headless 会话不会实时出现在侧边栏（数据层完整，`POST /api/session/list` 可查到、落在「未分组」分组，但 GUI 只在页面加载时拉取——刷新页面即可见；气球仍会第一时间告知）。
- 插件会为 store-watch 捕获的会话补发 `api-session/added`（让 GUI 有机会实时入列），但该推送能否穿过 gateway 的事件作用域路由取决于 DSH 版本。

## 卸载

删除 `~/.dsh/profiles/desktop/node_modules/dsh-a2a-notify/` 并从 profile `package.json` 移除两处登记、`cordis.patch.yml` 移除 config 块，然后 `schtasks /delete /tn "a2a-notify-dispatch" /f`；日志与信箱目录（`~/.dsh/a2a-notify/`）可一并删除。

## 安全面

- 只读 Host 事件总线，不注册 HTTP 路由、不监听端口、不联网。
- 写入位置：`~/.dsh/logs/a2a-notify.log`（日志）、`~/.dsh/a2a-notify/pending/`（通知请求信箱）、用户级计划任务 `a2a-notify-dispatch`（仅指向本插件的 dispatcher.ps1）。
- 通知内容来自会话标题 / 工作区路径，不包含会话正文。

## License

MIT
