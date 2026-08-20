#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Applink callback handler tests
#
# Posts real Applink callback payloads at your own endpoints. No Applink
# account or connectivity needed — the payloads are fully specified, so you can
# build and test the inbound half of the integration before provisioning.
#
# Usage:
#   ./scripts/test-callbacks.sh [base-url]
#   ./scripts/test-callbacks.sh http://localhost:3000
#
# Every handler must answer HTTP 200 with:
#   {"statusCode":"S1000","statusDetail":"Success"}
# ...including for malformed and wrong-app payloads.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${1:-http://localhost:3000}"
APP_ID="${APPLINK_APP_ID:-APP_000029}"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; DIM=$'\033[2m'; NC=$'\033[0m'
PASS=0; FAIL=0

# check <name> <path> <body>
check() {
  local name="$1" path="$2" body="$3"
  printf '%-40s' "$name"
  local out status response
  out=$(curl -sS --max-time 10 -w '\n%{http_code}' -X POST "$BASE$path" \
    -H 'Content-Type: application/json;charset=utf-8' --data "$body" 2>&1)
  status=$(printf '%s' "$out" | tail -1)
  response=$(printf '%s' "$out" | sed '$d')

  if [ "$status" != "200" ]; then
    echo "${RED}HTTP $status${NC}  (must always be 200 — a non-2xx triggers redelivery)"
    FAIL=$((FAIL+1)); return
  fi
  if printf '%s' "$response" | grep -q '"S1000"'; then
    echo "${GREEN}200 S1000${NC}"; PASS=$((PASS+1))
  else
    echo "${RED}200 but no S1000${NC}"; echo "${DIM}  $response${NC}"; FAIL=$((FAIL+1))
  fi
}

echo
echo "Callback tests against $BASE"
echo

echo "── Valid payloads ──────────────────────────────────────"

check "SMS receive (MO)" /api/applink/sms/receive \
  "{\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"sourceAddress\":\"tel:8801959979376\",\"message\":\"JOIN\",\"requestId\":\"22607072011552911\",\"encoding\":\"0\"}"

check "Delivery report (DELIVERED)" /api/applink/sms/report \
  '{"destinationAddress":"tel:8801959979376","timeStamp":"20120113082110","requestId":"MSG_000111","deliveryStatus":"DELIVERED"}'

check "Delivery report (SMPP spelling)" /api/applink/sms/report \
  '{"destinationAddress":"tel:8801959979376","timeStamp":"1201130821","requestId":"MSG_000112","deliveryStatus":"DELIVRD"}'

check "USSD mo-init" /api/applink/ussd/receive \
  "{\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"message\":\"*141#\",\"requestId\":\"1330933229901\",\"sessionId\":\"1330929317043\",\"ussdOperation\":\"mo-init\",\"sourceAddress\":\"tel:8801959979376\",\"vlrAddress\":\"tel:8801959979376\",\"encoding\":\"440\"}"

check "USSD mo-cont" /api/applink/ussd/receive \
  "{\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"message\":\"1\",\"requestId\":\"1330933229902\",\"sessionId\":\"1330929317043\",\"ussdOperation\":\"mo-cont\",\"sourceAddress\":\"tel:8801959979376\",\"encoding\":\"440\"}"

# NOTE: the subscriber notification really does carry your password. Your
# handler must strip it before anything is logged. The placeholder below stands
# in for the value the platform would send.
check "Subscriber notification REGISTERED" /api/applink/subscription/notify \
  "{\"timeStamp\":\"20120113082110\",\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"password\":\"<redacted-placeholder>\",\"subscriberId\":\"tel:8801973579363\",\"frequency\":\"monthly\",\"status\":\"REGISTERED\"}"

check "Subscriber notification UNREGISTERED" /api/applink/subscription/notify \
  "{\"timeStamp\":\"20120113082111\",\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"password\":\"<redacted-placeholder>\",\"subscriberId\":\"tel:8801973579363\",\"frequency\":\"monthly\",\"status\":\"UNREGISTERED\"}"

check "Charging notification (paid in full)" /api/applink/caas/charging-notification \
  '{"timeStamp":"15-Nov-2023 11:55","TotalAmount":"5.00","externalTrxId":"256091234","balanceDue":"0","statusDetail":"Request was Successfully processed, Due amount fully paid.","currency":"BDT","version":"1.0","internalTrxId":"9111511550014764","paidAmount":"5.00","referenceId":"8801422222550170004932307900016","statusCode":"S1000"}'

check "Charging notification (partial)" /api/applink/caas/charging-notification \
  '{"timeStamp":"15-Nov-2023 11:57","TotalAmount":"5.00","externalTrxId":"256091235","balanceDue":"2.00","statusDetail":"Partially paid.","currency":"BDT","version":"1.0","internalTrxId":"9111511570014765","paidAmount":"3.00","referenceId":"8801422222550170004932307900017","statusCode":"P1003"}'

echo
echo "${DIM}  The partial case is the one people skip: a non-zero balanceDue must NOT${NC}"
echo "${DIM}  mark the order fulfilled. Verify that in your logs / database.${NC}"

echo
echo "── Hostile payloads (must still return 200 S1000) ───────"

check "Malformed JSON" /api/applink/ussd/receive \
  '{not valid json'

check "Empty body" /api/applink/sms/receive \
  ''

check "Wrong applicationId" /api/applink/sms/receive \
  '{"version":"1.0","applicationId":"APP_999999","sourceAddress":"tel:8801959979376","message":"x","requestId":"r1","encoding":"0"}'

check "Missing required fields" /api/applink/ussd/receive \
  '{"applicationId":"'"$APP_ID"'"}'

check "Oversized message" /api/applink/sms/receive \
  "{\"version\":\"1.0\",\"applicationId\":\"$APP_ID\",\"sourceAddress\":\"tel:8801959979376\",\"message\":\"$(printf 'A%.0s' {1..5000})\",\"requestId\":\"r2\",\"encoding\":\"0\"}"

echo
echo "── Idempotency (the test people skip) ───────────────────"
echo "${DIM}  Same payload twice. Both must return 200 S1000, and your handler${NC}"
echo "${DIM}  must process it ONCE. Verify in your logs / database.${NC}"

DUP='{"timeStamp":"15-Nov-2023 12:05","TotalAmount":"5.00","externalTrxId":"dup-test-001","balanceDue":"0","statusDetail":"Success","currency":"BDT","version":"1.0","internalTrxId":"9111512050014999","paidAmount":"5.00","referenceId":"8801422222550170004932307900099","statusCode":"S1000"}'
check "Charging notification (1st)" /api/applink/caas/charging-notification "$DUP"
check "Charging notification (2nd)" /api/applink/caas/charging-notification "$DUP"

echo
echo "────────────────────────────────────────────────────────"
echo "  ${GREEN}passed ${PASS}${NC}   ${RED}failed ${FAIL}${NC}"
echo
[ "$FAIL" -eq 0 ] || exit 1
