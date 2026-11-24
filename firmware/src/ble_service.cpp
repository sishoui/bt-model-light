// BLE GATT service + command dispatch implementation (ADR-0004/0007/0009).
//
// Arduino/ESP32-specific (BLEDevice). Excluded from the native test build
// (see platformio.ini build_src_filter). The wire codec / dispatch logic is
// exercised via the pure config/notify modules in native tests.

#include "ble_service.h"

#if defined(ARDUINO)
#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_system.h>   // esp_read_mac

#include "state_machine.h"
#include "watchdog.h"
#include "protocol_parser.h"
#include "notify.h"
#include "config_persist.h"

// ATT MTU 23 -> 20-byte notify/write chunk (frame-spec.md).
#define BLE_CHUNK 20

// ---- module state --------------------------------------------------------

static device_config_t *sCfg = nullptr;
static group_playback_t (*sPb)[GROUPS_PER_PIN_MAX] = nullptr;
static bool sConnected = false;

static BLECharacteristic *sNotifyChar = nullptr;
static parser_t sParser;

// ---- notify helper -------------------------------------------------------

// Send a built frame over the notify char in BLE_CHUNK-sized writes.
static void notify_send(const uint8_t *frame, size_t len) {
    if (!sNotifyChar) return;
    for (size_t off = 0; off < len; off += BLE_CHUNK) {
        size_t n = (len - off < BLE_CHUNK) ? (len - off) : BLE_CHUNK;
        sNotifyChar->setValue((uint8_t *)(frame + off), n);
        sNotifyChar->notify();
    }
}

static void notify_status(uint8_t status, uint8_t code, uint8_t seq) {
    // Static buffer: this runs in the BTC task context (BLE callback), where
    // the stack is small (3072 bytes on ESP32-C3). A 1507-byte local would
    // overflow it. Static is safe because callbacks are serialized on BTC.
    static uint8_t buf[FRAME_TOTAL_MAX];
    size_t n = notify_build_status(buf, sizeof(buf), status, code, seq);
    if (n > 0) notify_send(buf, n);
}

static void notify_version(uint8_t seq) {
    static uint8_t buf[FRAME_TOTAL_MAX];
    size_t n = notify_build_version(buf, sizeof(buf), seq);
    if (n > 0) notify_send(buf, n);
}

// ---- command handlers ----------------------------------------------------
// Each handler returns the seq it is responding to (so notify pairs with
// the triggering command). Handlers never block long; SPIFFS writes are
// the slowest (~tens of ms) and are acceptable inside the callback.

static void handle_get_version(uint8_t seq) {
    notify_version(seq);
}

static void handle_write_config(uint8_t seq, const uint8_t *payload, size_t len) {
    // Static buffer: decoded config is ~5.4KB, too large for the BTC task
    // stack (3072 bytes on ESP32-C3). Static is safe because callbacks are
    // serialized on BTC.
    static device_config_t decoded;
    uint8_t rc = config_decode(payload, len, &decoded);
    if (rc != 0) {
        notify_status(NOTIFY_STATUS_ERROR, rc, seq);
        return;
    }
    // State transition (CONNECTED/CONFIGURED -> CONFIGURED) must succeed
    // before we commit the config (ADR-0007: APPLY from non-CONFIGURED
    // is illegal, and WRITE_CONFIG from an illegal state is rejected).
    uint8_t tr = stateMachineDispatch(FW_EVT_WRITE_CONFIG_OK);
    if (tr != 0) {
        notify_status(NOTIFY_STATUS_ERROR, tr, seq);
        return;
    }
    // Commit: copy into the live config and persist.
    *sCfg = decoded;
    composition_init(sCfg, sPb);
    configPersistSave(sCfg);   // best-effort; RAM stays consistent on failure
    notify_status(NOTIFY_STATUS_OK, CMD_WRITE_CONFIG, seq);
}

static void handle_read_config(uint8_t seq) {
    // Encode the active config and send it back as a cmd=0x02 frame.
    // Static buffers: this runs in the BTC task context (small stack).
    static uint8_t buf[FRAME_LEN_MAX];
    uint8_t err = 0;
    size_t n = config_encode(sCfg, buf, sizeof(buf), &err);
    if (n == 0) {
        notify_status(NOTIFY_STATUS_ERROR, err, seq);
        return;
    }
    static uint8_t frame[FRAME_TOTAL_MAX];
    size_t fn = notify_build_frame(frame, sizeof(frame), CMD_READ_CONFIG, seq,
                                   buf, n);
    if (fn > 0) notify_send(frame, fn);
}

