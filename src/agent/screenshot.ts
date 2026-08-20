import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { SCREENSHOT_KEEP_COUNT, SCREENSHOT_TIMEOUT_MS, screenshotRoot } from '../config.js';

/**
 * screenshot 工具：让 Agent 截取当前 Windows 系统屏幕，保存为 PNG 图片文件。
 *
 * 设计要点：
 * - 注册方式：与 send_image 一致，AgentSessionConfig.customTools（进程内注入，不写 session JSONL）；
 * - 实现：内嵌 PowerShell 脚本（ASCII-only，参数经 UTF-8 JSON 文件传递规避命令行编码问题），
 *   spawn powershell.exe 执行，解析单行 JSON 结果标记；
 * - 能力矩阵（本机实测）：
 *   - 全屏：GDI CopyFromScreen（虚拟桌面拼接 / 主屏 / 逐屏 / 指定显示器）；
 *   - 窗口：PrintWindow + PW_RENDERFULLCONTENT=2（可截被遮挡窗口）；
 *   - 最小化窗口：自动「还原 → 移屏外(-32000,-32000) → PrintWindow → 再最小化」技巧（实测可截；
 *     少数 UWP / 硬件加速窗口可能失败，返回 window-capture-failed）；
 *   - DPI：显式 SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)，保证高 DPI（如 200% 缩放）
 *     下按物理像素截图，避免 GDI 虚拟化导致模糊；
 *   - 空白检测：截图后采样唯一颜色数 + 平均亮度，全黑等异常标记 blank（显示器关闭 / 锁屏
 *     / 无法离屏渲染时的启发式提示）；
 * - 不可用场景返回明确错误码（screenshotErrorText 映射为中文提示）：
 *   no-interactive-session（服务 / Session 0 无法截用户桌面）、window-not-found（附当前可见窗口
 *   列表）、display-not-found（附显示器列表）、window-capture-failed、capture-failed、write-failed、
 *   unsupported-platform（非 Windows）、timeout、exec-failed、parse-failed、bad-target；
 * - 产物：PNG 写入 stateRoot/screenshots，保留最近 SCREENSHOT_KEEP_COUNT 张；Agent 用 send_image 发送；
 * - 失败兜底：任何错误转为工具结果文本返回给 Agent，不阻塞本次 prompt。
 */

// ───────────────────────── 类型 ─────────────────────────

export type ScreenshotTarget = 'full' | 'primary' | 'all' | 'display' | 'window';

export type ScreenshotParams = {
  target: ScreenshotTarget;
  /** target=window 时：窗口标题关键字（不区分大小写的模糊匹配） */
  windowTitle?: string;
  /** target=window 时：进程 PID（优先于 windowTitle） */
  pid?: number;
  /** target=display 时：显示器序号（从 1 开始；缺省 1，可先用 target=all 查询列表） */
  display?: number;
};

export type ScreenInfo = {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
};

export type ScreenshotFile = {
  path: string;
  width: number;
  height: number;
  /** 来源描述：显示器名（全屏类）或 "window:<标题>" */
  display: string;
  /** 内容疑似空白（全黑/单色）：可能显示器关闭、锁屏、或窗口无法离屏渲染 */
  blank: boolean;
  title?: string;
  pid?: number;
};

export const SCREENSHOT_ERROR_CODES = [
  'unsupported-platform',
  'no-interactive-session',
  'window-not-found',
  'window-capture-failed',
  'display-not-found',
  'capture-failed',
  'write-failed',
  'bad-target',
  'timeout',
  'exec-failed',
  'parse-failed',
] as const;
export type ScreenshotErrorCode = (typeof SCREENSHOT_ERROR_CODES)[number];

export type ScreenshotResult =
  | { ok: true; files: ScreenshotFile[]; monitors: ScreenInfo[]; blank: boolean }
  | { ok: false; code: ScreenshotErrorCode; message: string; monitors: ScreenInfo[] };

// ───────────────────────── 错误码 → 中文提示 ─────────────────────────

