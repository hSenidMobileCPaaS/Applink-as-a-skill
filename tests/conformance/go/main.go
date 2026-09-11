// Conformance driver for templates/go. Usage: go run . <base-url> <sample|variant|fail>
//
// run.mjs builds a throwaway module with templates/go copied in as package
// conformance/applink, so the template is compiled exactly as written.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"conformance/applink"
)

const correlator = "8801442233146169943053700500040"

func must[T any](v T, err error) T {
	if err != nil {
		fail("unexpected error: %v", err)
	}
	return v
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "go: "+format+"\n", args...)
	os.Exit(1)
}

func expectFailure(code string, err error) {
	var applinkErr *applink.Error
	if !errors.As(err, &applinkErr) {
		fail("expected *applink.Error %s, got %v", code, err)
	}
	if applinkErr.StatusCode != code {
		fail("expected %s, got %s", code, applinkErr.StatusCode)
	}
}

func main() {
	base, scenario := os.Args[1], os.Args[2]
	for name, path := range map[string]string{
		"APPLINK_SMS_SEND_URL":                   "/sms/send",
		"APPLINK_USSD_SEND_URL":                  "/ussd/send",
		"APPLINK_SUBSCRIPTION_SEND_URL":          "/subscription/send",
		"APPLINK_SUBSCRIPTION_QUERY_BASE_URL":    "/subscription/query-base",
		"APPLINK_SUBSCRIPTION_CHARGING_INFO_URL": "/subscription/getSubscriberChargingInfo",
		"APPLINK_OTP_REQUEST_URL":                "/otp/request",
		"APPLINK_OTP_VERIFY_URL":                 "/otp/verify",
		"APPLINK_CAAS_DEBIT_URL":                 "/caas/direct/debit",
		"APPLINK_CAAS_OTP_VERIFY_URL":            "/caas/otp/verify",
		"APPLINK_CAAS_BALANCE_URL":               "/caas/get/balance",
	} {
		os.Setenv(name, base+path)
	}
	if os.Getenv("APPLINK_APP_ID") == "" {
		os.Setenv("APPLINK_APP_ID", "APP_000001")
	}
	if os.Getenv("APPLINK_PASSWORD") == "" {
		os.Setenv("APPLINK_PASSWORD", "conformance-only")
	}

	config := must(applink.LoadConfig())
	c := applink.NewClient(config)
	ctx := context.Background()

	if scenario == "fail" {
		_, err := c.QueryBase(ctx)
		expectFailure("E1313", err)
		_, err = c.Register(ctx, "8801959979376")
		expectFailure("E1313", err)
		_, err = c.SendSMS(ctx, []string{"8801959979376"}, "Hello")
		expectFailure("E1313", err)
		_, err = c.StartCharge(ctx, "8801973579363", "5", "t1", "")
		expectFailure("E1313", err)
		_, err = c.ConfirmCharge(ctx, correlator, "123456", "8801973579363")
		expectFailure("E1313", err)
		_, err = c.VerifyOTP(ctx, "213561321321613", "000000")
		expectFailure("E1850", err)
		fmt.Println("go fail: every failure body raised with its statusCode")
		return
	}

	sms := must(c.SendSMS(ctx, []string{"01959979376"}, "Hello"))
	if scenario == "sample" {
		entry := sms["destinationResponses"].([]any)[0].(map[string]any)
		if entry["statusCode"] != "S1000" {
			fail("per-recipient statusCode %v", entry["statusCode"])
		}
	}
	must(c.SendSMS(ctx, []string{"+8801959979376", "tel:8801959979377"}, "হ্যালো"))
	must(c.BroadcastSMS(ctx, "Service update", applink.BroadcastConfirmation))
	must(c.SendUSSD(ctx, "1330929317043", "tel:8801959979376", "1. One\n2. Two", "mt-cont"))
	if !applink.HasSubscriptionStatus(must(c.Register(ctx, "8801959979376")), "REGISTERED") {
		fail("register did not read REGISTERED")
	}
	if !applink.HasSubscriptionStatus(must(c.Unregister(ctx, "8801959979376")), "UNREGISTERED") {
		fail("unregister did not read UNREGISTERED")
	}
	if size := must(c.QueryBase(ctx)); size != 0 {
		fail("baseSize %d", size)
	}
	must(c.GetSubscriberChargingInfo(ctx, []string{"8801973579363"}))
	otp := must(c.RequestOTP(ctx, "8801416177301", nil))
	if otp["referenceNo"] != "213561321321613" {
		fail("referenceNo %v", otp["referenceNo"])
	}
	must(c.RequestOTP(ctx, "8801416177301", map[string]any{
		"client": "WEBAPP", "device": "PC", "os": "Windows 10", "appCode": "https://example.com",
	}))
	verified := must(c.VerifyOTP(ctx, "213561321321613", "012345"))
	if verified["subscriberId"] != "tel:8801416177301" {
		fail("subscriberId %v", verified["subscriberId"])
	}
	trx := must(applink.GenerateExternalTrxID())
	charge := must(c.StartCharge(ctx, "8801973579363", "5", trx, ""))
	if charge["statusCode"] != "P1003" || charge["requestCorrelator"] != correlator {
		fail("charge %v", charge)
	}
	must(c.ConfirmCharge(ctx, correlator, "123456", "8801973579363"))
	must(c.QueryBalance(ctx, "8801959979376"))
	fmt.Printf("go %s: every wrapper returned and parsed the response\n", scenario)
}
