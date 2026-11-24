// Dual-layer composition + step sequencing + config-driven rendering.
//
// See composition.h for the contract. Pure C++ (no Arduino), native-testable.

#include "composition.h"

#include <string.h>

// ---------------------------------------------------------------------------
// Playback init
// ---------------------------------------------------------------------------

void composition_init(device_config_t *c, group_playback_t pb[PIN_COUNT][GROUPS_PER_PIN_MAX]) {
    (void)c;
    for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
        for (uint8_t gi = 0; gi < GROUPS_PER_PIN_MAX; gi++) {
            pb[pin][gi].step_ticks = 0;
            pb[pin][gi].step_idx = 0;
            pb[pin][gi].dir = +1;
        }
    }
}

// ---------------------------------------------------------------------------
// Step clock advance (ADR-0021: duration / loop mode)
// ---------------------------------------------------------------------------

uint8_t composition_advance_group(const config_group_t *g, group_playback_t *pb,
                                  uint32_t dt_ticks) {
    if (!g || !pb || g->step_count == 0) return 0;
    if (g->step_count == 1) {
        // Single step: keep ticking (effect phase advances), never changes.
        pb->step_ticks += dt_ticks;
        return 0;
    }

    pb->step_ticks += dt_ticks;
    bool advanced = true;
    while (advanced) {
        advanced = false;
        const config_step_t *cur = &g->steps[pb->step_idx];
        uint32_t dur_ticks = (uint32_t)cur->duration * (1000 / TICK_MS);
        if (dur_ticks == 0) dur_ticks = 1;
        if (pb->step_ticks >= dur_ticks) {
            pb->step_ticks -= dur_ticks;
            // Step expired -> move to next per loop_mode.
            switch (cur->loop_mode) {
                case CONFIG_LOOP_ONCE:
                    // Hold at last step once we reach the end.
                    if (pb->step_idx + 1 < g->step_count) {
                        pb->step_idx++;
                        pb->dir = +1;
                    } else {
                        // Stay on last step; reset tick so we don't busy-loop.
                        pb->step_ticks = 0;
                        return pb->step_idx;
                    }
                    break;
                case CONFIG_LOOP_LOOP:
                    pb->step_idx = (uint8_t)((pb->step_idx + 1) % g->step_count);
                    pb->dir = +1;
                    break;
                case CONFIG_LOOP_PINGPONG:
                default:
                    if (pb->dir > 0) {
                        if (pb->step_idx + 1 < g->step_count) {
                            pb->step_idx++;
                        } else {
                            pb->dir = -1;
                            if (pb->step_idx > 0) pb->step_idx--;
                        }
                    } else {
                        if (pb->step_idx > 0) {
                            pb->step_idx--;
                        } else {
                            pb->dir = +1;
                            if (pb->step_idx + 1 < g->step_count) pb->step_idx++;
                        }
                    }
                    break;
            }
            advanced = true; // might need to advance again if dt spans many steps
        }
    }
    return pb->step_idx;
}

// ---------------------------------------------------------------------------
// Layer composition (ADR-0020)
// ---------------------------------------------------------------------------

// Compose two layers per pixel: if the animation layer (top) is non-black,
// use it; otherwise use the background layer.
static inline Rgb compose_layer(Rgb bg, Rgb anim) {
    if (anim.r != 0 || anim.g != 0 || anim.b != 0) return anim;
    return bg;
}

// Apply a simple fade-in at step start (ADR-0021 transition). For
// TRANSITION_FADE, the first 500ms of a step scales brightness from 0 to
// full. TRANSITION_SMOOTH is treated the same for T6 (a linear ramp);
// TRANSITION_NONE is a no-op. `elapsed_ms` is the step-local elapsed time.
static inline uint8_t transition_scale(uint8_t transition, uint32_t elapsed_ms) {
    if (transition == CONFIG_TRANSITION_NONE) return 255;
    const uint32_t kFadeMs = 500;
    if (elapsed_ms >= kFadeMs) return 255;
    return (uint8_t)((uint32_t)elapsed_ms * 255u / kFadeMs);
}

static inline Rgb scale_rgb_local(Rgb c, uint8_t b) {
    if (b == 255) return c;
    if (b == 0) { Rgb z = {0,0,0}; return z; }
    Rgb o;
    o.r = (uint8_t)(((uint16_t)c.r * b) / 255);
    o.g = (uint8_t)(((uint16_t)c.g * b) / 255);
    o.b = (uint8_t)(((uint16_t)c.b * b) / 255);
    return o;
}