const SCREENSHOT_ERROR_TEXT: Record<ScreenshotErrorCode, (extra?: string) => string> = {
  'unsupported-platform': () => '当前平台不支持截图：该工具仅支持 Windows（macOS/Linux 请使用系统自带截图）。',
  'no-interactive-session': () => '无法截图：当前进程运行在非交互会话（如 Windows 服务 / Session 0），系统禁止从该会话截取用户桌面（会得到黑屏）。请确认服务以用户会话方式运行（控制台会话可正常截图）。',
  'window-not-found': (extra) => `未找到匹配的窗口。请检查窗口标题或进程 PID。${extra ? `当前可见窗口参考：${extra}` : ''}`,
  'window-capture-failed': (extra) => `窗口截图失败：PrintWindow 无法捕获该窗口（常见于 UWP / 硬件加速 / 受保护窗口）。${extra ? `（${extra}）` : ''}`,
  'display-not-found': (extra) => `显示器编号不存在。${extra ? `${extra}。` : ''}可先用 target=primary 或 target=all 获取显示器列表。`,
  'capture-failed': (extra) => `屏幕捕获失败：${extra || 'CopyFromScreen 调用出错'}。可能原因：显示器已断开、显卡驱动异常或屏幕内容当前不可用（如显示器关闭）。`,
  'write-failed': (extra) => `截图文件写入失败：${extra || '未知原因'}`,
  'bad-target': (extra) => `未知的截图目标：${extra || '不支持的值'}`,
  timeout: () => `截图执行超时（超过 ${SCREENSHOT_TIMEOUT_MS / 1000} 秒）。可能原因：目标窗口无响应、系统负载过高或显示器状态异常。`,
  'exec-failed': (extra) => `截图进程启动/执行失败：${extra || '无法启动 PowerShell'}`,
  'parse-failed': (extra) => `截图结果解析失败：${extra || '脚本未输出预期结果'}`,
};

export function screenshotErrorText(code: ScreenshotErrorCode, extra?: string): string {
  const fn = SCREENSHOT_ERROR_TEXT[code];
  if (!fn) return `截图失败（未知错误码：${code}）${extra ? `：${extra}` : ''}`;
  return fn(extra);
}

// ───────────────────────── 内嵌 PowerShell 脚本（ASCII-only，无反引号/无 ${}，可安全内嵌模板字符串） ─────────────────────────

