// SPIFFS config persistence (T6 / #26, ADR-0014 / 0015).
//
// Stores the config blob (same bytes as WRITE_CONFIG payload) in
// /config.bin on the spiffs partition (ADR-0010). On boot the firmware
// loads this blob, decodes it, and restores the saved effect (重启自恢复).
// If the file is missing or corrupt (magic/version/crc mismatch), the
// firmware falls back to the factory default (ADR-0015) and continues —
// the device never bricks on a bad config.
//
// Arduino/ESP32-specific (SPIFFS). Excluded from the native test build;
// the encode/decode + corruption logic lives in config.cpp (pure) and is
// unit-tested there.

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "config.h"

#ifdef __cplusplus
extern "C" {
#endif

// Initialize the spiffs filesystem. Call once at boot before any load/save.
// Returns true on success (mounted or freshly formatted).
bool configPersistInit();

// Load the config blob from /config.bin into `out`. Returns:
//   1  -> loaded + decoded OK (out filled)
//   0  -> file missing (out set to factory default)
//  -1  -> file present but corrupt / decode failed (out set to factory default)
// Caller should treat both 0 and -1 as "use factory default".
int configPersistLoad(device_config_t *out);

// Save the config blob to /config.bin (atomic-ish: write to a temp file
// then rename). Returns true on success.
bool configPersistSave(const device_config_t *c);

// Erase /config.bin (factory reset). Returns true on success or if the
// file didn't exist.
bool configPersistErase();

#ifdef __cplusplus
}
#endif