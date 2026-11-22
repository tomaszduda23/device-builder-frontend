/** The nRF54L chips the CMSIS-DAP flasher writes, told apart by their part code. */
import type { HexSegment } from "../../../util/intel-hex.js";

/** One chip of the family: where its RRAM controller sits and how much RRAM it has. */
export interface Nrf54lChip {
  readonly name: string;
  /** FICR.INFO.PART values of the chip. */
  readonly parts: readonly number[];
  readonly rramcBase: number;
  readonly rramSize: number;
}

export const NRF54L_CHIPS: readonly Nrf54lChip[] = [
  {
    name: "nRF54LM20A",
    parts: [0x054bc20a],
    rramcBase: 0x5004e000,
    rramSize: 0x1fd000,
  },
  {
    name: "nRF54L15",
    parts: [0x00054b15],
    rramcBase: 0x5004b000,
    rramSize: 0x17d000,
  },
];

/** The chip whose FICR.INFO.PART reads ``part``, if the flasher knows it. */
export const nrf54lChipByPart = (part: number): Nrf54lChip | undefined =>
  NRF54L_CHIPS.find((c) => c.parts.includes(part >>> 0));

export const UICR_BASE = 0x00ffd000;
const UICR_SIZE = 0x1000;

/** The first segment that puts bytes outside the chip's RRAM and UICR, if any. */
export function outOfRange(
  chip: Nrf54lChip,
  segments: readonly HexSegment[]
): HexSegment | undefined {
  const inside = (start: number, end: number) =>
    (start >= 0 && end <= chip.rramSize) ||
    (start >= UICR_BASE && end <= UICR_BASE + UICR_SIZE);
  return segments.find((s) => !inside(s.address, s.address + s.data.length));
}