const SCREENSHOT_SCRIPT = `# screenshot.ps1 - pi agent screen capture (Windows only, ASCII-only source)
param([string]$ParamsFile)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Native {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

try { [Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { }

$script:monitors = @()

function Emit-Error([string]$code, [string]$extra) {
  $obj = @{ code = $code; message = $extra; monitors = $script:monitors }
  Write-Output ('SCREENSHOT_ERROR=' + ($obj | ConvertTo-Json -Compress -Depth 5))
  exit 1
}

function Emit-Result($files, $blank) {
  $obj = @{ files = $files; monitors = $script:monitors; blank = $blank }
  Write-Output ('SCREENSHOT_RESULT=' + ($obj | ConvertTo-Json -Compress -Depth 6))
  exit 0
}

# ---------- params ----------
$p = Get-Content $ParamsFile -Raw -Encoding UTF8 | ConvertFrom-Json

# ---------- session probe ----------
$sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
if ($sid -eq 0 -or -not [Environment]::UserInteractive) {
  Emit-Error 'no-interactive-session' ''
}

# ---------- monitors ----------
$screens = [System.Windows.Forms.Screen]::AllScreens
for ($i = 0; $i -lt $screens.Count; $i++) {
  $s = $screens[$i]
  $script:monitors += @{
    index = ($i + 1)
    name = $s.DeviceName
    x = $s.Bounds.X
    y = $s.Bounds.Y
    width = $s.Bounds.Width
    height = $s.Bounds.Height
    primary = [bool]$s.Primary
  }
}

# ---------- helpers ----------
function Save-Bitmap($bmp, [string]$path) {
  try { $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) }
  catch { Emit-Error 'write-failed' ("save to " + $path + " failed: " + $_.Exception.Message) }
}

function Get-Blank($bmp) {
  $hs = New-Object 'System.Collections.Generic.HashSet[int]'
  $sum = 0L; $n = 0
  for ($x = 0; $x -lt $bmp.Width; $x += 32) {
    for ($y = 0; $y -lt $bmp.Height; $y += 32) {
      $c = $bmp.GetPixel($x, $y)
      [void]$hs.Add($c.ToArgb())
      $sum += [int]$c.R + [int]$c.G + [int]$c.B
      $n++
    }
  }
  $avg = 255.0
  if ($n -gt 0) { $avg = ($sum / [double]$n) / 3.0 }
  return @{ unique = $hs.Count; avgLuma = [math]::Round($avg, 1) }
}

function Is-Blank($bk) {
  return (($bk.unique -le 2) -and ($bk.avgLuma -lt 250))
}

function Capture-ScreenRect($x, $y, $w, $h, [string]$path) {
  if ($w -le 0 -or $h -le 0) { Emit-Error 'capture-failed' 'invalid screen rect' }
  $b = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($b)
  try { $g.CopyFromScreen($x, $y, 0, 0, $b.Size) }
  catch { Emit-Error 'capture-failed' ($_.Exception.Message) }
  $g.Dispose()
  Save-Bitmap $b $path
  $bk = Get-Blank $b
  $b.Dispose()
  return @{ path = $path; width = $w; height = $h; blank = (Is-Blank $bk); unique = $bk.unique; luma = $bk.avgLuma }
}

function Capture-WindowByHandle($hwnd, [string]$path) {
  $rect = New-Object Native+RECT
  [Native]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { Emit-Error 'window-capture-failed' 'window rect is empty' }

  $wasMinimized = [Native]::IsIconic($hwnd)
  if ($wasMinimized) {
    # classic trick: restore -> move offscreen -> capture -> restore state
    [Native]::ShowWindow($hwnd, 9) | Out-Null
    Start-Sleep -Milliseconds 400
    [Native]::SetWindowPos($hwnd, [IntPtr]::Zero, -32000, -32000, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
    Start-Sleep -Milliseconds 400
    [Native]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
  }

  $b = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $hdc = $g.GetHdc()
  $ok = [Native]::PrintWindow($hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc)
  $g.Dispose()

  if ($wasMinimized) {
    # restore original minimized state after capture
    [Native]::ShowWindow($hwnd, 6) | Out-Null
  }

  if (-not $ok) {
    $b.Dispose()
    Emit-Error 'window-capture-failed' 'PrintWindow failed (UWP/hardware-accelerated/protected window?)'
  }
  Save-Bitmap $b $path
  $bk = Get-Blank $b
  $b.Dispose()
  return @{ path = $path; width = $w; height = $h; blank = (Is-Blank $bk); unique = $bk.unique; luma = $bk.avgLuma; restoredMinimized = $wasMinimized }
}

function Get-WindowList {
  $list = New-Object System.Collections.ArrayList
  $cb = [Native+EnumWindowsProc]{ param($h, $l)
    if ([Native]::IsWindowVisible($h)) {
      $len = [Native]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder($len + 1)
        [void][Native]::GetWindowText($h, $sb, $sb.Capacity)
        $pid2 = 0
        [void][Native]::GetWindowThreadProcessId($h, [ref]$pid2)
        [void]$list.Add(@{ hwnd = $h.ToInt64(); title = $sb.ToString(); pid = $pid2 })
      }
    }
    return $true
  }
  [void][Native]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

# ---------- dispatch ----------
$files = @()
$blankAny = $false
$target = [string]$p.target

if ($target -eq 'full') {
  # whole virtual desktop (note: may be very large on multi-monitor + high DPI)
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $r = Capture-ScreenRect $vs.X $vs.Y $vs.Width $vs.Height (Join-Path $p.outDir ($p.prefix + '.png'))
  $blankAny = [bool]$r.blank
  $files += @{ path = $r.path; width = $r.width; height = $r.height; display = 'all'; blank = $r.blank }
}
elseif ($target -eq 'primary') {
  $s = $screens | Where-Object { $_.Primary } | Select-Object -First 1
  if (-not $s) { Emit-Error 'capture-failed' 'no primary screen' }
  $r = Capture-ScreenRect $s.Bounds.X $s.Bounds.Y $s.Bounds.Width $s.Bounds.Height (Join-Path $p.outDir ($p.prefix + '.png'))
  $blankAny = [bool]$r.blank
  $files += @{ path = $r.path; width = $r.width; height = $r.height; display = $s.DeviceName; blank = $r.blank }
}
elseif ($target -eq 'all') {
  for ($i = 0; $i -lt $screens.Count; $i++) {
    $s = $screens[$i]
    $r = Capture-ScreenRect $s.Bounds.X $s.Bounds.Y $s.Bounds.Width $s.Bounds.Height (Join-Path $p.outDir (($p.prefix) + '_' + ($i + 1) + '.png'))
    if ($r.blank) { $blankAny = $true }
    $files += @{ path = $r.path; width = $r.width; height = $r.height; display = $s.DeviceName; blank = $r.blank }
  }
}
elseif ($target -eq 'display') {
  $idx = if ($p.display) { [int]$p.display } else { 1 }
  if ($idx -lt 1 -or $idx -gt $screens.Count) {
    Emit-Error 'display-not-found' ("display index " + $idx + " out of range, total " + $screens.Count)
  }
  $s = $screens[$idx - 1]
  $r = Capture-ScreenRect $s.Bounds.X $s.Bounds.Y $s.Bounds.Width $s.Bounds.Height (Join-Path $p.outDir ($p.prefix + '.png'))
  $blankAny = [bool]$r.blank
  $files += @{ path = $r.path; width = $r.width; height = $r.height; display = $s.DeviceName; blank = $r.blank }
}
elseif ($target -eq 'window') {
  $wins = Get-WindowList
  $cands = @()
  if ($p.pid -and [int64]$p.pid -gt 0) {
    $cands = @($wins | Where-Object { $_.pid -eq [int64]$p.pid })
  }
  elseif ($p.windowTitle) {
    $needle = [string]$p.windowTitle
    $cands = @($wins | Where-Object { $_.title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }
  else {
    $fg = [Native]::GetForegroundWindow()
    $cands = @($wins | Where-Object { $_.hwnd -eq $fg.ToInt64() })
  }
  if ($cands.Count -eq 0) {
    $titles = ($wins | Select-Object -First 15 | ForEach-Object { $_.title }) -join ' | '
    Emit-Error 'window-not-found' ("no matching window. current visible windows: " + $titles)
  }
  $win = $cands[0]
  $r = Capture-WindowByHandle ([IntPtr]$win.hwnd) (Join-Path $p.outDir ($p.prefix + '.png'))
  $blankAny = [bool]$r.blank
  $files += @{ path = $r.path; width = $r.width; height = $r.height; display = ('window:' + $win.title); blank = $r.blank; title = $win.title; pid = $win.pid }
}
else {
  Emit-Error 'bad-target' ("unknown target: " + $target)
}

Emit-Result $files $blankAny
`;

