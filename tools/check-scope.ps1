[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$token = (Get-Content 'E:\niuniu\.deploy-token' -Raw).Trim()
$h = @{ Authorization = "token $token"; 'User-Agent' = 'nn-deploy' }
$resp = Invoke-WebRequest -Headers $h 'https://api.github.com/user'
Write-Output ("scopes=" + $resp.Headers['X-OAuth-Scopes'])
