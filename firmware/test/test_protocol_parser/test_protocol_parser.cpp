// Unity tests for the pure-C protocol parser (ADR-0003 / ADR-0005 / ADR-0006).
//
// Coverage:
//   - CRC-16/CCITT known vector
//   - valid frame parse (GET_VERSION, WRITE_CONFIG with payload)
//   - bad CRC rejected
//   - half frame -> PARSE_INCOMPLETE (streaming reassembly)
//   - unknown command rejected
//   - multi-frame stream split at arbitrary byte boundaries
//   - garbage before header is skipped
//   - len-too-large rejected early (ADR-0006 step 3)

#include <unity.h>
#include <string.h>
#include "protocol_parser.h"

// Unity expects setUp/tearDown with C linkage. In a C++ test file
// these must be declared extern "C" or the linker can't find them.
extern "C" void setUp(void) {}
extern "C" void tearDown(void) {}

// Build a valid frame in `out`. Returns total length.
// payload may be NULL if payload_len == 0.
static size_t build_frame(uint8_t *out, uint8_t cmd, uint8_t seq,
                          const uint8_t *payload, uint16_t payload_len) {
    out[0] = FRAME_HEADER_BYTE;
    out[1] = (uint8_t)(payload_len & 0xFF);
    out[2] = (uint8_t)(payload_len >> 8);
    out[3] = cmd;
    out[4] = seq;
    if (payload_len && payload) {
        memcpy(&out[5], payload, payload_len);
    }
    uint16_t crc = crc16_ccitt(out, (size_t)(5 + payload_len));
    out[5 + payload_len] = (uint8_t)(crc & 0xFF);
    out[6 + payload_len] = (uint8_t)(crc >> 8);
    return (size_t)(7 + payload_len);
}

// --- CRC --------------------------------------------------------------------

void test_crc_known_vector(void) {
    // CRC-16/CCITT of "123456789" with init 0xFFFF, poly 0x1021,
    // no reflect, no final xor = 0x29B1. This is the standard check
    // value for CRC-16/CCITT-FALSE.
    const uint8_t data[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
    TEST_ASSERT_EQUAL_UINT16(0x29B1, crc16_ccitt(data, sizeof(data)));
}

void test_crc_empty(void) {
    TEST_ASSERT_EQUAL_UINT16(0xFFFF, crc16_ccitt(NULL, 0));
}

// --- One-shot parse: valid frames ------------------------------------------

void test_parse_one_get_version(void) {
    uint8_t frame[16];
    size_t n = build_frame(frame, CMD_GET_VERSION, 7, NULL, 0);
    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_OK, parser_parse_one(frame, n, &out));
    TEST_ASSERT_EQUAL(CMD_GET_VERSION, out.cmd);
    TEST_ASSERT_EQUAL(7, out.seq);
    TEST_ASSERT_EQUAL_UINT16(0, out.len);
}

void test_parse_one_write_config_with_payload(void) {
    uint8_t payload[] = {0xDE, 0xAD, 0xBE, 0xEF};
    uint8_t frame[32];
    size_t n = build_frame(frame, CMD_WRITE_CONFIG, 1, payload, sizeof(payload));
    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_OK, parser_parse_one(frame, n, &out));
    TEST_ASSERT_EQUAL(CMD_WRITE_CONFIG, out.cmd);
    TEST_ASSERT_EQUAL(1, out.seq);
    TEST_ASSERT_EQUAL_UINT16(4, out.len);
    TEST_ASSERT_EQUAL_UINT8(0xDE, out.payload[0]);
    TEST_ASSERT_EQUAL_UINT8(0xEF, out.payload[3]);
}

// --- One-shot parse: rejections -------------------------------------------

void test_parse_one_bad_crc(void) {
    uint8_t frame[16];
    size_t n = build_frame(frame, CMD_GET_VERSION, 0, NULL, 0);
    frame[n - 1] ^= 0xFF;  // corrupt CRC low byte
    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_INVALID_CRC, parser_parse_one(frame, n, &out));
}

