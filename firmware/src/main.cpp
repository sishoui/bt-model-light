// Firmware entry point for bt-model-light ESP32-C3.
//
// T2 scope:
//   - Initialize the 8-pin WS2812B driver (ADR-0013).
//   - Play the factory-default breath-rainbow effect on first boot so
//     a freshly flashed device lights up (ADR-0015).
//   - Detect a 5s long-press on BOOT (GPIO9) and restore factory
//     default by restarting the factory-default playback (ADR-0015).
//   - Enter PLAYING state once the factory default starts (ADR-0016).
//
// T3 (#23) adds:
//   - Protocol parser (pure C, ADR-0003/0006) — compiled but not yet
//     wired to a transport; the BLE GATT service lands in T6 and will
//     call parser_feed/parser_next from its write callback.
//   - Full state machine (ADR-0016) with illegal-transition detection
//     returning ERR_INVALID_STATE (0x05). T3 ships the transition table
//     and dispatch API; T6 wires commands to events.
//   - Watchdog task (ADR-0016): feeds from the frame loop for now, and
//     resets the MCU on a 5s unfed window. T6 moves the feed into the
//     BLE command handler.
// T6 (#26) adds: BLE GATT service, spiffs config persistence, full
//   8-effect render set, layer composition.
//
// Note: no Serial console in T2. The ESP32-C3-DevKitM-1 has no
// USB-UART bridge, and Serial.begin() blocks when the native USB-CDC
// port is not enumerated, which would prevent the app task from
// starting. Console logging is introduced in T8 (ADR-0026).

#include <Arduino.h>

#include "protocol_gen.h"
#include "led_driver.h"
#include "effects.h"
#include "factory_default.h"
#include "boot_button.h"
#include "state_machine.h"
#include "watchdog.h"

// Tick clock: one tick = TICK_MS (10ms). At each tick we advance the
// breath-rainbow phase and push the new frame to all 8 strips.
static uint32_t sTickCount = 0;

static void frameTask(void *) {
    for (;;) {
        // Factory-default playback: fill all pins, then refresh in order.
        factoryDefaultFillAll(sTickCount);
        ledRefreshAll();
        sTickCount++;
        // The frame loop is the heartbeat: as long as we keep ticking,
        // the firmware is alive. T6 will move the feed to the BLE
        // command handler once it lands; for now feeding here means a
        // hang in LED rendering or scheduling is what triggers reset.
        watchdogFeed();
        vTaskDelay(pdMS_TO_TICKS(TICK_MS));
    }
}

static void bootButtonTask(void *) {
    for (;;) {
        if (bootButtonPoll()) {
            // 5s long-press complete -> restore factory default.
            // In T2 "restore" means replay factory-default playback
            // from tick 0. T6 will also clear spiffs /config.bin.
            sTickCount = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void setup() {
    ledInit();
    bootButtonInit();
    stateMachineInit();
    watchdogInit();

    // Factory-default playback at boot enters PLAYING (ADR-0015/0016).
    // T6 will instead drive transitions from CONNECTED via APPLY when
    // BLE config lands; for now boot must always end in PLAYING.
    stateMachineForce(FW_STATE_PLAYING);

    // Three RTOS tasks: LED frame loop, BOOT button polling, watchdog.
    // The watchdog task feeds itself from the protocol/loop side; here
    // we just keep it fed while the frame task runs (T6 wires the feed
    // to actual command-handler activity).
    xTaskCreate(frameTask, "frame", 4096, nullptr, 5, nullptr);
    xTaskCreate(bootButtonTask, "bootbtn", 2048, nullptr, 3, nullptr);
    xTaskCreate(watchdogTask, "wdt", 2048, nullptr, 1, nullptr);
}

void loop() {
    // All work is in dedicated RTOS tasks; nothing to do here.
    vTaskDelay(pdMS_TO_TICKS(1000));
}
