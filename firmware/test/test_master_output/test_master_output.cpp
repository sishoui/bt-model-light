// Unity tests for the master output stage (整机开关 + 整机亮度, ADR-0031/0032).
//
// Covers:
//   - Defaults are 开机 + 255 (no gating/scaling) so a device that never
//     receives the master commands renders exactly as before.
//   - Brightness: integer value/255 per channel; 0 -> black.
//   - Power: off -> black regardless of brightness; **off/on must not clear
//     the brightness setting** (state preservation is the whole point of the
//     device-level switch, ADR-0032).
//   - Stub integration: ledSetPixel applies the output stage, so every
//     renderer (composition, factory default) is covered by one choke point.
//   - masterResetDefaults -> 开机 + 满亮度 (RESET_DEFAULT / BOOT long-press).

#include <unity.h>
#include "master_output.h"
#include "led_driver.h"

// Native-only pixel readback from led_driver_stub.cpp.
void ledTestReset(void);
bool ledTestGetPixel(uint8_t pin, uint16_t idx, Rgb *out);

extern "C" void setUp(void) {
    masterResetDefaults();
    ledTestReset();
}
extern "C" void tearDown(void) {}

static Rgb rgb(uint8_t r, uint8_t g, uint8_t b) {
    Rgb c = {r, g, b};
    return c;
}

static void assert_pixel(uint8_t pin, uint16_t idx, uint8_t r, uint8_t g, uint8_t b) {
    Rgb out = {0, 0, 0};
    TEST_ASSERT_TRUE(ledTestGetPixel(pin, idx, &out));
    TEST_ASSERT_EQUAL_UINT8(r, out.r);
    TEST_ASSERT_EQUAL_UINT8(g, out.g);
    TEST_ASSERT_EQUAL_UINT8(b, out.b);
}

// ---- 亮度（SET_BRIGHTNESS） ------------------------------------------------

static void test_default_is_unscaled(void) {
    TEST_ASSERT_EQUAL_UINT8(255, masterGetBrightness());
    Rgb out = masterApplyOutput(rgb(255, 200, 100));
    TEST_ASSERT_EQUAL_UINT8(255, out.r);
    TEST_ASSERT_EQUAL_UINT8(200, out.g);
    TEST_ASSERT_EQUAL_UINT8(100, out.b);
}

static void test_half_scales_each_channel(void) {
    masterSetBrightness(128);
    Rgb out = masterApplyOutput(rgb(255, 200, 100));
    TEST_ASSERT_EQUAL_UINT8(128, out.r);  // 255*128/255
    TEST_ASSERT_EQUAL_UINT8(100, out.g);  // 200*128/255 = 100.4 -> 100
    TEST_ASSERT_EQUAL_UINT8(50, out.b);   // 100*128/255 = 50.2 -> 50
}

static void test_zero_brightness_is_black(void) {
    masterSetBrightness(0);
    Rgb out = masterApplyOutput(rgb(255, 200, 100));
    TEST_ASSERT_EQUAL_UINT8(0, out.r);
    TEST_ASSERT_EQUAL_UINT8(0, out.g);
    TEST_ASSERT_EQUAL_UINT8(0, out.b);
}

// ---- 整机开关（SET_POWER） -------------------------------------------------

static void test_default_power_is_on(void) {
    TEST_ASSERT_TRUE(masterGetPower());
    ledSetPixel(0, 0, rgb(10, 20, 30));
    assert_pixel(0, 0, 10, 20, 30);
}

static void test_power_off_blacks_output(void) {
    masterSetPower(false);
    ledSetPixel(0, 0, rgb(255, 255, 255));
    assert_pixel(0, 0, 0, 0, 0);   // 关机 = 输出全黑
}

static void test_power_off_wins_over_brightness(void) {
    masterSetBrightness(200);
    masterSetPower(false);
    Rgb out = masterApplyOutput(rgb(255, 255, 255));
    TEST_ASSERT_EQUAL_UINT8(0, out.r);
    TEST_ASSERT_EQUAL_UINT8(0, out.g);
    TEST_ASSERT_EQUAL_UINT8(0, out.b);
}

static void test_power_cycle_keeps_brightness(void) {
    // 关机再开机不得清掉亮度设定（ADR-0032：整机开关只门控输出）。
    masterSetBrightness(64);
    masterSetPower(false);
    TEST_ASSERT_EQUAL_UINT8(64, masterGetBrightness());
    masterSetPower(true);
    TEST_ASSERT_EQUAL_UINT8(64, masterGetBrightness());
    ledSetPixel(1, 0, rgb(255, 200, 100));
    assert_pixel(1, 0, 64, 50, 25);   // 仍是 64/255 的缩放
}

static void test_power_on_restores_render(void) {
    masterSetPower(false);
    ledSetPixel(1, 0, rgb(9, 9, 9));
    assert_pixel(1, 0, 0, 0, 0);
    masterSetPower(true);
    ledSetPixel(1, 0, rgb(9, 9, 9));
    assert_pixel(1, 0, 9, 9, 9);      // 开机后按原样渲染
}

// ---- 出厂复位 --------------------------------------------------------------

static void test_reset_defaults_restores_on_and_full(void) {
    masterSetPower(false);
    masterSetBrightness(7);
    masterResetDefaults();
    TEST_ASSERT_TRUE(masterGetPower());
    TEST_ASSERT_EQUAL_UINT8(255, masterGetBrightness());
    ledSetPixel(2, 0, rgb(255, 100, 50));
    assert_pixel(2, 0, 255, 100, 50);
}

// ---- stub 集成与边界 -------------------------------------------------------

static void test_out_of_range_pixel_is_ignored(void) {
    masterSetBrightness(128);
    ledSetPixel(PIN_COUNT, 0, rgb(255, 255, 255));
    ledSetPixel(0, LEDS_PER_PIN_MAX, rgb(255, 255, 255));
    Rgb out = {0, 0, 0};
    TEST_ASSERT_FALSE(ledTestGetPixel(0, LEDS_PER_PIN_MAX, &out));
}

int main(int, char **) {
    UNITY_BEGIN();
    RUN_TEST(test_default_is_unscaled);
    RUN_TEST(test_half_scales_each_channel);
    RUN_TEST(test_zero_brightness_is_black);
    RUN_TEST(test_default_power_is_on);
    RUN_TEST(test_power_off_blacks_output);
    RUN_TEST(test_power_off_wins_over_brightness);
    RUN_TEST(test_power_cycle_keeps_brightness);
    RUN_TEST(test_power_on_restores_render);
    RUN_TEST(test_reset_defaults_restores_on_and_full);
    RUN_TEST(test_out_of_range_pixel_is_ignored);
    return UNITY_END();
}
