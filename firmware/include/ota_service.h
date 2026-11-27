// OTA partition writer (Arduino/esp_ota_ops side). ADR-0034.
//
// Splits responsibility with ota_protocol.c:
//   - ota_protocol.c  : session legality (offsets / sizes / CRC-32), pure C.
//   - ota_service.cpp : esp_ota_begin/write/end/set_boot_partition, Arduino only.
//
// Native builds link the stubs at the bottom of ota_service.cpp, so files
// that reference this header still build under `pio test -e native`
// (same pattern as ble_service).

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "protocol_gen.h"

#ifdef __cplusplus
extern "C" {
#endif

// Handle one OTA frame payload (payload[0] = OTA_SUB_*).
// Returns 0 on success, or an ERR_* code for the STATUS_NOTIFY reply.
// `seq` is only used for PROGRESS notifications built by the BLE layer.
uint8_t otaServiceHandle(const uint8_t *payload, size_t len);

// True while an upload is in flight. The command dispatcher rejects
// configuration commands during this window (they would interleave
// flash writes and restart playback mid-upgrade).
bool otaServiceBusy(void);

// Called from the frame task: performs the deferred restart once an
// upload has been committed (gives the OK notify time to flush first).
void otaServicePollRestart(void);

#ifdef __cplusplus
}
#endif
