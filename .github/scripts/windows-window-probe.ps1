# Renders the canary while a hidden parent (no console, like an embedding app) watches for visible top-level windows.
param([Parameter(Mandatory)][string]$Cli, [Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Chrome)
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Windows {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string[]> Visible() {
    var rows = new List<string[]>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(256); var c = new StringBuilder(256);
      GetWindowText(h, t, 256); GetClassName(h, c, 256);
      rows.Add(new[] { h.ToString(), pid.ToString(), c.ToString(), t.ToString() });
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@

function Snapshot {
  $seen = @{}
  foreach ($w in [Windows]::Visible()) {
    $proc = Get-Process -Id ([int]$w[1]) -ErrorAction SilentlyContinue
    $seen[$w[0]] = [pscustomobject]@{ Handle = $w[0]; Pid = $w[1]; Process = $proc.ProcessName; Class = $w[2]; Title = $w[3]; Detail = '' }
  }
  $seen
}

$baseline = Snapshot
Write-Host "Visible top-level windows before the render: $($baseline.Count)"
$baseline.Values | Format-Table -AutoSize | Out-String | Write-Host

function Watch([string[]]$NodeArgs) {
  $script:baseline = Snapshot
  $p = Start-Process -FilePath node -ArgumentList $NodeArgs -WindowStyle Hidden -PassThru
  $found = @{}
  $script:procs = @{}
  while (-not $p.HasExited) {
    foreach ($q in (Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|ffmpeg|ffprobe|powershell|pwsh|nvidia|cmd|conhost|node' })) {
      if (-not $script:procs.ContainsKey($q.ProcessId)) { $script:procs[$q.ProcessId] = "$($q.Name) pid=$($q.ProcessId) ppid=$($q.ParentProcessId) cmd=[$(($q.CommandLine -replace '\s+',' ').Substring(0, [Math]::Min(170, "$($q.CommandLine)".Length)))]" }
    }
    foreach ($entry in (Snapshot).GetEnumerator()) {
      if (-not $baseline.ContainsKey($entry.Key) -and -not $found.ContainsKey($entry.Key)) { $found[$entry.Key] = $entry.Value }
    }
    Start-Sleep -Milliseconds 50
  }
  $p.WaitForExit()
  [pscustomobject]@{ Exit = $p.ExitCode; Windows = $found }
}

# The launcher has no console and no window, so any window below was created by its own children.
$spawn = Join-Path $env:GITHUB_WORKSPACE '.github/scripts/spawn-probe.mjs'
$ffmpeg = (Get-Command ffmpeg.exe).Source
$ffprobe = (Get-Command ffprobe.exe).Source
Write-Host "--- one spawn at a time (windowsHide: true) ---"
foreach ($target in @(@('chrome', $Chrome), @('ffmpeg', $ffmpeg), @('ffprobe', $ffprobe))) {
  foreach ($detached in @('0', '1')) {
    $r = Watch @($spawn, $target[1], $detached)
    Write-Host ("{0,-8} detached={1} -> {2} new window(s)" -f $target[0], $detached, $r.Windows.Count)
    $r.Windows.Values | ForEach-Object { Write-Host "    $($_.Process) class=$($_.Class) title=[$($_.Title)]" }
  }
}

$r = Watch @($spawn, $Chrome, '0', '1')
Write-Host ("chrome   nested -> {0} new window(s)" -f $r.Windows.Count)
$r.Windows.Values | ForEach-Object { Write-Host "    $($_.Process) class=$($_.Class) title=[$($_.Title)]" }

Write-Host "--- full render ---"
$launcher = Join-Path $env:RUNNER_TEMP 'launch-render.mjs'
@'
import { spawn } from "node:child_process";
const [cli, cwd] = process.argv.slice(2);
const child = spawn(process.execPath, [cli, "render", "--fps", "30", "--quality", "draft", "--workers", "2", "--output", "renders/probe.mp4"], { cwd, windowsHide: true, stdio: "ignore" });
child.on("exit", (code) => process.exit(code ?? 1));
'@ | Set-Content -Encoding utf8 $launcher
$render = Watch @($launcher, $Cli, $Project)
$script:procs.Values | Sort-Object | ForEach-Object { Write-Host "proc $_" }
Write-Host "Render exit code: $($render.Exit)"
Write-Host "New visible windows during the render: $($render.Windows.Count)"
$render.Windows.Values | ForEach-Object { Write-Host "$($_.Process) class=$($_.Class) title=[$($_.Title)]" }
if ($render.Exit -ne 0) { throw "render failed" }
if ($render.Windows.Count -gt 0) { throw "the render opened $($render.Windows.Count) visible window(s)" }
