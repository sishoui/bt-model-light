// LED driver: 8-pin sequential refresh of WS2812B strips (ADR-0013).
// Each pin drives one independent strip; strips are refreshed in order
// pin0 -> pin1 -> ... -> pin7, repeated. WS2812B self-latches so
// sequential refresh is correct without a hardware mux.
//
// Uses Adafruit NeoPixel (ESP32 RMT peripheral) — ADR-0002 allows
// either FastLED or Adafruit NeoPixel. FastLED 3.10's PARLIO driver
// references symbols absent on ESP32-C3 (single-core RISC-V), causing
// link errors, so Adafruit NeoPixel is used here.
//
// Per-pin LED count <= 100 (ADR-0013a); buffers preallocated.
//
// T2 scope: expose enough to drive the factory-default breath rainbow
// across all 8 pins. T6 will extend with config-driven groups/layers.

#pragma once

#include <stdint.h>
#include <stddef.h>
#include "protocol_gen.h"

// Default GPIO assignments for the 8 WS2812B strips on ESP32-C3-FH4.
// ESP32-C3 GPIO9 is the BOOT button (ADR-0015) and is NOT used here.
// GPIO0/GPIO1 are avoided (UART/boot). The remaining 8 free GPIOs are
// used for the strips.
#define LED_PIN_0   2
#define LED_PIN_1   3
#define LED_PIN_2   4
#define LED_PIN_3   5
#define LED_PIN_4   6
#define LED_PIN_5   7
#define LED_PIN_6   8
#define LED_PIN_7  10

static const uint8_t kLedPinMap[PIN_COUNT] = {
    LED_PIN_0, LED_PIN_1, LED_PIN_2, LED_PIN_3,
    LED_PIN_4, LED_PIN_5, LED_PIN_6, LED_PIN_7,
};

// One RGB pixel (NeoPixel uses byte order R,G,B).
struct Rgb {
    uint8_t r, g, b;
};

// Initialize all 8 strips. After init all pixels are black.
// Returns true on success.
bool ledInit();

// Set a single pixel on a pin.
//   pin  : 0..PIN_COUNT-1
//   idx  : LED index within that pin's strip, 0..count-1
//   color: RGB color (0,0,0 = off)
void ledSetPixel(uint8_t pin, uint16_t idx, Rgb color);

// Refresh all 8 pins sequentially: pin0.show() -> pin1.show() -> ...
// Blocks ~8 * strip_len * 30us. Call once per animation frame.
void ledRefreshAll();

// Fill an entire pin with a color.
void ledFill(uint8_t pin, Rgb color);
