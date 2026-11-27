// Unity tests for the pure OTA session logic (ADR-0034).
// No Arduino / no flash: only ota_protocol.c is under test.

#include <unity.h>

#include "ota_protocol.h"

static void put_u32le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

// Build a BEGIN payload: [1][total][crc][maj][min]
static size_t make_begin(uint8_t *out, uint32_t total, uint32_t crc,
                          uint8_t maj, uint8_t min) {
    out[0] = OTA_SUB_BEGIN;
    put_u32le(out + 1, total);
    put_u32le(out + 5, crc);
    out[9] = maj;
    out[10] = min;
    return 11;
}

// ---- CRC-32 ---------------------------------------------------------------

// Known vectors: "123456789" -> 0xCBF43926 (IEEE 802.3).
static void test_crc32_known_vector(void) {
    const uint8_t data[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
    TEST_ASSERT_EQUAL_HEX32(0xCBF43926u, ota_crc32_buf(data, sizeof(data)));
}

static void test_crc32_empty(void) {
    TEST_ASSERT_EQUAL_HEX32(0x00000000u, ota_crc32_buf(NULL, 0));
}

// Chained chunks must equal the CRC of the concatenation (this is what
// DATA does: accumulate block by block).
static void test_crc32_chained_equals_whole(void) {
    const uint8_t whole[] = "bt-model-light firmware";
    const size_t n = sizeof(whole) - 1; // drop NUL
    const size_t split = 8;
    uint32_t chained = ota_crc32(0, whole, split);
    chained = ota_crc32(chained, whole + split, n - split);
    TEST_ASSERT_EQUAL_HEX32(ota_crc32_buf(whole, n), chained);
}

// ---- BEGIN ----------------------------------------------------------------

static void test_begin_accepts_valid(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 1000, 0xDEADBEEFu, 0, 4);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
    TEST_ASSERT_TRUE(ota_protocol_busy(&s));
    TEST_ASSERT_EQUAL_UINT32(1000, s.total);
    TEST_ASSERT_EQUAL_UINT32(0xDEADBEEFu, s.crc32);
    TEST_ASSERT_EQUAL_UINT8(0, s.version_major);
    TEST_ASSERT_EQUAL_UINT8(4, s.version_minor);
}

static void test_begin_rejects_bad_len(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 1000, 1, 0, 4);
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, ota_protocol_begin(&s, p, n - 1));
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, ota_protocol_begin(&s, p, n + 1));
}

static void test_begin_rejects_wrong_sub(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 1000, 1, 0, 4);
    p[0] = OTA_SUB_DATA;
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, ota_protocol_begin(&s, p, n));
}

static void test_begin_rejects_zero_and_oversize(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 0, 1, 0, 4);
    TEST_ASSERT_EQUAL_UINT8(ERR_CONFIG_LIMIT_EXCEEDED, ota_protocol_begin(&s, p, n));

    ota_protocol_init(&s);
    n = make_begin(p, 0x1E0001u, 1, 0, 4); // 1 byte over ota_0
    TEST_ASSERT_EQUAL_UINT8(ERR_CONFIG_LIMIT_EXCEEDED, ota_protocol_begin(&s, p, n));

    ota_protocol_init(&s);
    n = make_begin(p, 0x1E0000u, 1, 0, 4); // exactly the partition size
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
}

static void test_begin_rejects_while_receiving(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 1000, 1, 0, 4);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_STATE, ota_protocol_begin(&s, p, n));
}

// ---- DATA -----------------------------------------------------------------

// Helper: feed `blob` as sequential DATA chunks of `chunk` bytes.
static uint8_t feed(const ota_session_t *unused, ota_session_t *s,
                       const uint8_t *blob, size_t n, size_t chunk) {
    (void)unused;
    uint8_t p[64];
    for (size_t off = 0; off < n; off += chunk) {
        size_t take = (n - off < chunk) ? (n - off) : chunk;
        p[0] = OTA_SUB_DATA;
        put_u32le(p + 1, (uint32_t)off);
        for (size_t i = 0; i < take; i++) p[5 + i] = blob[off + i];
        uint8_t rc = ota_protocol_data(s, p, 5 + take);
        if (rc) return rc;
    }
    return 0;
}

static void test_data_sequential_ok(void) {
    ota_session_t s;
    uint8_t blob[100];
    for (size_t i = 0; i < sizeof(blob); i++) blob[i] = (uint8_t)i;
    uint8_t p[16];
    size_t n = make_begin(p, sizeof(blob), ota_crc32_buf(blob, sizeof(blob)), 0, 4);
    ota_protocol_init(&s);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
    TEST_ASSERT_EQUAL_UINT8(0, feed(NULL, &s, blob, sizeof(blob), 16));
    TEST_ASSERT_EQUAL_UINT32(sizeof(blob), s.received);
}

