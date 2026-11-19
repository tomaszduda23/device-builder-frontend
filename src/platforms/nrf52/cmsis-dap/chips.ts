/** The nRF54L chips the CMSIS-DAP flasher writes, by the device's ``mcu``. */
import type { HexSegment } from "../../../util/intel-hex.js";

/** One chip of the family: where its RRAM controller sits and how much RRAM it has. */
export interface Nrf54lChip {
  readonly name: string;
  /** FICR.INFO.PART values of the chip. */
  readonly parts: readonly number[];
  readonly rramcBase: number;
  readonly rramSize: number;
}

export const NRF54L_CHIPS = {
  nrf54lm20a: {
    name: "nRF54LM20A",
    parts: [0x054bc20a],
    rramcBase: 0x5004e000,
    rramSize: 0x1fd000,
  },
} as const satisfies Record<string, Nrf54lChip>;

export type Nrf54lMcu = keyof typeof NRF54L_CHIPS;

/** The ``mcu`` values the flasher is offered for. */
export const NRF54L_MCUS = Object.keys(NRF54L_CHIPS) as Nrf54lMcu[];

export function nrf54lChipOf(mcu: string | null | undefined): Nrf54lChip | undefined {
  return mcu && mcu in NRF54L_CHIPS ? NRF54L_CHIPS[mcu as Nrf54lMcu] : undefined;
}

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
