// LED driver implementation.

#include "led_driver.h"

#if defined(ARDUINO)
#include <Adafruit_NeoPixel.h>
#include <Arduino.h>

// Static strip objects: one per pin. Static allocation avoids heap
// fragmentation on a 7x24 embedded device (no malloc/free churn at
// runtime). Each strip is sized to LEDS_PER_PIN_MAX (worst case);
// T6 will read actual counts from config.
static Adafruit_NeoPixel sStrips[PIN_COUNT] = {
    Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[0], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[1], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[2], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[3], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[4], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[5], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[6], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[7], NEO_GRB + NEO_KHZ800),
};

static bool sInit = false;
#endif

bool ledInit() {
#if defined(ARDUINO)
    if (sInit) return true;
    for (uint8_t p = 0; p < PIN_COUNT; p++) {
        sStrips[p].begin();
        sStrips[p].clear();
        sStrips[p].show();
    }
    sInit = true;
    return true;
#else
    return true;
#endif
}

void ledSetPixel(uint8_t pin, uint16_t idx, Rgb color) {
    if (pin >= PIN_COUNT) return;
    if (idx >= LEDS_PER_PIN_MAX) return;
#if defined(ARDUINO)
    sStrips[pin].setPixelColor(idx, sStrips[pin].Color(color.r, color.g, color.b));
#else
    (void)idx; (void)color;
#endif
}

void ledFill(uint8_t pin, Rgb color) {
    if (pin >= PIN_COUNT) return;
    for (uint16_t i = 0; i < LEDS_PER_PIN_MAX; i++) {
        ledSetPixel(pin, i, color);
    }
}

void ledRefreshAll() {
#if defined(ARDUINO)
    // Sequential refresh: pin0.show() -> pin1.show() -> ... -> pin7.show().
    // Each show() pushes the strip's CRGB buffer out over RMT.
    for (uint8_t p = 0; p < PIN_COUNT; p++) {
        sStrips[p].show();
    }
#endif
}
