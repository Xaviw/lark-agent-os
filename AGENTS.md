# Agent 注意事项

## 重启 lark-agent-os

不要在由同一个 `lark-agent-os` 进程处理的飞书 Agent 请求中执行 `kill -TERM <lark-agent-os-pid>`。服务进入关闭流程后会中止所有正在执行的 Agent run，其中包括正在执行该命令的当前请求，导致 pi 报错：`Error: This operation was aborted`。

应在当前 Agent 请求完成后，从外部终端重启服务。如必须以编程方式触发重启，应先启动一个脱离旧服务进程组的 supervisor，再停止服务；该 supervisor 应等待旧 PID 退出后再启动新实例。
