// Pure-C protocol parser for bt-model-light (ADR-0003 / ADR-0005 / ADR-0006).
//
// Decodes the binary TLV frame:
//   [0xAA][len:u16le][cmd:u8][seq:u8][payload:len][crc16:u16le]
// Total frame = 7 + len bytes. CRC-16/CCITT covers header..payload.
//
// Hardware-free: only depends on <stdint.h>/<stddef.h> and protocol_gen.h.
// No Arduino, no FreeRTOS, no global state beyond the caller-owned
// parser_t. Safe to compile under PlatformIO native test target.
//
// Error codes reuse protocol_gen.h ERR_* values (ADR-0026 unified error
// table) rather than defining a parallel set. PARSE_INCOMPLETE and
// PARSE_NO_HEADER are parser-local statuses with no ERR_* equivalent.

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "protocol_gen.h"

#ifdef __cplusplus
extern "C" {
#endif

// Result codes returned by the parser. 0 == success. Non-zero values
// mirror protocol_gen.h ERR_* where a unified code exists.
typedef enum {
    PARSE_OK = 0,
    PARSE_INCOMPLETE = 1,             // need more bytes (half frame; parser-local)
    PARSE_INVALID_CRC = ERR_CRC_ERROR,            // 0x01
    PARSE_UNKNOWN_COMMAND = ERR_UNSUPPORTED_COMMAND, // 0x02
    PARSE_LEN_OVERFLOW = ERR_INVALID_PARAMETER,   // 0x04 (len > FRAME_LEN_MAX)
    PARSE_BUFFER_OVERFLOW = ERR_BUFFER_OVERFLOW,  // 0x06
    PARSE_NO_HEADER = ERR_INTERNAL_ERROR,         // 0x07 (no 0xAA found; parser-local)
} parse_result_t;

// A decoded frame. payload points into the parser's internal buffer and
// is valid until the next parser_feed()/parser_next() call on the same
// parser (caller must copy if it needs to outlive).
typedef struct {
    uint8_t  cmd;
    uint8_t  seq;
    uint16_t len;
    const uint8_t *payload;
} parsed_frame_t;

// Streaming reassembly buffer (caller-owned, zero-initialize or
// parser_init()).
#define PARSER_BUF_SIZE (FRAME_TOTAL_MAX + 1)

typedef struct {
    uint8_t  buf[PARSER_BUF_SIZE];
    uint16_t len;   // total bytes currently in the buffer
    uint16_t pos;   // read cursor (bytes [0..pos) have been consumed)
} parser_t;

// Initialize a parser to empty state.
void parser_init(parser_t *p);

// Feed bytes into the buffer. Appends at the end; compacts first if
// the cursor has advanced far enough that appending would overflow.
// Returns PARSE_OK or PARSE_BUFFER_OVERFLOW if the input still doesn't
// fit after compaction.
parse_result_t parser_feed(parser_t *p, const uint8_t *data, size_t n);

// Try to extract one frame from the buffered bytes.
//   PARSE_OK              -> out filled; read cursor advanced past frame
//   PARSE_INCOMPLETE      -> need more bytes (cursor unchanged)
//   PARSE_INVALID_CRC     -> frame discarded; cursor advanced past frame
//   PARSE_LEN_OVERFLOW    -> header dropped; cursor advanced by 1
//   PARSE_UNKNOWN_COMMAND -> frame discarded; cursor advanced past frame
//   PARSE_NO_HEADER       -> cursor advanced to last buffered byte
parse_result_t parser_next(parser_t *p, parsed_frame_t *out);

// One-shot: parse a complete frame from a single buffer. Does not
// require a parser_t. Returns PARSE_OK on success.
parse_result_t parser_parse_one(const uint8_t *data, size_t n,
                                parsed_frame_t *out);

// True if cmd is a known command code (in CMD_TABLE).
bool parser_cmd_known(uint8_t cmd);

// CRC-16/CCITT (also declared in protocol_gen.h).
uint16_t crc16_ccitt(const uint8_t *data, size_t len);

#ifdef __cplusplus
}
#endif