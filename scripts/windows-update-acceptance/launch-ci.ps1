$ErrorActionPreference = 'Stop'
$started = [DateTime]::UtcNow
# 此入口只允许一次性 GitHub 托管 Windows VM，明确拒绝本机与自托管 runner。
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
    throw 'Native acceptance is restricted to GitHub-hosted Windows runners.'
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$root = 'C:\OpenCodexAcceptance'
$evidence = 'C:\AcceptanceOutput'
if (Test-Path -LiteralPath $root) { throw 'Acceptance workspace already exists; refusing to overwrite.' }
if (Test-Path -LiteralPath $evidence) { throw 'Acceptance evidence already exists; refusing to overwrite.' }
if (-not $env:RUNNER_TEMP) { throw 'Hosted runner temporary directory is missing.' }
$output = Join-Path $env:RUNNER_TEMP ('opencodex-native-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$buildLog = Join-Path $evidence 'build.log'
if (-not $env:ELECTRON_BUILDER_CACHE) {
    $knownCache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
    if (Test-Path -LiteralPath $knownCache) { $env:ELECTRON_BUILDER_CACHE = $knownCache }
}
# 构建只生成包；真正安装由带第二道环境检查的 guest-runner 执行。
& node (Join-Path $PSScriptRoot 'build.cjs') $output 2>&1 | Tee-Object -FilePath $buildLog
if ($LASTEXITCODE -ne 0) { throw ('Acceptance fixture build failed with code ' + $LASTEXITCODE) }
New-Item -ItemType Directory -Path $root | Out-Null
Copy-Item -LiteralPath (Join-Path $output 'inputs') -Destination (Join-Path $root 'inputs') -Recurse
@{ purpose = 'opencodex-native-update-acceptance'; isolated = $true; environment = 'github-hosted' } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $root 'ISOLATED-SANDBOX.json') -Encoding ascii
Copy-Item -LiteralPath (Join-Path $root 'inputs\manifest.json') -Destination (Join-Path $evidence 'manifest.json')
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $root 'inputs\node-host\OpenCodexAcceptanceHost.exe'
$start.Arguments = '"C:\OpenCodexAcceptance\inputs\guest-runner.cjs" --run-github-hosted'
$start.WorkingDirectory = $root
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
if (-not $process.Start()) { throw 'Could not start isolated acceptance runner.' }
$stdoutFile = Join-Path $evidence 'stdout.log'
$lineTask = $process.StandardOutput.ReadLineAsync()
$stderr = $process.StandardError.ReadToEndAsync()
while ($true) {
    if ($lineTask.Wait(1000)) {
        $line = $lineTask.GetAwaiter().GetResult()
        if ($null -eq $line) { break }
        $line | Add-Content -LiteralPath $stdoutFile
        Write-Output $line
        $lineTask = $process.StandardOutput.ReadLineAsync()
    }
    if (([DateTime]::UtcNow - $started).TotalMinutes -ge 20) {
        # 不按名称或未核验 PID 强杀；让一次性 VM 销毁现场，保留已导出的证据。
        'Acceptance exceeded the 20-minute overall limit; process ownership is not assumed for cleanup.' | Set-Content -LiteralPath (Join-Path $evidence 'timeout.txt')
        throw 'Native acceptance timed out.'
    }
}
$remaining = [Math]::Max(1, 1200000 - [int]([DateTime]::UtcNow - $started).TotalMilliseconds)
if (-not $process.WaitForExit($remaining)) { throw 'Acceptance did not exit within its total time limit.' }
$stderr.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $evidence 'stderr.log')
if ($process.ExitCode -ne 0) { throw ('Native acceptance exited ' + $process.ExitCode + '; inspect AcceptanceOutput artifacts.') }
$result = Get-Content -LiteralPath (Join-Path $evidence 'result.json') -Raw | ConvertFrom-Json
if ($result.passed -ne $true -or $result.finalProcessStopped -ne $true) { throw 'Native acceptance did not confirm all scenarios and owned-process cleanup.' }
Write-Output 'Native Windows upgrade and controlled rollback acceptance passed.'
