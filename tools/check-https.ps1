#requires -Version 5.1
param([string]$HostName = 'ipv4.rinkore.com', [int]$Port = 9000)
$ErrorActionPreference = 'Stop'
# curl validates the certificate chain and hostname by default; never use -k.
$headers = & curl.exe --silent --show-error --head --connect-timeout 8 --max-time 15 "https://${HostName}:$Port/"
if ($LASTEXITCODE -ne 0) { throw 'HTTPS certificate or connectivity check failed.' }
$headers
if (($headers -join "`n") -notmatch '(?im)^Strict-Transport-Security:\s*max-age=[1-9]') {
    throw 'HTTPS is reachable but HSTS is missing. Deploy the hardened server behind the trusted proxy.'
}
if (($headers -join "`n") -notmatch '(?im)^X-Frame-Options:\s*DENY') { throw 'Anti-framing header is missing.' }
$probe = & curl.exe --silent --output NUL --write-out '%{http_code}' --connect-timeout 5 --max-time 8 "http://${HostName}:9001/"
if ($LASTEXITCODE -eq 0) { throw "Port 9001 is publicly reachable (HTTP $probe). Stop the old listener and use loopback binding; remove external forwarding." }
Write-Host 'HTTPS certificate, HSTS and anti-framing checks passed; HTTP 9001 was not reachable from this machine.'
Write-Host 'Also verify the server listener is 127.0.0.1:9001 and repeat this check from an external network.'
