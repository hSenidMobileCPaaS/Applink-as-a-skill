<#
.SYNOPSIS
    Applink smoke tests (Windows / PowerShell).

.DESCRIPTION
    Verifies credentials, IP provisioning, and every endpoint you have
    configured.

    Only the services with a URL set in your environment are tested — an unset
    endpoint means that API is not enabled on your application, so there is
    nothing to test. Configure them in .env; see templates/.env.example.

    RUN THIS FROM THE SERVER THAT WILL CALL APPLINK. Running it from a laptop
    tests the laptop's IP, which is not what you provisioned.

    Credentials come from the environment. Never paste them into this file.

.EXAMPLE
    .\scripts\smoke-test.ps1

.EXAMPLE
    .\scripts\smoke-test.ps1 -WithSms -TestMsisdn 8801959979376
#>
[CmdletBinding()]
param(
    [switch]$WithSms,
    [switch]$WithCharge,
    [string]$TestMsisdn = $(if ($env:TEST_MSISDN) { $env:TEST_MSISDN } else { "8801959979376" })
)

# Load .env if present (KEY=VALUE lines, skipping comments).
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
            Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"').Trim()
        }
    }
}

if (-not $env:APPLINK_APP_ID)   { throw "Set APPLINK_APP_ID (see templates/.env.example)" }
if (-not $env:APPLINK_PASSWORD) { throw "Set APPLINK_PASSWORD (see templates/.env.example)" }

$script:Pass = 0
$script:Fail = 0
$script:Skip = 0

function Skip-Test {
    param([string]$Name, [string]$Reason)
    Write-Host ("{0,-28}" -f $Name) -NoNewline
    Write-Host $Reason -ForegroundColor DarkGray
    $script:Skip++
}

