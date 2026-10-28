# Renders the canary while a hidden parent (no console, like an embedding app) watches for visible top-level windows.
param([Parameter(Mandatory)][string]$Cli, [Parameter(Mandatory)][string]$Project)
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
    $seen[$w[0]] = [pscustomobject]@{ Handle = $w[0]; Process = $proc.ProcessName; Class = $w[2]; Title = $w[3] }
  }
  $seen
}

$baseline = Snapshot
Write-Host "Visible top-level windows before the render: $($baseline.Count)"
$baseline.Values | Format-Table -AutoSize | Out-String | Write-Host

# The launcher has no console and no window, so any window below was created by the render's own children.
$launcher = Join-Path $env:RUNNER_TEMP 'launch-render.mjs'
@'
import { spawn } from "node:child_process";
const [cli, cwd] = process.argv.slice(2);
const child = spawn(process.execPath, [cli, "render", "--fps", "30", "--quality", "draft", "--workers", "2", "--output", "renders/probe.mp4"], { cwd, windowsHide: true, stdio: "ignore" });
child.on("exit", (code) => process.exit(code ?? 1));
'@ | Set-Content -Encoding utf8 $launcher

$render = Start-Process -FilePath node -ArgumentList @($launcher, $Cli, $Project) -WindowStyle Hidden -PassThru
$new = @{}
while (-not $render.HasExited) {
  foreach ($entry in (Snapshot).GetEnumerator()) {
    if (-not $baseline.ContainsKey($entry.Key) -and -not $new.ContainsKey($entry.Key)) { $new[$entry.Key] = $entry.Value }
  }
  Start-Sleep -Milliseconds 50
}
$render.WaitForExit()
Write-Host "Render exit code: $($render.ExitCode)"
Write-Host "New visible windows during the render: $($new.Count)"
$new.Values | Format-Table -AutoSize | Out-String | Write-Host
if ($render.ExitCode -ne 0) { throw "render failed" }
if ($new.Count -gt 0) { throw "the render opened $($new.Count) visible window(s)" }