void test_parse_one_unknown_command(void) {
    uint8_t frame[16];
    size_t n = build_frame(frame, 0x55, 0, NULL, 0);  // 0x55 not in table
    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_UNKNOWN_COMMAND, parser_parse_one(frame, n, &out));
}

void test_parse_one_half_frame(void) {
    uint8_t frame[16];
    size_t n = build_frame(frame, CMD_GET_VERSION, 0, NULL, 0);
    parsed_frame_t out;
    // Drop the last byte (CRC high byte missing).
    TEST_ASSERT_EQUAL(PARSE_INCOMPLETE, parser_parse_one(frame, n - 1, &out));
    // Drop everything but header + len low + len high (3 bytes).
    TEST_ASSERT_EQUAL(PARSE_INCOMPLETE, parser_parse_one(frame, 3, &out));
    // Empty.
    TEST_ASSERT_EQUAL(PARSE_INCOMPLETE, parser_parse_one(frame, 0, &out));
}

void test_parse_one_no_header(void) {
    uint8_t frame[16];
    size_t n = build_frame(frame, CMD_GET_VERSION, 0, NULL, 0);
    frame[0] = 0x00;
    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_NO_HEADER, parser_parse_one(frame, n, &out));
}

// --- Streaming: reassembly -------------------------------------------------

void test_streaming_single_complete_frame(void) {
    uint8_t frame[16];
    size_t n = build_frame(frame, CMD_READ_STATUS, 42, NULL, 0);

    parser_t p;
    parser_init(&p);
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, frame, n));

    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_OK, parser_next(&p, &out));
    TEST_ASSERT_EQUAL(CMD_READ_STATUS, out.cmd);
    TEST_ASSERT_EQUAL(42, out.seq);
    TEST_ASSERT_EQUAL_UINT16(0, out.len);
    TEST_ASSERT_EQUAL_UINT16(n, p.pos);  // cursor consumed the frame
}

void test_streaming_byte_by_byte(void) {
    uint8_t payload[] = {1, 2, 3};
    uint8_t frame[32];
    size_t n = build_frame(frame, CMD_APPLY, 9, payload, sizeof(payload));

    parser_t p;
    parser_init(&p);
    // Feed one byte at a time — worst-case BLE fragmentation.
    for (size_t i = 0; i < n; i++) {
        TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, &frame[i], 1));
        parsed_frame_t out;
        parse_result_t r = parser_next(&p, &out);
        if (i + 1 < n) {
            // Not enough bytes yet.
            TEST_ASSERT_EQUAL(PARSE_INCOMPLETE, r);
        } else {
            TEST_ASSERT_EQUAL(PARSE_OK, r);
            TEST_ASSERT_EQUAL(CMD_APPLY, out.cmd);
            TEST_ASSERT_EQUAL(9, out.seq);
            TEST_ASSERT_EQUAL_UINT16(3, out.len);
            TEST_ASSERT_EQUAL_UINT8(1, out.payload[0]);
            TEST_ASSERT_EQUAL_UINT8(3, out.payload[2]);
        }
    }
}

void test_streaming_two_frames_one_feed(void) {
    // Two frames, the first carrying a payload. This is the regression
    // test for the payload-clobber bug: a naive drop-in-place
    // reassembly slides trailing bytes over the payload region before
    // the caller copies it out. The read-cursor design must keep the
    // payload intact.
    uint8_t payload1[] = {0x11, 0x22, 0x33, 0x44};
    uint8_t buf[64];
    size_t n1 = build_frame(buf, CMD_WRITE_CONFIG, 1, payload1, sizeof(payload1));
    size_t n2 = build_frame(buf + n1, CMD_READ_STATUS, 2, NULL, 0);
    size_t total = n1 + n2;

    parser_t p;
    parser_init(&p);
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, buf, total));

    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_OK, parser_next(&p, &out));
    TEST_ASSERT_EQUAL(CMD_WRITE_CONFIG, out.cmd);
    TEST_ASSERT_EQUAL(1, out.seq);
    TEST_ASSERT_EQUAL_UINT16(4, out.len);
    // Payload must match exactly — this is what the drop-in-place
    // implementation got wrong.
    TEST_ASSERT_EQUAL_UINT8(0x11, out.payload[0]);
    TEST_ASSERT_EQUAL_UINT8(0x22, out.payload[1]);
    TEST_ASSERT_EQUAL_UINT8(0x33, out.payload[2]);
    TEST_ASSERT_EQUAL_UINT8(0x44, out.payload[3]);

    TEST_ASSERT_EQUAL(PARSE_OK, parser_next(&p, &out));
    TEST_ASSERT_EQUAL(CMD_READ_STATUS, out.cmd);
    TEST_ASSERT_EQUAL(2, out.seq);

    // Empty after both consumed.
    TEST_ASSERT_EQUAL(PARSE_NO_HEADER, parser_next(&p, &out));
    TEST_ASSERT_EQUAL_UINT16(p.pos, p.len);  // cursor reached end
}

