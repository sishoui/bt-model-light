// Minimal state machine implementation for T2.
// T3 (#23) will replace this with full transition validation + watchdog.

#include "state_machine.h"

static fw_state_t sState = FW_STATE_IDLE;

void stateMachineInit() {
    sState = FW_STATE_IDLE;
}

fw_state_t stateMachineState() {
    return sState;
}

void stateMachineSet(fw_state_t s) {
    sState = s;
}