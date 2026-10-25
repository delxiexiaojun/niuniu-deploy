[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$token = (Get-Content 'E:\niuniu\.deploy-token' -Raw).Trim()
$h = @{ Authorization = "token $token"; 'User-Agent' = 'nn-deploy' }
try {
  $r = Invoke-RestMethod -Headers $h 'https://api.github.com/repos/delxiexiaojun/niuniu-deploy'
  Write-Output "repo exists: $($r.full_name) private=$($r.private)"
} catch {
  Write-Output "repo GET failed: $($_.Exception.Message)"
  try {
    $body = @{ name = 'niuniu-deploy'; private = $false; description = 'niuniu p2p game pages' } | ConvertTo-Json
    $r = Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' -Body $body 'https://api.github.com/user/repos'
    Write-Output "repo created: $($r.full_name)"
  } catch {
    Write-Output "repo create failed: $($_.Exception.Message)"
  }
}
try {
  $p = Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' -Body '{"source":{"branch":"main","path":"/"}}' 'https://api.github.com/repos/delxiexiaojun/niuniu-deploy/pages'
  Write-Output "pages enabled: $($p.html_url)"
} catch {
  Write-Output "pages: $($_.Exception.Message)"
}
