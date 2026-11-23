// Firmware state machine (ADR-0016). Full implementation lands in T3
// (#23); T2 only needs the enum + a minimal transition so that the
// factory-default playback at boot enters PLAYING.
//
// States: IDLE -> CONNECTED -> CONFIGURED -> PLAYING -> (PREVIEW / PAUSED)

#pragma once

#include <stdint.h>

typedef enum {
    FW_STATE_IDLE = 0,
    FW_STATE_CONNECTED,
    FW_STATE_CONFIGURED,
    FW_STATE_PLAYING,
    FW_STATE_PREVIEW,
    FW_STATE_PAUSED,
} fw_state_t;

// Initialize to IDLE.
void stateMachineInit();
// Current state.
fw_state_t stateMachineState();
// Force a transition (T2: IDLE -> PLAYING when factory default starts).
void stateMachineSet(fw_state_t s);
