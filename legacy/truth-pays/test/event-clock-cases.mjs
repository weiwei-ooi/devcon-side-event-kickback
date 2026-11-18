// The table of cases for the event's clock (scripts/core.mjs eventClock), shared by test/core.test.mjs (each result is
// the expected one) and test/site-generic.e2e.mjs (the generic guest page's own copy of eventClock gives the same
// results as the core's on every case). Each case: [what, case description text, eventStart (unix seconds), expected].
// The texts are case descriptions as the contract writes them (JSON), from the live template and the generic one, or
// bits of text an organiser could have typed anywhere in one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../scripts/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
// EIP-55 test vectors (the guest's wallet and the contract), and the organiser
const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", C = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", ORG = "0x259a1084C2043a7B3b5b288596E05C41b8EFa5d6";
const POLICY = core.ipfsPathOf(read(core.GENERIC_POLICY));
const base = { deposit: "0.01 ETH", owner: ORG, ownerLower: ORG.toLowerCase(), explorer: "https://etherscan.io" };
// the live Truth Pays case, as the contract writes it
const live = core.renderCase(core.caseTemplate(read(core.DEFAULT_METAEVIDENCE_TEMPLATE), { ...base, eventName: "Truth Pays", policyURI: "/ipfs/QmPzb9q9TyHS2jPmoCd1U9eDfZ9Nijh5NSFhhvJGVU7knE" }), W, C);
// a case of an event created from the admin panel (the generic template), with some of its fields as given
const generic = (fields) => core.renderCase(core.caseTemplate(read(core.GENERIC_METAEVIDENCE_TEMPLATE), {
  ...base, policyURI: POLICY, eventTitle: "Onchain Justice Night: Talks & \"Dinner\"", eventName: "Onchain Justice Night, Berlin 2027",
  eventWhere: "Café Example, Main Street 1, Berlin", hosts: "Kleros and friends", eventLink: "https://luma.com/your-event", ...fields,
}), W, C);
const at = (iso) => Date.parse(iso) / 1000;
const CET = ["2027-03-12T19:00:00+01:00", "2027-03-12T23:00:00+01:00"], CEST = ["2027-06-12T19:00:00+02:00", "2027-06-12T23:00:00+02:00"];
const NEWFOUNDLAND = ["2027-01-15T19:00:00-03:30", "2027-01-15T22:00:00-03:30"];
const cet = generic({ eventWhen: core.describeWhen(...CET, "CET") });

