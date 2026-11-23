// Firmware state machine (ADR-0016).
//
// States: IDLE -> CONNECTED -> CONFIGURED -> PLAYING -> (PREVIEW / PAUSED)
//
// The state machine is a pure function of (current_state, event) -> next
// state. Illegal transitions return ERR_INVALID_STATE (0x05) and leave
// the state unchanged. See fw_event_t for the event vocabulary and
// kTransitionTable for the legal edges.
//
// T2 only needed enum + minimal set so factory-default could enter
// PLAYING. T3 (#23) replaces that with full transition validation.
//
// The .cpp keeps the file pure C++ (no Arduino includes) so it can be
// compiled in the PlatformIO native test target alongside the parser.

#pragma once

#include <stdint.h>
#include <stdbool.h>

// Error code 0x05 — reuse protocol_gen.h ERR_INVALID_STATE.
#include "protocol_gen.h"

// States in the firmware lifecycle.
typedef enum {
    FW_STATE_IDLE = 0,
    FW_STATE_CONNECTED,
    FW_STATE_CONFIGURED,
    FW_STATE_PLAYING,
    FW_STATE_PREVIEW,
    FW_STATE_PAUSED,
    FW_STATE_COUNT,
} fw_state_t;

// Events that drive transitions. Kept small and command-aligned with
// ADR-0007; each command from the BLE layer maps to one event.
typedef enum {
    FW_EVT_CONNECT = 0,         // BLE connected
    FW_EVT_DISCONNECT,          // BLE disconnected
    FW_EVT_WRITE_CONFIG_OK,     // WRITE_CONFIG accepted -> CONFIGURED
    FW_EVT_APPLY,               // APPLY -> start playing
    FW_EVT_TRIGGER_STEP,        // TRIGGER_STEP -> preview one step
    FW_EVT_STOP,                // STOP -> hold current lights, PAUSED
    FW_EVT_RESUME,              // RESUME -> back to PLAYING
    FW_EVT_RESET_DEFAULT,       // RESET_DEFAULT -> back to IDLE
    FW_EVT_ENTER_PREVIEW,       // enter PREVIEW from PLAYING
    FW_EVT_EXIT_PREVIEW,        // leave PREVIEW back to PLAYING
    FW_EVT_COUNT,
} fw_event_t;

// Initialize to IDLE.
void stateMachineInit();

// Current state.
fw_state_t stateMachineState();

// Name of a state (for logs/tests). Never NULL.
const char *stateMachineName(fw_state_t s);

// Try a transition. Returns:
//   0                        -> transitioned
//   ERR_INVALID_STATE (0x05) -> illegal transition, state unchanged
uint8_t stateMachineDispatch(fw_event_t evt);

// T2 compatibility: force a state without validation.
// Used at boot to enter PLAYING for factory-default playback, and by
// tests. Do NOT call this from command handlers — use stateMachineDispatch.
void stateMachineForce(fw_state_t s);

// True if (state, evt) is a legal transition (caller passes both).
bool stateMachineIsLegal(fw_state_t from, fw_event_t evt);