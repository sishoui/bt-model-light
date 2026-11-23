// BOOT button (GPIO9 on ESP32-C3) long-press detection.
// Long-press 5s -> restore factory default (clear spiffs config +
// replay factory-default effect). See ADR-0015.
//
// Pure polling with debounce; no hardware ISR needed for T2. A
// FreeRTOS task in main.cpp calls bootButtonPoll() every 20ms.

#pragma once

#include <stdint.h>

// GPIO for the BOOT button on ESP32-C3 (ADR-0015).
#define BOOT_BUTTON_GPIO 9

// Hold threshold for "factory reset" in milliseconds.
#define BOOT_LONGPRESS_MS 5000

// Initialize the BOOT button pin (input + pull-up).
void bootButtonInit();

// Poll the button state. Call every ~20ms from a FreeRTOS task.
// Returns true exactly once when a full 5s press completes, then
// latches until the button is released (so holding longer doesn't
// re-trigger).
bool bootButtonPoll();

// Current raw level (0 = pressed, since BOOT pulls to GND).
int bootButtonRaw();