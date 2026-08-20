#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Applink smoke tests
#
# Verifies credentials, IP provisioning, and every endpoint you have configured.
#
# Only the services with a URL set in your environment are tested — an unset
# endpoint means that API is not enabled on your application, so there is
# nothing to test. Configure them in .env; see templates/.env.example.
#
# Usage:
#   cp templates/.env.example .env && $EDITOR .env
#   ./scripts/smoke-test.sh                 # safe tests only
#   ./scripts/smoke-test.sh --with-sms      # also sends a real SMS
#   ./scripts/smoke-test.sh --with-charge   # also STARTS a real charge
#
# RUN THIS FROM THE SERVER THAT WILL CALL APPLINK. Running it from a laptop
# tests the laptop's IP, which is not what you provisioned, and E1303 will tell
# you nothing useful.
#
# Credentials come from the environment. Never paste them into this file.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

[ -f .env ] && set -a && . ./.env && set +a

: "${APPLINK_APP_ID:?Set APPLINK_APP_ID (see templates/.env.example)}"
: "${APPLINK_PASSWORD:?Set APPLINK_PASSWORD (see templates/.env.example)}"

# A number on your application's whitelist.
TEST_MSISDN="${TEST_MSISDN:-8801959979376}"

WITH_SMS=false; WITH_CHARGE=false
for arg in "$@"; do
  case "$arg" in
    --with-sms) WITH_SMS=true ;;
    --with-charge) WITH_CHARGE=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
PASS=0; FAIL=0; SKIP=0

skip() { printf '%-28s%s\n' "$1" "${DIM}$2${NC}"; SKIP=$((SKIP+1)); }

# call <name> <url> <json-body>
call() {
  local name="$1" url="$2" body="$3"
  printf '%-28s' "$name"
  local response
  response=$(curl -sS --max-time 20 -X POST "$url" \
    -H 'Content-Type: application/json;charset=utf-8' --data "$body" 2>&1)

  if [ -z "$response" ]; then
    echo "${RED}NO RESPONSE${NC}  (network, firewall, or TLS chain problem)"
    FAIL=$((FAIL+1)); return
  fi

  local code
  code=$(printf '%s' "$response" | grep -o '"statusCode"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([SEP][0-9]*\)"/\1/')

  case "$code" in
    S1000) echo "${GREEN}S1000 OK${NC}"; PASS=$((PASS+1)) ;;
    P1003) echo "${YELLOW}P1003${NC}  OTP sent to the subscriber — the charge is NOT complete"; PASS=$((PASS+1)) ;;
    E1303) echo "${RED}E1303${NC}  This IP is not provisioned. Run: curl -4 https://api.ipify.org"; FAIL=$((FAIL+1)) ;;
    E1313) echo "${RED}E1313${NC}  Auth failure — check APPLINK_APP_ID / APPLINK_PASSWORD"; FAIL=$((FAIL+1)) ;;
    E1309) echo "${YELLOW}E1309${NC}  Service not provisioned — remove this URL from your .env"; FAIL=$((FAIL+1)) ;;
    E1343) echo "${YELLOW}E1343${NC}  $TEST_MSISDN is not whitelisted on this application"; FAIL=$((FAIL+1)) ;;
    E1326) echo "${YELLOW}E1326${NC}  Insufficient balance on $TEST_MSISDN"; FAIL=$((FAIL+1)) ;;
    "")    echo "${RED}NO statusCode${NC}"; echo "${DIM}  $response${NC}"; FAIL=$((FAIL+1)) ;;
    *)     echo "${RED}${code}${NC}"; echo "${DIM}  $response${NC}"; FAIL=$((FAIL+1)) ;;
  esac
}

creds="\"applicationId\":\"$APPLINK_APP_ID\",\"password\":\"$APPLINK_PASSWORD\""

echo
echo "Applink smoke test"
echo "  app id     $APPLINK_APP_ID"
echo "  password   ***redacted***"
echo "  egress IP  $(curl -4 -sS --max-time 10 https://api.ipify.org 2>/dev/null || echo '(could not determine)')"
echo "             ^ this must be in your application's allowed host addresses"
echo

# ── Subscription ────────────────────────────────────────────────────────────
echo "── Subscription ────────────────────────────────"
if [ -n "${APPLINK_SUBSCRIPTION_QUERY_BASE_URL:-}" ]; then
  call "Base Size" "$APPLINK_SUBSCRIPTION_QUERY_BASE_URL" "{$creds}"
else
  skip "Base Size" "APPLINK_SUBSCRIPTION_QUERY_BASE_URL not set"
fi

if [ -n "${APPLINK_SUBSCRIPTION_CHARGING_INFO_URL:-}" ]; then
  call "Subscriber charging info" "$APPLINK_SUBSCRIPTION_CHARGING_INFO_URL" \
    "{$creds,\"subscriberIds\":[\"tel:$TEST_MSISDN\"]}"
else
  skip "Subscriber charging info" "APPLINK_SUBSCRIPTION_CHARGING_INFO_URL not set"
fi