// ───────────────────────── 纯函数：解析 ps1 输出 ─────────────────────────

/**
 * 解析 screenshot.ps1 的单行结果标记（纯函数）。
 * - 有 SCREENSHOT_RESULT= / SCREENSHOT_ERROR= 行 → 解析对应结果（ps1 错误分支 exit 1 但带标记行，优先解析标记）；
 * - 无标记行：timeout（超时被 kill）> AbortError > exec-failed > parse-failed。
 */
export function parseScreenshotOutput(stdout: string, exitCode: number, error?: Error): ScreenshotResult {
  const line = stdout.split(/\r?\n/).find(
    (l) => l.startsWith('SCREENSHOT_RESULT=') || l.startsWith('SCREENSHOT_ERROR='),
  );
  if (line) {
    try {
      const json = JSON.parse(line.slice(line.indexOf('=') + 1)) as {
        code?: string;
        message?: string;
        files?: ScreenshotFile[];
        monitors?: ScreenInfo[];
        blank?: boolean;
      };
      if (line.startsWith('SCREENSHOT_ERROR=')) {
        const code = json.code as ScreenshotErrorCode;
        const extra = typeof json.message === 'string' && json.message.length > 0 ? json.message : undefined;
        return { ok: false, code, message: screenshotErrorText(code, extra), monitors: Array.isArray(json.monitors) ? json.monitors : [] };
      }
      const files = Array.isArray(json.files) ? json.files : [];
      const monitors = Array.isArray(json.monitors) ? json.monitors : [];
      if (files.length === 0) return { ok: false, code: 'parse-failed', message: screenshotErrorText('parse-failed', '脚本返回了空文件列表'), monitors };
      return { ok: true, files, monitors, blank: json.blank === true };
    } catch (e) {
      return { ok: false, code: 'parse-failed', message: screenshotErrorText('parse-failed', e instanceof Error ? e.message : String(e)), monitors: [] };
    }
  }
  if (error) {
    if (error.name === 'AbortError') return { ok: false, code: 'exec-failed', message: screenshotErrorText('exec-failed', '截图已被中止'), monitors: [] };
    const errno = error as NodeJS.ErrnoException & { killed?: boolean };
    if (errno.killed || errno.code === 'ETIMEDOUT') return { ok: false, code: 'timeout', message: screenshotErrorText('timeout'), monitors: [] };
    if (errno.code === 'ENOENT') return { ok: false, code: 'exec-failed', message: screenshotErrorText('exec-failed', '找不到 powershell.exe'), monitors: [] };
    return { ok: false, code: 'exec-failed', message: screenshotErrorText('exec-failed', error.message), monitors: [] };
  }
  return { ok: false, code: 'parse-failed', message: screenshotErrorText('parse-failed', `脚本未输出结果标记（exit=${exitCode}）`), monitors: [] };
}

