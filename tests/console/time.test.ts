import {describe,expect,it} from "vitest";
import {formatBeijingTime} from "../../apps/console/src/time.js";

describe("Console 东八区时间",()=>{
  it("converts ISO timestamps across the local day boundary",()=>{
    expect(formatBeijingTime("2026-11-09T16:00:05.999Z")).toBe("2026年11月10日 00:00:05（UTC+08:00）");
    expect(formatBeijingTime("2026-11-10T08:15:30+08:00")).toBe("2026年11月10日 08:15:30（UTC+08:00）");
  });
  it("accepts chain seconds and database milliseconds without changing the instant",()=>{
    const seconds=Date.parse("2026-11-10T04:05:06Z")/1000;
    expect(formatBeijingTime(seconds)).toBe("2026年11月10日 12:05:06（UTC+08:00）");
    expect(formatBeijingTime("2026-11-10T06:55:36Z")).toBe("2026年11月10日 14:55:36（UTC+08:00）");
    expect(formatBeijingTime(String(seconds))).toBe(formatBeijingTime(seconds*1000));
  });
  it("does not invent a time when data is absent or invalid",()=>{
    expect(formatBeijingTime(null)).toBe("—");
    expect(formatBeijingTime("not-a-date")).toBe("—");
  });
});
