import { MachineOptions } from "xstate"
import {
  extractQueries,
  writeOutRequires,
  calculateDirtyQueries,
  runStaticQueries,
  runPageQueries,
  waitUntilAllJobsComplete,
  writeOutRedirects,
} from "../../services"
import { IQueryRunningContext } from "./types"

export const queryRunningServices: MachineOptions<
  IQueryRunningContext,
  any
>["services"] = {
  extractQueries,
  writeOutRequires,
  calculateDirtyQueries,
  runStaticQueries,
  runPageQueries,
  waitUntilAllJobsComplete,
  writeOutRedirects,
}