/** 工具描述辅助：显示器信息 → 人类可读摘要（纯函数，供成功/错误结果展示） */
export function describeMonitors(monitors: ScreenInfo[]): string {
  if (monitors.length === 0) return '';
  return monitors
    .map((m) => `${m.index}:${m.name} ${m.width}x${m.height}${m.primary ? '(主)' : ''}`)
    .join('，');
}

// ───────────────────────── 执行器 ─────────────────────────

export type ScreenshotExecutor = (params: ScreenshotParams, signal?: AbortSignal) => Promise<ScreenshotResult>;

/**
 * 创建截图执行器：平台校验 → 写临时 ps1（UTF-8 BOM）与参数 JSON → spawn powershell → 解析标记行。
 * 截图文件输出到 screenshotRoot；成功后清理超出 SCREENSHOT_KEEP_COUNT 的旧文件。
 */
export function createScreenshotExecutor(): ScreenshotExecutor {
  return async (params, signal) => {
    if (process.platform !== 'win32') {
      return { ok: false, code: 'unsupported-platform', message: screenshotErrorText('unsupported-platform'), monitors: [] };
    }
    let tmpDir: string | undefined;
    try {
      await mkdir(screenshotRoot, { recursive: true });
      tmpDir = await mkdtemp(join(tmpdir(), 'lark-agent-os-shot-'));
      const scriptPath = join(tmpDir, 'shot.ps1');
      const paramsPath = join(tmpDir, 'params.json');
      // ps1 源内容全 ASCII，BOM 仅为防御 PowerShell 5.1 按系统 ANSI 解析的编码坑
      await writeFile(scriptPath, '\uFEFF' + SCREENSHOT_SCRIPT, 'utf8');
      // outDir/prefix 由执行器注入：输出到 screenshotRoot，文件名带时间戳+随机后缀避免并发/同秒覆盖
      await writeFile(paramsPath, JSON.stringify({
        ...params,
        outDir: screenshotRoot,
        prefix: `s${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      }), 'utf8');
      const { stdout, exitCode, error } = await runPowerShell(scriptPath, paramsPath, signal);
      const result = parseScreenshotOutput(stdout, exitCode, error);
      if (result.ok) await pruneScreenshots();
      return result;
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

function runPowerShell(
  scriptPath: string,
  paramsPath: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; exitCode: number; error?: Error }> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, paramsPath],
      {
        encoding: 'utf8',
        timeout: SCREENSHOT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        resolve({
          stdout,
          exitCode: error && typeof error.code === 'number' ? error.code : 0,
          error: error ?? undefined,
        });
      },
    );
  });
}

/** 截图目录保留最近 SCREENSHOT_KEEP_COUNT 张（按 mtime），清理失败不影响截图结果 */
async function pruneScreenshots(): Promise<void> {
  try {
    const entries = await readdir(screenshotRoot, { withFileTypes: true });
    const pngs = (
      await Promise.all(
        entries
          .filter((e) => e.isFile() && e.name.endsWith('.png'))
          .map(async (e) => {
            try {
              const st = await stat(join(screenshotRoot, e.name));
              return { name: e.name, mtime: st.mtimeMs };
            } catch {
              return null;
            }
          }),
      )
    )
      .filter((x): x is { name: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of pngs.slice(SCREENSHOT_KEEP_COUNT)) {
      await rm(join(screenshotRoot, f.name), { force: true }).catch(() => undefined);
    }
  } catch {
    // 清理失败不影响截图结果
  }
}

// ───────────────────────── 工具构建 ─────────────────────────

/** 构造可被 LLM 调用的 screenshot 工具定义（与 send_image 同模式） */
export function buildScreenshotTool(opts: {
  /** 惰性获取截图执行器（组装点注入；未装配返回 undefined） */
  screenshot: () => ScreenshotExecutor | undefined;
}): ToolDefinition {
  const { screenshot } = opts;
  return defineTool({
    name: 'screenshot',
    label: '屏幕截图',
    description: [
      '截取当前 Windows 系统屏幕，保存为 PNG 图片文件，返回本地文件路径。',
      'target 说明：primary=主显示器；all=每台显示器各一张（推荐，文件小）；display=N=第 N 台显示器（从 1 开始，可先用 target=all 查询显示器列表）；full=整块虚拟桌面拼接（多显示器 + 高 DPI 时文件可能很大）；window=指定窗口（配合 windowTitle 标题关键字模糊匹配，或 pid 进程号；两者都不给则截前台窗口）。',
      '窗口支持最小化状态：会自动在屏幕外还原捕获后恢复原状态；少数 UWP / 硬件加速窗口可能无法离屏捕获并返回明确错误。',
      '截图成功返回图片路径，请用 send_image 工具将图片发送给用户，并简要说明内容；若内容疑似空白（如显示器关闭/黑屏）会给出警告。',
      '不可用场景返回明确错误提示：非交互会话（服务）无法截图、窗口找不到、显示器编号不存在等。',
    ].join(' '),
    parameters: Type.Object({
      target: Type.Union(
        [
          Type.Literal('full'),
          Type.Literal('primary'),
          Type.Literal('all'),
          Type.Literal('display'),
          Type.Literal('window'),
        ],
        { description: '截图目标' },
      ),
      windowTitle: Type.Optional(Type.String({ description: 'target=window 时：窗口标题关键字（模糊匹配，不区分大小写）' })),
      pid: Type.Optional(Type.Number({ description: 'target=window 时：进程 PID（优先于 windowTitle）' })),
      display: Type.Optional(Type.Number({ description: 'target=display 时：显示器序号（从 1 开始；缺省 1）' })),
    }),
    async execute(_toolCallId, params, signal) {
      const executor = screenshot();
      if (!executor) {
        return { content: [{ type: 'text', text: '截图失败：截图执行器未装配。' }], details: {} };
      }
      const result = await executor({
        target: params.target,
        windowTitle: params.windowTitle,
        pid: params.pid,
        display: params.display,
      }, signal);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `截图失败：${result.message}` }], details: {} };
      }
      const lines = [`截图完成，共 ${result.files.length} 张：`];
      for (const f of result.files) {
        lines.push(`- ${f.path}（${f.width}x${f.height}，来源：${f.display}${f.blank ? '，⚠️ 内容疑似空白' : ''}）`);
      }
      if (result.blank) {
        lines.push('警告：截图内容疑似空白/纯色，可能原因：显示器关闭、系统锁屏、或目标窗口无法离屏渲染（UWP/硬件加速）。请确认屏幕可用后重试。');
      }
      lines.push(`可用 send_image 工具把图片发送给用户。显示器列表：${describeMonitors(result.monitors) || '无'}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    },
  });
}
