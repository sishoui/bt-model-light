// Effect rendering: compute RGB for a pin's strip at time `t`.
//
// T2 shipped the factory-default breath-rainbow. T6 (#26) adds the full
// 8-effect set (ADR-0017) driven by config: SOLID/BREATH/BLINK/MARQUEE/
// RAINBOW/METEOR/DUAL_GRADIENT/RHYTHM. Each effect is a pure function of
// (params, pixel_index, led_cnt, t_ticks) -> Rgb, so it can be unit-tested
// under PlatformIO+Unity (ADR-0003) without touching hardware.
//
// The breath-rainbow factory-default helper is kept for backward compat
// (boot visual before any config is applied) but the config renderer uses
// the 8-effect dispatch below.

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "led_driver.h"
#include "config.h"   // effect_params_t

// Time unit: one "tick" = 10ms. A frame loop calls ledRefreshAll()
// every tick; effects use tick to compute phase.
#define TICK_MS 10

// Breath-rainbow factory-default effect: the whole pin breathes
// (brightness sinusoid) while the hue slowly cycles across the strip
// and over time. This is the "呼吸彩光" played at first boot.
//
//   pin     : which pin's strip (affects hue offset for variety)
//   pixel   : LED index within the strip
//   led_cnt : number of LEDs on this pin
//   t_ticks : elapsed ticks since effect start
// Returns RGB for that pixel at that moment.
Rgb breathRainbowPixel(uint8_t pin, uint16_t pixel, uint16_t led_cnt,
                       uint32_t t_ticks);

// Fill a pin's strip buffer with the breath-rainbow effect at `t_ticks`.
// The caller then calls ledRefreshAll() to push to hardware.
void breathRainbowFill(uint8_t pin, uint16_t led_cnt, uint32_t t_ticks);

// Sine brightness from a phase in [0,2pi). Used by breath.
// phase_steps in [0,1024) -> brightness in [0,255] as (sin+1)/2.
uint8_t breathBrightness(uint16_t phase_steps);

// HSV -> RGB. h in [0,1535] (=360*255/60), s,v in [0,255].
// Standard FastLED-style conversion; kept pure for unit tests.
Rgb hsvToRgb(uint16_t h, uint8_t s, uint8_t v);

// ---------------------------------------------------------------------------
// 8-effect dispatch (ADR-0017)
// ---------------------------------------------------------------------------

// Render one pixel of an effect. `params` must already be decoded via
// config_decode_params (caller owns lifetime). `t_ticks` is the step-local
// tick counter (resets on step change). Returns RGB in [0,255]^3.
//   effect_id : EFF_* (1..8); unknown ids render black.
Rgb effectRenderPixel(uint8_t effect_id, const effect_params_t *params,
                      uint16_t pixel, uint16_t led_cnt, uint32_t t_ticks);

// Fill a pin's strip buffer [0, led_cnt) with an effect. Convenience
// wrapper around effectRenderPixel; the caller then calls ledRefreshAll().
void effectRenderFill(uint8_t pin, uint8_t effect_id,
                      const effect_params_t *params,
                      uint16_t led_cnt, uint32_t t_ticks);