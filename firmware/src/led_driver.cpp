// LED driver implementation.

#include "led_driver.h"

#if defined(ARDUINO)
#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#endif

// One NeoPixel strip per pin, dynamically allocated at LEDS_PER_PIN_MAX.
#if defined(ARDUINO)
static Adafruit_NeoPixel *sStrips[PIN_COUNT] = {nullptr};
static bool sInit = false;
#endif

bool ledInit() {
#if defined(ARDUINO)
    if (sInit) return true;
    for (uint8_t p = 0; p < PIN_COUNT; p++) {
        // NEO_GRB + NEO_KHZ800: WS2812B wire order is GRB, 800kHz.
        sStrips[p] = new Adafruit_NeoPixel(LEDS_PER_PIN_MAX, kLedPinMap[p],
                                           NEO_GRB + NEO_KHZ800);
        if (!sStrips[p]) return false;
        sStrips[p]->begin();
        sStrips[p]->clear();
        sStrips[p]->show();
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
    sStrips[pin]->setPixelColor(idx, sStrips[pin]->Color(color.r, color.g, color.b));
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
        if (sStrips[p]) sStrips[p]->show();
    }
#endif
}