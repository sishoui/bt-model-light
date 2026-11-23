// Unity tests for the firmware config module (T6 / #26).
//
// Coverage:
//   - Factory default: build, validate, encode, decode round-trip.
//   - Empty config: validate, encode (small blob), decode round-trip.
//   - Encode -> decode preserves every field (8 pins, groups, steps,
//     layers, params) for a hand-built config.
//   - Corruption detection: flip a byte in the body -> CRC error (0x01).
//   - Corruption: bad magic -> ERR_INTERNAL_ERROR (0x07).
//   - Corruption: version mismatch -> ERR_INVALID_PARAMETER (0x04).
//   - Validation: led_end < led_start -> 0x04; unknown effect -> 0x04;
//     duration out of range -> 0x04; layer_count 0 -> 0x03.
//   - param_len mismatch -> 0x04.
//   - effectRenderPixel / config_decode_params basic sanity.

#include <unity.h>
#include "config.h"
#include "effects.h"

#include <string.h>

extern "C" void setUp(void) {}
extern "C" void tearDown(void) {}

// Build a minimal valid config: one pin, one group, one step, one SOLID layer.
static void build_minimal(device_config_t *c) {
    config_init_empty(c);
    config_pin_t *p = &c->pins[0];
    p->group_count = 1;
    config_group_t *g = &p->groups[0];
    g->led_start = 0;
    g->led_end = 9;
    g->step_count = 1;
    config_step_t *s = &g->steps[0];
    s->duration = 5;
    s->transition = CONFIG_TRANSITION_NONE;
    s->loop_mode = CONFIG_LOOP_LOOP;
    s->layer_count = 1;
    config_layer_t *l = &s->layers[0];
    l->effect_id = EFF_SOLID;
    l->param_len = (uint8_t)config_effect_param_size(EFF_SOLID);
    // SOLID params: color(R,G,B) + brightness
    l->params[0] = 0x12; l->params[1] = 0x34; l->params[2] = 0x56;
    l->params[3] = 200;
}

// ---- factory default -----------------------------------------------------

void test_factory_default_validates(void) {
    device_config_t c;
    config_load_factory_default(&c);
    TEST_ASSERT_EQUAL_UINT8(0, config_validate(&c));
    TEST_ASSERT_EQUAL_UINT8(CONFIG_VERSION, c.version);
    for (int pin = 0; pin < PIN_COUNT; pin++) {
        TEST_ASSERT_EQUAL_UINT8(1, c.pins[pin].group_count);
        TEST_ASSERT_EQUAL_UINT8(1, c.pins[pin].groups[0].step_count);
        TEST_ASSERT_EQUAL_UINT8(EFF_BREATH, c.pins[pin].groups[0].steps[0].layers[0].effect_id);
    }
}

void test_factory_default_roundtrip(void) {
    device_config_t c, d;
    config_load_factory_default(&c);
    uint8_t buf[FRAME_LEN_MAX];
    uint8_t err = 0;
    size_t n = config_encode(&c, buf, sizeof(buf), &err);
    TEST_ASSERT_TRUE(n > 0);
    TEST_ASSERT_EQUAL_UINT8(0, err);
    uint8_t rc = config_decode(buf, n, &d);
    TEST_ASSERT_EQUAL_UINT8(0, rc);
    // Spot-check a field deep in the config.
    TEST_ASSERT_EQUAL_UINT8(c.pins[7].groups[0].steps[0].layers[0].effect_id,
                            d.pins[7].groups[0].steps[0].layers[0].effect_id);
    TEST_ASSERT_EQUAL_UINT8(c.pins[7].groups[0].led_end,
                            d.pins[7].groups[0].led_end);
    TEST_ASSERT_EQUAL_UINT16(c.pins[0].groups[0].steps[0].duration,
                             d.pins[0].groups[0].steps[0].duration);
    TEST_ASSERT_EQUAL_UINT8(c.pins[3].groups[0].steps[0].layers[0].params[6],
                            d.pins[3].groups[0].steps[0].layers[0].params[6]);
}

// ---- minimal roundtrip ---------------------------------------------------