static void handle_apply(uint8_t seq) {
    uint8_t rc = stateMachineDispatch(FW_EVT_APPLY);
    if (rc != 0) {
        notify_status(NOTIFY_STATUS_ERROR, rc, seq);
        return;
    }
    // Reset playback clocks so the saved effect starts from step 0.
    composition_init(sCfg, sPb);
    notify_status(NOTIFY_STATUS_OK, CMD_APPLY, seq);
}

static void handle_read_status(uint8_t seq) {
    notify_status(NOTIFY_STATUS_STATE, (uint8_t)stateMachineState(), seq);
}

static void handle_trigger_step(uint8_t seq, const uint8_t *payload, size_t len) {
    // payload: [group_idx:1][step_idx:1] (ADR-0007). For T6 we just enter
    // PREVIEW; the step selection is applied by resetting the group's
    // clock to the requested step if the payload is present.
    uint8_t rc = stateMachineDispatch(FW_EVT_TRIGGER_STEP);
    if (rc != 0) {
        notify_status(NOTIFY_STATUS_ERROR, rc, seq);
        return;
    }
    if (len >= 2 && sCfg) {
        uint8_t g = payload[0];
        uint8_t si = payload[1];
        // Apply to all pins (preview the step globally); clamp to valid.
        for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
            config_pin_t *p = &sCfg->pins[pin];
            if (g < p->group_count && si < p->groups[g].step_count) {
                sPb[pin][g].step_idx = si;
                sPb[pin][g].step_ticks = 0;
                sPb[pin][g].dir = +1;
            }
        }
    }
    notify_status(NOTIFY_STATUS_OK, CMD_TRIGGER_STEP, seq);
}

static void handle_stop(uint8_t seq) {
    uint8_t rc = stateMachineDispatch(FW_EVT_STOP);
    if (rc != 0) {
        notify_status(NOTIFY_STATUS_ERROR, rc, seq);
        return;
    }
    notify_status(NOTIFY_STATUS_OK, CMD_STOP, seq);
}

static void handle_reset_default(uint8_t seq) {
    // Clear spiffs, restore factory default in RAM, back to IDLE.
    configPersistErase();
    config_load_factory_default(sCfg);
    composition_init(sCfg, sPb);
    stateMachineDispatch(FW_EVT_RESET_DEFAULT);
    notify_status(NOTIFY_STATUS_OK, CMD_RESET_DEFAULT, seq);
}

static void handle_get_pin_caps(uint8_t seq) {
    // T6 returns 8 bytes: each pin's LED count. We report LEDS_PER_PIN_MAX
    // for every pin as the conservative capability (actual strip lengths
    // come from a future GET_PIN_CAPS v2; see ADR-0013a).
    uint8_t caps[PIN_COUNT];
    for (uint8_t i = 0; i < PIN_COUNT; i++) caps[i] = LEDS_PER_PIN_MAX;
    // Static buffer (BTC task stack is small; see notify_status above).
    static uint8_t frame[FRAME_TOTAL_MAX];
    size_t n = notify_build_frame(frame, sizeof(frame), CMD_GET_PIN_CAPS, seq,
                                  caps, PIN_COUNT);
    if (n > 0) notify_send(frame, n);
}

// Dispatch one decoded frame. `payload` points into the parser buffer and
// is only valid for this call.
static void dispatch_frame(const parsed_frame_t *fr) {
    const uint8_t *pl = fr->payload;
    size_t len = fr->len;
    switch (fr->cmd) {
        case CMD_GET_VERSION:    handle_get_version(fr->seq); break;
        case CMD_WRITE_CONFIG:   handle_write_config(fr->seq, pl, len); break;
        case CMD_READ_CONFIG:    handle_read_config(fr->seq); break;
        case CMD_APPLY:          handle_apply(fr->seq); break;
        case CMD_READ_STATUS:    handle_read_status(fr->seq); break;
        case CMD_TRIGGER_STEP:   handle_trigger_step(fr->seq, pl, len); break;
        case CMD_STOP:           handle_stop(fr->seq); break;
        case CMD_RESET_DEFAULT:  handle_reset_default(fr->seq); break;
        case CMD_GET_PIN_CAPS:   handle_get_pin_caps(fr->seq); break;
        default:
            // Unknown command (incl. OTA 0xF0 which is reserved for v2).
            notify_status(NOTIFY_STATUS_ERROR, ERR_UNSUPPORTED_COMMAND, fr->seq);
            break;
    }
    // Feed the watchdog from the command handler so a chatty BLE session
    // keeps the device alive (ADR-0016). The frame loop also feeds it.
    watchdogFeed();
}

