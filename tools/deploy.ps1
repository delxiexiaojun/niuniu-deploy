# 部署 E:\niuniu 到 GitHub Pages（delxiexiaojun/niuniu-deploy）。
# token 不落盘：运行前设置 $env:NN_GH_TOKEN，脚本只从环境变量读取。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$token = $env:NN_GH_TOKEN
if (-not $token -and (Test-Path 'E:\niuniu\.deploy-token')) {
  $token = (Get-Content 'E:\niuniu\.deploy-token' -Raw).Trim()
}
if (-not $token) { Write-Error '未找到 token（环境变量 NN_GH_TOKEN 或 E:\niuniu\.deploy-token）'; exit 1 }
$h = @{ Authorization = "token $token"; 'User-Agent' = 'nn-deploy' }
$me = Invoke-RestMethod -Headers $h 'https://api.github.com/user'
Write-Output "login=$($me.login)"

$root = 'E:\niuniu'
$files = @(
  'index.html', 'css/style.css',
  'js/evaluator.js', 'js/game.js', 'js/peerjs.min.js', 'js/peer.js', 'js/net.js', 'js/app.js', 'js/sound.js',
  'package.json', 'render.yaml',
  'server/rooms.js', 'server/ws.js', 'server/index.js',
  'tools/RENDER.md'
) +
  (Get-ChildItem "$root\audio\*.mp3" | ForEach-Object { 'audio/' + $_.Name })
$ok = 0; $fail = @()
foreach ($f in $files) {
  $bytes = [IO.File]::ReadAllBytes("$root\" + ($f -replace '/', '\'))
  $b64 = [Convert]::ToBase64String($bytes)
  $sha = $null
  try {
    $cur = Invoke-RestMethod -Headers $h "https://api.github.com/repos/delxiexiaojun/niuniu-deploy/contents/$f`?ref=main"
    $sha = $cur.sha
  } catch {}
  $body = @{ message = "deploy: $f"; content = $b64; branch = 'main' }
  if ($sha) { $body.sha = $sha }
  try {
    Invoke-RestMethod -Method Put -Headers $h -ContentType 'application/json' -Body ($body | ConvertTo-Json) "https://api.github.com/repos/delxiexiaojun/niuniu-deploy/contents/$f" | Out-Null
    $ok++; Write-Output "OK $f"
  } catch {
    $fail += $f; Write-Output "FAIL $f $($_.Exception.Message)"
  }
}
Write-Output "done ok=$ok fail=$($fail.Count)"
if ($fail.Count) { exit 2 }
