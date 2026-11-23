// Firmware state machine implementation (ADR-0016).
//
// Pure C++ with no Arduino/FreeRTOS includes. The transition table is
// a static const array indexed by [from_state][event] so dispatch is
// O(1) and easy to audit. Each cell holds the next state, or
// FW_STATE_COUNT as a sentinel for "illegal".

#include "state_machine.h"

static fw_state_t sState = FW_STATE_IDLE;

// Transition table. Entry [from][evt] = next state, or FW_STATE_COUNT
// for "illegal". Rows = states (FW_STATE_*), cols = events (FW_EVT_*).
//
// Diagram (legal edges only):
//
//   IDLE       --CONNECT-----------> CONNECTED
//   CONNECTED  --WRITE_CONFIG_OK--> CONFIGURED
//   CONNECTED  --DISCONNECT-------> IDLE
//   CONFIGURED --APPLY------------> PLAYING
//   CONFIGURED --DISCONNECT-------> IDLE
//   PLAYING    --TRIGGER_STEP-----> PREVIEW
//   PLAYING    --ENTER_PREVIEW----> PREVIEW
//   PLAYING    --STOP------------> PAUSED
//   PLAYING    --RESET_DEFAULT---> IDLE
//   PLAYING    --DISCONNECT------> IDLE
//   PREVIEW    --EXIT_PREVIEW----> PLAYING
//   PREVIEW    --STOP------------> PAUSED
//   PREVIEW    --RESET_DEFAULT---> IDLE
//   PREVIEW    --DISCONNECT------> IDLE
//   PAUSED     --RESUME----------> PLAYING
//   PAUSED     --STOP------------> PAUSED (self)
//   PAUSED     --RESET_DEFAULT---> IDLE
//   PAUSED     --DISCONNECT------> IDLE
//
// Illegal transitions (e.g. APPLY from IDLE) leave state unchanged and
// return ERR_INVALID_STATE (0x05).
static const fw_state_t kTransitionTable[FW_STATE_COUNT][FW_EVT_COUNT] = {
    /* IDLE */ {
        /* CONNECT          */ FW_STATE_CONNECTED,
        /* DISCONNECT       */ FW_STATE_COUNT,
        /* WRITE_CONFIG_OK  */ FW_STATE_COUNT,
        /* APPLY            */ FW_STATE_COUNT,
        /* TRIGGER_STEP     */ FW_STATE_COUNT,
        /* STOP             */ FW_STATE_COUNT,
        /* RESUME           */ FW_STATE_COUNT,
        /* RESET_DEFAULT    */ FW_STATE_IDLE,
        /* ENTER_PREVIEW    */ FW_STATE_COUNT,
        /* EXIT_PREVIEW     */ FW_STATE_COUNT,
    },
    /* CONNECTED */ {
        /* CONNECT          */ FW_STATE_COUNT,
        /* DISCONNECT       */ FW_STATE_IDLE,
        /* WRITE_CONFIG_OK  */ FW_STATE_CONFIGURED,
        /* APPLY            */ FW_STATE_COUNT,
        /* TRIGGER_STEP     */ FW_STATE_COUNT,
        /* STOP             */ FW_STATE_COUNT,
        /* RESUME           */ FW_STATE_COUNT,
        /* RESET_DEFAULT    */ FW_STATE_IDLE,
        /* ENTER_PREVIEW    */ FW_STATE_COUNT,
        /* EXIT_PREVIEW     */ FW_STATE_COUNT,
    },
    /* CONFIGURED */ {
        /* CONNECT          */ FW_STATE_COUNT,
        /* DISCONNECT       */ FW_STATE_IDLE,
        /* WRITE_CONFIG_OK  */ FW_STATE_CONFIGURED,
        /* APPLY            */ FW_STATE_PLAYING,
        /* TRIGGER_STEP     */ FW_STATE_PREVIEW,
        /* STOP             */ FW_STATE_COUNT,
        /* RESUME           */ FW_STATE_COUNT,
        /* RESET_DEFAULT    */ FW_STATE_IDLE,
        /* ENTER_PREVIEW    */ FW_STATE_COUNT,
        /* EXIT_PREVIEW     */ FW_STATE_COUNT,
    },
    /* PLAYING */ {
        /* CONNECT          */ FW_STATE_COUNT,
        /* DISCONNECT       */ FW_STATE_IDLE,
        /* WRITE_CONFIG_OK  */ FW_STATE_COUNT,
        /* APPLY            */ FW_STATE_PLAYING,
        /* TRIGGER_STEP     */ FW_STATE_PREVIEW,
        /* STOP             */ FW_STATE_PAUSED,
        /* RESUME           */ FW_STATE_COUNT,
        /* RESET_DEFAULT    */ FW_STATE_IDLE,
        /* ENTER_PREVIEW    */ FW_STATE_PREVIEW,
        /* EXIT_PREVIEW     */ FW_STATE_COUNT,
    },
    /* PREVIEW */ {
        /* CONNECT          */ FW_STATE_COUNT,
        /* DISCONNECT       */ FW_STATE_IDLE,
        /* WRITE_CONFIG_OK  */ FW_STATE_COUNT,
        /* APPLY            */ FW_STATE_PLAYING,
        /* TRIGGER_STEP     */ FW_STATE_PREVIEW,
        /* STOP             */ FW_STATE_PAUSED,
        /* RESUME           */ FW_STATE_COUNT,
        /* RESET_DEFAULT    */ FW_STATE_IDLE,
        /* ENTER_PREVIEW    */ FW_STATE_PREVIEW,
        /* EXIT_PREVIEW     */ FW_STATE_PLAYING,
    },
    /* PAUSED */ {
        /* CONNECT          */ FW_STATE_COUNT,
        /* DISCONNECT       */ FW_STATE_IDLE,
        /* WRITE_CONFIG_OK  */ FW_STATE_COUNT,
        /* APPLY            */ FW_STATE_PLAYING,
        /* TRIGGER_STEP     */ FW_STATE_COUNT,
        /* STOP             */ FW_STATE_PAUSED,
        /* RESUME           */ FW_STATE_PLAYING,
        /* RESET_DEFAULT    */ FW_STATE_IDLE,
        /* ENTER_PREVIEW    */ FW_STATE_COUNT,
        /* EXIT_PREVIEW     */ FW_STATE_COUNT,
    },
};

