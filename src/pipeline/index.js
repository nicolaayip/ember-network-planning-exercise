/**
 * Ordered list of pipeline steps (see flow step → module map below).
 * Each step module exports `name` and `async run(ctx)`; steps mutate ctx.document.
 *
 * Flow step → module:
 *   1 INPUT ............... 01-stops
 *   2 TEMPORAL WINDOWS .... 00-temporal
 *   3 TOPOLOGY ............ 02-topology
 *   3b REFINE BASIS ....... 02b-refine-basis (route-aligned WebTRIS counters)
 *   3c CARRIAGEWAY ........ 02c-carriageway (OSM per-leg carriageway kind)
 *   4 VELOCITY ............ 03-velocity
 *   4b PAIR PATH .......... 03b-pair-drive (Google Route Matrix)
 *   5 SPATIAL ............. 04-spatial
 *   6 OFF-PEAK DEMAND ..... 06-offpeak-demand
 *   7 SUPPLY .............. 07-supply
 *   9 TIMETABLE SELECTION . 09-selection
 *  10 VEHICLES & CHARGING . 09-vehicles
 *  11 OUTPUT .............. 08-output
 */

import * as stops from "./01-stops.js";
import * as temporal from "./00-temporal.js";
import * as topology from "./02-topology.js";
import * as refineBasis from "./02b-refine-basis.js";
import * as carriageway from "./02c-carriageway.js";
import * as velocity from "./03-velocity.js";
import * as pairDrive from "./03b-pair-drive.js";
import * as spatial from "./04-spatial.js";
import * as offPeakDemand from "./06-offpeak-demand.js";
import * as supply from "./07-supply.js";
import * as selection from "./09-selection.js";
import * as vehicles from "./09-vehicles.js";
import * as output from "./08-output.js";

export const steps = [stops, temporal, topology, refineBasis, carriageway, velocity, pairDrive, spatial, offPeakDemand, supply, selection, vehicles, output];
