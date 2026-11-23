// Watchdog task (ADR-0016): 7×24 device self-recovery.
//
// Design:
//   - A dedicated FreeRTOS task monitors a "last feed" timestamp.
//   - Any long-running work (BLE handler, LED render, OTA write) must
//     call watchdogFeed() periodically. If the task goes unfed for
//     WATCHDOG_TIMEOUT_MS, the firmware reboots.
//   - The implementation is Arduino/FreeRTOS-specific (uses millis(),
//     ESP.restart(), esp_task_wdt_reset()) and is excluded from the
//     native test build (see platformio.ini build_src_filter). The
//     timeout/feed logic is intentionally trivial (a single subtraction
//     and comparison) so the hardware integration is the only thing
//     that needs review; the behaviour is exercised by 真机 smoke test
//     (ADR-0012), not by Unity.

#pragma once

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Watchdog timeout in milliseconds. Chosen to be much longer than any
// single blocking call (LED refresh < 10ms, BLE handler < 50ms) but
// short enough to recover from a hang without user-visible downtime.
#define WATCHDOG_TIMEOUT_MS 5000

// Initialize the watchdog (clears the feed timestamp).
// Call once at boot before creating the task.
void watchdogInit();

// Feed the watchdog. Call from long-running loops/tasks.
// Safe to call from any FreeRTOS task context.
void watchdogFeed();

// The watchdog task entry. Pass to xTaskCreate.
//   stack: 2048 bytes, priority: low (1), never blocks on I/O.
void watchdogTask(void *);

#ifdef __cplusplus
}
#endif