<?php
// Conformance driver for templates/php. Usage: php drive.php <base-url> <sample|variant|fail>
// Needs the curl extension; run.mjs supplies the APPLINK_* environment.

declare(strict_types=1);

// Any notice, warning or deprecation from the template fails the run: in a web
// request it would be written into the response body.
error_reporting(E_ALL);
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

require __DIR__ . '/../../../templates/php/ApplinkConfig.php';
require __DIR__ . '/../../../templates/php/ApplinkClient.php';

use App\Applink\ApplinkClient;
use App\Applink\ApplinkConfig;
use App\Applink\ApplinkException;

const CORRELATOR = '8801442233146169943053700500040';

$scenario = $argv[2];
$c = new ApplinkClient(ApplinkConfig::fromEnvironment());

function check(bool $ok, string $message): void
{
    if (!$ok) {
        fwrite(STDERR, "php: {$message}\n");
        exit(1);
    }
}

function expectFailure(string $code, callable $call): void
{
    try {
        $call();
    } catch (ApplinkException $e) {
        check($e->statusCode === $code, "expected {$code}, got {$e->statusCode}");
        return;
    }
    check(false, "expected ApplinkException {$code}, the call returned normally");
}

if ($scenario === 'fail') {
    expectFailure('E1313', fn () => $c->queryBase());
    expectFailure('E1313', fn () => $c->register('8801959979376'));
    expectFailure('E1313', fn () => $c->sendSms('8801959979376', 'Hello'));
    expectFailure('E1313', fn () => $c->startCharge('8801973579363', '5', 't1'));
    expectFailure('E1313', fn () => $c->confirmCharge(CORRELATOR, '123456', '8801973579363'));
    expectFailure('E1850', fn () => $c->verifyOtp('213561321321613', '000000'));
    echo "php fail: every failure body raised with its statusCode\n";
    exit(0);
}

$sms = $c->sendSms('01959979376', 'Hello', ['deliveryStatusRequest' => 1]);
if ($scenario === 'sample') {
    check($sms['destinationResponses'][0]['statusCode'] === 'S1000', 'per-recipient code');
}
$c->sendSms(['+8801959979376', 'tel:8801959979377'], 'হ্যালো');
$c->broadcastSms('Service update', ApplinkClient::BROADCAST_CONFIRMATION);
$c->sendUssd('1330929317043', 'tel:8801959979376', "1. One\n2. Two", 'mt-cont');
check(ApplinkClient::hasSubscriptionStatus($c->register('8801959979376'), 'REGISTERED'), 'register');
check(ApplinkClient::hasSubscriptionStatus($c->unregister('8801959979376'), 'UNREGISTERED'), 'unregister');
check($c->queryBase() === 0, 'baseSize');
$c->getSubscriberChargingInfo(['8801973579363']);
$otp = $c->requestOtp('8801416177301');
check($otp['referenceNo'] === '213561321321613', 'referenceNo');
$c->requestOtp('8801416177301', [], '');
$c->requestOtp('8801416177301', ['client' => 'WEBAPP', 'device' => 'PC', 'os' => 'Windows 10', 'appCode' => 'https://example.com'], 'abcdefgh');
$verified = $c->verifyOtp('213561321321613', '012345');
check($verified['subscriberId'] === 'tel:8801416177301', 'subscriberId');
$charge = $c->startCharge('8801973579363', '5', ApplinkClient::generateExternalTrxId());
check($charge['statusCode'] === 'P1003', 'P1003');
check($charge['requestCorrelator'] === CORRELATOR, 'requestCorrelator must survive as the exact string');
$c->confirmCharge(CORRELATOR, '123456', '8801973579363');
$c->queryBalance('8801959979376');
echo "php {$scenario}: every wrapper returned and parsed the response\n";
