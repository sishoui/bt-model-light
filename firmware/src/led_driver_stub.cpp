// Native stub for the LED driver. On the real ESP32-C3 build, led_driver.cpp
// drives Adafruit_NeoPixel strips; on the native test target the Arduino
// headers aren't available, so this stub provides the same symbols.
//
// Pixels are recorded into a static buffer (instead of being discarded) so
// composition/effects tests can read back what would be pushed to the strips
// via the ledTest* hooks below. The recording is native-test-only; the
// Arduino build compiles led_driver.cpp and never sees this file.

#include "led_driver.h"
#include "master_output.h"   // 输出级整机开关门控 + 整机亮度缩放（ADR-0031/0032）

#ifndef ARDUINO

#include <string.h>

static Rgb sPixel[PIN_COUNT][LEDS_PER_PIN_MAX];
static bool sPixelSet[PIN_COUNT][LEDS_PER_PIN_MAX];

bool ledInit() { return true; }

void ledSetPixel(uint8_t pin, uint16_t idx, Rgb color) {
    if (pin >= PIN_COUNT || idx >= LEDS_PER_PIN_MAX) return;
    // 与真机驱动同一点门控/缩放（ADR-0031/0032），native 测试才能断言输出级行为。
    sPixel[pin][idx] = masterApplyOutput(color);
    sPixelSet[pin][idx] = true;
}

void ledFill(uint8_t pin, Rgb color) {
    for (uint16_t i = 0; i < LEDS_PER_PIN_MAX; i++) ledSetPixel(pin, i, color);
}

void ledRefreshAll() {}

// ---- test hooks (native only) -------------------------------------------

void ledTestReset(void) {
    memset(sPixel, 0, sizeof(sPixel));
    memset(sPixelSet, 0, sizeof(sPixelSet));
}

bool ledTestGetPixel(uint8_t pin, uint16_t idx, Rgb *out) {
    if (pin >= PIN_COUNT || idx >= LEDS_PER_PIN_MAX || !sPixelSet[pin][idx]) return false;
    if (out) *out = sPixel[pin][idx];
    return true;
}

#endif // !ARDUINO