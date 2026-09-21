/**
 * Ordered list of pipeline steps (see flow step → module map below).
 * Filename prefix matches flow step number.
 * Each step module exports `name` and `async run(ctx)`; steps mutate ctx.document.
 *
 * Flow step → module:
 *   1 INPUT ............... 01-stops
 *   2 TEMPORAL WINDOWS .... 02-temporal
 *   3 TOPOLOGY ............ 03-topology
 *   3b REFINE BASIS ....... 03b-refine-basis (route-aligned WebTRIS counters)
 *   3c CARRIAGEWAY ........ 03c-carriageway (OSM per-leg carriageway kind)
 *   4 VELOCITY ............ 04-velocity
 *   4b PAIR PATH .......... 04b-pair-drive (Google Route Matrix)
 *   5 SPATIAL ............. 05-spatial
 *   6 OFF-PEAK DEMAND ..... 06-offpeak-demand
 *   7 SUPPLY .............. 07-supply
 *   8 TIMETABLE SELECTION . 08-selection
 *   9 VEHICLES & CHARGING . 09-vehicles
 *  10 OUTPUT .............. 10-output
 */

import * as stops from "./01-stops.js";
import * as temporal from "./02-temporal.js";
import * as topology from "./03-topology.js";
import * as refineBasis from "./03b-refine-basis.js";
import * as carriageway from "./03c-carriageway.js";
import * as velocity from "./04-velocity.js";
import * as pairDrive from "./04b-pair-drive.js";
import * as spatial from "./05-spatial.js";
import * as offPeakDemand from "./06-offpeak-demand.js";
import * as supply from "./07-supply.js";
import * as selection from "./08-selection.js";
import * as vehicles from "./09-vehicles.js";
import * as output from "./10-output.js";

export const steps = [stops, temporal, topology, refineBasis, carriageway, velocity, pairDrive, spatial, offPeakDemand, supply, selection, vehicles, output];
