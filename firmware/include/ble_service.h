// BLE GATT service + command dispatch (T6 / #26, ADR-0004 / 0007 / 0009).
//
// One custom GATT service (BLE_SERVICE_UUID) with:
//   - Write characteristic  (BLE_WRITE_CHAR_UUID): app -> fw commands
//   - Notify characteristic (BLE_NOTIFY_CHAR_UUID): fw -> app status/error/version
//
// Write bytes are fed into a streaming parser (ADR-0006); each decoded frame
// is dispatched by command code. Responses go back via the notify char in
// 20-byte chunks (the miniprogram reassembles, frame-spec.md).
//
// Commands handled:
//   0x08 GET_VERSION    -> STATUS_NOTIFY VERSION (protocol + firmware ver)
//   0x01 WRITE_CONFIG   -> decode blob, validate, store + persist, STATUS_NOTIFY OK
//   0x02 READ_CONFIG    -> encode active config, notify as cmd=0x02 frame
//   0x03 APPLY          -> state CONNECTED/CONFIGURED -> PLAYING, OK notify
//   0x04 READ_STATUS    -> STATUS_NOTIFY STATE (current state value)
//   0x05 TRIGGER_STEP   -> PLAYING -> PREVIEW, OK notify
//   0x06 STOP           -> PLAYING/PREVIEW -> PAUSED, OK notify
//   0x07 RESET_DEFAULT  -> clear spiffs, IDLE, OK notify
//   0x09 GET_PIN_CAPS   -> notify each pin's LED count (v2 shape; T6 returns 8x u8)
//
// Unknown commands -> STATUS_NOTIFY ERROR 0x02. Malformed configs ->
// ERROR 0x03/0x04/0x06. Illegal state transitions -> ERROR 0x05 (ADR-0026).
//
// The onConnect / onDisconnect callbacks drive the state machine
// (IDLE -> CONNECTED, * -> IDLE on disconnect). The adapter name is
// "BTLight_" + a short id derived from the ESP32-C3 MAC (ADR-0025).

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "protocol_gen.h"
#include "config.h"
#include "composition.h"

#ifdef __cplusplus
extern "C" {
#endif

// Initialize the BLE GATT service + start advertising. Call once at boot
// after ledInit/configPersistInit. The actual BLE stack is initialized
// here; the command dispatch runs from the BLE event callbacks (no
// dedicated task needed for T6 — callbacks are short).
//
// `cfg` is the live config the dispatcher mutates on WRITE_CONFIG. The
// caller (main.cpp) owns the storage; this module only reads/writes through
// the pointer. `pb` is the per-group playback state advanced by the render
// loop; the dispatcher resets it on WRITE_CONFIG/APPLY.
void bleServiceBegin(device_config_t *cfg,
                     group_playback_t pb[PIN_COUNT][GROUPS_PER_PIN_MAX]);

// True if a central is currently connected.
bool bleServiceConnected();

#ifdef __cplusplus
}
#endif