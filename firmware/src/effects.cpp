// Effect rendering implementation.
//
// T2 scope: breath-rainbow (the factory-default effect). The other 7
// effects from ADR-0017 land in T6.

#include "effects.h"
#include "factory_default.h"

// Phase steps: a full breath cycle is 1024 phase steps.
// At FACTORY_BREATH_PERIOD_MS = 3000ms and TICK_MS = 10ms, that is
// 300 ticks per cycle; phase advances by 1024/300 ≈ 3.4 per tick.
static const uint16_t PHASE_STEPS = 1024;
static const uint32_t BREATH_TICKS_PER_CYCLE = FACTORY_BREATH_PERIOD_MS / TICK_MS;
static const uint16_t HUE_WRAP = 1536; // 360 * 255 / 60

// Sine lookup: 256 samples over [0, 2pi). brightness = (sin+1)/2*255
// with a soft floor of 34 so "dark" is not fully black.
static const uint8_t SIN_TABLE[256] = {
        128, 137, 146, 154, 162, 170, 177, 184, 191, 197, 202, 207,
        212, 216, 220, 223, 226, 228, 230, 231, 232, 233, 233, 233,
        233, 233, 233, 233, 233, 233, 233, 232, 230, 228, 226, 223,
        220, 216, 212, 207, 202, 197, 191, 184, 177, 170, 162, 154,
        146, 137, 128, 119, 110, 102, 94, 86, 79, 72, 65, 59, 54,
        49, 45, 41, 38, 36, 35, 34, 34, 34, 34, 34, 34, 34, 34,
        34, 35, 36, 38, 41, 45, 49, 54, 59, 65, 72, 79, 86, 94,
        102, 110, 119, 128, 137, 146, 154, 162, 170, 177, 184, 191,
        197, 202, 207, 212, 216, 220, 223, 226, 228, 230, 231, 232,
        233, 233, 233, 233, 233, 233, 233, 233, 233, 233, 233, 232,
        230, 228, 226, 223, 220, 216, 212, 207, 202, 197, 191, 184,
        177, 170, 162, 154, 146, 137, 128, 119, 110, 102, 94, 86,
        79, 72, 65, 59, 54, 49, 45, 41, 38, 36, 35, 34, 34, 34,
        34, 34, 34, 34, 34, 34, 34, 35, 36, 38, 41, 45, 49, 54,
        59, 65, 72, 79, 86, 94, 102, 110, 119, 128, 137, 146, 154,
        162, 170, 177, 184, 191, 197, 202, 207, 212, 216, 220, 223,
        226, 228, 230, 231, 232, 233, 233, 233, 233, 233, 233, 233,
        233, 233, 233, 233, 233, 233, 233, 233, 233, 233, 233, 233,
        233, 233, 233, 233, 233, 233, 233, 233, 233, 233, 233, 233,
        233, 233, 233, 233, 233, 233, 233, 233, 233, 233, 233, 233,
};

uint8_t breathBrightness(uint16_t phase_steps) {
    uint16_t idx = (uint16_t)((phase_steps * 256u) / PHASE_STEPS) & 0xFFu;
    return SIN_TABLE[idx];
}

// HSV -> RGB. FastLED's hsv2rgb_rainbow reference algorithm.
// h in [0,1536), s,v in [0,255].
Rgb hsvToRgb(uint16_t h, uint8_t s, uint8_t v) {
    uint8_t offset = (uint8_t)(h & 0xFF);
    uint8_t hue = (uint8_t)(h >> 8);
    // sector boundaries at 0, 256, 512, ... within 1536
    uint8_t third = hue / 3;
    // compute base RGB from the hue sector
    uint8_t p = (uint8_t)(((uint16_t)(255 - s) * v) / 255);
    uint8_t q = (uint8_t)(((uint16_t)(255 - ((s * offset) / 255)) * v) / 255);
    uint8_t t = (uint8_t)(((uint16_t)(255 - ((s * (255 - offset)) / 255)) * v) / 255);
    uint8_t r, g, b;
    switch (third) {
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
// At 4 hue-units/sec and 100 ticks/sec that is 0.04 units/tick, so we
// carry it in a fixed-point accumulator inside breathRainbowFill.
#define HUE_PER_TICK 0x0A  // ≈ 4 units/s * 10ms / 256 (fixed point)

// breathRainbowPixel: hue varies by pixel index and by global time;
// brightness is the shared breath phase.
Rgb breathRainbowPixel(uint8_t pin, uint16_t pixel, uint16_t led_cnt,
                       uint32_t t_ticks) {
    if (led_cnt == 0) led_cnt = 1;
    // Spatial hue: across the strip.
    uint32_t spatial = ((uint32_t)pixel * FACTORY_HUE_SPAN * 256u) / led_cnt;
    // Temporal hue drift: linear in t_ticks (fixed point).
    uint32_t temporal = (uint32_t)t_ticks * HUE_PER_TICK * 16u;
    uint16_t hue = (uint16_t)((spatial + temporal) >> 8) % HUE_WRAP;
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