function Invoke-ApplinkCall {
    param([string]$Name, [string]$Url, [hashtable]$Body)

    Write-Host ("{0,-28}" -f $Name) -NoNewline

    $payload = ($Body + @{
        applicationId = $env:APPLINK_APP_ID
        password      = $env:APPLINK_PASSWORD
    }) | ConvertTo-Json -Depth 5 -Compress

    try {
        $response = Invoke-RestMethod -Uri $Url -Method Post `
            -ContentType 'application/json;charset=utf-8' -Body $payload -TimeoutSec 20
    }
    catch {
        Write-Host "NO RESPONSE" -ForegroundColor Red -NoNewline
        Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
        $script:Fail++
        return
    }

    switch -Regex ($response.statusCode) {
        '^S1000$' { Write-Host "S1000 OK" -ForegroundColor Green; $script:Pass++ }
        '^P1003$' { Write-Host "P1003" -ForegroundColor Yellow -NoNewline
                    Write-Host "  OTP sent to the subscriber - the charge is NOT complete" -ForegroundColor DarkGray
                    $script:Pass++ }
        '^E1303$' { Write-Host "E1303" -ForegroundColor Red -NoNewline
                    Write-Host "  This IP is not provisioned. Run: curl -4 https://api.ipify.org" -ForegroundColor DarkGray
                    $script:Fail++ }
        '^E1313$' { Write-Host "E1313" -ForegroundColor Red -NoNewline
                    Write-Host "  Auth failure - check APPLINK_APP_ID / APPLINK_PASSWORD" -ForegroundColor DarkGray
                    $script:Fail++ }
        '^E1309$' { Write-Host "E1309" -ForegroundColor Yellow -NoNewline
                    Write-Host "  Service not provisioned - remove this URL from your .env" -ForegroundColor DarkGray
                    $script:Fail++ }
        '^E1343$' { Write-Host "E1343" -ForegroundColor Yellow -NoNewline
                    Write-Host "  $TestMsisdn is not whitelisted on this application" -ForegroundColor DarkGray
                    $script:Fail++ }
        '^E1326$' { Write-Host "E1326" -ForegroundColor Yellow -NoNewline
                    Write-Host "  Insufficient balance on $TestMsisdn" -ForegroundColor DarkGray
                    $script:Fail++ }
        default   { Write-Host "$($response.statusCode)" -ForegroundColor Red -NoNewline
                    Write-Host "  $($response.statusDetail)" -ForegroundColor DarkGray
                    $script:Fail++ }
    }
}

Write-Host ""
Write-Host "Applink smoke test"
Write-Host "  app id     $($env:APPLINK_APP_ID)"
Write-Host "  password   ***redacted***"
try {
    Write-Host "  egress IP  $(Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 10)"
} catch {
    Write-Host "  egress IP  (could not determine)"
}
Write-Host "             ^ this must be in your application's allowed host addresses"
Write-Host ""

Write-Host "-- Subscription --------------------------------"
if ($env:APPLINK_SUBSCRIPTION_QUERY_BASE_URL) {
    Invoke-ApplinkCall "Base Size" $env:APPLINK_SUBSCRIPTION_QUERY_BASE_URL @{}
} else { Skip-Test "Base Size" "APPLINK_SUBSCRIPTION_QUERY_BASE_URL not set" }

if ($env:APPLINK_SUBSCRIPTION_CHARGING_INFO_URL) {
    Invoke-ApplinkCall "Subscriber charging info" $env:APPLINK_SUBSCRIPTION_CHARGING_INFO_URL `
        @{ subscriberIds = @("tel:$TestMsisdn") }
} else { Skip-Test "Subscriber charging info" "APPLINK_SUBSCRIPTION_CHARGING_INFO_URL not set" }

if ($env:APPLINK_SUBSCRIPTION_SEND_URL) {
    Invoke-ApplinkCall "Register (opt-in)"    $env:APPLINK_SUBSCRIPTION_SEND_URL @{ subscriberId = "tel:$TestMsisdn"; action = "1" }
    Invoke-ApplinkCall "Unregister (opt-out)" $env:APPLINK_SUBSCRIPTION_SEND_URL @{ subscriberId = "tel:$TestMsisdn"; action = "0" }
    Write-Host "  Read subscriptionStatus in each response - Applink publishes no" -ForegroundColor DarkGray
    Write-Host "  'already registered' code, so the body is what tells you the state." -ForegroundColor DarkGray
} else { Skip-Test "Register / Unregister" "APPLINK_SUBSCRIPTION_SEND_URL not set" }

Write-Host ""
Write-Host "-- CaaS ----------------------------------------"
if ($env:APPLINK_CAAS_BALANCE_URL) {
    Invoke-ApplinkCall "Query Balance" $env:APPLINK_CAAS_BALANCE_URL @{
        subscriberId = "tel:$TestMsisdn"; paymentInstrumentName = "MobileAccount"; currency = "BDT"
    }
} else { Skip-Test "Query Balance" "APPLINK_CAAS_BALANCE_URL not set" }

if (-not $env:APPLINK_CAAS_DEBIT_URL) {
    Skip-Test "CaaS OTP Generation" "APPLINK_CAAS_DEBIT_URL not set"
} elseif (-not $WithCharge) {
    Skip-Test "CaaS OTP Generation" "skipped (-WithCharge to run - starts a real charge)"
} else {
    Write-Host "  !! This STARTS a real charge against $TestMsisdn." -ForegroundColor Yellow
    Write-Host "     P1003 means an OTP was sent; the money only moves once that OTP is verified." -ForegroundColor Yellow
    $trxId = [guid]::NewGuid().ToString("N")
    Write-Host "  externalTrxId: $trxId  (persist this BEFORE charging, in real code)" -ForegroundColor DarkGray
    Invoke-ApplinkCall "CaaS OTP Generation (BDT 1)" $env:APPLINK_CAAS_DEBIT_URL @{
        externalTrxId         = $trxId
        amount                = "1.00"
        paymentInstrumentName = "Mobile Account"
        subscriberId          = "tel:$TestMsisdn"
        Currency              = "BDT"
    }
    Write-Host "  Persist requestCorrelator from that response - it is the referenceNo" -ForegroundColor DarkGray
    Write-Host "  the verification step needs, and it cannot be recovered." -ForegroundColor DarkGray
}

if (-not $env:APPLINK_CAAS_OTP_VERIFY_URL) {
    Skip-Test "CaaS OTP Verification" "APPLINK_CAAS_OTP_VERIFY_URL not set"
} else {
    Skip-Test "CaaS OTP Verification" "needs a real OTP from the subscriber - not scriptable"
}

Write-Host ""
Write-Host "-- SMS -----------------------------------------"
if (-not $env:APPLINK_SMS_SEND_URL) {
    Skip-Test "SMS Send" "APPLINK_SMS_SEND_URL not set"
} elseif (-not $WithSms) {
    Skip-Test "SMS Send" "skipped (-WithSms to run - sends a real SMS)"
} else {
    Invoke-ApplinkCall "SMS Send" $env:APPLINK_SMS_SEND_URL @{
        version = "1.0"; message = "Applink smoke test"; destinationAddresses = @("tel:$TestMsisdn")
    }
}

Write-Host ""
Write-Host "-- USSD / OTP ----------------------------------"
if ($env:APPLINK_USSD_SEND_URL) {
    Skip-Test "USSD Send" "needs a live sessionId from an inbound session - not scriptable"
} else { Skip-Test "USSD Send" "APPLINK_USSD_SEND_URL not set" }

if ($env:APPLINK_OTP_REQUEST_URL) {
    Skip-Test "Request OTP" "sends a real SMS - run it by hand when you mean to"
} else { Skip-Test "Request OTP" "APPLINK_OTP_REQUEST_URL not set" }

Write-Host ""
Write-Host "-----------------------------------------------"
Write-Host "  passed $($script:Pass)" -ForegroundColor Green -NoNewline
Write-Host "   failed $($script:Fail)" -ForegroundColor Red -NoNewline
Write-Host "   skipped $($script:Skip)" -ForegroundColor DarkGray
if ($script:Pass -eq 0 -and $script:Fail -eq 0) {
    Write-Host "  Nothing ran - no service endpoints are configured in .env." -ForegroundColor Yellow
}
Write-Host ""

if ($script:Fail -gt 0) { exit 1 }