// Render a single step's layers for one pixel. Returns composed RGB.
static Rgb render_step_pixel(const config_step_t *s, uint16_t pixel,
                             uint16_t led_cnt, uint32_t t_ticks) {
    if (s->layer_count == 0) {
        Rgb z = {0,0,0};
        return z;
    }
    // Layer 0 = background, layer 1 = animation (ADR-0020).
    effect_params_t ep0, ep1;
    memset(&ep0, 0, sizeof(ep0));
    memset(&ep1, 0, sizeof(ep1));
    bool ok0 = config_decode_params(&s->layers[0], &ep0);
    Rgb bg = ok0 ? effectRenderPixel(s->layers[0].effect_id, &ep0, pixel, led_cnt, t_ticks)
                 : (Rgb){0,0,0};
    if (s->layer_count == 1) {
        return bg;
    }
    bool ok1 = config_decode_params(&s->layers[1], &ep1);
    Rgb anim = ok1 ? effectRenderPixel(s->layers[1].effect_id, &ep1, pixel, led_cnt, t_ticks)
                   : (Rgb){0,0,0};
    return compose_layer(bg, anim);
}

// ---------------------------------------------------------------------------
// Pin render
// ---------------------------------------------------------------------------

void composition_render_pin(uint8_t pin, uint16_t led_cnt,
                            const device_config_t *c,
                            const group_playback_t pb_pin[GROUPS_PER_PIN_MAX],
                            uint32_t pin_ticks[GROUPS_PER_PIN_MAX]) {
    if (pin >= PIN_COUNT || !c) return;
    // Default: black the whole strip so uncovered LEDs are dark.
    for (uint16_t i = 0; i < led_cnt && i < LEDS_PER_PIN_MAX; i++) {
        ledSetPixel(pin, i, (Rgb){0,0,0});
    }

    const config_pin_t *p = &c->pins[pin];
    for (uint8_t gi = 0; gi < p->group_count; gi++) {
        const config_group_t *g = &p->groups[gi];
        if (pb_pin[gi].step_idx >= g->step_count) continue;
        if (g->led_start == 0xFF || g->led_end == 0xFF) continue; // 255 哨兵：空组不渲染
        const config_step_t *s = &g->steps[pb_pin[gi].step_idx];
        uint16_t start = g->led_start;
        uint16_t end = g->led_end;
        if (start >= LEDS_PER_PIN_MAX) start = LEDS_PER_PIN_MAX - 1;
        if (end >= LEDS_PER_PIN_MAX) end = LEDS_PER_PIN_MAX - 1;
        if (end < start) continue;
        uint16_t len = (uint16_t)(end - start + 1);
        uint32_t t = pin_ticks[gi];

        // Transition scale for this step.
        uint32_t elapsed_ms = t * TICK_MS;
        uint8_t tscale = transition_scale(s->transition, elapsed_ms);

        for (uint16_t i = 0; i < len; i++) {
            uint16_t pixel = (uint16_t)(start + i);
            Rgb c = render_step_pixel(s, pixel, len, t);
            if (tscale != 255) c = scale_rgb_local(c, tscale);
            // Last group covering this pixel wins (groups may overlap).
            ledSetPixel(pin, pixel, c);
        }
    }
}

// ---------------------------------------------------------------------------
// Whole-device render
// ---------------------------------------------------------------------------

uint8_t composition_render_all(const device_config_t *c,
                               group_playback_t pb[PIN_COUNT][GROUPS_PER_PIN_MAX],
                               uint32_t dt_ticks) {
    if (!c) return 0;
    uint8_t touched = 0;
    for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
        const config_pin_t *p = &c->pins[pin];
        // Advance each group's step clock for this pin.
        uint32_t pin_ticks[GROUPS_PER_PIN_MAX] = {0};
        for (uint8_t gi = 0; gi < p->group_count && gi < GROUPS_PER_PIN_MAX; gi++) {
            composition_advance_group(&p->groups[gi], &pb[pin][gi], dt_ticks);
            pin_ticks[gi] = pb[pin][gi].step_ticks;
        }
        if (p->group_count > 0) {
            composition_render_pin(pin, LEDS_PER_PIN_MAX, c, pb[pin], pin_ticks);
            touched++;
        } else {
            // No groups: clear the strip.
            composition_render_pin(pin, LEDS_PER_PIN_MAX, c, pb[pin], pin_ticks);
        }
    }
    return touched;
}