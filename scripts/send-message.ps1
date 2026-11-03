# Requires the project's pnpm installation and an authenticated Wrangler account.
# Creates a temporary workspace API key, sends one message, then revokes the key.
[CmdletBinding()]
param(
    [string]$To,
    [string]$Text = "Halo, ini pesan tes dari Replyloom via PowerShell.",
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$SessionId,
    [string]$EngineUrl,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workerConfig = Join-Path $repoRoot 'apps/worker/wrangler.jsonc'

function Invoke-ReplyloomSql([string]$Sql) {
    $output = & pnpm --filter worker exec wrangler d1 execute replyloom_db `
        --config $workerConfig --remote --command $Sql --json
    if ($LASTEXITCODE -ne 0) {
        throw 'Wrangler gagal. Pastikan pnpm tersedia dan Anda sudah wrangler login.'
    }
    $result = @(($output -join "`n") | ConvertFrom-Json)
    if ($result.Count -eq 0 -or @($result | Where-Object { -not $_.success }).Count -gt 0) {
        throw 'Query database gagal.'
    }
    foreach ($statement in $result) {
        $statement.results
    }
}

function ConvertTo-SqlLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

Push-Location $repoRoot
try {
    $filter = ''
    if ($SessionId) {
        $filter = 'WHERE id = ' + (ConvertTo-SqlLiteral $SessionId)
    }
    $sessions = @(Invoke-ReplyloomSql "SELECT id, workspace_id, label, status FROM wa_sessions $filter ORDER BY created_at DESC, id DESC LIMIT 21")
    if ($CheckOnly) {
        $sessions | Select-Object id, label, status | Format-Table -AutoSize
        return
    }
    if ($sessions.Count -eq 0) {
        throw 'Sesi tidak ditemukan. Hubungkan WhatsApp melalui halaman Integrations.'
    }
    if ($sessions.Count -ne 1) {
        $sessions | Select-Object id, label, status | Format-Table -AutoSize | Out-Host
        throw 'Pilih nomor pengirim dengan parameter -SessionId dari daftar di atas (maksimal 21 sesi).'
    }
    $session = $sessions[0]
    if ($session.status -ne 'connected') {
        throw 'WhatsApp belum connected. Buka aplikasi > Integrations > Connect terlebih dahulu.'
    }
    if ([string]::IsNullOrWhiteSpace($To) -or [string]::IsNullOrWhiteSpace($Text)) {
        throw 'Isi -To dengan nomor tujuan dan -Text dengan pesan.'
    }
    $recipient = $To -replace '\D', ''
    if ($recipient.StartsWith('0')) {
        $recipient = '62' + $recipient.Substring(1)
    }
    if ($recipient -notmatch '^[1-9][0-9]{7,14}$') {
        throw 'Nomor tujuan tidak valid. Contoh format Indonesia: 08... atau 628...'
    }

    if (-not $EngineUrl) {
        $productionEnv = Join-Path $repoRoot 'apps/web/.env.production'
        $engineLine = Get-Content -LiteralPath $productionEnv | Where-Object { $_ -match '^VITE_ENGINE_URL=' } | Select-Object -First 1
        if (-not $engineLine) { throw 'VITE_ENGINE_URL belum diatur. Isi parameter -EngineUrl.' }
        $EngineUrl = ($engineLine -replace '^VITE_ENGINE_URL=', '').Trim().Trim('"').Trim("'")
    }
    $engineUri = [uri]$EngineUrl
    if (-not $engineUri.IsAbsoluteUri -or $engineUri.Scheme -ne 'https' -or $engineUri.UserInfo -or $engineUri.Query -or $engineUri.Fragment) {
        throw '-EngineUrl harus berupa URL HTTPS engine.'
    }
    $sessionUrl = $EngineUrl.TrimEnd('/') + '/session/' + $session.id

    $randomBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
    $apiKey = 'wa_' + [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $keyHash = [BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($apiKey))).Replace('-', '').ToLowerInvariant()
    } finally { $sha256.Dispose() }
    $keyId = [guid]::NewGuid().ToString()
    $workspaceSql = ConvertTo-SqlLiteral $session.workspace_id
    $headers = @{ Authorization = "Bearer $apiKey" }

    try {
        $null = Invoke-ReplyloomSql "INSERT INTO api_keys (id, workspace_id, name, key_hash) VALUES ('$keyId', $workspaceSql, 'PowerShell temporary test', '$keyHash')"
        $live = Invoke-RestMethod -Uri $sessionUrl -Headers $headers -Method Get -TimeoutSec 30
        if ($live.connection -ne 'connected') {
            throw 'Sesi WhatsApp belum siap. Hubungkan kembali melalui Integrations lalu coba lagi.'
        }
        Write-Host ("Mengirim satu pesan melalui sesi: {0}" -f $session.label)
        $body = @{ to = $recipient; text = $Text } | ConvertTo-Json -Compress
        $response = Invoke-RestMethod -Uri "$sessionUrl/send" -Method Post -Headers $headers `
            -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 60
        $response | ConvertTo-Json -Depth 8
    } catch {
        if ($_.ErrorDetails.Message) {
            throw ("Request gagal: " + $_.ErrorDetails.Message)
        }
        throw
    } finally {
        try {
            $null = Invoke-ReplyloomSql "DELETE FROM api_keys WHERE id = '$keyId' AND workspace_id = $workspaceSql"
        } catch {
            Write-Warning "Key sementara belum berhasil dihapus. Hapus api_keys dengan id $keyId pada workspace terkait."
        }
        $headers.Clear()
        $apiKey = $null
    }
} finally {
    Pop-Location
}