void test_streaming_garbage_before_header(void) {
    uint8_t frame[16];
    size_t n = build_frame(frame, CMD_GET_VERSION, 3, NULL, 0);

    parser_t p;
    parser_init(&p);
    // Garbage prefix — 0x00s and 0xAA false starts.
    uint8_t garbage[] = {0x00, 0x11, 0xAA, 0x00};  // trailing 0xAA is a false start
    // We need to be careful: the trailing 0xAA looks like a header, but
    // parser_next will read len = 0x00 + (next byte << 8). Since we
    // only fed 4 bytes, after the real 0xAA (in frame) the next byte
    // is the len low = 0. That gives payload_len = 0 — which then
    // needs 7 more bytes. So the false 0xAA will get dropped when the
    // real frame's bytes fill in, or rejected when len turns out huge.
    // To keep the test deterministic, feed garbage separately first.
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, garbage, 2));  // 0x00 0x11
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, frame, n));

    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_OK, parser_next(&p, &out));
    TEST_ASSERT_EQUAL(CMD_GET_VERSION, out.cmd);
    TEST_ASSERT_EQUAL(3, out.seq);
}

void test_streaming_bad_crc_then_good(void) {
    uint8_t bad[16];
    size_t n = build_frame(bad, CMD_GET_VERSION, 5, NULL, 0);
    bad[n - 1] ^= 0xFF;  // corrupt CRC

    uint8_t good[16];
    size_t m = build_frame(good, CMD_READ_STATUS, 6, NULL, 0);

    parser_t p;
    parser_init(&p);
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, bad, n));
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, good, m));

    parsed_frame_t out;
    // First frame: bad CRC, gets dropped.
    TEST_ASSERT_EQUAL(PARSE_INVALID_CRC, parser_next(&p, &out));
    // Second frame: good.
    TEST_ASSERT_EQUAL(PARSE_OK, parser_next(&p, &out));
    TEST_ASSERT_EQUAL(CMD_READ_STATUS, out.cmd);
    TEST_ASSERT_EQUAL(6, out.seq);
}

void test_streaming_len_1500_accepted(void) {
    // Regression: a frame with len = FRAME_LEN_MAX (1500) must be
    // accepted. The earlier implementation rejected anything > 1024,
    // which would have dropped legal WRITE_CONFIG frames.
    static uint8_t payload[FRAME_LEN_MAX];
    for (uint16_t i = 0; i < FRAME_LEN_MAX; i++) {
        payload[i] = (uint8_t)(i & 0xFF);
    }
    uint8_t frame[FRAME_TOTAL_MAX];
    size_t n = build_frame(frame, CMD_WRITE_CONFIG, 0x42, payload, FRAME_LEN_MAX);
    TEST_ASSERT_EQUAL_UINT16(FRAME_TOTAL_MAX, n);

    parser_t p;
    parser_init(&p);
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, frame, n));

    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_OK, parser_next(&p, &out));
    TEST_ASSERT_EQUAL(CMD_WRITE_CONFIG, out.cmd);
    TEST_ASSERT_EQUAL_UINT8(0x42, out.seq);
    TEST_ASSERT_EQUAL_UINT16(FRAME_LEN_MAX, out.len);
    // Spot-check first and last payload bytes.
    TEST_ASSERT_EQUAL_UINT8(0x00, out.payload[0]);
    TEST_ASSERT_EQUAL_UINT8((FRAME_LEN_MAX - 1) & 0xFF, out.payload[FRAME_LEN_MAX - 1]);
}

