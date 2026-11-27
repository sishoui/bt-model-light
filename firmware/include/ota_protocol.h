// BLE OTA session state + CRC-32 (pure, native-testable). ADR-0034.
//
// The BLE layer (ble_service.cpp) decodes the frame and calls into this
// module; the partition writes live in ota_service.cpp (Arduino-only, so
// this file has no Arduino/FreeRTOS dependency and runs under `pio test
// -e native`).
//
// Responsibility split:
//   - ota_protocol.c : "is this upload legal?" (offsets, sizes, CRC-32).
//   - ota_service.cpp: "write bytes to the OTA partition / switch boot
//                      partition" (esp_ota_ops).
//
// Wire layouts: protocol/frame-spec.md "OTA（0xF0）负载",
// sub-command codes: protocol/ota.csv (OTA_SUB_* in protocol_gen.h).

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "protocol_gen.h"

#ifdef __cplusplus
extern "C" {
#endif

// Upgrade state. DONE means "all bytes received and CRC-32 matched"; the
// caller (ota_service) still has to commit the partition.
typedef enum {
    OTA_STATE_IDLE = 0,
    OTA_STATE_RECEIVING,
    OTA_STATE_DONE,
} ota_state_t;

// Caller-owned session. Zero-init or ota_protocol_init().
typedef struct {
    ota_state_t state;
    uint32_t total;      // expected image size (from BEGIN)
    uint32_t received;   // bytes accepted so far (== next expected offset)
    uint32_t crc32;      // expected CRC-32 of the whole image (from BEGIN)
    uint32_t running;    // CRC-32 accumulated over accepted bytes
    uint8_t version_major;
    uint8_t version_minor;
} ota_session_t;

// Reset to IDLE (also used by ABORT).
void ota_protocol_init(ota_session_t *s);

// CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320, init/final 0xFFFFFFFF).
// Matches zlib.crc32 on the miniprogram/server side.
uint32_t ota_crc32(uint32_t crc, const uint8_t *data, size_t n);

// Convenience: CRC-32 of a whole buffer from a clean seed.
uint32_t ota_crc32_buf(const uint8_t *data, size_t n);

// Handle BEGIN (payload = OTA_SUB_BEGIN + [total:u32le][crc32:u32le]
// + [ver_major][ver_minor]). Returns 0 on success or an ERR_* code:
//   0x04 length/shape wrong, 0x03 total == 0 or > OTA_IMAGE_MAX_BYTES,
//   0x05 a session is already in progress.
uint8_t ota_protocol_begin(ota_session_t *s, const uint8_t *payload, size_t len);

// Handle DATA (payload = OTA_SUB_DATA + [offset:u32le][bytes...]).
//   0x05 no session, 0x04 bad shape / offset != received / over total.
uint8_t ota_protocol_data(ota_session_t *s, const uint8_t *payload, size_t len);

// Handle END. Verifies received == total and running == crc32.
//   0x05 no session, 0x04 incomplete (received < total), 0x01 CRC mismatch.
// On success the session goes to DONE (caller commits the partition).
uint8_t ota_protocol_end(ota_session_t *s);

// True while an upload is in flight (receiving). Used to reject config
// commands that would interleave with partition writes.
bool ota_protocol_busy(const ota_session_t *s);

#ifdef __cplusplus
}
#endif