// Drain all complete frames currently in the parser buffer.
static void drain_parser() {
    parsed_frame_t fr;
    for (;;) {
        parse_result_t r = parser_next(&sParser, &fr);
        if (r == PARSE_OK) {
            dispatch_frame(&fr);
        } else if (r == PARSE_INCOMPLETE) {
            break;
        } else {
            // PARSE_INVALID_CRC / UNKNOWN_COMMAND / LEN_OVERFLOW /
            // NO_HEADER: the parser already advanced past the bad bytes.
            // Surface as an error notify for CRC (the most common wire
            // issue); stay silent for NO_HEADER (noise before a frame).
            if (r == PARSE_INVALID_CRC) {
                notify_status(NOTIFY_STATUS_ERROR, ERR_CRC_ERROR, 0);
            } else if (r == PARSE_UNKNOWN_COMMAND) {
                notify_status(NOTIFY_STATUS_ERROR, ERR_UNSUPPORTED_COMMAND, 0);
            }
            // Avoid an infinite loop if the parser doesn't advance.
            if (sParser.pos >= sParser.len) break;
        }
    }
}

// ---- BLE callbacks -------------------------------------------------------

class WriteCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *c) override {
        // The central may split a frame across many writes; feed each
        // chunk into the streaming parser and drain.
        std::string v = c->getValue();
        if (v.empty()) return;
        parser_feed(&sParser, (const uint8_t *)v.data(), v.size());
        drain_parser();
    }
};

class ServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer *s) override {
        (void)s;
        sConnected = true;
        // IDLE -> CONNECTED. From PLAYING (factory default playing) this is
        // illegal; we stay in PLAYING and let the app issue WRITE_CONFIG,
        // which handle_write_config forces to CONFIGURED.
        if (stateMachineState() == FW_STATE_IDLE) {
            stateMachineDispatch(FW_EVT_CONNECT);
        }
        // Send current state so the app knows where we are.
        notify_status(NOTIFY_STATUS_STATE, (uint8_t)stateMachineState(), 0);
    }
    void onDisconnect(BLEServer *s) override {
        (void)s;
        sConnected = false;
        // 保持当前灯效：PLAYING/PREVIEW/PAUSED 状态下不断电、不回 IDLE，
        // 让 frameTask 继续用 sConfig 渲染用户配置（ADR-0015 修订：断连
        // 不丢配置）。仅 CONNECTED/CONFIGURED（尚未 APPLY）回 IDLE 显示
        // 出厂默认呼吸彩光。
        fw_state_t st = stateMachineState();
        if (st == FW_STATE_CONNECTED || st == FW_STATE_CONFIGURED) {
            stateMachineDispatch(FW_EVT_DISCONNECT);
        }
        // PLAYING / PREVIEW / PAUSED：保持状态，frameTask 继续渲染。
        // Restart advertising so the device is discoverable again (ADR-0025).
        BLEDevice::startAdvertising();
    }
};

// ---- public API ----------------------------------------------------------

void bleServiceBegin(device_config_t *cfg,
                     group_playback_t (*pb)[GROUPS_PER_PIN_MAX]) {
    sCfg = cfg;
    sPb = pb;
    sConnected = false;
    parser_init(&sParser);

    // Device name: BTLight_ + 4 hex chars of the MAC (ADR-0025 prefix).
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char name[32];
    snprintf(name, sizeof(name), "%s%02X%02X",
             BLE_NAME_PREFIX, mac[4], mac[5]);

    BLEDevice::init(name);
    BLEServer *server = BLEDevice::createServer();
    server->setCallbacks(new ServerCallbacks());

    BLEService *svc = server->createService(BLE_SERVICE_UUID);

    // Write characteristic (app -> fw).
    BLECharacteristic *writeChar = svc->createCharacteristic(
        BLE_WRITE_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE);
    writeChar->setCallbacks(new WriteCallbacks());

    // Notify characteristic (fw -> app).
    sNotifyChar = svc->createCharacteristic(
        BLE_NOTIFY_CHAR_UUID,
        BLECharacteristic::PROPERTY_NOTIFY);
    BLE2902 *desc = new BLE2902();
    desc->setNotifications(true);
    sNotifyChar->addDescriptor(desc);

    svc->start();

    BLEAdvertising *adv = BLEDevice::getAdvertising();
    adv->addServiceUUID(BLE_SERVICE_UUID);
    adv->setScanResponse(true);
    BLEDevice::startAdvertising();
}

bool bleServiceConnected() {
    return sConnected;
}

#else
// Native / non-Arduino build: stubs so files that include ble_service.h
// still link. ble_service.cpp is excluded from the native test build, so
// these are never called there.
void bleServiceBegin(device_config_t *cfg,
                     group_playback_t (*pb)[GROUPS_PER_PIN_MAX]) {
    (void)cfg; (void)pb;
}
bool bleServiceConnected() { return false; }
#endif