export const CLOCK_CASES = [
  ["the live Truth Pays case: IST", live, at("2026-11-04T18:00:00+05:30"), { offset: 330, zone: "IST" }],
  ["CET (Berlin in winter)", cet, at(CET[0]), { offset: 60, zone: "CET" }],
  ["CEST (Berlin in summer)", generic({ eventWhen: core.describeWhen(...CEST, "CEST") }), at(CEST[0]), { offset: 120, zone: "CEST" }],
  ["UTC-03:30 without a name (Newfoundland)", generic({ eventWhen: core.describeWhen(...NEWFOUNDLAND) }), at(NEWFOUNDLAND[0]), { offset: -210, zone: "UTC-03:30" }],
  ["NST (Newfoundland)", generic({ eventWhen: core.describeWhen(...NEWFOUNDLAND, "NST") }), at(NEWFOUNDLAND[0]), { offset: -210, zone: "NST" }],
  ["EDT (New York in summer)", generic({ eventWhen: core.describeWhen("2027-07-15T18:30:00-04:00", "2027-07-15T22:00:00-04:00", "EDT") }), at("2027-07-15T18:30:00-04:00"), { offset: -240, zone: "EDT" }],
  ["past midnight (\"to\" form): the start counts, not the end", generic({ eventWhen: core.describeWhen("2027-03-12T22:00:00-05:00", "2027-03-13T02:30:00-05:00", "EST") }),
    at("2027-03-12T22:00:00-05:00"), { offset: -300, zone: "EST" }],
  ["past midnight without a name", generic({ eventWhen: core.describeWhen("2027-03-12T22:00:00+01:00", "2027-03-13T01:00:00+01:00") }), at("2027-03-12T22:00:00+01:00"), { offset: 60, zone: "UTC+01:00" }],
  ["an earlier made-up date whose offset is impossible is skipped", generic({ eventName: "Launch Friday 5 March 2027, 19:00", eventWhen: core.describeWhen(...CET, "CET") }), at(CET[0]), { offset: 60, zone: "CET" }],
  ["an earlier made-up date with a real offset but no zone name: the case's own date, which names its zone, comes first",
    generic({ eventName: "Party Friday 12 March 2027, 20:00", eventWhen: core.describeWhen(...CET, "CET") }), at(CET[0]), { offset: 60, zone: "CET" }],
  ["an earlier made-up date whose zone name is its offset: that one, the first named (the moment shown is still right)",
    generic({ eventName: "Party Friday 12 March 2027, 20:00 CEST; Berlin", eventWhen: core.describeWhen(...CET, "CET") }), at(CET[0]), { offset: 120, zone: "CEST" }],
  ["a doors time in the event's name (+00:30 from the start, no timezone's offset) is skipped",
    generic({ eventName: "Onchain Justice Night, doors Friday 12 March 2027, 18:30", eventWhen: core.describeWhen(...CET, "CET") }), at(CET[0]), { offset: 60, zone: "CET" }],
  ["a talks time in the event's name (+01:45, no timezone's offset) is skipped",
    generic({ eventName: "Night Friday 12 March 2027, 19:45 (talks)", eventWhen: core.describeWhen(...CET, "CET") }), at(CET[0]), { offset: 60, zone: "CET" }],
  ["only a date whose offset no timezone uses (+01:30): none", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 CET)?"}', at("2027-03-12T19:00:00+01:30"), null],
  ["only a date whose offset no timezone uses (-11:30): none", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 UTC-11:30)?"}', at("2027-03-12T19:00:00-11:30"), null],
  ["a zone name that can't be the offset (IST at +07:00): the offset instead", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 IST)?"}', at("2027-03-12T19:00:00+07:00"), { offset: 420, zone: "UTC+07:00" }],
  ["a zone name that can't be the offset (CET at +05:30): the offset instead", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 CET)?"}', at("2027-03-12T19:00:00+05:30"), { offset: 330, zone: "UTC+05:30" }],
  // names with more than one meaning (ZONE_OFFSETS) are kept only for the one readers take them for first
  ["IST at +01:00 (Irish time, but read as India time): the offset instead", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 IST)?"}', at("2027-03-12T19:00:00+01:00"), { offset: 60, zone: "UTC+01:00" }],
  ["PST at +08:00 (Philippine time, but read as Pacific time): the offset instead", generic({ eventWhen: core.describeWhen("2026-11-04T19:00:00+08:00", "2026-11-04T22:00:00+08:00", "PST") }),
    at("2026-11-04T19:00:00+08:00"), { offset: 480, zone: "UTC+08:00" }],
  ["PST at -08:00 (Pacific time): kept", generic({ eventWhen: core.describeWhen("2026-11-04T19:00:00-08:00", "2026-11-04T22:00:00-08:00", "PST") }), at("2026-11-04T19:00:00-08:00"), { offset: -480, zone: "PST" }],
  ["CST at -05:00 (Cuba, but read as US Central time): the offset instead", generic({ eventWhen: core.describeWhen("2026-11-04T19:00:00-05:00", "2026-11-04T22:00:00-05:00", "CST") }),
    at("2026-11-04T19:00:00-05:00"), { offset: -300, zone: "UTC-05:00" }],
  ["CST at +08:00 (China): the offset instead", generic({ eventWhen: core.describeWhen("2026-11-04T19:00:00+08:00", "2026-11-04T22:00:00+08:00", "CST") }), at("2026-11-04T19:00:00+08:00"), { offset: 480, zone: "UTC+08:00" }],
  ["CST at -06:00 (US Central time): kept", generic({ eventWhen: core.describeWhen("2026-11-04T19:00:00-06:00", "2026-11-04T22:00:00-06:00", "CST") }), at("2026-11-04T19:00:00-06:00"), { offset: -360, zone: "CST" }],
  ["BST at +06:00 (Bangladesh): the offset instead", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 BST)?"}', at("2027-03-12T19:00:00+06:00"), { offset: 360, zone: "UTC+06:00" }],
  ["BST at +01:00 (British summer time): kept", '{"title": "Night (Thursday 15 July 2027, 19:00-23:00 BST)?"}', at("2027-07-15T19:00:00+01:00"), { offset: 60, zone: "BST" }],
  ["AST at +03:00 (Arabia): the offset instead", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 AST)?"}', at("2027-03-12T19:00:00+03:00"), { offset: 180, zone: "UTC+03:00" }],
  ["AST at -04:00 (Atlantic time): kept", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 AST)?"}', at("2027-03-12T19:00:00-04:00"), { offset: -240, zone: "AST" }],
  ["a UTC form of another offset: the offset instead", '{"title": "Night (Friday 12 March 2027, 19:00-23:00 UTC+02:00)?"}', at(CET[0]), { offset: 60, zone: "UTC+01:00" }],
  ["GMT+7", '{"description": "on Saturday 7 November 2026, 11:00-14:00 GMT+7; place"}', at("2026-11-07T11:00:00+07:00"), { offset: 420, zone: "GMT+7" }],
  ["a name with more than the zone in it (Berlin time (CEST)): the offset", generic({ eventWhen: core.describeWhen(...CEST, "Berlin time (CEST)") }), at(CEST[0]), { offset: 120, zone: "UTC+02:00" }],
  ["a name that is no timezone (Berlin time): the offset", generic({ eventWhen: core.describeWhen(...CEST, "Berlin time") }), at(CEST[0]), { offset: 120, zone: "UTC+02:00" }],
  ["a weekday that doesn't match its date is skipped", '{"title": "Thursday 12 March 2027, 19:00 CET; Friday 12 March 2027, 19:00-23:00 CET"}', at(CET[0]), { offset: 60, zone: "CET" }],
  ["only a weekday that doesn't match: none", '{"title": "Thursday 12 March 2027, 19:00-23:00 CET"}', at(CET[0]), null],
  ["a day that doesn't exist (31 February): none", '{"title": "Wednesday 31 February 2027, 19:00 CET"}', at("2027-03-03T19:00:00+01:00"), null],
  ["24:00: none", '{"title": "Friday 12 March 2027, 24:00 CET"}', at("2027-03-13T00:00:00+01:00"), null],
  ["a start that is no whole quarter hour away: none", cet, at(CET[0]) + 7 * 60, null],
  ["the case names another day: none", cet, at("2027-03-14T19:00:00+01:00"), null],
  ["no date in the case (\"soon\"): none", generic({ eventWhen: "soon" }), at(CET[0]), null],
  ["not a case description: none", "garbage {{{ 19:00 CET", 1_800_000_000, null],
  ["empty: none", "", 0, null],
  ["no start time: none", cet, "not a number", null],
  ["JSON-escaped: the date in quotes in a title", JSON.stringify({ title: 'Did wallet 0x… attend "Friday 12 March 2027, 19:00-23:00 CET"?' }), at(CET[0]), { offset: 60, zone: "CET" }],
  ["JSON-escaped: a line break right after the zone", JSON.stringify({ description: "Friday 12 March 2027, 19:00-23:00 CET\n\nThe guest concerned…" }), at(CET[0]), { offset: 60, zone: "CET" }],
  ["JSON-escaped: an escaped backslash stays one (CET\\new is no zone name, not CET and a line break)", JSON.stringify({ title: "Friday 12 March 2027, 19:00-23:00 CET\\new" }), at(CET[0]), { offset: 60, zone: "UTC+01:00" }],
  ["JSON-escaped: \\u0043ET reads CET", '{"title": "Friday 12 March 2027, 19:00-23:00 \\u0043ET"}', at(CET[0]), { offset: 60, zone: "CET" }],
];
