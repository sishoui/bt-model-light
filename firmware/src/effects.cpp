// Effect rendering implementation.
//
// T2 scope: breath-rainbow (the factory-default effect). The other 7
// effects from ADR-0017 land in T6.

#include "effects.h"
#include "factory_default.h"

// A full breath cycle is PHASE_STEPS phase steps.
// At FACTORY_BREATH_PERIOD_MS = 3000ms and TICK_MS = 10ms, that is
// 300 ticks per cycle; phase advances by PHASE_STEPS/300 ≈ 3.4 per tick.
static const uint16_t PHASE_STEPS = 1024;
static const uint32_t BREATH_TICKS_PER_CYCLE = FACTORY_BREATH_PERIOD_MS / TICK_MS;
static const uint16_t HUE_WRAP = 1536; // 360 * 255 / 60

// Sine lookup: 256 samples over [0, 2pi). brightness = (sin+1)/2*221 + 34
// (floor 34 so "dark" is not fully black, peak 255).
static const uint8_t SIN_TABLE[256] = {
    144, 147, 150, 153, 155, 158, 161, 163, 166, 169, 171, 174,
    177, 179, 182, 184, 187, 189, 192, 194, 197, 199, 201, 204,
    206, 208, 210, 212, 215, 217, 219, 221, 223, 225, 226, 228,
    230, 232, 233, 235, 236, 238, 239, 241, 242, 243, 244, 246,
    247, 248, 249, 249, 250, 251, 252, 252, 253, 253, 254, 254,
    254, 255, 255, 255, 255, 255, 255, 255, 254, 254, 254, 253,
    253, 252, 252, 251, 250, 249, 249, 248, 247, 246, 244, 243,
    242, 241, 239, 238, 236, 235, 233, 232, 230, 228, 226, 225,
    223, 221, 219, 217, 215, 212, 210, 208, 206, 204, 201, 199,
    197, 194, 192, 189, 187, 184, 182, 179, 177, 174, 171, 169,
    166, 163, 161, 158, 155, 153, 150, 147, 145, 142, 139, 136,
    134, 131, 128, 126, 123, 120, 118, 115, 112, 110, 107, 105,
    102, 100, 97, 95, 92, 90, 88, 85, 83, 81, 79, 77,
    74, 72, 70, 68, 66, 64, 63, 61, 59, 57, 56, 54,
    53, 51, 50, 48, 47, 46, 45, 43, 42, 41, 40, 40,
    39, 38, 37, 37, 36, 36, 35, 35, 35, 34, 34, 34,
    34, 34, 34, 34, 35, 35, 35, 36, 36, 37, 37, 38,
    39, 40, 40, 41, 42, 43, 45, 46, 47, 48, 50, 51,
    53, 54, 56, 57, 59, 61, 63, 64, 66, 68, 70, 72,
    74, 77, 79, 81, 83, 85, 88, 90, 92, 95, 97, 100,
    102, 105, 107, 110, 112, 115, 118, 120, 123, 126, 128, 131,
    134, 136, 139, 142,
};

uint8_t breathBrightness(uint16_t phase_steps) {
    // Map phase_steps [0,1024) to a 256-entry table index [0,256).
    // Bit shift for speed (1024 = 256 << 2).
    uint16_t idx = (phase_steps >> 2) & 0xFFu;
    return SIN_TABLE[idx];
}

// HSV -> RGB. Standard 6-sector algorithm.
// h in [0,1536) (=360*255/60), s,v in [0,255].
Rgb hsvToRgb(uint16_t h, uint8_t s, uint8_t v) {
    // Reduce h into [0,1536).
    h %= HUE_WRAP;
    // Sector in [0,6): which 60-degree slice of the color wheel.
    uint8_t sector = (uint8_t)(h / 256u);
    // Fractional position within the sector [0,255].
    uint8_t f = (uint8_t)(h & 0xFF);
    uint8_t p = (uint8_t)(((uint16_t)(255 - s) * v) / 255);
    uint8_t q = (uint8_t)(((uint16_t)(255 - ((s * f) / 255)) * v) / 255);
    uint8_t t = (uint8_t)(((uint16_t)(255 - ((s * (255 - f)) / 255)) * v) / 255);
    uint8_t r, g, b;
    switch (sector) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        default: r = v; g = p; b = q; break;
    }
    Rgb out;
    out.r = r; out.g = g; out.b = b;
    return out;
}

// Global hue drift: how much the rainbow as a whole shifts per tick.
// FACTORY_GLOBAL_HUE_RATE hue-units/sec; TICK_MS ms/tick.
// At 4 units/sec and 10ms/tick: 4*10/1000 = 0.04 units/tick.
// Carry in 16.16 fixed point so fractional rates accumulate cleanly.
#define HUE_PER_TICK_FIXED ((uint32_t)(FACTORY_GLOBAL_HUE_RATE * 65536 / (1000 / TICK_MS)))

