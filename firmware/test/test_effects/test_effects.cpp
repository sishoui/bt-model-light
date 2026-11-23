// Unity tests for the 8 effect renderers (T6 / #26, ADR-0017).
//
// Each effect is a pure function of (params, pixel, led_cnt, t_ticks).
// Tests verify the qualitative behaviour (non-black where lit, black
// where off, brightness scaling, direction, etc.) rather than exact
// pixel values — the latter would couple the tests to the integer
// arithmetic and make them brittle.

#include <unity.h>
#include "config.h"
#include "effects.h"

#include <string.h>

extern "C" void setUp(void) {
    // Deterministic RNG seed isn't needed; effects are pure.
}
extern "C" void tearDown(void) {}

static effect_params_t make_solid(uint8_t r, uint8_t g, uint8_t b, uint8_t br) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = r; p.color.g = g; p.color.b = b;
    p.brightness = br;
    return p;
}

// ---- SOLID ---------------------------------------------------------------

void test_solid_full_brightness(void) {
    effect_params_t p = make_solid(100, 150, 200, 255);
    for (uint16_t i = 0; i < 10; i++) {
        Rgb c = effectRenderPixel(EFF_SOLID, &p, i, 10, 0);
        TEST_ASSERT_EQUAL_UINT8(100, c.r);
        TEST_ASSERT_EQUAL_UINT8(150, c.g);
        TEST_ASSERT_EQUAL_UINT8(200, c.b);
    }
}

void test_solid_half_brightness(void) {
    effect_params_t p = make_solid(200, 200, 200, 128);
    Rgb c = effectRenderPixel(EFF_SOLID, &p, 0, 10, 0);
    // 200 * 128 / 255 ~= 100
    TEST_ASSERT_UINT8_WITHIN(2, 100, c.r);
}

void test_solid_zero_brightness_black(void) {
    effect_params_t p = make_solid(255, 255, 255, 0);
    Rgb c = effectRenderPixel(EFF_SOLID, &p, 0, 10, 0);
    TEST_ASSERT_EQUAL_UINT8(0, c.r);
    TEST_ASSERT_EQUAL_UINT8(0, c.g);
    TEST_ASSERT_EQUAL_UINT8(0, c.b);
}

// ---- BREATH --------------------------------------------------------------

void test_breath_changes_over_time(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = 100; p.color.g = 100; p.color.b = 100;
    p.brightness = 255;
    p.period = 1000; // 1s period -> 100 ticks
    p.waveform = 0;
    Rgb a = effectRenderPixel(EFF_BREATH, &p, 0, 10, 0);
    Rgb b = effectRenderPixel(EFF_BREATH, &p, 0, 10, 25); // quarter cycle
    // brightness should differ across the cycle
    TEST_ASSERT_TRUE(a.r != b.r || a.g != b.g || a.b != b.b);
}

void test_breath_direction_inverts(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = 100; p.color.g = 100; p.color.b = 100;
    p.brightness = 255;
    p.period = 1000;
    p.waveform = 0;
    p.direction = 0;
    Rgb fwd = effectRenderPixel(EFF_BREATH, &p, 0, 10, 25);
    p.direction = 1;
    Rgb rev = effectRenderPixel(EFF_BREATH, &p, 0, 10, 25);
    // direction=1 inverts brightness; at quarter cycle fwd is bright,
    // rev should be dark (and vice versa). They must differ.
    TEST_ASSERT_TRUE(fwd.r != rev.r || fwd.g != rev.g || fwd.b != rev.b);
}

// ---- BLINK ---------------------------------------------------------------

void test_blink_on_off(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = 255; p.color.g = 255; p.color.b = 255;
    p.brightness = 255;
    p.on_time = 100;  // 10 ticks
    p.off_time = 100; // 10 ticks
    // t=0 -> in on phase (pos 0 < on_ticks 10).
    Rgb on = effectRenderPixel(EFF_BLINK, &p, 0, 10, 0);
    TEST_ASSERT_EQUAL_UINT8(255, on.r);
    // t=15 ticks -> pos 15 >= on_ticks 10 -> off.
    Rgb off = effectRenderPixel(EFF_BLINK, &p, 0, 10, 15);
    TEST_ASSERT_EQUAL_UINT8(0, off.r);
}

// ---- MARQUEE -------------------------------------------------------------

void test_marquee_some_lit_some_dark(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = 255; p.color.g = 255; p.color.b = 255;
    p.brightness = 255;
    p.speed = 50;      // moderate
    p.direction = 0;
    p.led_count = 3;   // 3 lit
    p.gap = 2;         // 2 dark
    // Over a full strip at t=0, some pixels lit, some dark.
    int lit = 0, dark = 0;
    for (uint16_t i = 0; i < 20; i++) {
        Rgb c = effectRenderPixel(EFF_MARQUEE, &p, i, 20, 0);
        if (c.r != 0) lit++; else dark++;
    }
    TEST_ASSERT_TRUE(lit > 0);
    TEST_ASSERT_TRUE(dark > 0);
}

// ---- RAINBOW -------------------------------------------------------------

void test_rainbow_varies_across_strip(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.brightness = 255;
    p.speed = 50;
    p.direction = 0;
    p.spread = 100; // full wheel across the strip
    Rgb a = effectRenderPixel(EFF_RAINBOW, &p, 0, 10, 0);
    Rgb b = effectRenderPixel(EFF_RAINBOW, &p, 5, 10, 0);
    // Different positions -> different hues -> different RGB.
    TEST_ASSERT_TRUE(a.r != b.r || a.g != b.g || a.b != b.b);
}

