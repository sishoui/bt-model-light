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
// T3 (#23) adds: protocol parser (pure C), full state machine with
//   illegal-transition detection, watchdog task.
// T6 (#26) adds: BLE GATT service, spiffs config persistence, full
//   8-effect render set, layer composition.
//
// Pin map and partition table live in led_driver.h / partitions.csv.

#include <Arduino.h>

#include "protocol_gen.h"
#include "led_driver.h"
#include "effects.h"
#include "factory_default.h"
#include "boot_button.h"
#include "state_machine.h"

// Tick clock: one tick = TICK_MS (10ms). At each tick we advance the
// breath-rainbow phase and push the new frame to all 8 strips.
static uint32_t sTickCount = 0;

static void frameTask(void *) {
    for (;;) {
        // Factory-default playback: fill all pins, then refresh in order.
        factoryDefaultFillAll(sTickCount);
        ledRefreshAll();
        sTickCount++;
        vTaskDelay(pdMS_TO_TICKS(TICK_MS));
    }
}

static void bootButtonTask(void *) {
    for (;;) {
        if (bootButtonPoll()) {
            // 5s long-press complete -> restore factory default.
            // In T2 "restore" means replay factory-default playback
            // from tick 0. T6 will also clear spiffs /config.bin.
            Serial.println("[factory] long-press BOOT -> restore default");
            sTickCount = 0;
            // Note: ledInit() already configured; no re-init needed.
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println();
    Serial.printf("bt-model-light firmware %s (protocol %s)\n",
                  FIRMWARE_VERSION_STRING, PROTOCOL_VERSION_STRING);

    ledInit();
    bootButtonInit();
    stateMachineInit();

    // Factory-default playback at boot enters PLAYING (ADR-0015/0016).
    stateMachineSet(FW_STATE_PLAYING);

    // Two RTSS tasks: LED frame loop and BOOT button polling.
    xTaskCreate(frameTask, "frame", 4096, nullptr, 5, nullptr);
    xTaskCreate(bootButtonTask, "bootbtn", 2048, nullptr, 3, nullptr);
}

void loop() {
    // All work is in dedicated RTSS tasks; nothing to do here.
    vTaskDelay(pdMS_TO_TICKS(1000));
}