// breathRainbowPixel: hue varies by pixel index and by global time;
// brightness is the shared breath phase.
Rgb breathRainbowPixel(uint8_t pin, uint16_t pixel, uint16_t led_cnt,
                       uint32_t t_ticks) {
    if (led_cnt == 0) led_cnt = 1;
    // Spatial hue: across the strip.
    uint32_t spatial = ((uint32_t)pixel * FACTORY_HUE_SPAN * 256u) / led_cnt;
    // Temporal hue drift: fixed-point (t_ticks * HUE_PER_TICK_FIXED) >> 16.
    uint32_t temporal = (uint32_t)t_ticks * HUE_PER_TICK_FIXED;
    uint16_t hue = (uint16_t)(((spatial << 8) + temporal) >> 8) % HUE_WRAP;
    // Pin offset so adjacent strips are phase-shifted in color.
    hue = (uint16_t)(hue + pin * 64) % HUE_WRAP;
    // Breath brightness from the tick clock.
    uint16_t phase = (uint16_t)(((uint32_t)t_ticks * PHASE_STEPS) /
                                BREATH_TICKS_PER_CYCLE);
    uint8_t b = breathBrightness(phase & (PHASE_STEPS - 1));
    return hsvToRgb(hue, 255, b);
}

void breathRainbowFill(uint8_t pin, uint16_t led_cnt, uint32_t t_ticks) {
    for (uint16_t i = 0; i < led_cnt; i++) {
        Rgb c = breathRainbowPixel(pin, i, led_cnt, t_ticks);
        ledSetPixel(pin, i, c);
    }
}

// ===========================================================================
// 8-effect dispatch (ADR-0017). Each renderer is a pure function of
// (params, pixel, led_cnt, t_ticks). Unknown effect ids render black so a
// malformed config never bricks the strip.
// ===========================================================================

// Scale an RGB by brightness/255 (integer). brightness in [0,255].
static Rgb scale_rgb(Rgb c, uint8_t brightness) {
    if (brightness == 255) return c;
    if (brightness == 0) { Rgb z = {0,0,0}; return z; }
    Rgb o;
    o.r = (uint8_t)(((uint16_t)c.r * brightness) / 255);
    o.g = (uint8_t)(((uint16_t)c.g * brightness) / 255);
    o.b = (uint8_t)(((uint16_t)c.b * brightness) / 255);
    return o;
}

// Clamp a uint32 to uint8.
static uint8_t clamp_u8(uint32_t v) {
    return v > 255 ? 255 : (uint8_t)v;
}

// 0x01 SOLID: constant color scaled by brightness.
static Rgb fx_solid(const effect_params_t *p, uint16_t pixel, uint16_t led_cnt,
                    uint32_t t) {
    (void)pixel; (void)led_cnt; (void)t;
    Rgb c = { p->color.r, p->color.g, p->color.b };
    return scale_rgb(c, p->brightness);
}

// 0x02 BREATH: brightness sinusoid. waveform 0 = sine, 1 = triangle.
// period (ms) controls cycle speed. direction 0 = in-phase, 1 = inverted.
static Rgb fx_breath(const effect_params_t *p, uint16_t pixel, uint16_t led_cnt,
                     uint32_t t) {
    (void)led_cnt;
    // phase in [0, 1024) over one period. period in ms; t_ticks in 10ms.
    uint32_t period_ticks = (uint32_t)p->period / TICK_MS;
    if (period_ticks == 0) period_ticks = 1;
    uint32_t phase = (uint32_t)((t + pixel) % period_ticks) * PHASE_STEPS / period_ticks;
    uint8_t b;
    if (p->waveform == 0) {
        b = breathBrightness((uint16_t)phase);
    } else {
        // triangle: ramp up first half, down second half.
        uint16_t ph = (uint16_t)(phase & (PHASE_STEPS - 1));
        b = (ph < (PHASE_STEPS / 2))
                ? (uint8_t)(ph * 2 / (PHASE_STEPS / 2) * 255 / 256)
                : (uint8_t)(255 - (ph - PHASE_STEPS / 2) * 2 / (PHASE_STEPS / 2));
    }
    if (p->direction & 1) b = (uint8_t)(255 - b);
    Rgb c = { p->color.r, p->color.g, p->color.b };
    return scale_rgb(c, b);
}

