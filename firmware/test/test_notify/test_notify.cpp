// Unity tests for the notify frame builder (T6 / #26).
//
// Coverage:
//   - notify_build_version produces a valid STATUS_NOTIFY frame with
//     status=0x03, code=0, seq echoed, 4 version bytes.
//   - notify_build_status (OK/STATE/ERROR) produces 3-byte payloads.
//   - notify_build_frame wraps an arbitrary payload (READ_CONFIG shape).
//   - CRC is valid over the produced frame.
//   - The produced bytes parse back via parser_parse_one.

#include <unity.h>
#include "notify.h"
#include "protocol_parser.h"

#include <string.h>

extern "C" void setUp(void) {}
extern "C" void tearDown(void) {}

// Parse a frame and assert the cmd/seq/payload match.
static void assert_frame_ok(const uint8_t *frame, size_t len,
                            uint8_t want_cmd, uint8_t want_seq) {
    TEST_ASSERT_TRUE(len >= FRAME_OVERHEAD);
    TEST_ASSERT_EQUAL_UINT8(FRAME_HEADER_BYTE, frame[0]);
    uint16_t plen = (uint16_t)frame[1] | ((uint16_t)frame[2] << 8);
    TEST_ASSERT_EQUAL_UINT16(len - FRAME_OVERHEAD, plen);
    TEST_ASSERT_EQUAL_UINT8(want_cmd, frame[3]);
    TEST_ASSERT_EQUAL_UINT8(want_seq, frame[4]);
    // crc valid
    uint16_t want_crc = (uint16_t)frame[5 + plen] | ((uint16_t)frame[6 + plen] << 8);
    uint16_t got_crc = crc16_ccitt(frame, 5 + plen);
    TEST_ASSERT_EQUAL_UINT16(want_crc, got_crc);
}

void test_version_frame_shape(void) {
    uint8_t buf[FRAME_TOTAL_MAX];
    size_t n = notify_build_version(buf, sizeof(buf), 0x2A);
    TEST_ASSERT_TRUE(n > 0);
    assert_frame_ok(buf, n, CMD_STATUS_NOTIFY, 0x2A);
    // payload: [status=0x03, code=0, seq=0x2A, v1, v2, v3, v4]
    TEST_ASSERT_EQUAL_UINT8(NOTIFY_STATUS_VERSION, buf[5]);
    TEST_ASSERT_EQUAL_UINT8(0, buf[6]);
    TEST_ASSERT_EQUAL_UINT8(0x2A, buf[7]);
    TEST_ASSERT_EQUAL_UINT8(PROTOCOL_VERSION_MAJOR, buf[8]);
    TEST_ASSERT_EQUAL_UINT8(PROTOCOL_VERSION_MINOR, buf[9]);
    TEST_ASSERT_EQUAL_UINT8(FIRMWARE_VERSION_MAJOR, buf[10]);
    TEST_ASSERT_EQUAL_UINT8(FIRMWARE_VERSION_MINOR, buf[11]);
}

void test_status_ok_frame(void) {
    uint8_t buf[FRAME_TOTAL_MAX];
    size_t n = notify_build_status(buf, sizeof(buf),
                                   NOTIFY_STATUS_OK, CMD_APPLY, 0x07);
    TEST_ASSERT_TRUE(n > 0);
    assert_frame_ok(buf, n, CMD_STATUS_NOTIFY, 0x07);
    TEST_ASSERT_EQUAL_UINT8(NOTIFY_STATUS_OK, buf[5]);
    TEST_ASSERT_EQUAL_UINT8(CMD_APPLY, buf[6]);
    TEST_ASSERT_EQUAL_UINT8(0x07, buf[7]);
}

void test_status_state_frame(void) {
    uint8_t buf[FRAME_TOTAL_MAX];
    size_t n = notify_build_status(buf, sizeof(buf),
                                   NOTIFY_STATUS_STATE, 3 /* PLAYING */, 0);
    TEST_ASSERT_TRUE(n > 0);
    assert_frame_ok(buf, n, CMD_STATUS_NOTIFY, 0);
    TEST_ASSERT_EQUAL_UINT8(NOTIFY_STATUS_STATE, buf[5]);
    TEST_ASSERT_EQUAL_UINT8(3, buf[6]);
}

void test_status_error_frame(void) {
    uint8_t buf[FRAME_TOTAL_MAX];
    size_t n = notify_build_status(buf, sizeof(buf),
                                   NOTIFY_STATUS_ERROR, ERR_INVALID_STATE, 0x11);
    TEST_ASSERT_TRUE(n > 0);
    assert_frame_ok(buf, n, CMD_STATUS_NOTIFY, 0x11);
    TEST_ASSERT_EQUAL_UINT8(NOTIFY_STATUS_ERROR, buf[5]);
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_STATE, buf[6]);
}

void test_generic_frame_read_config(void) {
    uint8_t payload[8] = {0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04};
    uint8_t buf[FRAME_TOTAL_MAX];
    size_t n = notify_build_frame(buf, sizeof(buf), CMD_READ_CONFIG, 0x05,
                                  payload, sizeof(payload));
    TEST_ASSERT_TRUE(n > 0);
    assert_frame_ok(buf, n, CMD_READ_CONFIG, 0x05);
    // payload echoed
    TEST_ASSERT_EQUAL_UINT8_ARRAY(payload, buf + 5, sizeof(payload));
}

void test_roundtrip_through_parser(void) {
    uint8_t buf[FRAME_TOTAL_MAX];
    size_t n = notify_build_version(buf, sizeof(buf), 0x99);
    TEST_ASSERT_TRUE(n > 0);
    parsed_frame_t fr;
    parse_result_t rc = parser_parse_one(buf, n, &fr);
    TEST_ASSERT_EQUAL(parse_result_t(PARSE_OK), rc);
    TEST_ASSERT_EQUAL_UINT8(CMD_STATUS_NOTIFY, fr.cmd);
    TEST_ASSERT_EQUAL_UINT8(0x99, fr.seq);
    TEST_ASSERT_EQUAL_UINT8(7, fr.len);
}

void test_cap_enforcement(void) {
    uint8_t buf[4]; // too small
    size_t n = notify_build_status(buf, sizeof(buf),
                                   NOTIFY_STATUS_OK, 0, 0);
    TEST_ASSERT_EQUAL_size_t(0, n);
}

int main(int argc, char **argv) {
    UNITY_BEGIN();
    RUN_TEST(test_version_frame_shape);
    RUN_TEST(test_status_ok_frame);
    RUN_TEST(test_status_state_frame);
    RUN_TEST(test_status_error_frame);
    RUN_TEST(test_generic_frame_read_config);
    RUN_TEST(test_roundtrip_through_parser);
    RUN_TEST(test_cap_enforcement);
    return UNITY_END();
}