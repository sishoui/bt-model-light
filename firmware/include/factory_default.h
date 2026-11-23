// Factory-default device config: breath rainbow across all 8 pins
// (ADR-0015). Built-in as a constant so a freshly flashed or
// spiffs-corrupted device still lights up at first boot and the user
// can confirm the hardware is healthy.
//
// Each pin gets a fixed LED count for now; actual counts will come
// from GET_PIN_CAPS / config in T6. Here we just need enough to drive
// the factory-default effect at boot.

#pragma once

#include <stdint.h>
#include "protocol_gen.h"
#include "led_driver.h"

// Default LED count per pin for the factory-default playback.
// Conservative mid-value; T6 reads real strip length from config.
#define FACTORY_LED_PER_PIN 60

// Total LEDs driven by factory default.
#define FACTORY_TOTAL_LEDS  (PIN_COUNT * FACTORY_LED_PER_PIN)

// Factory-default playback parameters.
#define FACTORY_BREATH_PERIOD_MS   3000   // one breath cycle
#define FACTORY_HUE_SPAN           256    // hue units across the strip
#define FACTORY_GLOBAL_HUE_RATE    4      // hue units per second

// Fill all 8 pin buffers with the breath-rainbow effect at t_ticks.
// Then call ledRefreshAll() to push to the strips.
void factoryDefaultFillAll(uint32_t t_ticks);