static const char *kStateNames[FW_STATE_COUNT] = {
    "IDLE",
    "CONNECTED",
    "CONFIGURED",
    "PLAYING",
    "PREVIEW",
    "PAUSED",
};

void stateMachineInit() {
    sState = FW_STATE_IDLE;
}

fw_state_t stateMachineState() {
    return sState;
}

const char *stateMachineName(fw_state_t s) {
    if ((int)s < 0 || (int)s >= (int)FW_STATE_COUNT) {
        return "UNKNOWN";
    }
    return kStateNames[s];
}

bool stateMachineIsLegal(fw_state_t from, fw_event_t evt) {
    if ((int)from < 0 || (int)from >= (int)FW_STATE_COUNT) return false;
    if ((int)evt < 0 || (int)evt >= (int)FW_EVT_COUNT) return false;
    return kTransitionTable[from][evt] != FW_STATE_COUNT;
}

uint8_t stateMachineDispatch(fw_event_t evt) {
    if ((int)evt < 0 || (int)evt >= (int)FW_EVT_COUNT) {
        return ERR_INVALID_STATE;
    }
    fw_state_t next = kTransitionTable[sState][evt];
    if (next == FW_STATE_COUNT) {
        return ERR_INVALID_STATE;
    }
    sState = next;
    return 0;
}

void stateMachineForce(fw_state_t s) {
    if ((int)s < 0 || (int)s >= (int)FW_STATE_COUNT) {
        return;
    }
    sState = s;
}