// Dual-layer composition + step sequencing + config-driven rendering (T6).
//
// Implements ADR-0020 (动效层 RGB 非黑取动效层) and ADR-0021 (step duration /
// transition / loop mode). Pure C++ (no Arduino), native-testable.
//
// The renderer walks each pin's groups, picks the current step per group
// from its playback clock, renders each layer to a per-pixel RGB, and
// composes: animation layer non-black wins over background layer. Output
// is written through ledSetPixel so the frame loop only needs one
// ledRefreshAll() per tick.

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "config.h"
#include "led_driver.h"
#include "effects.h"

#ifdef __cplusplus
extern "C" {
#endif

// Per-group playback state. The renderer keeps one of these per group so
// each group advances its own step timeline independently. t_ticks is the
// step-local tick counter (resets on step change); step_idx is the active
// step within the group.
typedef struct {
    uint32_t step_ticks;   // ticks elapsed in the current step
    uint8_t  step_idx;     // active step index within the group
    int8_t   dir;          // +1 forward, -1 reverse (ping-pong)
} group_playback_t;

// Initialize playback state for a config (all groups to step 0, tick 0).
void composition_init(device_config_t *c, group_playback_t pb[PIN_COUNT][GROUPS_PER_PIN_MAX]);

// Advance one group's step clock by `dt_ticks` and return the (possibly
// new) active step index. Handles duration expiry + loop mode (once / loop
// / pingpong). `loop_mode` is taken from the step's own loop_mode field
// (ADR-0021 places it per-step). Returns the active step index.
uint8_t composition_advance_group(const config_group_t *g, group_playback_t *pb,
                                  uint32_t dt_ticks);

// Render one pin's strip for the current playback state into the LED
// buffer. `pin_ticks[group]` gives each group's current step-local tick
// (for effect phase); the caller usually passes pb[pin][g].step_ticks.
// Uncovered LEDs (no group covers them) are left untouched (caller clears
// first if desired).
void composition_render_pin(uint8_t pin, uint16_t led_cnt,
                            const device_config_t *c,
                            const group_playback_t pb_pin[GROUPS_PER_PIN_MAX],
                            uint32_t pin_ticks[GROUPS_PER_PIN_MAX]);

// Render the whole device config for one frame. Returns the number of pins
// actually touched. Uncovered LEDs are set to black (so turning off a
// group visibly darkens). The caller then calls ledRefreshAll().
uint8_t composition_render_all(const device_config_t *c,
                               group_playback_t pb[PIN_COUNT][GROUPS_PER_PIN_MAX],
                               uint32_t dt_ticks);

#ifdef __cplusplus
}
#endif