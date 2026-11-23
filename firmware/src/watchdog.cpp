// Watchdog task implementation (ADR-0016).
//
// Arduino/FreeRTOS-specific: excluded from native test build. The
// timeout/feed accounting is intentionally tiny so a hang is caught by
// the hardware timer without complex logic.
//
// Strategy:
//   - Software watchdog: a low-priority FreeRTOS task wakes every 100ms,
//     checks "now - last_feed > WATCHDOG_TIMEOUT_MS", and calls
//     ESP.restart() if so.
//   - Hardware watchdog: the ESP32-C3 task watchdog (TWDT) is also
//     kept happy by the same task via esp_task_wdt_reset(). We rely on
//     the Arduino-ESP32 default TWDT setup; no extra config here.
//
// Why software + TWDT and not just TWDT?
//   - TWDT only monitors idle-task feeding; if a high-priority task
//     hangs without yielding, TWDT still resets. That's exactly what
//     we want for "firmware stuck". The software layer is the
//     application-level semantic ("nobody fed me in 5s") which is
//     stricter and covers the case where the protocol handler is
//     intentionally not feeding while it waits on a blocking call.

#include <Arduino.h>
#include "watchdog.h"

#if defined(ESP32)
#include <esp_task_wdt.h>
#endif

static volatile uint32_t sLastFeedMs = 0;

void watchdogInit() {
    sLastFeedMs = millis();
}

void watchdogFeed() {
    sLastFeedMs = millis();
}

void watchdogTask(void *) {
    // Give the rest of setup() a moment to start feeding.
    vTaskDelay(pdMS_TO_TICKS(100));
    sLastFeedMs = millis();

    for (;;) {
        // Keep the hardware TWDT happy regardless of application feed.
        // esp_task_wdt_reset() is Arduino-ESP32's wrapper; on platforms
        // where it isn't available this is a no-op (guarded by ESP32).
#if defined(ESP32)
        esp_task_wdt_reset();
#endif

        uint32_t now = millis();
        if ((now - sLastFeedMs) > WATCHDOG_TIMEOUT_MS) {
            // No feed within the window — assume firmware is hung.
            // Reboot. Rebooting is the only safe recovery for a 7×24
            // device that has stopped responding.
            ESP.restart();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}