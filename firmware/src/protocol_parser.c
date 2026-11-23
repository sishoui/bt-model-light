// Pure-C protocol parser implementation (ADR-0003 / ADR-0006).
//
// No Arduino/FreeRTOS includes. Compiles under:
//   - PlatformIO esp32-c3-devkitm-1 (for firmware)
//   - PlatformIO native (for Unity tests)
//
// Reassembly strategy (ADR-0006): the parser keeps a read cursor `pos`
// into the append-only byte buffer `buf[0..len)`. parser_feed() appends
// at the end and compacts when the cursor has advanced past the first
// half of the buffer. parser_next() scans from `pos` for a 0xAA header,
// reads len/cmd/seq/payload/crc, and on success advances `pos` by the
// full frame length. The returned payload pointer points into `buf` and
// remains valid until the next parser_feed() or parser_next() call on
// the same parser. This avoids the slide-overwrite bug that a naive
// drop-in-place reassembly has when a payload-bearing frame is followed
// by trailing bytes.

#include "protocol_parser.h"

// ---------------------------------------------------------------------------
// CRC-16/CCITT (polynomial 0x1021, init 0xFFFF, MSB-first, no final xor)
// Defined here; declared in protocol_gen.h (codegen). See frame-spec.md.
// ---------------------------------------------------------------------------
uint16_t crc16_ccitt(const uint8_t *data, size_t len) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
                                 : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static bool cmd_is_known(uint8_t cmd) {
    for (uint32_t i = 0; i < CMD_COUNT; i++) {
        if (CMD_TABLE[i].code == cmd) return true;
    }
    return false;
}

bool parser_cmd_known(uint8_t cmd) {
    return cmd_is_known(cmd);
}

