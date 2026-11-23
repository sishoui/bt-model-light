// BOOT button (GPIO9) long-press detection.
// Press-and-hold 5s -> factory reset (clear spiffs config + replay
// factory default). Latch until release so holding longer doesn't
// re-trigger. See ADR-0015.

#include "boot_button.h"
#include <Arduino.h>

static bool     sLatched = false;
static uint32_t sPressStart = 0;
static bool     sPressing = false;

void bootButtonInit() {
    pinMode(BOOT_BUTTON_GPIO, INPUT_PULLUP);
}

int bootButtonRaw() {
    return digitalRead(BOOT_BUTTON_GPIO);
}

bool bootButtonPoll() {
    int raw = bootButtonRaw();
    bool pressed = (raw == 0);  // BOOT pulls to GND when held
    bool fired = false;

    if (pressed) {
        if (!sPressing) {
            sPressing = true;
            sPressStart = millis();
            sLatched = false;
        }
        if (!sLatched && (millis() - sPressStart >= BOOT_LONGPRESS_MS)) {
            sLatched = true;
            fired = true;
        }
    } else {
        sPressing = false;
        sLatched = false;
    }
    return fired;
}