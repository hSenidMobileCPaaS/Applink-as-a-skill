"""Conformance driver for templates/python. Usage: drive.py <base-url> <sample|variant|fail>"""
import os
import sys
from decimal import Decimal

base, scenario = sys.argv[1], sys.argv[2]
for var, path in {
    "APPLINK_SMS_SEND_URL": "/sms/send",
    "APPLINK_USSD_SEND_URL": "/ussd/send",
    "APPLINK_SUBSCRIPTION_SEND_URL": "/subscription/send",
    "APPLINK_SUBSCRIPTION_QUERY_BASE_URL": "/subscription/query-base",
    "APPLINK_SUBSCRIPTION_CHARGING_INFO_URL": "/subscription/getSubscriberChargingInfo",
    "APPLINK_OTP_REQUEST_URL": "/otp/request",
    "APPLINK_OTP_VERIFY_URL": "/otp/verify",
    "APPLINK_CAAS_DEBIT_URL": "/caas/direct/debit",
    "APPLINK_CAAS_OTP_VERIFY_URL": "/caas/otp/verify",
    "APPLINK_CAAS_BALANCE_URL": "/caas/get/balance",
}.items():
    os.environ[var] = base + path
os.environ.setdefault("APPLINK_APP_ID", "APP_000001")
os.environ.setdefault("APPLINK_PASSWORD", "conformance-only")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "templates", "python"))
import applink_client as c  # noqa: E402

CORRELATOR = "8801442233146169943053700500040"


def expect_failure(code, call):
    try:
        call()
    except c.ApplinkError as err:
        assert err.status_code == code, f"expected {code}, got {err.status_code}"
        return
    raise AssertionError(f"expected ApplinkError {code}, the call returned normally")


if scenario == "fail":
    expect_failure("E1313", lambda: c.query_base())
    expect_failure("E1313", lambda: c.register("8801959979376"))
    expect_failure("E1313", lambda: c.send_sms("8801959979376", "Hello"))
    expect_failure("E1313", lambda: c.start_charge(subscriber_id="8801973579363", amount="5", external_trx_id="t1"))
    expect_failure("E1313", lambda: c.confirm_charge(request_correlator=CORRELATOR, otp="123456", subscriber_id="8801973579363"))
    expect_failure("E1850", lambda: c.verify_otp(reference_no="213561321321613", otp="000000"))
    print("python fail: every failure body raised with its statusCode")
    sys.exit(0)

sms = c.send_sms("01959979376", "Hello", delivery_status_request="1")
if scenario == "sample":
    assert sms["destinationResponses"][0]["statusCode"] == "S1000"
c.send_sms(["+8801959979376", "tel:8801959979377"], "হ্যালো")
c.broadcast_sms("Service update", c.BROADCAST_CONFIRMATION)
c.send_ussd(session_id="1330929317043", destination_address="tel:8801959979376", message="1. One\n2. Two", operation="mt-cont")
assert c.has_subscription_status(c.register("8801959979376"), "REGISTERED")
assert c.has_subscription_status(c.unregister("8801959979376"), "UNREGISTERED")
assert c.query_base()["size"] == 0
c.get_subscriber_charging_info(["8801973579363"])
otp = c.request_otp(subscriber_id="8801416177301")
assert otp["referenceNo"] == "213561321321613"
c.request_otp(
    subscriber_id="8801416177301",
    meta_data={"client": "WEBAPP", "device": "PC", "os": "Windows 10", "appCode": "https://example.com"},
    application_hash="abcdefgh",
)
verified = c.verify_otp(reference_no=otp["referenceNo"], otp="012345")
assert verified["subscriberId"] == "tel:8801416177301"
charge = c.start_charge(subscriber_id="8801973579363", amount=Decimal("5"), external_trx_id=c.generate_external_trx_id())
assert charge["statusCode"] == "P1003"
assert charge["requestCorrelator"] == CORRELATOR, "requestCorrelator must survive as the exact string"
c.confirm_charge(request_correlator=charge["requestCorrelator"], otp="123456", subscriber_id="8801973579363")
c.query_balance(subscriber_id="8801959979376")
print(f"python {scenario}: every wrapper returned and parsed the response")
