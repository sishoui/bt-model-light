// Unity tests for the firmware state machine (ADR-0016).
//
// Coverage:
//   - Legal happy path: IDLE -> CONNECTED -> CONFIGURED -> PLAYING
//   - PLAYING -> PREVIEW -> PLAYING (preview round-trip)
//   - PLAYING -> PAUSED -> PLAYING (stop/resume)
//   - Illegal transition from IDLE returns 0x05 (ERR_INVALID_STATE)
//   - Illegal transition from PLAYING to CONNECTED returns 0x05
//   - RESET_DEFAULT from any state goes back to IDLE
//   - stateMachineName returns stable strings
//   - stateMachineForce bypasses validation (for boot factory default)

#include <unity.h>
#include "state_machine.h"

extern "C" void setUp(void) {
    stateMachineInit();
}

extern "C" void tearDown(void) {}

// --- Legal path -----------------------------------------------------------

void test_happy_path(void) {
    TEST_ASSERT_EQUAL(FW_STATE_IDLE, stateMachineState());
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_CONNECT));
    TEST_ASSERT_EQUAL(FW_STATE_CONNECTED, stateMachineState());
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_WRITE_CONFIG_OK));
    TEST_ASSERT_EQUAL(FW_STATE_CONFIGURED, stateMachineState());
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_APPLY));
    TEST_ASSERT_EQUAL(FW_STATE_PLAYING, stateMachineState());
}

void test_preview_roundtrip(void) {
    stateMachineForce(FW_STATE_PLAYING);
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_ENTER_PREVIEW));
    TEST_ASSERT_EQUAL(FW_STATE_PREVIEW, stateMachineState());
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_EXIT_PREVIEW));
    TEST_ASSERT_EQUAL(FW_STATE_PLAYING, stateMachineState());
}

void test_pause_resume(void) {
    stateMachineForce(FW_STATE_PLAYING);
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_STOP));
    TEST_ASSERT_EQUAL(FW_STATE_PAUSED, stateMachineState());
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_RESUME));
    TEST_ASSERT_EQUAL(FW_STATE_PLAYING, stateMachineState());
}

void test_trigger_step_enters_preview(void) {
    stateMachineForce(FW_STATE_PLAYING);
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_TRIGGER_STEP));
    TEST_ASSERT_EQUAL(FW_STATE_PREVIEW, stateMachineState());
}

// --- Illegal transitions --------------------------------------------------

void test_apply_from_idle_is_illegal(void) {
    // IDLE --APPLY--> ???  Illegal: must return 0x05 and stay IDLE.
    TEST_ASSERT_EQUAL(FW_STATE_IDLE, stateMachineState());
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_STATE,
                            stateMachineDispatch(FW_EVT_APPLY));
    TEST_ASSERT_EQUAL(FW_STATE_IDLE, stateMachineState());
}

void test_connect_from_connected_is_illegal(void) {
    stateMachineDispatch(FW_EVT_CONNECT);
    TEST_ASSERT_EQUAL(FW_STATE_CONNECTED, stateMachineState());
    // CONNECT while already CONNECTED — not in the table.
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_STATE,
                            stateMachineDispatch(FW_EVT_CONNECT));
    TEST_ASSERT_EQUAL(FW_STATE_CONNECTED, stateMachineState());
}

void test_write_config_from_playing_returns_configured(void) {
    // PLAYING --WRITE_CONFIG_OK--> CONFIGURED (edit mid-play is allowed; APPLY
    // from CONFIGURED resumes PLAYING).
    stateMachineForce(FW_STATE_PLAYING);
    TEST_ASSERT_EQUAL_UINT8(0,
                            stateMachineDispatch(FW_EVT_WRITE_CONFIG_OK));
    TEST_ASSERT_EQUAL(FW_STATE_CONFIGURED, stateMachineState());
}