// 0x03 BLINK: on/off by on_time/off_time (ms). brightness scales the "on".
static Rgb fx_blink(const effect_params_t *p, uint16_t pixel, uint16_t led_cnt,
                    uint32_t t) {
    (void)pixel; (void)led_cnt;
    uint32_t on_ticks = (uint32_t)p->on_time / TICK_MS;
    uint32_t off_ticks = (uint32_t)p->off_time / TICK_MS;
    if (on_ticks == 0) on_ticks = 1;
    if (off_ticks == 0) off_ticks = 1;
    uint32_t period = on_ticks + off_ticks;
    uint32_t pos = t % period;
    if (pos < on_ticks) {
        Rgb c = { p->color.r, p->color.g, p->color.b };
        return scale_rgb(c, p->brightness);
    }
    Rgb z = {0,0,0};
    return z;
}

// 0x04 MARQUEE: a moving block of `led_count` lit pixels with `gap` dark
// pixels between repetitions. speed (1..100) -> pixels per second.
static Rgb fx_marquee(const effect_params_t *p, uint16_t pixel, uint16_t led_cnt,
                      uint32_t t) {
    // speed 1..100 -> 1..100 pixels/sec -> ticks per pixel = 1000/speed/10.
    uint32_t speed = p->speed ? p->speed : 1;
    uint32_t ticks_per_step = 1000 / speed / TICK_MS;
    if (ticks_per_step == 0) ticks_per_step = 1;
    uint32_t head = t / ticks_per_step; // head position in "cells"
    uint32_t cell = (uint32_t)p->led_count + (uint32_t)p->gap;
    if (cell == 0) cell = 1;
    // position of this pixel within the cell pattern
    uint32_t period_cells = (led_cnt + cell - 1) / cell; // cells across strip
    if (period_cells == 0) period_cells = 1;
    uint32_t my_cell = (uint32_t)pixel / cell;
    uint32_t my_off  = (uint32_t)pixel % cell;
    // direction: 0 forward, 1 reverse
    uint32_t head_cell = (p->direction & 1)
        ? (period_cells - 1) - (head % period_cells)
        : (head % period_cells);
    uint32_t dist = (my_cell >= head_cell) ? (my_cell - head_cell)
                                           : (my_cell + period_cells - head_cell);
    if (dist < (uint32_t)p->led_count && my_off < (uint32_t)p->led_count) {
        // brightness fades with distance from head (tail effect).
        uint8_t b = p->brightness;
        if (dist > 0) {
            uint32_t fade = (uint32_t)dist * 255 / (uint32_t)p->led_count;
            b = (uint8_t)(b > fade ? b - fade : 0);
        }
        Rgb c = { p->color.r, p->color.g, p->color.b };
        return scale_rgb(c, b);
    }
    Rgb z = {0,0,0};
    return z;
}

// 0x05 RAINBOW: hue gradient across the strip, scrolling over time.
// spread (1..100) -> hue span as a percentage of the full wheel.
static Rgb fx_rainbow(const effect_params_t *p, uint16_t pixel, uint16_t led_cnt,
                      uint32_t t) {
    if (led_cnt == 0) led_cnt = 1;
    uint32_t speed = p->speed ? p->speed : 1;
    // scroll rate: full wheel per (256/speed) seconds.
    uint32_t scroll = (t * 256u) / (256u / speed) / (1000u / TICK_MS);
    uint32_t span = (uint32_t)p->spread * HUE_WRAP / 100u;
    uint32_t spatial = (uint32_t)pixel * span / led_cnt;
    uint16_t hue = (uint16_t)((spatial + scroll) % HUE_WRAP);
    if (p->direction & 1) hue = (uint16_t)(HUE_WRAP - 1 - hue);
    return hsvToRgb(hue, 255, p->brightness);
}

// 0x06 METEOR: a bright head with an exponentially-decaying tail.
// tail_length (1..100) lit pixels; decay (1..255) brightness falloff.
static Rgb fx_meteor(const effect_params_t *p, uint16_t pixel, uint16_t led_cnt,
                     uint32_t t) {
    uint32_t speed = p->speed ? p->speed : 1;
    uint32_t ticks_per_step = 1000 / speed / TICK_MS;
    if (ticks_per_step == 0) ticks_per_step = 1;
    uint32_t head = t / ticks_per_step;
    // direction: 0 -> head moves toward higher indices (tail behind = lower
    // indices); 1 -> head moves toward lower indices (tail behind = higher).
    uint32_t dist;
    if (p->direction & 1) {
        // reverse: tail is at indices >= head
        dist = (pixel >= head) ? (pixel - head) : 0;
    } else {
        // forward: tail is at indices <= head
        dist = (pixel <= head) ? (head - pixel) : 0;
    }
    uint32_t tail = p->tail_length ? p->tail_length : 1;
    if (dist >= tail) {
        Rgb z = {0,0,0};
        return z;
    }
    // brightness = brightness * (decay/255)^dist
    uint32_t b = p->brightness;
    for (uint32_t i = 0; i < dist; i++) {
        b = (b * (uint32_t)p->decay) / 255;
        if (b == 0) break;
    }
    Rgb c = { p->color.r, p->color.g, p->color.b };
    return scale_rgb(c, clamp_u8(b));
}

