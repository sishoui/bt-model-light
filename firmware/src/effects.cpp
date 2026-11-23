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
