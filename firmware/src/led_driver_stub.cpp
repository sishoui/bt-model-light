// Native stub for the LED driver. On the real ESP32-C3 build, led_driver.cpp
// drives Adafruit_NeoPixel strips; on the native test target the Arduino
// headers aren't available, so this stub provides the same symbols as no-ops.
//
// The composition + effects tests need ledSetPixel to exist (they call it
// indirectly via composition_render_pin / effectRenderFill) even though they
// can't read back pixels on native. A no-op keeps the link green without
// pulling in Arduino.

#include "led_driver.h"

#ifndef ARDUINO

bool ledInit() { return true; }
void ledSetPixel(uint8_t pin, uint16_t idx, Rgb color) {
    (void)pin; (void)idx; (void)color;
}
void ledFill(uint8_t pin, Rgb color) {
    (void)pin; (void)color;
}
void ledRefreshAll() {}

#endif // !ARDUINO