// Firmware entry point for bt-model-light ESP32-C3.
//
// T2 scope:
//   - Initialize the 8-pin WS2812B driver (ADR-0013).
//   - Play the factory-default breath-rainbow effect on first boot so
//     a freshly flashed device lights up (ADR-0015).
//   - Detect a 5s long-press on BOOT (GPIO9) and restore factory
//     default by restarting the factory-default playback (ADR-0015).
//
// T3 (#23) adds:
//   - Protocol parser (pure C, ADR-0003/0006).
//   - Full state machine (ADR-0016) with illegal-transition detection
//     returning ERR_INVALID_STATE (0x05).
//   - Watchdog task (ADR-0016): resets the MCU on a 5s unfed window.
//
// T6 (#26) adds: BLE GATT service (Write + Notify), spiffs config
//   persistence (ADR-0014/0015), full 8-effect render set (ADR-0017),
//   dual-layer composition (ADR-0020), config-driven playback with
//   step duration/transition/loop (ADR-0021), GET_VERSION negotiation
//   on connect (ADR-0009).
//
// Boot flow (T6):
//   1. ledInit + bootButtonInit + stateMachineInit + watchdogInit.
//   2. configPersistInit (mount spiffs, format-on-failure).
//   3. configPersistLoad -> saved config or factory default (ADR-0015).
//      State stays IDLE; the factory-default visual plays in IDLE so the
//      user sees lights immediately. PLAYING is reserved for user-config
//      playback after APPLY.
//   4. bleServiceBegin (advertising + GATT server + notify char).
//   5. Frame task: every TICK_MS, render the active config (or factory
//      default when IDLE) + ledRefreshAll + 配置落盘轮询（ADR-0030）。
//      Watchdog fed here + in BLE command handlers (ADR-0016).
//   6. BOOT task: 5s long-press -> clear spiffs + factory default + IDLE.
//
// Note: no Serial console in T2. The ESP32-C3-DevKitM-1 has no
// USB-UART bridge, and Serial.begin() blocks when the native USB-CDC
// port is not enumerated, which would prevent the app task from
// starting. Console logging is introduced in T8 (ADR-0026).

#include <Arduino.h>
#include <esp_ota_ops.h>

#include "protocol_gen.h"
#include "effects.h"
#include "config.h"
#include "composition.h"
#include "config_persist.h"
#include "ble_service.h"
#include "factory_default.h"
#include "boot_button.h"
#include "led_driver.h"
#include "master_output.h"
#include "ota_service.h"
#include "state_machine.h"
#include "watchdog.h"

// ---- live device state ---------------------------------------------------

static device_config_t sConfig;
static group_playback_t sPlayback[PIN_COUNT][GROUPS_PER_PIN_MAX];

// Tick clock: one tick = TICK_MS (10ms). The frame loop advances effect
// phase by one tick per iteration.
static uint32_t sTickCount = 0;

// ---- frame task ----------------------------------------------------------

