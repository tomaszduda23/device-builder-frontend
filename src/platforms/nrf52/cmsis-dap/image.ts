/**
 * The image a CMSIS-DAP debugger writes: one or more hex files. Which chip it
 * goes to, and so whether it fits, is known once the debugger is connected.
 */
import {
  type HexSegment,
  IntelHexError,
  parseIntelHex,
} from "../../../util/intel-hex.js";

export interface CmsisDapImage {
  segments: HexSegment[];
}

/** Why the files are not an image: the copy for the user and the detail. */
export interface CmsisDapImageFailure {
  key: "firmware.cmsis_dap_bad_image";
  detail: string;
}

/** Parse ``texts`` into one image; never throws. */
export function parseCmsisDapImage(
  texts: string[]
): CmsisDapImage | CmsisDapImageFailure {
  try {
    return { segments: parseIntelHex(...texts) };
  } catch (err) {
    if (!(err instanceof IntelHexError)) throw err;
    return { key: "firmware.cmsis_dap_bad_image", detail: err.message };
  }
}