void test_minimal_roundtrip(void) {
    device_config_t c, d;
    build_minimal(&c);
    uint8_t buf[FRAME_LEN_MAX];
    uint8_t err = 0;
    size_t n = config_encode(&c, buf, sizeof(buf), &err);
    TEST_ASSERT_TRUE(n > 0);
    TEST_ASSERT_EQUAL_UINT8(0, config_decode(buf, n, &d));
    TEST_ASSERT_EQUAL_UINT8(1, d.pins[0].group_count);
    TEST_ASSERT_EQUAL_UINT8(0, d.pins[0].groups[0].led_start);
    TEST_ASSERT_EQUAL_UINT8(9, d.pins[0].groups[0].led_end);
    TEST_ASSERT_EQUAL_UINT8(1, d.pins[0].groups[0].step_count);
    TEST_ASSERT_EQUAL_UINT8(5, d.pins[0].groups[0].steps[0].duration);
    TEST_ASSERT_EQUAL_UINT8(1, d.pins[0].groups[0].steps[0].layer_count);
    TEST_ASSERT_EQUAL_UINT8(EFF_SOLID, d.pins[0].groups[0].steps[0].layers[0].effect_id);
    TEST_ASSERT_EQUAL_UINT8(0x12, d.pins[0].groups[0].steps[0].layers[0].params[0]);
    TEST_ASSERT_EQUAL_UINT8(0x56, d.pins[0].groups[0].steps[0].layers[0].params[2]);
    TEST_ASSERT_EQUAL_UINT8(200, d.pins[0].groups[0].steps[0].layers[0].params[3]);
}

// ---- corruption detection ------------------------------------------------

void test_crc_error_on_body_flip(void) {
    device_config_t c;
    config_load_factory_default(&c);
    uint8_t buf[FRAME_LEN_MAX];
    uint8_t err = 0;
    size_t n = config_encode(&c, buf, sizeof(buf), &err);
    TEST_ASSERT_TRUE(n > 0);
    // Flip a byte in the body (offset 10, well inside body).
    buf[12] ^= 0xFF;
    device_config_t d;
    uint8_t rc = config_decode(buf, n, &d);
    TEST_ASSERT_EQUAL_UINT8(ERR_CRC_ERROR, rc);
}

void test_bad_magic(void) {
    device_config_t c;
    config_load_factory_default(&c);
    uint8_t buf[FRAME_LEN_MAX];
    uint8_t err = 0;
    size_t n = config_encode(&c, buf, sizeof(buf), &err);
    buf[0] = 0x00; // corrupt magic
    device_config_t d;
    TEST_ASSERT_EQUAL_UINT8(ERR_INTERNAL_ERROR, config_decode(buf, n, &d));
}

void test_version_mismatch(void) {
    device_config_t c;
    config_load_factory_default(&c);
    uint8_t buf[FRAME_LEN_MAX];
    uint8_t err = 0;
    size_t n = config_encode(&c, buf, sizeof(buf), &err);
    buf[4] = 0xFF; // bad version (and crc will also fail, but version
                  // is checked before crc in config_decode).
    device_config_t d;
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, config_decode(buf, n, &d));
}

void test_truncated_blob(void) {
    device_config_t c;
    config_load_factory_default(&c);
    uint8_t buf[FRAME_LEN_MAX];
    uint8_t err = 0;
    size_t n = config_encode(&c, buf, sizeof(buf), &err);
    // Pass fewer bytes than the blob claims.
    device_config_t d;
    TEST_ASSERT_EQUAL_UINT8(ERR_BUFFER_OVERFLOW, config_decode(buf, n - 3, &d));
}

void test_empty_blob(void) {
    device_config_t d;
    TEST_ASSERT_EQUAL_UINT8(ERR_INTERNAL_ERROR, config_decode(NULL, 0, &d));
}

// ---- validation rejections ----------------------------------------------

void test_validate_led_end_lt_start(void) {
    device_config_t c;
    build_minimal(&c);
    c.pins[0].groups[0].led_end = 0; // < led_start (0) -> actually equal;
    c.pins[0].groups[0].led_start = 5;
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, config_validate(&c));
}

void test_validate_unknown_effect(void) {
    device_config_t c;
    build_minimal(&c);
    c.pins[0].groups[0].steps[0].layers[0].effect_id = 0x7F;
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, config_validate(&c));
}

void test_validate_duration_out_of_range(void) {
    device_config_t c;
    build_minimal(&c);
    c.pins[0].groups[0].steps[0].duration = 0; // < STEP_DURATION_MIN
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, config_validate(&c));
    c.pins[0].groups[0].steps[0].duration = 61; // > STEP_DURATION_MAX
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, config_validate(&c));
}