void test_rainbow_scrolls_over_time(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.brightness = 255;
    p.speed = 50;
    p.direction = 0;
    p.spread = 100;
    Rgb a = effectRenderPixel(EFF_RAINBOW, &p, 0, 10, 0);
    Rgb b = effectRenderPixel(EFF_RAINBOW, &p, 0, 10, 25);
    TEST_ASSERT_TRUE(a.r != b.r || a.g != b.g || a.b != b.b);
}

// ---- METEOR --------------------------------------------------------------

void test_meteor_head_bright_tail_dim(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = 255; p.color.g = 255; p.color.b = 255;
    p.brightness = 255;
    p.speed = 50;
    p.direction = 0;
    p.tail_length = 5;
    p.decay = 128; // aggressive falloff
    // At a tick where the head is at pixel 3, head bright, tail dim.
    // ticks_per_step = 1000/50/10 = 2. t=6 -> head = 3.
    Rgb head = effectRenderPixel(EFF_METEOR, &p, 3, 20, 6);
    Rgb tail = effectRenderPixel(EFF_METEOR, &p, 5, 20, 6);
    TEST_ASSERT_TRUE(head.r > 0);
    // tail pixel (dist 2) should be dimmer than head (dist 0)
    TEST_ASSERT_TRUE(tail.r <= head.r);
}

void test_meteor_beyond_tail_black(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = 255; p.color.g = 255; p.color.b = 255;
    p.brightness = 255;
    p.speed = 50;
    p.direction = 1; // reverse: head moves toward lower indices,
                     // tail is at indices >= head
    p.tail_length = 3;
    p.decay = 128;
    // ticks_per_step = 1000/50/10 = 2. t=0 -> head = 0.
    // In reverse mode, tail is at indices >= head. With head=0 and
    // tail_length=3, pixels 0,1,2 are the tail; pixel 5 is beyond ->
    // dist = 5 >= tail 3 -> black.
    Rgb far = effectRenderPixel(EFF_METEOR, &p, 5, 20, 0);
    TEST_ASSERT_EQUAL_UINT8(0, far.r);
}

// ---- DUAL_GRADIENT -------------------------------------------------------

void test_dual_gradient_varies_across_strip(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = 255; p.color.g = 0; p.color.b = 0;
    p.color2.r = 0; p.color2.g = 0; p.color2.b = 255;
    p.brightness = 255;
    p.speed = 1;       // slow so scroll is ~0 at t=0
    p.mode = 0;        // linear
    Rgb a = effectRenderPixel(EFF_DUAL_GRADIENT, &p, 0, 10, 0);
    Rgb b = effectRenderPixel(EFF_DUAL_GRADIENT, &p, 9, 10, 0);
    // a near color (red), b near color2 (blue).
    TEST_ASSERT_TRUE(a.r > b.r);
    TEST_ASSERT_TRUE(b.b > a.b);
}

// ---- RHYTHM --------------------------------------------------------------

void test_rhythm_unknown_effect_black(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    Rgb c = effectRenderPixel(0x7F, &p, 0, 10, 0);
    TEST_ASSERT_EQUAL_UINT8(0, c.r);
    TEST_ASSERT_EQUAL_UINT8(0, c.g);
    TEST_ASSERT_EQUAL_UINT8(0, c.b);
}

void test_rhythm_produces_some_lit(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    p.color.r = 255; p.color.g = 255; p.color.b = 255;
    p.brightness = 255;
    p.speed = 50;
    p.pattern = 0xFF; // all bits set -> always on gate
    p.step_size = 3;
    int lit = 0;
    for (uint32_t t = 0; t < 20; t++) {
        for (uint16_t i = 0; i < 10; i++) {
            Rgb c = effectRenderPixel(EFF_RHYTHM, &p, i, 10, t);
            if (c.r != 0) lit++;
        }
    }
    // With pattern 0xFF, some beats are on -> some lit pixels.
    TEST_ASSERT_TRUE(lit > 0);
}

// ---- unknown effect ------------------------------------------------------

void test_unknown_effect_black(void) {
    effect_params_t p;
    memset(&p, 0, sizeof(p));
    Rgb c = effectRenderPixel(0x99, &p, 0, 10, 0);
    TEST_ASSERT_EQUAL_UINT8(0, c.r);
}

// ---- main ----------------------------------------------------------------

int main(int argc, char **argv) {
    UNITY_BEGIN();
    RUN_TEST(test_solid_full_brightness);
    RUN_TEST(test_solid_half_brightness);
    RUN_TEST(test_solid_zero_brightness_black);
    RUN_TEST(test_breath_changes_over_time);
    RUN_TEST(test_breath_direction_inverts);
    RUN_TEST(test_blink_on_off);
    RUN_TEST(test_marquee_some_lit_some_dark);
    RUN_TEST(test_rainbow_varies_across_strip);
    RUN_TEST(test_rainbow_scrolls_over_time);
    RUN_TEST(test_meteor_head_bright_tail_dim);
    RUN_TEST(test_meteor_beyond_tail_black);
    RUN_TEST(test_dual_gradient_varies_across_strip);
    RUN_TEST(test_rhythm_unknown_effect_black);
    RUN_TEST(test_rhythm_produces_some_lit);
    RUN_TEST(test_unknown_effect_black);
    return UNITY_END();
}