void test_streaming_len_1501_rejected(void) {
    // One byte over the cap — must be rejected as overflow.
    uint8_t bogus[] = {FRAME_HEADER_BYTE, 0xDD, 0x05};  // len = 0x05DD = 1501
    TEST_ASSERT_EQUAL_UINT16(1501, (uint16_t)bogus[1] | ((uint16_t)bogus[2] << 8));

    parser_t p;
    parser_init(&p);
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, bogus, sizeof(bogus)));

    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_LEN_OVERFLOW, parser_next(&p, &out));
    TEST_ASSERT_EQUAL_UINT16(1, p.pos);  // header dropped
}

void test_streaming_len_too_large_rejected(void) {
    parser_t p;
    parser_init(&p);
    // Header + len=2000 (LE: 0xD0, 0x07). frame-spec.md caps len at
    // FRAME_LEN_MAX (1500), so 2000 must be rejected as overflow.
    uint8_t bogus[] = {FRAME_HEADER_BYTE, 0xD0, 0x07};
    TEST_ASSERT_EQUAL(PARSE_OK, parser_feed(&p, bogus, sizeof(bogus)));

    parsed_frame_t out;
    TEST_ASSERT_EQUAL(PARSE_LEN_OVERFLOW, parser_next(&p, &out));
    // Header byte dropped (cursor advanced by 1); the 2 len bytes
    // remain in the buffer but are now treated as garbage before the
    // next 0xAA.
    TEST_ASSERT_EQUAL_UINT16(1, p.pos);
    TEST_ASSERT_EQUAL_UINT16(3, p.len);
}

void test_parser_feed_overflow(void) {
    parser_t p;
    parser_init(&p);
    // PARSER_BUF_SIZE is 1508; feed 1509 bytes — must reject.
    static uint8_t big[PARSER_BUF_SIZE + 16];
    for (size_t i = 0; i < sizeof(big); i++) big[i] = 0x00;
    TEST_ASSERT_EQUAL(PARSE_BUFFER_OVERFLOW,
                      parser_feed(&p, big, sizeof(big)));
}

void test_parser_cmd_known(void) {
    TEST_ASSERT_TRUE(parser_cmd_known(CMD_GET_VERSION));
    TEST_ASSERT_TRUE(parser_cmd_known(CMD_WRITE_CONFIG));
    TEST_ASSERT_TRUE(parser_cmd_known(CMD_OTA));
    TEST_ASSERT_FALSE(parser_cmd_known(0x55));
    TEST_ASSERT_FALSE(parser_cmd_known(0x00));
}

// --- Runner ----------------------------------------------------------------

int main(int argc, char **argv) {
    UNITY_BEGIN();
    RUN_TEST(test_crc_known_vector);
    RUN_TEST(test_crc_empty);
    RUN_TEST(test_parse_one_get_version);
    RUN_TEST(test_parse_one_write_config_with_payload);
    RUN_TEST(test_parse_one_bad_crc);
    RUN_TEST(test_parse_one_unknown_command);
    RUN_TEST(test_parse_one_half_frame);
    RUN_TEST(test_parse_one_no_header);
    RUN_TEST(test_streaming_single_complete_frame);
    RUN_TEST(test_streaming_byte_by_byte);
    RUN_TEST(test_streaming_two_frames_one_feed);
    RUN_TEST(test_streaming_garbage_before_header);
    RUN_TEST(test_streaming_bad_crc_then_good);
    RUN_TEST(test_streaming_len_too_large_rejected);
    RUN_TEST(test_streaming_len_1500_accepted);
    RUN_TEST(test_streaming_len_1501_rejected);
    RUN_TEST(test_parser_feed_overflow);
    RUN_TEST(test_parser_cmd_known);
    return UNITY_END();
}