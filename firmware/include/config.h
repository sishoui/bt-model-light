// Device config model + binary codec + validation (T6 / #26).
//
// Hierarchy: 8 pins -> groups -> steps -> layers (ADR-0007 / 0020 / 0021).
// Wire format (WRITE_CONFIG / READ_CONFIG payload, also stored verbatim in
// spiffs /config.bin) is documented in protocol/frame-spec.md
// "配置负载". This module is the single encoder/decoder for that blob.
//
// Pure C++ with no Arduino/FreeRTOS/SPIFFS includes, so it compiles under
// the PlatformIO native test target (ADR-0003 / ADR-0012). SPIFFS persistence
// lives in config_persist.cpp and only depends on the encode/decode here.
//
// In-memory model is fixed-size (device_config_t, ~5.4KB) so there is no
// heap churn at runtime on a 7x24 device (ADR-0013a RAM budget). The wire
// blob is compact (variable length) and is what fits in a single ~1.5KB
// BLE frame for typical configs; oversized configs are rejected with
// ERR_CONFIG_LIMIT_EXCEEDED (ADR-0007 error 0x03).

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "protocol_gen.h"
#include "led_driver.h"   // Rgb
#include "factory_default.h"  // FACTORY_LED_PER_PIN

#ifdef __cplusplus
extern "C" {
#endif

// ---- constants -----------------------------------------------------------

#define CONFIG_VERSION          1
#define CONFIG_MAGIC_LE         0x434C5442u   // "BTLC" little-endian
#define CONFIG_BLOB_OVERHEAD    10            // magic(4)+ver(1)+flags(1)+body_len(2)+crc(2)
#define CONFIG_BODY_MAX         (FRAME_LEN_MAX - CONFIG_BLOB_OVERHEAD)

// Step transition modes (ADR-0021).
#define CONFIG_TRANSITION_NONE    0
#define CONFIG_TRANSITION_FADE    1
#define CONFIG_TRANSITION_SMOOTH  2

// Group loop modes (ADR-0021).
#define CONFIG_LOOP_ONCE      0
#define CONFIG_LOOP_LOOP      1
#define CONFIG_LOOP_PINGPONG  2

// Max param block bytes across all effects. BREATH is the longest
// (color3+brightness1+speed1+direction1+period2+waveform1 = 9).
#define CONFIG_EFFECT_PARAM_MAX 9

// ---- in-memory model -----------------------------------------------------

// One layer: an effect id + its raw param block (decoded form).
typedef struct {
    uint8_t effect_id;                       // EFF_* (1..8)
    uint8_t param_len;                       // valid bytes in params[]
    uint8_t params[CONFIG_EFFECT_PARAM_MAX]; // raw param bytes (schema order)
} config_layer_t;

// One step: duration + transition + loop mode + 1..2 layers.
typedef struct {
    uint16_t duration;                       // seconds, 1..60
    uint8_t  transition;                     // CONFIG_TRANSITION_*
    uint8_t  loop_mode;                      // CONFIG_LOOP_*
    uint8_t  layer_count;                    // 1..LAYERS_PER_STEP_MAX
    config_layer_t layers[LAYERS_PER_STEP_MAX];
} config_step_t;

// One group: LED range + 1..5 steps.
typedef struct {
    uint8_t led_start;                       // 0..99
    uint8_t led_end;                         // 0..99, >= led_start
    uint8_t step_count;                      // 1..STEPS_PER_GROUP_MAX
    config_step_t steps[STEPS_PER_GROUP_MAX];
} config_group_t;

// One pin: 0..5 groups.
typedef struct {
    uint8_t group_count;                     // 0..GROUPS_PER_PIN_MAX
    config_group_t groups[GROUPS_PER_PIN_MAX];
} config_pin_t;

// Whole device: 8 pins.
typedef struct {
    uint8_t version;                         // CONFIG_VERSION
    config_pin_t pins[PIN_COUNT];
} device_config_t;

// ---- lifecycle -----------------------------------------------------------

// Reset to an empty config (all pins, 0 groups). Does NOT touch the
// factory default; use config_load_factory_default for that.
void config_init_empty(device_config_t *c);

// Fill with the factory-default config (breath on all 8 pins, full range,
// loop forever). Used as the fallback when spiffs is missing/corrupt
// (ADR-0015) and as the response to RESET_DEFAULT before the blob is
// cleared. Built from the same 8-effect set the renderer uses.
void config_load_factory_default(device_config_t *c);

// ---- validation ----------------------------------------------------------

// Validate structural + range constraints. Returns 0 if valid, or an
// ERR_* code (0x03 limit / 0x04 invalid parameter) describing the first
// problem found. Call before encode / before applying a decoded config.
uint8_t config_validate(const device_config_t *c);

// ---- wire codec ----------------------------------------------------------

// Encode the in-memory config into `out` (capacity `cap`) as a full blob
// (magic+version+flags+body_len+body+crc). Returns the blob length on
// success, or 0 if `cap` is too small / config invalid / body exceeds
// CONFIG_BODY_MAX. On 0, `*err` (if non-NULL) is set to the ERR_* code.
size_t config_encode(const device_config_t *c, uint8_t *out, size_t cap,
                     uint8_t *err);

// Decode a blob from `in` (`in_len` bytes) into `out`. Returns 0 on
// success, or an ERR_* code:
//   0x01 CRC error, 0x03 limit exceeded, 0x04 invalid parameter,
//   0x07 internal (bad magic / version / truncated / body_len overflow).
uint8_t config_decode(const uint8_t *in, size_t in_len, device_config_t *out);

// ---- typed param accessors ----------------------------------------------

// Read a param from a layer's param block by schema order. These mirror
// EFFECT_PARAMS in protocol_gen.h; the caller must have already validated
// effect_id / param_len. Each returns false if the param type doesn't
// match the schema slot at `index`.
typedef struct {
    uint8_t r, g, b;
} config_rgb_t;

// Decode a whole layer's param block into a typed struct. `out` fields
// are only written for params the effect actually declares; unused fields
// keep their prior value (zero-init the struct first). Returns false if
// the block is shorter than the schema requires.
typedef struct {
    config_rgb_t color;     // effects with `color`
    config_rgb_t color2;    // DUAL_GRADIENT only
    uint8_t  brightness;
    uint8_t  speed;
    uint8_t  direction;
    uint8_t  waveform;      // BREATH
    uint16_t period;        // BREATH (u16)
    uint16_t on_time;       // BLINK (u16)
    uint16_t off_time;      // BLINK (u16)
    uint8_t  led_count;     // MARQUEE
    uint8_t  gap;           // MARQUEE
    uint8_t  spread;        // RAINBOW
    uint8_t  tail_length;   // METEOR
    uint8_t  decay;         // METEOR
    uint8_t  mode;          // DUAL_GRADIENT
    uint8_t  pattern;       // RHYTHM
    uint8_t  step_size;     // RHYTHM
} effect_params_t;

// Look up the effect entry by id (EFFECT_TABLE). Returns NULL if unknown.
const effect_entry_t *config_effect_entry(uint8_t effect_id);

// Expected param block byte length for an effect (sum of param sizes),
// or 0 if effect_id is unknown.
uint8_t config_effect_param_size(uint8_t effect_id);

// Decode a layer's param block into `out`. Returns false if the block is
// shorter than the effect's schema requires (caller should have validated).
bool config_decode_params(const config_layer_t *layer, effect_params_t *out);

#ifdef __cplusplus
}
#endif