// Compact the buffer: slide bytes [pos..len) to the front and reset pos.
// Called when the cursor has advanced far enough that the free space at
// the end of the buffer is running low, or whenever parser_feed needs
// room. This is the only place the buffer is "shifted", and it only
// happens between parser_next/parser_feed calls, never while a returned
// payload pointer is still in use by the caller (the caller's next
// parser_next/parser_feed call invalidates the pointer anyway).
static void parser_compact(parser_t *p) {
    if (p->pos == 0) return;
    uint16_t remain = p->len - p->pos;
    for (uint16_t i = 0; i < remain; i++) {
        p->buf[i] = p->buf[i + p->pos];
    }
    p->len = remain;
    p->pos = 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void parser_init(parser_t *p) {
    p->len = 0;
    p->pos = 0;
}

parse_result_t parser_feed(parser_t *p, const uint8_t *data, size_t n) {
    // Make room: if appending would overflow, compact first.
    if (p->len + n > PARSER_BUF_SIZE) {
        parser_compact(p);
    }
    if (p->len + n > PARSER_BUF_SIZE) {
        return PARSE_BUFFER_OVERFLOW;
    }
    for (size_t i = 0; i < n; i++) {
        p->buf[p->len++] = data[i];
    }
    return PARSE_OK;
}

parse_result_t parser_next(parser_t *p, parsed_frame_t *out) {
    // Step 1: find the header byte 0xAA starting at pos.
    uint16_t header_pos = p->pos;
    while (header_pos < p->len && p->buf[header_pos] != FRAME_HEADER_BYTE) {
        header_pos++;
    }
    if (header_pos >= p->len) {
        // No header in [pos, len). Keep a trailing 0xAA (if any) as a
        // candidate frame start for the next feed; drop everything else.
        // Never move the cursor backward — it may already be at len.
        if (p->len > p->pos && p->buf[p->len - 1] == FRAME_HEADER_BYTE) {
            p->pos = p->len - 1;
        } else {
            p->pos = p->len;
        }
        return PARSE_NO_HEADER;
    }
    p->pos = header_pos;

    // Need at least 3 bytes (header + 2-byte len) to read the length.
    if (p->pos + 3 > p->len) {
        return PARSE_INCOMPLETE;
    }

    uint16_t payload_len = (uint16_t)p->buf[p->pos + 1]
                         | ((uint16_t)p->buf[p->pos + 2] << 8);

    // Per frame-spec.md: len cap is FRAME_LEN_MAX (1500). ADR-0006's
    // 1024 was superseded by frame-spec.md's 1500 budget (800 LEDs per
    // frame). Anything above FRAME_LEN_MAX is invalid.
    if (payload_len > FRAME_LEN_MAX) {
        // Drop this candidate header (1 byte) and retry.
        p->pos++;
        return PARSE_LEN_OVERFLOW;
    }

    // Total frame size = header(1) + len(2) + cmd(1) + seq(1)
    //                  + payload + crc16(2) = 7 + payload_len.
    uint16_t total = (uint16_t)(FRAME_OVERHEAD + payload_len);

    if (p->pos + total > p->len) {
        return PARSE_INCOMPLETE;
    }

    // Bytes layout in p->buf (relative to p->pos):
    //   0          : 0xAA
    //   1..2       : len (LE)
    //   3          : cmd
    //   4          : seq
    //   5..5+len-1 : payload
    //   5+len..5+len+1 : crc16 (LE)
    uint8_t cmd = p->buf[p->pos + 3];
    uint8_t seq = p->buf[p->pos + 4];
    const uint8_t *payload_ptr = &p->buf[p->pos + 5];

    // CRC covers header..payload (i.e. first 5 + len bytes).
    uint16_t crc_hi_lo = (uint16_t)p->buf[p->pos + 5 + payload_len]
                       | ((uint16_t)p->buf[p->pos + 6 + payload_len] << 8);
    uint16_t crc_calc = crc16_ccitt(&p->buf[p->pos],
                                    (size_t)(5 + payload_len));

    // Consume the frame: advance the read cursor by total. The buffer
    // itself is not shifted; compaction happens lazily in parser_feed.
    uint16_t frame_start_pos = p->pos;
    p->pos += total;

    if (crc_calc != crc_hi_lo) {
        return PARSE_INVALID_CRC;
    }
    if (!cmd_is_known(cmd)) {
        return PARSE_UNKNOWN_COMMAND;
    }

    if (out) {
        out->cmd = cmd;
        out->seq = seq;
        out->len = payload_len;
        // Payload pointer is into the parser's buffer; valid until the
        // next parser_feed() or parser_next() call compacts it.
        out->payload = payload_ptr;
    }
    (void)frame_start_pos;
    return PARSE_OK;
}

parse_result_t parser_parse_one(const uint8_t *data, size_t n,
                                parsed_frame_t *out) {
    if (n < (size_t)FRAME_OVERHEAD) {
        return PARSE_INCOMPLETE;
    }
    if (data[0] != FRAME_HEADER_BYTE) {
        return PARSE_NO_HEADER;
    }
    uint16_t payload_len = (uint16_t)data[1] | ((uint16_t)data[2] << 8);
    if (payload_len > FRAME_LEN_MAX) {
        return PARSE_LEN_OVERFLOW;
    }
    size_t total = (size_t)FRAME_OVERHEAD + payload_len;
    if (n < total) {
        return PARSE_INCOMPLETE;
    }

    uint8_t cmd = data[3];
    uint8_t seq = data[4];
    const uint8_t *payload_ptr = &data[5];

    uint16_t crc_hi_lo = (uint16_t)data[5 + payload_len]
                       | ((uint16_t)data[6 + payload_len] << 8);
    uint16_t crc_calc = crc16_ccitt(data, (size_t)(5 + payload_len));
    if (crc_calc != crc_hi_lo) {
        return PARSE_INVALID_CRC;
    }
    if (!cmd_is_known(cmd)) {
        return PARSE_UNKNOWN_COMMAND;
    }

    if (out) {
        out->cmd = cmd;
        out->seq = seq;
        out->len = payload_len;
        out->payload = payload_ptr;
    }
    return PARSE_OK;
}