void test_trigger_step_from_idle_is_illegal(void) {
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_STATE,
                            stateMachineDispatch(FW_EVT_TRIGGER_STEP));
    TEST_ASSERT_EQUAL(FW_STATE_IDLE, stateMachineState());
}

// --- Reset -------------------------------------------------------------

void test_reset_default_from_playing(void) {
    stateMachineForce(FW_STATE_PLAYING);
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_RESET_DEFAULT));
    TEST_ASSERT_EQUAL(FW_STATE_IDLE, stateMachineState());
}

void test_reset_default_from_paused(void) {
    stateMachineForce(FW_STATE_PAUSED);
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_RESET_DEFAULT));
    TEST_ASSERT_EQUAL(FW_STATE_IDLE, stateMachineState());
}

void test_reset_default_from_idle_is_self(void) {
    // IDLE --RESET_DEFAULT--> IDLE (self-transition, not illegal).
    TEST_ASSERT_EQUAL_UINT8(0, stateMachineDispatch(FW_EVT_RESET_DEFAULT));
    TEST_ASSERT_EQUAL(FW_STATE_IDLE, stateMachineState());
}

// --- Helpers -----------------------------------------------------------

void test_state_machine_name(void) {
    TEST_ASSERT_EQUAL_STRING("IDLE", stateMachineName(FW_STATE_IDLE));
    TEST_ASSERT_EQUAL_STRING("CONNECTED", stateMachineName(FW_STATE_CONNECTED));
    TEST_ASSERT_EQUAL_STRING("CONFIGURED", stateMachineName(FW_STATE_CONFIGURED));
    TEST_ASSERT_EQUAL_STRING("PLAYING", stateMachineName(FW_STATE_PLAYING));
    TEST_ASSERT_EQUAL_STRING("PREVIEW", stateMachineName(FW_STATE_PREVIEW));
    TEST_ASSERT_EQUAL_STRING("PAUSED", stateMachineName(FW_STATE_PAUSED));
    TEST_ASSERT_EQUAL_STRING("UNKNOWN",
                             stateMachineName((fw_state_t)FW_STATE_COUNT));
}

void test_state_machine_is_legal_helper(void) {
    TEST_ASSERT_TRUE(stateMachineIsLegal(FW_STATE_IDLE, FW_EVT_CONNECT));
    TEST_ASSERT_FALSE(stateMachineIsLegal(FW_STATE_IDLE, FW_EVT_APPLY));
    TEST_ASSERT_TRUE(stateMachineIsLegal(FW_STATE_PLAYING, FW_EVT_STOP));
    TEST_ASSERT_FALSE(stateMachineIsLegal(FW_STATE_CONNECTED, FW_EVT_APPLY));
}

void test_force_bypasses_table(void) {
    // Force from IDLE to PLAYING — bypasses the table.
    TEST_ASSERT_EQUAL(FW_STATE_IDLE, stateMachineState());
    stateMachineForce(FW_STATE_PLAYING);
    TEST_ASSERT_EQUAL(FW_STATE_PLAYING, stateMachineState());
}

// --- Runner -------------------------------------------------------------

int main(int argc, char **argv) {
    UNITY_BEGIN();
    RUN_TEST(test_happy_path);
    RUN_TEST(test_preview_roundtrip);
    RUN_TEST(test_pause_resume);
    RUN_TEST(test_trigger_step_enters_preview);
    RUN_TEST(test_apply_from_idle_is_illegal);
    RUN_TEST(test_connect_from_connected_is_illegal);
    RUN_TEST(test_write_config_from_playing_returns_configured);
    RUN_TEST(test_trigger_step_from_idle_is_illegal);
    RUN_TEST(test_reset_default_from_playing);
    RUN_TEST(test_reset_default_from_paused);
    RUN_TEST(test_reset_default_from_idle_is_self);
    RUN_TEST(test_state_machine_name);
    RUN_TEST(test_state_machine_is_legal_helper);
    RUN_TEST(test_force_bypasses_table);
    return UNITY_END();
}