// OTA partition writer (Arduino/esp_ota_ops side). ADR-0034.
//
// See ota_service.h. Session legality lives in ota_protocol.c (pure,
// native-tested); this file only touches the flash / boot partition.
//
// The BLE dispatcher calls otaServiceHandle() from the BTC task context,
// and otaServicePollRestart() from the frame task. Both are guarded by a
// mutex because the BTC task can be preempted mid-write on single-core
// ESP32-C3 and the frame task polls the restart flag.

#include "ota_service.h"

#if defined(ARDUINO)

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <esp_ota_ops.h>
#include <esp_system.h>

#include "ota_protocol.h"

// PROGRESS 由 ble_service 转发（本文件不依赖 notify 的帧构造）。
extern void bleNotifyProgress(uint32_t written, uint32_t total);

// PROGRESS cadence: 256KB keeps the notify traffic off the critical path
// (a 1.875MB image sends ~8 progress frames).
#define OTA_PROGRESS_STEP 0x40000u
// Give the OK notify time to leave the BLE stack before resetting.
#define OTA_RESTART_DELAY_MS 300

static ota_session_t sSession;
static SemaphoreHandle_t sLock = nullptr;

static esp_ota_handle_t sOtaHandle = 0;
static const esp_partition_t *sOtaPartition = nullptr;
static uint32_t sNextProgress = 0;
static bool sRestartPending = false;
static uint32_t sRestartAtMs = 0;

static void send_progress(bool force) {
    if (!force && sSession.received < sNextProgress) return;
    bleNotifyProgress(sSession.received, sSession.total);
    sNextProgress = sSession.received + OTA_PROGRESS_STEP;
}

static uint8_t begin_handler(const uint8_t *payload, size_t len) {
    uint8_t rc = ota_protocol_begin(&sSession, payload, len);
    if (rc) return rc;

    sOtaPartition = esp_ota_get_next_update_partition(nullptr);
    if (!sOtaPartition) {
        ota_protocol_init(&sSession);
        return ERR_INTERNAL_ERROR;
    }
    esp_err_t err = esp_ota_begin(sOtaPartition, sSession.total, &sOtaHandle);
    if (err != ESP_OK) {
        ota_protocol_init(&sSession);
        return ERR_BUFFER_OVERFLOW; // no room / partition unusable
    }
    sNextProgress = OTA_PROGRESS_STEP;
    send_progress(true);
    return 0;
}

static uint8_t data_handler(const uint8_t *payload, size_t len) {
    // Validate first (offset/size/CRC bookkeeping) using a scratch copy so
    // a rejected block does not advance the session.
    ota_session_t probe = sSession;
    uint8_t rc = ota_protocol_data(&probe, payload, len);
    if (rc) return rc;

    size_t n = len - 5;
    esp_err_t err = esp_ota_write(sOtaHandle, payload + 5, n);
    if (err != ESP_OK) {
        ota_protocol_init(&sSession);
        esp_ota_abort(sOtaHandle);
        sOtaHandle = 0;
        return ERR_INTERNAL_ERROR;
    }
    sSession = probe;
    send_progress(false);
    return 0;
}

static uint8_t end_handler(void) {
    uint8_t rc = ota_protocol_end(&sSession);
    if (rc) return rc;

    esp_err_t err = esp_ota_end(sOtaHandle);
    sOtaHandle = 0;
    if (err != ESP_OK) {
        ota_protocol_init(&sSession);
        return ERR_CRC_ERROR; // esp_ota_end also validates the image
    }
    err = esp_ota_set_boot_partition(sOtaPartition);
    if (err != ESP_OK) {
        ota_protocol_init(&sSession);
        return ERR_INTERNAL_ERROR;
    }
    send_progress(true);
    ota_protocol_init(&sSession); // session over; the app polls GET_VERSION after reboot
    sRestartPending = true;
    sRestartAtMs = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS) +
                   OTA_RESTART_DELAY_MS;
    return 0;
}

static uint8_t abort_handler(void) {
    if (sOtaHandle) {
        esp_ota_abort(sOtaHandle);
        sOtaHandle = 0;
    }
    ota_protocol_init(&sSession);
    return 0;
}

uint8_t otaServiceHandle(const uint8_t *payload, size_t len) {
    if (!payload || len < 1) return ERR_INVALID_PARAMETER;
    // 锁只在第一次调用时创建（out of memory 时返回 NULL）。没有锁也要能拒绝，
    // 不能对着 NULL handle 调 xSemaphoreTake（会断言/崩溃）。
    if (!sLock) sLock = xSemaphoreCreateMutex();
    if (!sLock) return ERR_INTERNAL_ERROR;

    xSemaphoreTake(sLock, portMAX_DELAY);
    uint8_t rc;
    switch (payload[0]) {
        case OTA_SUB_BEGIN: rc = begin_handler(payload, len); break;
        case OTA_SUB_DATA:  rc = data_handler(payload, len); break;
        case OTA_SUB_END:   rc = end_handler(); break;
        case OTA_SUB_ABORT: rc = abort_handler(); break;
        default:            rc = ERR_INVALID_PARAMETER; break;
    }
    xSemaphoreGive(sLock);
    return rc;
}

bool otaServiceBusy(void) {
    // 待重启也算忙：END 成功到 esp_restart 之间有 ~300ms，此时放行
    // WRITE_CONFIG 只会让改动在重启时白丢，还可能与 flash 收尾交错。
    if (sRestartPending) return true;
    if (!sLock) return ota_protocol_busy(&sSession);
    xSemaphoreTake(sLock, portMAX_DELAY);
    bool busy = ota_protocol_busy(&sSession);
    xSemaphoreGive(sLock);
    return busy;
}

void otaServicePollRestart(void) {
    if (!sRestartPending) return;
    uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    if ((int32_t)(now - sRestartAtMs) < 0) return;
    sRestartPending = false;
    esp_restart();
}

#else
// Native / non-Arduino build: stubs so including files still link.
// ota_service.cpp is excluded from the native build (see platformio.ini).

uint8_t otaServiceHandle(const uint8_t *payload, size_t len) {
    (void)payload; (void)len;
    return ERR_UNSUPPORTED_COMMAND;
}
bool otaServiceBusy(void) { return false; }
void otaServicePollRestart(void) {}

#endif
