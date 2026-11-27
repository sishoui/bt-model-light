// STATUS_NOTIFY frame builder (pure, native-testable).
//
// See notify.h for the contract. Pure C++ (no Arduino).

#include "notify.h"
#include "protocol_parser.h"   // crc16_ccitt

#include <string.h>

size_t notify_build_frame(uint8_t *out, size_t out_cap, uint8_t cmd,
                          uint8_t seq, const uint8_t *payload, size_t plen) {
    if (!out) return 0;
    size_t total = FRAME_OVERHEAD + plen;
    if (total > out_cap) return 0;
    if (plen > FRAME_LEN_MAX) return 0;
    out[0] = FRAME_HEADER_BYTE;
    out[1] = (uint8_t)(plen & 0xFF);
    out[2] = (uint8_t)((plen >> 8) & 0xFF);
    out[3] = cmd;
    out[4] = seq;
    if (plen > 0 && payload) {
        memcpy(out + 5, payload, plen);
    }
    uint16_t crc = crc16_ccitt(out, 5 + plen);
    out[5 + plen] = (uint8_t)(crc & 0xFF);
    out[6 + plen] = (uint8_t)((crc >> 8) & 0xFF);
    return total;
}

size_t notify_build_status_ext(uint8_t *out, size_t out_cap,
                               uint8_t status, uint8_t code, uint8_t trigger_seq,
                               const uint8_t *extra, size_t extra_len) {
    if (!out) return 0;
    // payload = [status, code, seq] + extra
    if (3 + extra_len > FRAME_LEN_MAX) return 0;
    if (FRAME_OVERHEAD + 3 + extra_len > out_cap) return 0;
    uint8_t payload[FRAME_LEN_MAX];
    payload[0] = status;
    payload[1] = code;
    payload[2] = trigger_seq;
    if (extra_len > 0 && extra) {
        memcpy(payload + 3, extra, extra_len);
    }
    return notify_build_frame(out, out_cap, CMD_STATUS_NOTIFY,
                             trigger_seq, payload, 3 + extra_len);
}

size_t notify_build_status(uint8_t *out, size_t out_cap,
                           uint8_t status, uint8_t code, uint8_t trigger_seq) {
    return notify_build_status_ext(out, out_cap, status, code, trigger_seq, NULL, 0);
}

size_t notify_build_version(uint8_t *out, size_t out_cap, uint8_t trigger_seq) {
    uint8_t extra[4] = {
        PROTOCOL_VERSION_MAJOR, PROTOCOL_VERSION_MINOR,
        FIRMWARE_VERSION_MAJOR, FIRMWARE_VERSION_MINOR,
    };
    return notify_build_status_ext(out, out_cap, NOTIFY_STATUS_VERSION, 0,
                                  trigger_seq, extra, 4);
}
size_t notify_build_progress(uint8_t *out, size_t out_cap,
                             uint32_t written, uint32_t total) {
    // payload = [OTA_SUB_PROGRESS][written:u32le][total:u32le] (9 bytes).
    // The OTA progress packet reuses the STATUS_NOTIFY command but not its
    // status/code/seq prefix: payload[0] = 0x05 is unambiguous because the
    // normal layout's first byte is never 0x05 (see frame-spec.md).
    uint8_t payload[9];
    payload[0] = OTA_SUB_PROGRESS;
    payload[1] = (uint8_t)(written & 0xFF);
    payload[2] = (uint8_t)((written >> 8) & 0xFF);
    payload[3] = (uint8_t)((written >> 16) & 0xFF);
    payload[4] = (uint8_t)((written >> 24) & 0xFF);
    payload[5] = (uint8_t)(total & 0xFF);
    payload[6] = (uint8_t)((total >> 8) & 0xFF);
    payload[7] = (uint8_t)((total >> 16) & 0xFF);
    payload[8] = (uint8_t)((total >> 24) & 0xFF);
    return notify_build_frame(out, out_cap, CMD_STATUS_NOTIFY, 0,
                              payload, sizeof(payload));
}