if [ -n "${APPLINK_SUBSCRIPTION_SEND_URL:-}" ]; then
  call "Register (opt-in)" "$APPLINK_SUBSCRIPTION_SEND_URL" \
    "{$creds,\"subscriberId\":\"tel:$TEST_MSISDN\",\"action\":\"1\"}"
  call "Unregister (opt-out)" "$APPLINK_SUBSCRIPTION_SEND_URL" \
    "{$creds,\"subscriberId\":\"tel:$TEST_MSISDN\",\"action\":\"0\"}"
  echo "${DIM}  Read subscriptionStatus in each response — Applink publishes no${NC}"
  echo "${DIM}  'already registered' code, so the body is what tells you the state.${NC}"
else
  skip "Register / Unregister" "APPLINK_SUBSCRIPTION_SEND_URL not set"
fi

# ── CaaS ────────────────────────────────────────────────────────────────────
echo
echo "── CaaS ────────────────────────────────────────"
if [ -n "${APPLINK_CAAS_BALANCE_URL:-}" ]; then
  call "Query Balance" "$APPLINK_CAAS_BALANCE_URL" \
    "{$creds,\"subscriberId\":\"tel:$TEST_MSISDN\",\"paymentInstrumentName\":\"MobileAccount\",\"currency\":\"BDT\"}"
else
  skip "Query Balance" "APPLINK_CAAS_BALANCE_URL not set"
fi

if [ -z "${APPLINK_CAAS_DEBIT_URL:-}" ]; then
  skip "CaaS OTP Generation" "APPLINK_CAAS_DEBIT_URL not set"
elif [ "$WITH_CHARGE" != true ]; then
  skip "CaaS OTP Generation" "skipped (--with-charge to run — starts a real charge)"
else
  echo "${YELLOW}  ⚠  This STARTS a real charge against $TEST_MSISDN.${NC}"
  echo "${YELLOW}     P1003 means an OTP was sent; the money only moves if that OTP${NC}"
  echo "${YELLOW}     is then verified at ${APPLINK_CAAS_OTP_VERIFY_URL:-<APPLINK_CAAS_OTP_VERIFY_URL>}.${NC}"
  TRX_ID=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  echo "${DIM}  externalTrxId: $TRX_ID  (persist this BEFORE charging, in real code)${NC}"
  call "CaaS OTP Generation (BDT 1)" "$APPLINK_CAAS_DEBIT_URL" \
    "{$creds,\"externalTrxId\":\"$TRX_ID\",\"amount\":\"1.00\",\"paymentInstrumentName\":\"Mobile Account\",\"subscriberId\":\"tel:$TEST_MSISDN\",\"Currency\":\"BDT\"}"
  echo "${DIM}  Persist requestCorrelator from that response — it is the referenceNo${NC}"
  echo "${DIM}  the verification step needs, and it cannot be recovered.${NC}"
fi

if [ -z "${APPLINK_CAAS_OTP_VERIFY_URL:-}" ]; then
  skip "CaaS OTP Verification" "APPLINK_CAAS_OTP_VERIFY_URL not set"
else
  skip "CaaS OTP Verification" "needs a real OTP from the subscriber — not scriptable"
fi

# ── SMS ─────────────────────────────────────────────────────────────────────
echo
echo "── SMS ─────────────────────────────────────────"
if [ -z "${APPLINK_SMS_SEND_URL:-}" ]; then
  skip "SMS Send" "APPLINK_SMS_SEND_URL not set"
elif [ "$WITH_SMS" != true ]; then
  skip "SMS Send" "skipped (--with-sms to run — sends a real SMS)"
else
  call "SMS Send" "$APPLINK_SMS_SEND_URL" \
    "{$creds,\"version\":\"1.0\",\"message\":\"Applink smoke test\",\"destinationAddresses\":[\"tel:$TEST_MSISDN\"]}"
fi

# ── USSD ────────────────────────────────────────────────────────────────────
echo
echo "── USSD ────────────────────────────────────────"
if [ -n "${APPLINK_USSD_SEND_URL:-}" ]; then
  skip "USSD Send" "needs a live sessionId from an inbound session — not scriptable"
else
  skip "USSD Send" "APPLINK_USSD_SEND_URL not set"
fi

# ── OTP ─────────────────────────────────────────────────────────────────────
echo
echo "── OTP ─────────────────────────────────────────"
if [ -n "${APPLINK_OTP_REQUEST_URL:-}" ]; then
  skip "Request OTP" "sends a real SMS to $TEST_MSISDN — run it by hand when you mean to"
else
  skip "Request OTP" "APPLINK_OTP_REQUEST_URL not set"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "───────────────────────────────────────────────"
echo "  ${GREEN}passed ${PASS}${NC}   ${RED}failed ${FAIL}${NC}   ${DIM}skipped ${SKIP}${NC}"
if [ "$PASS" -eq 0 ] && [ "$FAIL" -eq 0 ]; then
  echo "  ${YELLOW}Nothing ran — no service endpoints are configured in .env.${NC}"
fi
echo
[ "$FAIL" -eq 0 ] || exit 1
