// STATUS_NOTIFY frame builder (pure, native-testable).
//
// Builds the full wire frame (header..crc) for the fw->app notify channel.
// The BLE layer sends these bytes over the notify characteristic in 20-byte
// chunks; the miniprogram reassembles via FrameParser (ADR-0006).
//
// STATUS_NOTIFY payload layouts are defined in protocol/frame-spec.md
// "STATUS_NOTIFY（0x81）负载".

#pragma once

#include <stdint.h>
#include <stddef.h>

#include "protocol_gen.h"

#ifdef __cplusplus
extern "C" {
#endif

// Build a STATUS_NOTIFY frame for OK/STATE/ERROR status.
//   status      : NOTIFY_STATUS_OK / _STATE / _ERROR
//   code        : OK -> triggering command code; STATE -> state value;
//                 ERROR -> error code
//   trigger_seq : seq of the triggering command (0 if spontaneous)
// Returns the total frame length written to `out`, or 0 on failure.
size_t notify_build_status(uint8_t *out, size_t out_cap,
                           uint8_t status, uint8_t code, uint8_t trigger_seq);

// Build a VERSION notify frame (status=0x03, code=0, + 4 version bytes).
size_t notify_build_version(uint8_t *out, size_t out_cap, uint8_t trigger_seq);

// Build a generic encoded frame (header..crc) for any command code.
// Used by READ_CONFIG (cmd=0x02) to return the config blob.
size_t notify_build_frame(uint8_t *out, size_t out_cap, uint8_t cmd,
                          uint8_t seq, const uint8_t *payload, size_t plen);

// Build a STATUS_NOTIFY frame with an arbitrary payload appended after the
// standard 3-byte prefix (status/code/seq). Used for VERSION (4 bytes).
// Returns total frame length.
size_t notify_build_status_ext(uint8_t *out, size_t out_cap,
                               uint8_t status, uint8_t code, uint8_t trigger_seq,
                               const uint8_t *extra, size_t extra_len);

#ifdef __cplusplus
}
#endif