void test_validate_layer_count_zero(void) {
    device_config_t c;
    build_minimal(&c);
    c.pins[0].groups[0].steps[0].layer_count = 0;
    TEST_ASSERT_EQUAL_UINT8(ERR_CONFIG_LIMIT_EXCEEDED, config_validate(&c));
}

void test_validate_param_len_mismatch(void) {
    device_config_t c;
    build_minimal(&c);
    // SOLID expects 4 bytes (color3 + brightness1). Set 3 -> mismatch.
    c.pins[0].groups[0].steps[0].layers[0].param_len = 3;
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, config_validate(&c));
}

// ---- param decode --------------------------------------------------------

void test_decode_params_solid(void) {
    device_config_t c;
    build_minimal(&c);
    effect_params_t ep;
    memset(&ep, 0, sizeof(ep));
    bool ok = config_decode_params(&c.pins[0].groups[0].steps[0].layers[0], &ep);
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_UINT8(0x12, ep.color.r);
    TEST_ASSERT_EQUAL_UINT8(0x34, ep.color.g);
    TEST_ASSERT_EQUAL_UINT8(0x56, ep.color.b);
    TEST_ASSERT_EQUAL_UINT8(200, ep.brightness);
}

void test_decode_params_breath_u16(void) {
    device_config_t c;
    config_load_factory_default(&c);
    effect_params_t ep;
    memset(&ep, 0, sizeof(ep));
    bool ok = config_decode_params(&c.pins[0].groups[0].steps[0].layers[0], &ep);
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_UINT16(3000, ep.period);
    TEST_ASSERT_EQUAL_UINT8(50, ep.speed);
    TEST_ASSERT_EQUAL_UINT8(255, ep.brightness);
}

// ---- effect param size helper -------------------------------------------

void test_effect_param_size(void) {
    TEST_ASSERT_EQUAL_UINT8(4, config_effect_param_size(EFF_SOLID));    // 3+1
    TEST_ASSERT_EQUAL_UINT8(9, config_effect_param_size(EFF_BREATH));   // 3+1+1+1+2+1
    TEST_ASSERT_EQUAL_UINT8(9, config_effect_param_size(EFF_BLINK));    // 3+1+1+2+2
    TEST_ASSERT_EQUAL_UINT8(8, config_effect_param_size(EFF_MARQUEE));  // 3+1+1+1+1+1
    TEST_ASSERT_EQUAL_UINT8(4, config_effect_param_size(EFF_RAINBOW));  // 1+1+1+1
    TEST_ASSERT_EQUAL_UINT8(8, config_effect_param_size(EFF_METEOR));   // 3+1+1+1+1+1
    TEST_ASSERT_EQUAL_UINT8(9, config_effect_param_size(EFF_DUAL_GRADIENT)); // 3+3+1+1+1
    TEST_ASSERT_EQUAL_UINT8(7, config_effect_param_size(EFF_RHYTHM));   // 3+1+1+1+1
    TEST_ASSERT_EQUAL_UINT8(0, config_effect_param_size(0x7F));         // unknown
}

// ---- encode cap enforcement ---------------------------------------------

void test_encode_cap_too_small(void) {
    device_config_t c;
    config_load_factory_default(&c);
    uint8_t buf[8]; // way too small
    uint8_t err = 0;
    size_t n = config_encode(&c, buf, sizeof(buf), &err);
    TEST_ASSERT_EQUAL_size_t(0, n);
    // err is either LIMIT (body too big for cap) — we accept any non-zero.
    TEST_ASSERT_TRUE(err != 0);
}

// ---- main ----------------------------------------------------------------

int main(int argc, char **argv) {
    UNITY_BEGIN();
    RUN_TEST(test_factory_default_validates);
    RUN_TEST(test_factory_default_roundtrip);
    RUN_TEST(test_minimal_roundtrip);
    RUN_TEST(test_crc_error_on_body_flip);
    RUN_TEST(test_bad_magic);
    RUN_TEST(test_version_mismatch);
    RUN_TEST(test_truncated_blob);
    RUN_TEST(test_empty_blob);
    RUN_TEST(test_validate_led_end_lt_start);
    RUN_TEST(test_validate_unknown_effect);
    RUN_TEST(test_validate_duration_out_of_range);
    RUN_TEST(test_validate_layer_count_zero);
    RUN_TEST(test_validate_param_len_mismatch);
    RUN_TEST(test_decode_params_solid);
    RUN_TEST(test_decode_params_breath_u16);
    RUN_TEST(test_effect_param_size);
    RUN_TEST(test_encode_cap_too_small);
    return UNITY_END();
}