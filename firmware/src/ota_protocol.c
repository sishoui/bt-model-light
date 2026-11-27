// BLE OTA session state + CRC-32 implementation (pure, native-testable).
// See ota_protocol.h for the contract and ADR-0034 for the design.

#include "ota_protocol.h"

#include <string.h>

// ota_0 / ota_1 partition size from firmware/partitions.csv (0x1E0000).
// Kept here (not pulled from the partition table) so the pure module stays
// hardware-free; ota_service.cpp additionally checks esp_ota_begin's result.
#define OTA_IMAGE_MAX_BYTES 0x1E0000u

// --- CRC-32 ---------------------------------------------------------------

uint32_t ota_crc32(uint32_t crc, const uint8_t *data, size_t n) {
    crc = ~crc;
    for (size_t i = 0; i < n; i++) {
        crc ^= data[i];
        for (int b = 0; b < 8; b++) {
            crc = (crc & 1u) ? (crc >> 1) ^ 0xEDB88320u : (crc >> 1);
        }
    }
    return ~crc;
}

uint32_t ota_crc32_buf(const uint8_t *data, size_t n) {
    return ota_crc32(0, data, n);
}

// --- helpers --------------------------------------------------------------

static uint32_t rd_u32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

// --- lifecycle ------------------------------------------------------------

void ota_protocol_init(ota_session_t *s) {
    if (!s) return;
    memset(s, 0, sizeof(*s));
    s->state = OTA_STATE_IDLE;
}

bool ota_protocol_busy(const ota_session_t *s) {
    return s && s->state == OTA_STATE_RECEIVING;
}

// --- BEGIN ----------------------------------------------------------------

uint8_t ota_protocol_begin(ota_session_t *s, const uint8_t *payload, size_t len) {
    if (!s || !payload) return ERR_INVALID_PARAMETER;
    if (len != 11) return ERR_INVALID_PARAMETER; // 1 + 4 + 4 + 1 + 1
    if (payload[0] != OTA_SUB_BEGIN) return ERR_INVALID_PARAMETER;
    if (s->state == OTA_STATE_RECEIVING) return ERR_INVALID_STATE;

    uint32_t total = rd_u32le(payload + 1);
    uint32_t crc = rd_u32le(payload + 5);
    if (total == 0 || total > OTA_IMAGE_MAX_BYTES) return ERR_CONFIG_LIMIT_EXCEEDED;

    memset(s, 0, sizeof(*s));
    s->state = OTA_STATE_RECEIVING;
    s->total = total;
    s->crc32 = crc;
    s->running = 0;
    s->version_major = payload[9];
    s->version_minor = payload[10];
    return 0;
}

// --- DATA -----------------------------------------------------------------

uint8_t ota_protocol_data(ota_session_t *s, const uint8_t *payload, size_t len) {
    if (!s || !payload) return ERR_INVALID_PARAMETER;
    if (len < 5) return ERR_INVALID_PARAMETER; // 1 + 4 (+ >=0 bytes)
    if (payload[0] != OTA_SUB_DATA) return ERR_INVALID_PARAMETER;
    if (s->state != OTA_STATE_RECEIVING) return ERR_INVALID_STATE;

    uint32_t offset = rd_u32le(payload + 1);
    const uint8_t *data = payload + 5;
    size_t n = len - 5;

    // Sequential only: the app resends the same block on timeout, so a gap
    // or a duplicate offset is always a protocol error, never a resume.
    if (offset != s->received) return ERR_INVALID_PARAMETER;
    if (s->received + n > s->total) return ERR_INVALID_PARAMETER;

    s->running = ota_crc32(s->running, data, n);
    s->received += (uint32_t)n;
    return 0;
}

// --- END / ABORT ----------------------------------------------------------

uint8_t ota_protocol_end(ota_session_t *s) {
    if (!s) return ERR_INVALID_PARAMETER;
    if (s->state != OTA_STATE_RECEIVING) return ERR_INVALID_STATE;
    if (s->received != s->total) return ERR_INVALID_PARAMETER;
    // ota_crc32(~x) is the running value seeded by 0; compare directly.
    if (s->running != s->crc32) return ERR_CRC_ERROR;
    s->state = OTA_STATE_DONE;
    return 0;
}