static void test_data_rejects_out_of_order(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 100, 0, 0, 4);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));

    uint8_t d[8] = {OTA_SUB_DATA, 0, 0, 0, 0, 1, 2, 3}; // offset 0, 3 bytes
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_data(&s, d, sizeof(d)));

    // Same block again (duplicate) and a skipped block both fail.
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, ota_protocol_data(&s, d, sizeof(d)));
    put_u32le(d + 1, 12);
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, ota_protocol_data(&s, d, sizeof(d)));
}

static void test_data_rejects_overflow_of_total(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 4, 0, 0, 4);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));

    uint8_t d[10] = {OTA_SUB_DATA, 0, 0, 0, 0, 1, 2, 3, 4, 5}; // 5 bytes > total 4
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, ota_protocol_data(&s, d, sizeof(d)));
    TEST_ASSERT_EQUAL_UINT32(0, s.received); // nothing accepted
}

static void test_data_requires_session(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t d[8] = {OTA_SUB_DATA, 0, 0, 0, 0, 1, 2, 3};
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_STATE, ota_protocol_data(&s, d, sizeof(d)));
}

static void test_data_rejects_short_payload(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 10, 0, 0, 4);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
    uint8_t d[4] = {OTA_SUB_DATA, 0, 0, 0}; // offset only, 4 < 5
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, ota_protocol_data(&s, d, sizeof(d)));
}

// ---- END ------------------------------------------------------------------

static void test_end_happy_path(void) {
    ota_session_t s;
    uint8_t blob[64];
    for (size_t i = 0; i < sizeof(blob); i++) blob[i] = (uint8_t)(i * 3);
    uint8_t p[16];
    size_t n = make_begin(p, sizeof(blob), ota_crc32_buf(blob, sizeof(blob)), 0, 4);
    ota_protocol_init(&s);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
    TEST_ASSERT_EQUAL_UINT8(0, feed(NULL, &s, blob, sizeof(blob), 20));
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_end(&s));
    TEST_ASSERT_EQUAL(OTA_STATE_DONE, s.state);
    TEST_ASSERT_FALSE(ota_protocol_busy(&s));
}

static void test_end_rejects_crc_mismatch(void) {
    ota_session_t s;
    uint8_t blob[32] = {1, 2, 3};
    uint8_t p[16];
    size_t n = make_begin(p, sizeof(blob), 0x12345678u, 0, 4); // wrong CRC
    ota_protocol_init(&s);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
    TEST_ASSERT_EQUAL_UINT8(0, feed(NULL, &s, blob, sizeof(blob), 8));
    TEST_ASSERT_EQUAL_UINT8(ERR_CRC_ERROR, ota_protocol_end(&s));
    TEST_ASSERT_TRUE(ota_protocol_busy(&s)); // still receiving: caller can ABORT
}

static void test_end_rejects_incomplete(void) {
    ota_session_t s;
    uint8_t blob[8] = {0};
    uint8_t p[16];
    size_t n = make_begin(p, 16, 0, 0, 4);
    ota_protocol_init(&s);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
    TEST_ASSERT_EQUAL_UINT8(0, feed(NULL, &s, blob, sizeof(blob), 8)); // only 8/16
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_PARAMETER, ota_protocol_end(&s));
}

static void test_end_requires_session(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    TEST_ASSERT_EQUAL_UINT8(ERR_INVALID_STATE, ota_protocol_end(&s));
}

// ---- ABORT ----------------------------------------------------------------

static void test_init_aborts_session(void) {
    ota_session_t s;
    ota_protocol_init(&s);
    uint8_t p[16];
    size_t n = make_begin(p, 100, 7, 0, 4);
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
    ota_protocol_init(&s); // ABORT path
    TEST_ASSERT_EQUAL(OTA_STATE_IDLE, s.state);
    TEST_ASSERT_EQUAL_UINT32(0, s.received);
    TEST_ASSERT_FALSE(ota_protocol_busy(&s));

    // A fresh BEGIN is accepted after abort.
    TEST_ASSERT_EQUAL_UINT8(0, ota_protocol_begin(&s, p, n));
}

void setUp(void) {}
void tearDown(void) {}

int main(int, char **) {
    UNITY_BEGIN();
    RUN_TEST(test_crc32_known_vector);
    RUN_TEST(test_crc32_empty);
    RUN_TEST(test_crc32_chained_equals_whole);
    RUN_TEST(test_begin_accepts_valid);
    RUN_TEST(test_begin_rejects_bad_len);
    RUN_TEST(test_begin_rejects_wrong_sub);
    RUN_TEST(test_begin_rejects_zero_and_oversize);
    RUN_TEST(test_begin_rejects_while_receiving);
    RUN_TEST(test_data_sequential_ok);
    RUN_TEST(test_data_rejects_out_of_order);
    RUN_TEST(test_data_rejects_overflow_of_total);
    RUN_TEST(test_data_requires_session);
    RUN_TEST(test_data_rejects_short_payload);
    RUN_TEST(test_end_happy_path);
    RUN_TEST(test_end_rejects_crc_mismatch);
    RUN_TEST(test_end_rejects_incomplete);
    RUN_TEST(test_end_requires_session);
    RUN_TEST(test_init_aborts_session);
    return UNITY_END();
}
