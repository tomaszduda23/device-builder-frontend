/** The image a CMSIS-DAP probe writes: one or more hex files for one chip. */
import { formatAddress } from "../../../util/flash-log.js";
import {
  type HexSegment,
  IntelHexError,
  parseIntelHex,
} from "../../../util/intel-hex.js";
import { type Nrf54lChip, outOfRange } from "./chips.js";

export interface CmsisDapImage {
  chip: Nrf54lChip;
  segments: HexSegment[];
}

/** Why the files are not an image for the chip: the copy for the user and the detail. */
export interface CmsisDapImageFailure {
  key: "firmware.cmsis_dap_bad_image";
  detail: string;
}

/** Parse ``texts`` into one image for ``chip``; never throws. */
export function parseCmsisDapImage(
  chip: Nrf54lChip,
  texts: string[]
): CmsisDapImage | CmsisDapImageFailure {
  let segments: HexSegment[];
  try {
    segments = parseIntelHex(...texts);
  } catch (err) {
    if (!(err instanceof IntelHexError)) throw err;
    return { key: "firmware.cmsis_dap_bad_image", detail: err.message };
  }
  const outside = outOfRange(chip, segments);
  if (outside) {
    return {
      key: "firmware.cmsis_dap_bad_image",
      detail: `The image writes outside the ${chip.name}'s memory, at ${formatAddress(outside.address)}`,
    };
  }
  return { chip, segments };
}
