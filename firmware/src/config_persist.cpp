// SPIFFS config persistence implementation (ADR-0014 / 0015).
//
// Arduino/ESP32-specific. Excluded from the native test build (see
// platformio.ini build_src_filter). The pure encode/decode + corruption
// logic is in config.cpp and is unit-tested there.

#include "config_persist.h"

#if defined(ARDUINO)
#include <SPIFFS.h>
#include <Arduino.h>
#else
// Native build: stub so files that include config_persist.h still link.
// The actual SPIFFS calls are guarded by ARDUINO above; these stubs never
// run in the native test target (config_persist.cpp is excluded from it).
#endif

#define CONFIG_FILE      "/config.bin"
#define CONFIG_FILE_TMP  "/config.bin.tmp"

bool configPersistInit() {
#if defined(ARDUINO)
    if (SPIFFS.begin(true)) {
        // mounted (true = format-on-failure, so a blank spiffs self-heals).
        return true;
    }
    // begin() failed even with format-on-failure: try explicit format.
    if (SPIFFS.format()) {
        return SPIFFS.begin(false);
    }
    return false;
#else
    return false;
#endif
}

int configPersistLoad(device_config_t *out) {
    if (!out) return -1;
#if defined(ARDUINO)
    if (!SPIFFS.exists(CONFIG_FILE)) {
        config_load_factory_default(out);
        return 0; // missing -> factory default
    }
    File f = SPIFFS.open(CONFIG_FILE, FILE_READ);
    if (!f) {
        config_load_factory_default(out);
        return -1;
    }
    size_t n = f.size();
    // Cap read to a sane upper bound (FRAME_LEN_MAX + slack).
    if (n == 0 || n > FRAME_LEN_MAX + 16) {
        f.close();
        config_load_factory_default(out);
        return -1;
    }
    uint8_t buf[FRAME_LEN_MAX + 16];
    size_t got = f.read(buf, n);
    f.close();
    if (got != n) {
        config_load_factory_default(out);
        return -1;
    }
    uint8_t rc = config_decode(buf, got, out);
    if (rc != 0) {
        // corrupt blob (magic/version/crc/structure) -> factory default.
        config_load_factory_default(out);
        return -1;
    }
    return 1;
#else
    config_load_factory_default(out);
    return 0;
#endif
}

bool configPersistSave(const device_config_t *c) {
    if (!c) return false;
#if defined(ARDUINO)
    uint8_t buf[FRAME_LEN_MAX + 16];
    uint8_t err = 0;
    size_t n = config_encode(c, buf, sizeof(buf), &err);
    if (n == 0) return false;

    // Write to a temp file, then rename over the real one (atomic-ish:
    // a power loss during rename leaves either the old or the new blob,
    // never a half-written config.bin).
    File tmp = SPIFFS.open(CONFIG_FILE_TMP, FILE_WRITE);
    if (!tmp) return false;
    size_t written = tmp.write(buf, n);
    tmp.flush();
    tmp.close();
    if (written != n) {
        SPIFFS.remove(CONFIG_FILE_TMP);
        return false;
    }
    if (SPIFFS.exists(CONFIG_FILE)) {
        SPIFFS.remove(CONFIG_FILE);
    }
    return SPIFFS.rename(CONFIG_FILE_TMP, CONFIG_FILE);
#else
    (void)c;
    return false;
#endif
}

bool configPersistErase() {
#if defined(ARDUINO)
    if (SPIFFS.remove(CONFIG_FILE)) return true;
    // remove() returns false if the file didn't exist; treat as success
    // (idempotent factory reset).
    return !SPIFFS.exists(CONFIG_FILE);
#else
    return false;
#endif
}