static void frameTask(void *) {
    // 用真实时间差推进 tick：ledRefreshAll 对 8 个 pin 各 show() 一次，
    // RMT 推 100 灯 × 8 pin 实际耗时可能 >TICK_MS，固定 dt=1 会让 step 变慢
    // （实测 5s 步骤跑 15s）。这里按墙钟时间推进，保证 step 时长准确。
    uint32_t last_ms = 0;
    for (;;) {
        uint32_t now_ms = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        uint32_t dt_ticks;
        if (last_ms == 0) {
            dt_ticks = 1;
        } else {
            uint32_t elapsed_ms = now_ms - last_ms;
            dt_ticks = elapsed_ms / TICK_MS;
            if (dt_ticks == 0) dt_ticks = 1; // 至少推进 1 tick，避免 0 速
        }
        last_ms = now_ms;

        fw_state_t st = stateMachineState();
        if (st == FW_STATE_PLAYING) {
            // Config-driven playback: render the active config, advance
            // each group's step clock, refresh all 8 strips in order.
            composition_render_all(&sConfig, sPlayback, dt_ticks);
        } else if (st == FW_STATE_PREVIEW) {
            // Preview: same render path; the step clock was set by
            // TRIGGER_STEP. dt keeps the effect animating at real time.
            composition_render_all(&sConfig, sPlayback, dt_ticks);
        } else if (st == FW_STATE_PAUSED) {
            // Hold current frame: just refresh (no re-render, no advance).
            // The strips keep their last-written pixels.
        } else if (st == FW_STATE_CONFIGURED) {
            // 配置已收到、等 APPLY：保持上一帧，不再刷出厂彩虹（ADR-0030）。
            // 首次配置时上一帧本就是出厂默认（IDLE/CONNECTED 画的），所以
            // "开箱即亮"不变；关灯时也不会先闪一下彩虹再灭。
        } else {
            // IDLE / CONNECTED: factory-default breath-rainbow visual so the
            // device is never dark before first APPLY (ADR-0015 "开箱即亮").
            factoryDefaultFillAll(sTickCount);
        }
        ledRefreshAll();
        sTickCount++;

        // 配置落盘轮询（ADR-0030）：WRITE_CONFIG 只改 RAM，flash 写在这里按
        // 尾部防抖执行，命令路径（含紧随其后的 APPLY）不再等落盘。
        bleServicePollPersist(now_ms);

        // OTA 提交后的延迟重启（ADR-0034）：留时间让 OK notify 先发出。
        otaServicePollRestart();

        // Frame loop is the heartbeat; the BLE command handler also feeds
        // (ADR-0016). A hang in rendering or scheduling trips the reset.
        watchdogFeed();
        vTaskDelay(pdMS_TO_TICKS(TICK_MS));
    }
}

// ---- BOOT button task ----------------------------------------------------

static void bootButtonTask(void *) {
    for (;;) {
        if (bootButtonPoll()) {
            // 5s long-press complete -> factory reset (ADR-0015).
            configPersistErase();
            config_load_factory_default(&sConfig);
            composition_init(&sConfig, sPlayback);
            // 整机开关/亮度同属出厂态（ADR-0031/0032）：回开机 + 满亮度。
            masterResetDefaults();
            // Back to IDLE: the frame loop shows factory-default visuals.
            // (If we were PLAYING, RESET_DEFAULT -> IDLE is legal; from
            // any other state it's a no-op or self-loop. Force to IDLE so
            // the visual path is deterministic regardless of prior state.)
            stateMachineForce(FW_STATE_IDLE);
            sTickCount = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

// ---- setup / loop --------------------------------------------------------

void setup() {
    ledInit();
    bootButtonInit();
    stateMachineInit();
    watchdogInit();

    // Mount spiffs and restore the saved config, or fall back to the
    // factory default if missing/corrupt (ADR-0015 重启自恢复).
    configPersistInit();
    int rc = configPersistLoad(&sConfig);
    // rc: 1 = loaded saved config, 0 = missing (-> factory default already
    // loaded by Load), -1 = corrupt (-> factory default already loaded).
    // Either way sConfig now holds a valid config. Reset playback clocks.
    composition_init(&sConfig, sPlayback);

    // 若从 SPIFFS 恢复了用户配置（rc==1），直接进 PLAYING 渲染保存的灯效，
    // 而不是 IDLE 播出厂默认（ADR-0015 修订：重启后保持用户配置）。
    // 无保存配置（rc!=1）时保持 IDLE，frameTask 播出厂呼吸彩光「开箱即亮」。
    if (rc == 1) {
        stateMachineForce(FW_STATE_PLAYING);
    }

    // Start the BLE GATT service (advertising + Write/Notify chars).
    bleServiceBegin(&sConfig, sPlayback);

    // Three RTOS tasks: LED frame loop, BOOT button polling, watchdog.
    xTaskCreate(frameTask, "frame", 4096, nullptr, 5, nullptr);
    xTaskCreate(bootButtonTask, "bootbtn", 2048, nullptr, 3, nullptr);
    xTaskCreate(watchdogTask, "wdt", 2048, nullptr, 1, nullptr);

    // OTA 回滚门禁（ADR-0034 / sdkconfig CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE）：
    // 新镜像跑到这里即视为"启动成功"，取消回滚。放在任务创建之后，确保
    // BLE/渲染/看门狗都已起来——若在 setup 早期崩溃，bootloader 会回滚。
    esp_ota_mark_app_valid_cancel_rollback();
}

void loop() {
    // All work is in dedicated RTOS tasks; nothing to do here.
    vTaskDelay(pdMS_TO_TICKS(1000));
}