// 0x07 DUAL_GRADIENT: blend between color and color2 across the strip.
// mode 0 = linear, 1 = sine ease.
static Rgb fx_dual_gradient(const effect_params_t *p, uint16_t pixel,
                            uint16_t led_cnt, uint32_t t) {
    if (led_cnt <= 1) {
        Rgb c = { p->color.r, p->color.g, p->color.b };
        return scale_rgb(c, p->brightness);
    }
    uint32_t speed = p->speed ? p->speed : 1;
    uint32_t scroll = (t * speed) / (100u / TICK_MS); // 0..255 sweep
    uint32_t pos = ((uint32_t)pixel * 255u / (led_cnt - 1) + scroll) & 0xFF;
    uint8_t frac;
    if (p->mode == 0) {
        frac = (uint8_t)pos; // linear
    } else {
        // sine ease: (1-cos(2pi*pos/256))/2 * 255
        uint16_t phase = (uint16_t)((pos * PHASE_STEPS) / 256) & (PHASE_STEPS - 1);
        frac = (uint8_t)(breathBrightness(phase)); // breathBrightness is (sin+1)/2*221+34
        // renormalize to 0..255 roughly
        frac = (uint8_t)(((uint32_t)frac * 255u) / 255u);
    }
    Rgb c1 = { p->color.r, p->color.g, p->color.b };
    Rgb c2 = { p->color2.r, p->color2.g, p->color2.b };
    Rgb out;
    out.r = (uint8_t)(c1.r + ((int)c2.r - (int)c1.r) * frac / 255);
    out.g = (uint8_t)(c1.g + ((int)c2.g - (int)c1.g) * frac / 255);
    out.b = (uint8_t)(c1.b + ((int)c2.b - (int)c1.b) * frac / 255);
    return scale_rgb(out, p->brightness);
}

// 0x08 RHYTHM: step-jump pattern. pattern (0..255) selects a beat mask;
// step_size (1..100) controls how many pixels jump per beat. speed ->
// beats per second.
static Rgb fx_rhythm(const effect_params_t *p, uint16_t pixel, uint16_t led_cnt,
                     uint32_t t) {
    uint32_t speed = p->speed ? p->speed : 1;
    uint32_t ticks_per_beat = 1000 / speed / TICK_MS;
    if (ticks_per_beat == 0) ticks_per_beat = 1;
    uint32_t beat = t / ticks_per_beat;
    // pattern bit: on/off for this beat (cycling through pattern bits).
    uint8_t mask = (uint8_t)(p->pattern >> (beat & 7)) & 1u;
    // also a slower gate so it visibly jumps.
    uint8_t gate = (uint8_t)((beat / 8) & 1u);
    bool on = (mask ^ gate) != 0;
    if (!on) {
        Rgb z = {0,0,0};
        return z;
    }
    // step jump: light blocks of step_size pixels, offset by beat.
    uint32_t step = p->step_size ? p->step_size : 1;
    uint32_t block = (uint32_t)pixel / step;
    uint32_t lit = (block + beat) % 3; // 1-in-3 blocks lit per beat
    if (lit != 0) {
        Rgb z = {0,0,0};
        return z;
    }
    Rgb c = { p->color.r, p->color.g, p->color.b };
    return scale_rgb(c, p->brightness);
}

Rgb effectRenderPixel(uint8_t effect_id, const effect_params_t *p,
                      uint16_t pixel, uint16_t led_cnt, uint32_t t) {
    switch (effect_id) {
        case EFF_SOLID:          return fx_solid(p, pixel, led_cnt, t);
        case EFF_BREATH:         return fx_breath(p, pixel, led_cnt, t);
        case EFF_BLINK:          return fx_blink(p, pixel, led_cnt, t);
        case EFF_MARQUEE:        return fx_marquee(p, pixel, led_cnt, t);
        case EFF_RAINBOW:        return fx_rainbow(p, pixel, led_cnt, t);
        case EFF_METEOR:         return fx_meteor(p, pixel, led_cnt, t);
        case EFF_DUAL_GRADIENT:  return fx_dual_gradient(p, pixel, led_cnt, t);
        case EFF_RHYTHM:         return fx_rhythm(p, pixel, led_cnt, t);
        default: {
            Rgb z = {0,0,0};
            return z;
        }
    }
}

void effectRenderFill(uint8_t pin, uint8_t effect_id, const effect_params_t *p,
                      uint16_t led_cnt, uint32_t t) {
    for (uint16_t i = 0; i < led_cnt; i++) {
        Rgb c = effectRenderPixel(effect_id, p, i, led_cnt, t);
        ledSetPixel(pin, i, c);
    }
}
